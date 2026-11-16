/**
 * Connector bundles through the two paths that use them: the push reconciler
 * and a run of a `SandboxedConnector`, with the flag on and off.
 *
 * Real Mongo (the index row is the thing being asserted). The repo listing,
 * the sync box, the build box and object storage are mocked, so what is
 * tested is the wiring: which path a folder takes, what the row says
 * afterwards, and what `list_connectors` reports from it.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const repo = vi.hoisted(() => ({
  files: new Map<string, Map<string, Uint8Array>>(),
  nodeModules: new Map<string, string>(),
}));
vi.mock("../resolver", async importOriginal => {
  const actual = await importOriginal<typeof import("../resolver")>();
  return {
    ...actual,
    listConnectorFoldersAtMain: vi.fn(async () => ({
      commit: "c".repeat(40),
      slugs: [
        ...new Set([...repo.files.keys(), ...repo.nodeModules.keys()]),
      ].sort(),
      filesBySlug: repo.files,
      oversized: new Map(),
      nodeModules: repo.nodeModules,
    })),
    readConnectorFolder: vi.fn(
      async (_ws: string, slug: string) => repo.files.get(slug) ?? new Map(),
    ),
    ensureConnectorRuntime: vi.fn(async () => "runtime"),
    connectorSdkVersion: vi.fn(async () => "0.1.0"),
  };
});

const box = vi.hoisted(() => ({
  bundles: new Set<string>(),
  runs: [] as Array<{ command: string; dir: string; entry?: string }>,
}));
vi.mock("../sync-box", async importOriginal => {
  const actual = await importOriginal<typeof import("../sync-box")>();
  const spec = {
    type: "SPEC",
    spec: {
      connectionSpecification: { properties: {} },
      mako: { name: "acme", version: "1.0.0", entities: { widgets: {} } },
    },
  };
  return {
    ...actual,
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
          await input.load();
          box.bundles.add(key);
        }
        return { dir: `/box/bundles/${key}`, entry: "connector.mjs" };
      },
    ),
    runConnectorCommand: vi.fn(
      async (input: {
        command: string;
        connectorDir: string;
        entry?: string;
      }) => {
        box.runs.push({
          command: input.command,
          dir: input.connectorDir,
          entry: input.entry,
        });
        const messages =
          input.command === "spec"
            ? [spec]
            : input.command === "check"
              ? [
                  {
                    type: "CONNECTION_STATUS",
                    connectionStatus: { status: "SUCCEEDED" },
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

const build = vi.hoisted(() => ({
  calls: 0,
  fail: null as string | null,
}));
vi.mock("./build-box", () => ({
  buildBundleInBox: vi.fn(async () => {
    build.calls++;
    if (build.fail) return { ok: false, reason: build.fail };
    return { ok: true, bytes: new TextEncoder().encode("export default 1;\n") };
  }),
}));

const stored = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("./store", () => ({
  readStoredBundle: vi.fn(
    async (ws: string, hash: string) => stored.get(`${ws}/${hash}`) ?? null,
  ),
  writeStoredBundle: vi.fn(
    async (input: { workspaceId: string; hash: string; bytes: Uint8Array }) => {
      stored.set(`${input.workspaceId}/${input.hash}`, input.bytes);
    },
  ),
}));

import {
  ConnectorDefinition,
  type ISourceConnection,
} from "../../../database/workspace-schema";
import { syncConnectorsFromRepo } from "../reconcile.service";
import { listWorkspaceConnectors } from "../catalog";
import { SandboxedConnector } from "../SandboxedConnector";
import { createConnectorTools } from "../../../agent-lib/tools/connector-tools";
import { CONNECTOR_BUNDLES_FLAG } from "./flag";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  delete process.env[CONNECTOR_BUNDLES_FLAG];
});

const WS = new Types.ObjectId().toString();
const enc = (text: string) => new TextEncoder().encode(text);
const CONNECTOR_TS = 'import { format } from "date-fns";\nexport default {};\n';
const lockfile = (resolved: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "date-fns": "4.1.0" } },
      "node_modules/date-fns": {
        version: "4.1.0",
        resolved,
        integrity: "sha512-abc",
      },
    },
  });
const LOCK = lockfile(
  "https://registry.npmjs.org/date-fns/-/date-fns-4.1.0.tgz",
);

function folder(extra: Record<string, string | null> = {}) {
  const files: Record<string, string | null> = {
    "connector.yaml": "runtime: node\n",
    "connector.ts": CONNECTOR_TS,
    "package.json": '{"dependencies":{"date-fns":"4.1.0"}}',
    "package-lock.json": LOCK,
    ...extra,
  };
  return new Map(
    Object.entries(files)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, text]) => [name, enc(text)]),
  );
}

const row = (slug = "acme") =>
  ConnectorDefinition.findOne({ workspaceId: WS, slug }).lean();

beforeEach(async () => {
  await ConnectorDefinition.deleteMany({});
  repo.files.clear();
  repo.nodeModules.clear();
  box.bundles.clear();
  box.runs.length = 0;
  stored.clear();
  build.calls = 0;
  build.fail = null;
  process.env[CONNECTOR_BUNDLES_FLAG] = "true";
});

describe("the push reconciler with bundles on", () => {
  it("builds a folder with dependencies, runs spec on the bundle and records the build", async () => {
    repo.files.set("acme", folder());

    const result = await syncConnectorsFromRepo(WS);
    expect(result.created).toBe(1);
    expect(build.calls).toBe(1);
    expect(stored.size).toBe(1);

    const spec = box.runs.find(run => run.command === "spec");
    expect(spec?.entry).toBe("connector.mjs");
    expect(spec?.dir).toMatch(/^\/box\/bundles\/acme@[0-9a-f]{64}$/);

    const indexed = await row();
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.build).toMatchObject({
      status: "built",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: 18,
    });
  });

  it("refuses a committed node_modules/ with the fix, before the size cap", async () => {
    repo.files.set("acme", folder());
    repo.nodeModules.set(
      "acme",
      "connectors/acme/node_modules/date-fns/index.js",
    );

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    expect(build.calls).toBe(0);
    expect(box.runs).toHaveLength(0);

    const blocked = await row();
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toContain("contains node_modules/");
    expect(blocked?.blockedReason).toContain("git rm -r --cached");
  });

  it("blocks package.json without a lockfile, without building", async () => {
    repo.files.set("acme", folder({ "package-lock.json": null }));

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    expect(build.calls).toBe(0);
    expect((await row())?.blockedReason).toContain("package-lock.json");
  });

  it("blocks a lockfile that installs from outside the npm registry, without building", async () => {
    repo.files.set(
      "acme",
      folder({
        "package-lock.json": lockfile(
          "git+ssh://git@github.com/evil/date-fns.git#0123456",
        ),
      }),
    );

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    expect(build.calls).toBe(0);
    expect(box.runs).toHaveLength(0);
    expect((await row())?.blockedReason).toContain("git+ssh://");
  });

  it("blocks a folder with a .npmrc, without building", async () => {
    repo.files.set(
      "acme",
      folder({ ".npmrc": "registry=https://evil.example/\n" }),
    );

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    expect(build.calls).toBe(0);
    expect((await row())?.blockedReason).toContain(".npmrc");
  });

  it("blocks a failed build and reports it next to the status", async () => {
    repo.files.set("acme", folder());
    build.fail = 'esbuild failed: Could not resolve "date-fns"';

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    const blocked = await row();
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe(
      'Build failed: esbuild failed: Could not resolve "date-fns"',
    );
    expect(blocked?.build).toMatchObject({
      status: "failed",
      error: 'esbuild failed: Could not resolve "date-fns"',
    });

    // The catalog the picker and the agent read carries it.
    const [summary] = await listWorkspaceConnectors(WS);
    expect(summary).toMatchObject({
      status: "blocked",
      usable: false,
      build: { status: "failed", error: expect.stringContaining("date-fns") },
    });

    const tools = createConnectorTools(WS) as unknown as Record<
      string,
      { execute: (input: unknown) => Promise<unknown> }
    >;
    const listed = (await tools.list_connectors.execute({})) as {
      connectors: Array<Record<string, unknown>>;
    };
    expect(
      listed.connectors.find(entry => entry.connector === "ws:acme"),
    ).toMatchObject({
      status: "blocked",
      build: { status: "failed" },
    });
    const inspected = (await tools.inspect_connector.execute({
      connector: "ws:acme",
    })) as Record<string, unknown>;
    expect(inspected).toMatchObject({
      status: "blocked",
      build: { status: "failed", error: expect.stringContaining("date-fns") },
    });
  });

  it("rebuilds after a failed build once the folder is pushed again", async () => {
    repo.files.set("acme", folder());
    build.fail = "npm ci failed: ETIMEDOUT";
    await syncConnectorsFromRepo(WS);
    expect((await row())?.status).toBe("blocked");

    build.fail = null;
    await syncConnectorsFromRepo(WS);
    const fixed = await row();
    expect(fixed?.status).toBe("indexed");
    expect(fixed?.build?.status).toBe("built");
    expect(fixed?.blockedReason).toBeUndefined();
  });

  it("runs a folder without package.json as before: no build, the TypeScript entry", async () => {
    repo.files.set(
      "acme",
      folder({ "package.json": null, "package-lock.json": null }),
    );

    await syncConnectorsFromRepo(WS);
    expect(build.calls).toBe(0);
    const spec = box.runs.find(run => run.command === "spec");
    expect(spec?.entry).toBe("connector.ts");
    expect(spec?.dir).toMatch(/^\/box\/connectors\/acme@/);
    const indexed = await row();
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.build).toBeUndefined();
  });
});

describe("the push reconciler with bundles off", () => {
  beforeEach(() => {
    delete process.env[CONNECTOR_BUNDLES_FLAG];
  });

  it("treats package.json as an ordinary file and runs the TypeScript entry", async () => {
    repo.files.set("acme", folder());

    await syncConnectorsFromRepo(WS);
    expect(build.calls).toBe(0);
    const spec = box.runs.find(run => run.command === "spec");
    expect(spec?.entry).toBe("connector.ts");
    expect(spec?.dir).toMatch(/^\/box\/connectors\/acme@/);
    const indexed = await row();
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.build).toBeUndefined();
  });

  it("still refuses a committed node_modules/: the guard is not behind the flag", async () => {
    repo.files.set("acme", folder());
    repo.nodeModules.set("acme", "connectors/acme/node_modules/x/index.js");

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    expect(box.runs).toHaveLength(0);
    const blocked = await row();
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toContain("contains node_modules/");
  });

  it("refuses node_modules/ in a folder without package.json too", async () => {
    repo.files.set(
      "acme",
      folder({ "package.json": null, "package-lock.json": null }),
    );
    repo.nodeModules.set("acme", "connectors/acme/node_modules/x/index.js");

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);
    expect((await row())?.status).toBe("blocked");
  });

  it("leaves a folder that is not a connector skipped, node_modules/ or not", async () => {
    // A helper folder (no connector.yaml) and an invalid slug were skipped
    // before the guard existed, and still are.
    repo.files.set(
      "shared",
      new Map([["index.ts", new TextEncoder().encode("export {};\n")]]),
    );
    repo.nodeModules.set("shared", "connectors/shared/node_modules/x/index.js");
    repo.files.set("My_Lib", folder());
    repo.nodeModules.set("My_Lib", "connectors/My_Lib/node_modules/x/index.js");

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(0);
    expect(result.skipped?.map(skip => skip.slug).sort()).toEqual([
      "My_Lib",
      "shared",
    ]);
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      0,
    );
  });

  it("does not check the lockfile: package.json is an ordinary file", async () => {
    repo.files.set(
      "acme",
      folder({ "package-lock.json": lockfile("https://evil.example/x.tgz") }),
    );

    const result = await syncConnectorsFromRepo(WS);
    expect(result.created).toBe(1);
    expect((await row())?.status).toBe("indexed");
  });
});

describe("a run that finds no bundle for its hash", () => {
  const connection = () =>
    ({
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(WS),
      name: "Acme",
      type: "ws:acme",
      config: {},
      settings: {},
    }) as unknown as ISourceConnection;

  it("builds it first, then runs the bundle", async () => {
    // Indexed with the flag off: no bundle exists anywhere yet.
    delete process.env[CONNECTOR_BUNDLES_FLAG];
    repo.files.set("acme", folder());
    await syncConnectorsFromRepo(WS);
    expect(build.calls).toBe(0);

    process.env[CONNECTOR_BUNDLES_FLAG] = "true";
    box.runs.length = 0;
    const result = await new SandboxedConnector(connection()).testConnection();
    expect(result.success).toBe(true);
    expect(build.calls).toBe(1);
    const check = box.runs.find(run => run.command === "check");
    expect(check?.entry).toBe("connector.mjs");
    expect((await row())?.build?.status).toBe("built");

    // A second run reuses the box's copy: no build, no storage read.
    await new SandboxedConnector(connection()).testConnection();
    expect(build.calls).toBe(1);
  });

  it("records a failed build without blocking, and the next run retries", async () => {
    delete process.env[CONNECTOR_BUNDLES_FLAG];
    repo.files.set("acme", folder());
    await syncConnectorsFromRepo(WS);

    process.env[CONNECTOR_BUNDLES_FLAG] = "true";
    build.fail = "npm ci failed: ECONNRESET";
    const failed = await new SandboxedConnector(connection()).testConnection();
    expect(failed.success).toBe(false);
    expect(failed.message).toContain("Build failed: npm ci failed: ECONNRESET");
    const after = await row();
    expect(after?.status).toBe("indexed");
    expect(after?.build).toMatchObject({ status: "failed" });

    build.fail = null;
    const retried = await new SandboxedConnector(connection()).testConnection();
    expect(retried.success).toBe(true);
    expect((await row())?.build?.status).toBe("built");
  });
});
