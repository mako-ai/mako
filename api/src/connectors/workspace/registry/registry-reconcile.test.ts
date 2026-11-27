/**
 * Install by reference through the paths that use it: the push reconciler,
 * a run of a `SandboxedConnector`, and the agent tools, with the flag on and
 * off.
 *
 * PGlite for the connector index and a real registry on the
 * filesystem artifact store. The repo listing and the sync box are mocked, so
 * what is tested is the wiring: what a `source:` folder resolves to, what
 * the row records, which bundle a run installs, and what an agent is told.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";
import { connectionsRepo } from "../../../repositories/connections";
import {
  type PgTestDb,
  setupPgTestDb,
  ensureTestWorkspace,
} from "../../../test-support/pg-test";

const repo = vi.hoisted(() => ({
  files: new Map<string, Map<string, Uint8Array>>(),
  commit: "c".repeat(40),
}));
vi.mock("../resolver", async importOriginal => {
  const actual = await importOriginal<typeof import("../resolver")>();
  return {
    ...actual,
    listConnectorFoldersAtMain: vi.fn(async () => ({
      commit: repo.commit,
      slugs: [...repo.files.keys()].sort(),
      filesBySlug: repo.files,
      oversized: new Map(),
      nodeModules: new Map(),
    })),
    readConnectorFolder: vi.fn(
      async (_ws: string, slug: string) => repo.files.get(slug) ?? new Map(),
    ),
    ensureConnectorRuntime: vi.fn(async () => "runtime"),
    connectorSdkVersion: vi.fn(async () => "0.1.0"),
  };
});

const box = vi.hoisted(() => ({
  bundles: new Map<string, Uint8Array>(),
  loads: 0,
  runs: [] as Array<{ command: string; dir: string; entry?: string }>,
  fail: null as string | null,
  cleanupFail: null as string | null,
  retired: [] as Array<{ workspaceId: string; reason: string }>,
  onCommand: null as
    | ((input: {
        command: string;
        connectorDir: string;
        entry?: string;
      }) => Promise<void> | void)
    | null,
}));
vi.mock("../sync-box", async importOriginal => {
  const actual = await importOriginal<typeof import("../sync-box")>();
  return {
    ...actual,
    retireLegacySyncBox: vi.fn(async () => undefined),
    retireSyncBox: vi.fn(async (workspaceId: string, reason: string) => {
      box.retired.push({ workspaceId, reason });
    }),
    materializeConnector: vi.fn(
      async ({ slug, sourceSha }: { slug: string; sourceSha: string }) =>
        `/box/connectors/${slug}@${sourceSha}`,
    ),
    installConnectorBundle: vi.fn(
      async (input: {
        slug: string;
        hash: string;
        load: () => Promise<Uint8Array>;
      }) => {
        const key = `${input.slug}@${input.hash}`;
        if (!box.bundles.has(key)) {
          box.loads++;
          box.bundles.set(key, await input.load());
        }
        return { dir: `/box/bundles/${key}`, entry: "connector.mjs" };
      },
    ),
    runConnectorCommand: vi.fn(
      async (input: {
        command: string;
        connectorDir: string;
        entry?: string;
        onCleanupFailure?: (reason: string) => void;
      }) => {
        if (box.cleanupFail) input.onCleanupFailure?.(box.cleanupFail);
        box.runs.push({
          command: input.command,
          dir: input.connectorDir,
          entry: input.entry,
        });
        await box.onCommand?.(input);
        // The bundle's bytes say which version it is, as a real one would.
        const key = input.connectorDir.replace("/box/bundles/", "");
        const version = box.bundles.has(key)
          ? new TextDecoder().decode(box.bundles.get(key))
          : "ws";
        if (box.fail && input.command === "spec") {
          return {
            exitCode: 1,
            messages: [],
            malformed: [],
            stderr: box.fail,
            timedOut: false,
          };
        }
        const messages =
          input.command === "spec"
            ? [
                {
                  type: "SPEC",
                  spec: {
                    connectionSpecification: {
                      properties: {
                        api_key: { type: "string", airbyte_secret: true },
                      },
                    },
                    mako: {
                      name: "stripe",
                      version,
                      entities: { customers: {}, charges: {} },
                    },
                  },
                },
              ]
            : input.command === "check"
              ? [
                  {
                    type: "CONNECTION_STATUS",
                    connectionStatus: { status: "SUCCEEDED" },
                  },
                ]
              : input.command === "discover"
                ? [
                    {
                      type: "CATALOG",
                      catalog: {
                        streams: [
                          { name: "customers", json_schema: {} },
                          { name: "charges", json_schema: {} },
                        ],
                      },
                    },
                  ]
                : [];
        return {
          exitCode: 0,
          messages,
          malformed: [],
          stderr: "",
          timedOut: false,
        };
      },
    ),
  };
});

import type { ISourceConnection } from "../../../database/workspace-schema";
import {
  recordConnectionCheck,
  syncConnectorsFromRepo,
} from "../reconcile.service";
import { SandboxedConnector } from "../SandboxedConnector";
import { createConnectorTools } from "../../../agent-lib/tools/connector-tools";
import { CONNECTOR_REGISTRY_FLAG } from "./flag";
import { clearRegistryCatalogCache } from "./registry.service";
import { withVersion } from "./publish";
import {
  catalogKey,
  readCatalog,
  sha256Hex,
  writeCatalog,
  writeRegistryArtifacts,
} from "./store";

let pg: PgTestDb;
let storeDir = "";
beforeAll(async () => {
  pg = await setupPgTestDb();
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-reconcile-"));
  process.env.DASHBOARD_ARTIFACT_DIR = storeDir;
}, 120_000);
afterAll(async () => {
  await pg?.close();
  delete process.env[CONNECTOR_REGISTRY_FLAG];
  delete process.env.DASHBOARD_ARTIFACT_DIR;
  await fs.rm(storeDir, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const enc = (text: string) => new TextEncoder().encode(text);
const folder = (yaml: string, extra: Record<string, string> = {}) =>
  new Map(
    Object.entries({ "connector.yaml": yaml, ...extra }).map(([n, t]) => [
      n,
      enc(t),
    ]),
  );

/** Publish a version: its "bundle" is the version string, so runs can tell. */
async function publish(version: string): Promise<string> {
  const bytes = enc(version);
  const hash = sha256Hex(enc(`source of ${version}`));
  await writeRegistryArtifacts({
    slug: "stripe",
    hash,
    bundle: bytes,
    source: {
      slug: "stripe",
      version,
      hash,
      entry: "connector.ts",
      files: {
        "connector.yaml": Buffer.from(
          "runtime: node\nentry: connector.ts\n",
        ).toString("base64"),
        "connector.ts": Buffer.from(`// ${version}\n`).toString("base64"),
      },
    },
  });
  await writeCatalog(
    withVersion(await readCatalog(), {
      slug: "stripe",
      name: "stripe",
      title: "Stripe",
      versions: [
        {
          version,
          hash,
          sha256: sha256Hex(bytes),
          bytes: bytes.byteLength,
          sdkVersion: "0.1.0",
          entry: "connector.ts",
          entities: ["customers", "charges"],
          authType: "api_key",
          changelog: `- ${version}`,
          publishedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  clearRegistryCatalogCache();
  return hash;
}

const row = (slug = "stripe") =>
  connectionsRepo.findConnectorDefinition(WS, slug);

const connection = (slug = "stripe") =>
  ({
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(WS),
    name: "Stripe",
    type: `ws:${slug}`,
    config: { api_key: "sk_test" },
    settings: {},
  }) as unknown as ISourceConnection;

const tools = () =>
  createConnectorTools(WS) as unknown as Record<
    string,
    { execute: (input: unknown) => Promise<any> }
  >;

beforeEach(async () => {
  await pg.reset();
  await ensureTestWorkspace(pg.db, { id: WS });
  await fs.rm(path.join(storeDir, "connector-registry"), {
    recursive: true,
    force: true,
  });
  clearRegistryCatalogCache();
  repo.files.clear();
  repo.commit = "c".repeat(40);
  box.bundles.clear();
  box.loads = 0;
  box.runs.length = 0;
  box.fail = null;
  box.cleanupFail = null;
  box.retired.length = 0;
  process.env[CONNECTOR_REGISTRY_FLAG] = "true";
});

describe("install by reference, flag on", () => {
  it("resolves mako/stripe@1 to the newest 1.x, runs its spec and records the version", async () => {
    await publish("1.0.0");
    const hash = await publish("1.1.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));

    const result = await syncConnectorsFromRepo(WS);
    expect(result).toMatchObject({ created: 1, blocked: 0 });

    const spec = box.runs.find(run => run.command === "spec");
    expect(spec?.dir).toBe(`/box/bundles/mako.stripe@${hash}`);
    expect(spec?.entry).toBe("connector.mjs");

    const indexed = await row();
    expect(indexed).toMatchObject({
      status: "indexed",
      runtime: "node",
      entry: "connector.mjs",
      entities: ["customers", "charges"],
      registry: {
        ref: "mako/stripe@1",
        slug: "stripe",
        range: "1",
        version: "1.1.0",
        hash,
        latest: "1.1.0",
      },
    });
    expect(indexed?.registry?.upgradeAvailable).toBeUndefined();
    expect(indexed?.build).toBeUndefined();
  });

  it("kills the workspace box when the registry spec run's cleanup failed", async () => {
    await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    box.cleanupFail = "the run's processes would not die";

    const result = await syncConnectorsFromRepo(WS);

    expect(result).toMatchObject({ created: 1 });
    expect(box.retired).toEqual([
      { workspaceId: WS, reason: "the run's processes would not die" },
    ]);
  });

  it("applies a minor release on the next reconcile, and only records a major", async () => {
    await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    await syncConnectorsFromRepo(WS);
    // A real check earned `verified` on 1.0.0.
    await connectionsRepo.recordConnectorDefinitionCheckResult(WS, "stripe", {
      ok: true,
      checkedAt: new Date(),
    });

    // Nothing new: no spec, verified kept.
    box.runs.length = 0;
    expect((await syncConnectorsFromRepo(WS)).unchanged).toBe(1);
    expect(box.runs).toHaveLength(0);
    expect((await row())?.status).toBe("verified");

    // A minor release inside the range: new code, spec again, verified dropped.
    const minor = await publish("1.2.0");
    expect((await syncConnectorsFromRepo(WS)).updated).toBe(1);
    const upgraded = await row();
    expect(upgraded?.registry).toMatchObject({ version: "1.2.0", hash: minor });
    expect(upgraded?.status).toBe("indexed");
    await connectionsRepo.recordConnectorDefinitionCheckResult(WS, "stripe", {
      ok: true,
      checkedAt: new Date(),
    });

    // A major release: the row keeps 1.2.0 and says 2.0.0 exists.
    await publish("2.0.0");
    box.runs.length = 0;
    expect((await syncConnectorsFromRepo(WS)).unchanged).toBe(1);
    expect(box.runs).toHaveLength(0);
    const held = await row();
    expect(held?.registry).toMatchObject({
      version: "1.2.0",
      latest: "2.0.0",
      upgradeAvailable: "2.0.0",
    });
    expect(held?.status).toBe("verified");

    // Bumping the range is the workspace's commit; it then applies.
    repo.files.set("stripe", folder("source: mako/stripe@2\n"));
    expect((await syncConnectorsFromRepo(WS)).updated).toBe(1);
    const bumped = await row();
    expect(bumped?.registry?.version).toBe("2.0.0");
    expect(bumped?.registry?.upgradeAvailable).toBeUndefined();
  });

  it("blocks a reference nothing satisfies, with what is published", async () => {
    await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@3\n"));
    expect((await syncConnectorsFromRepo(WS)).blocked).toBe(1);
    expect((await row())?.blockedReason).toBe(
      "No version of mako/stripe matches @3. Published: 1.0.0.",
    );

    repo.files.set("stripe", folder("source: mako/close@1\n"));
    await syncConnectorsFromRepo(WS);
    expect((await row())?.blockedReason).toContain(
      "The registry has no connector mako/close",
    );
  });

  it("blocks a reference to an Object.prototype name, and only that connector", async () => {
    await publish("1.0.0");
    repo.files.set("weird", folder("source: mako/constructor@1\n"));
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    const result = await syncConnectorsFromRepo(WS);
    expect(result).toMatchObject({ created: 1, blocked: 1 });
    expect((await row("weird"))?.blockedReason).toContain(
      "The registry has no connector mako/constructor",
    );
    expect((await row("stripe"))?.status).toBe("indexed");
  });

  it("blocks source together with entry, and a spec that fails", async () => {
    await publish("1.0.0");
    repo.files.set(
      "stripe",
      folder("source: mako/stripe@1\nentry: connector.ts\n"),
    );
    await syncConnectorsFromRepo(WS);
    expect((await row())?.blockedReason).toContain("both `source` and `entry`");

    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    box.fail = "SyntaxError: bad bundle";
    await syncConnectorsFromRepo(WS);
    expect((await row())?.status).toBe("blocked");
  });

  it("keeps a running install when the registry cannot be read", async () => {
    await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    await syncConnectorsFromRepo(WS);

    await fs.writeFile(path.join(storeDir, catalogKey()), "{ not json");
    clearRegistryCatalogCache();
    expect((await syncConnectorsFromRepo(WS)).unchanged).toBe(1);
    expect((await row())?.status).toBe("indexed");

    // A first install has nothing to keep, so it is refused with the cause.
    repo.files.set("billing", folder("source: mako/stripe@1\n"));
    await syncConnectorsFromRepo(WS);
    expect((await row("billing"))?.blockedReason).toContain(
      "Could not read the connector registry",
    );
  });

  it("an ejected folder is code again and drops its registry record", async () => {
    await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    await syncConnectorsFromRepo(WS);
    expect((await row())?.registry?.version).toBe("1.0.0");

    repo.files.set(
      "stripe",
      folder("runtime: node\nentry: connector.ts\n", {
        "connector.ts": "// 1.0.0\n",
      }),
    );
    expect((await syncConnectorsFromRepo(WS)).updated).toBe(1);
    const ejected = await row();
    expect(ejected?.registry).toBeUndefined();
    expect(ejected?.entry).toBe("connector.ts");
    const spec = box.runs.filter(run => run.command === "spec").at(-1);
    expect(spec?.dir).toMatch(/^\/box\/connectors\/stripe@/);
  });
});

describe("a run of a connector installed by reference", () => {
  it("runs the recorded version's bundle, not the newest", async () => {
    const pinned = await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1.0\n"));
    await syncConnectorsFromRepo(WS);
    await publish("1.1.0");
    box.bundles.clear();
    box.loads = 0;
    box.runs.length = 0;

    const connector = new SandboxedConnector(connection());
    expect((await connector.testConnection()).success).toBe(true);
    const check = box.runs.find(run => run.command === "check");
    expect(check).toMatchObject({
      dir: `/box/bundles/mako.stripe@${pinned}`,
      entry: "connector.mjs",
    });
    expect(await connector.resolveSchema("customers")).not.toBeNull();
    expect(box.loads).toBe(1);
  });

  it("refuses to run with the flag off", async () => {
    await publish("1.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    await syncConnectorsFromRepo(WS);

    delete process.env[CONNECTOR_REGISTRY_FLAG];
    const result = await new SandboxedConnector(connection()).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain("install by reference is off");
  });
});

describe("the agent tools", () => {
  it("list registry entries and versions, and the version an install runs", async () => {
    await publish("1.0.0");
    await publish("2.0.0");
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    await syncConnectorsFromRepo(WS);

    const listed = await tools().list_connectors.execute({});
    const registry = listed.connectors.find(
      (entry: any) => entry.connector === "mako/stripe",
    );
    expect(registry).toMatchObject({
      source: "registry",
      name: "Stripe",
      version: "2.0.0",
      authType: "api_key",
      entities: ["customers", "charges"],
      installedAs: ["ws:stripe"],
      versions: [
        { version: "2.0.0", changelog: "- 2.0.0" },
        { version: "1.0.0", changelog: "- 1.0.0" },
      ],
    });
    expect(registry.install).toContain("source: mako/stripe@2");

    const installed = listed.connectors.find(
      (entry: any) => entry.connector === "ws:stripe",
    );
    expect(installed.registry).toEqual({
      ref: "mako/stripe@1",
      version: "1.0.0",
      latest: "2.0.0",
      upgradeAvailable: "2.0.0",
    });

    const inspected = await tools().inspect_connector.execute({
      connector: "mako/stripe",
    });
    expect(inspected.versions.map((v: any) => v.version)).toEqual([
      "2.0.0",
      "1.0.0",
    ]);
    expect(inspected.source).toBe("registry");
    expect(inspected.release).toBeUndefined();

    const withSource = await tools().inspect_connector.execute({
      connector: "mako/stripe",
      version: "1.0.0",
      includeSource: true,
    });
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    expect(withSource.release).toEqual({
      version: "1.0.0",
      entry: "connector.ts",
      encoding: "base64",
      files: {
        "connector.yaml": b64("runtime: node\nentry: connector.ts\n"),
        "connector.ts": b64("// 1.0.0\n"),
      },
    });

    const inspectedInstall = await tools().inspect_connector.execute({
      connector: "ws:stripe",
    });
    expect(inspectedInstall.registry?.version).toBe("1.0.0");
  });

  it("list nothing from the registry with the flag off", async () => {
    await publish("1.0.0");
    delete process.env[CONNECTOR_REGISTRY_FLAG];
    const listed = await tools().list_connectors.execute({});
    expect(
      listed.connectors.some((entry: any) => entry.source === "registry"),
    ).toBe(false);
    const inspected = await tools().inspect_connector.execute({
      connector: "mako/stripe",
    });
    expect(inspected.error).toContain("registry is off");
  });
});

describe("flag off: a push behaves as before", () => {
  it("does not read source:, so the folder is refused for its missing runtime", async () => {
    await publish("1.0.0");
    delete process.env[CONNECTOR_REGISTRY_FLAG];
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    expect((await syncConnectorsFromRepo(WS)).blocked).toBe(1);
    const blocked = await row();
    expect(blocked?.blockedReason).toContain("needs a `runtime`");
    expect(blocked?.registry).toBeUndefined();
    expect(box.runs).toHaveLength(0);
  });

  it("indexReference preserves concurrent verified status when only commit sha or upgradeAvailable changes", async () => {
    process.env[CONNECTOR_REGISTRY_FLAG] = "true";
    await publish("1.0.0");
    repo.commit = "1".repeat(40);
    repo.files.set(
      "alpha",
      folder("runtime: node\nentry: connector.ts\n", {
        "connector.ts": "export default 1;\n",
      }),
    );
    repo.files.set("stripe", folder("source: mako/stripe@1\n"));
    expect((await syncConnectorsFromRepo(WS)).created).toBe(2);
    const stripeBefore = await connectionsRepo.findConnectorDefinition(
      WS,
      "stripe",
    );
    expect(stripeBefore?.status).toBe("indexed");
    if (!stripeBefore) throw new Error("expected stripe row");

    // Publish a new major (2.0.0) so stripe's registry metadata updates (upgradeAvailable)
    // while alpha changes and triggers runSpec. During alpha's spec, stripe gets verified.
    await publish("2.0.0");
    repo.commit = "2".repeat(40);
    repo.files.set(
      "alpha",
      folder("runtime: node\nentry: connector.ts\n", {
        "connector.ts": "export default 2;\n",
      }),
    );
    box.onCommand = async input => {
      if (input.command === "spec" && input.connectorDir.includes("alpha")) {
        const updated = await recordConnectionCheck({
          workspaceId: WS,
          slug: "stripe",
          sourceSha: stripeBefore.sourceSha,
          success: true,
        });
        expect(updated).toBe(true);
      }
    };
    try {
      const res = await syncConnectorsFromRepo(WS);
      expect(res.updated).toBe(1);
      expect(res.unchanged).toBe(1);
      const stripeAfter = await connectionsRepo.findConnectorDefinition(
        WS,
        "stripe",
      );
      expect(stripeAfter?.sha).toBe("2".repeat(40));
      expect(stripeAfter?.registry?.upgradeAvailable).toBe("2.0.0");
      expect(stripeAfter?.status).toBe("verified");
    } finally {
      box.onCommand = null;
    }
  });
});
