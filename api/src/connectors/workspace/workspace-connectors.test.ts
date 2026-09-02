/**
 * A workspace ships its own connector: the whole path, end to end.
 *
 * Real bare git repos under a temp APPS_GIT_ROOT, mongodb-memory-server for
 * the index, and the LOCAL sandbox provider so a connector really is executed
 * as a separate process — the same rig the skills and consoles suites use.
 * Nothing here is mocked: the assertions are about what a pushed folder
 * actually does, because every interesting failure in this feature is a
 * failure of the pieces to fit, not of any one of them.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  ConnectorDefinition,
  type IConnector,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  repoExists,
} from "../../apps/repository.service";
import {
  recordConnectionCheck,
  syncConnectorsFromRepo,
} from "./reconcile.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { connectionSpecificationToForm } from "./spec-translation";
import { validateSpec } from "./connector-file";
import {
  connectorTypeExists,
  listWorkspaceConnectors,
  workspaceConnectorForm,
} from "./catalog";
import { SandboxedConnector } from "./SandboxedConnector";
import { getSandboxProvider } from "../../apps/sandbox/provider";
import { syncBoxContext } from "./sync-box";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-connectors-test-"),
  );
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.NODE_ENV = "development";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();

beforeEach(async () => {
  await ConnectorDefinition.deleteMany({});
  // The repo goes too. Clearing only Mongo leaves the previous test's folders
  // on `main`, so a later case reconciles connectors it never pushed — which
  // is how "one bad connector does not stop the others" appeared to fail
  // while actually counting an earlier test's leftovers.
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
});

/** A connector an agent could plausibly have written. */
const CONNECTOR_TS = `
import { defineConnector } from "@makoai/connector-sdk";

const ROWS = Array.from({ length: 12 }, (_, i) => ({
  id: "row-" + (i + 1),
  name: "Row " + (i + 1),
  updated_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
}));

export default defineConnector({
  name: "acme",
  version: "1.2.0",
  config: {
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", title: "API key", airbyte_secret: true },
      region: { type: "string", enum: ["eu", "us"], default: "eu" },
    },
  },
  check: async ctx => {
    if (ctx.config.apiKey !== "secret") throw new Error("401: bad key");
    return true;
  },
  entities: {
    widgets: {
      primaryKey: ["id"],
      cursorField: "updated_at",
      schema: { id: "string", name: "string", updated_at: "timestamp" },
      async *read(ctx, state) {
        let offset = Number(state.offset ?? 0);
        while (offset < ROWS.length) {
          const records = ROWS.slice(offset, offset + 5);
          offset += records.length;
          yield {
            records,
            state: { offset },
            hasMore: offset < ROWS.length,
          };
        }
      },
    },
  },
});
`;

async function push(
  files: Record<string, string>,
  message = "add connector",
): Promise<void> {
  const repoDir = repoDirFor(WS);
  if (!(await repoExists(repoDir))) {
    await initRepo(
      repoDir,
      { "README.md": "# workspace\n" },
      { message: "init" },
    );
  }
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes: files },
    { message, author: { name: "Test", email: "test@example.com" } },
  );
}

const dataSourceFor = (
  type: string,
  config: Record<string, unknown>,
): IConnector =>
  ({
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(WS),
    name: "Acme",
    type,
    config,
    settings: {},
  }) as unknown as IConnector;

describe("a connector pushed to the workspace repo", () => {
  it("is discovered, its spec captured, and it becomes usable", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });

    const result = await syncConnectorsFromRepo(WS);
    expect(result.created).toBe(1);
    expect(result.blocked).toBe(0);

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    }).lean();
    expect(row?.status).toBe("indexed");
    expect(row?.runtime).toBe("node");
    expect(row?.entities).toEqual(["widgets"]);

    // Indexed, not verified: a push carries no credential, so nothing has
    // proven the connector can actually connect.
    expect(row?.status).not.toBe("verified");
  }, 120_000);

  it("renders a credential form from the spec, with the secret marked", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    const form = await workspaceConnectorForm(WS, "ws:acme");
    const byName = Object.fromEntries(form.fields.map(f => [f.name, f]));
    expect(byName.apiKey).toMatchObject({
      label: "API key",
      type: "password",
      required: true,
      encrypted: true,
    });
    expect(byName.region).toMatchObject({ type: "select", default: "eu" });
    expect(byName.region.options).toEqual([
      { label: "eu", value: "eu" },
      { label: "us", value: "us" },
    ]);
  }, 120_000);

  it("appears in the workspace catalog and is accepted as a data source type", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    const catalog = await listWorkspaceConnectors(WS);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      type: "ws:acme",
      name: "acme",
      usable: true,
    });

    expect(await connectorTypeExists("ws:acme", WS)).toEqual({ ok: true });
    const missing = await connectorTypeExists("ws:nope", WS);
    expect(missing.ok).toBe(false);
  }, 120_000);

  it("cannot be seen or used by another workspace", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    const other = new Types.ObjectId().toString();
    expect(await listWorkspaceConnectors(other)).toEqual([]);
    const exists = await connectorTypeExists("ws:acme", other);
    expect(exists.ok).toBe(false);
  }, 120_000);
});

describe("running a workspace connector", () => {
  beforeEach(async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);
  });

  it("tests a good credential, and reports the vendor's own message for a bad one", async () => {
    const good = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "secret" }),
    );
    await expect(good.testConnection()).resolves.toMatchObject({
      success: true,
    });

    const bad = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "wrong" }),
    );
    const result = await bad.testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain("bad key");
  }, 120_000);

  it("resolves an entity schema the destination adapters can use", async () => {
    const connector = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "secret" }),
    );
    const schema = await connector.resolveSchema("widgets");
    expect(schema).toMatchObject({
      entity: "widgets",
      keyColumns: ["id"],
      unknownFieldPolicy: "string",
    });
    expect(schema?.fields.updated_at.type).toBe("timestamp");
    expect(schema?.fields.id.type).toBe("string");
  }, 120_000);

  it("fetches in resumable chunks, without repeating or losing a row", async () => {
    const connector = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "secret" }),
    );
    const seen: Array<{ id: string }> = [];

    let state = await connector.fetchEntityChunk({
      entity: "widgets",
      maxIterations: 1,
      onBatch: async batch => {
        seen.push(...(batch as Array<{ id: string }>));
      },
    });
    expect(seen).toHaveLength(5);
    expect(state.hasMore).toBe(true);

    while (state.hasMore) {
      state = await connector.fetchEntityChunk({
        entity: "widgets",
        maxIterations: 1,
        state,
        onBatch: async batch => {
          seen.push(...(batch as Array<{ id: string }>));
        },
      });
    }

    // Every row exactly once, in order: the chunk boundary is the thing most
    // likely to duplicate or drop, so it is asserted precisely.
    expect(seen).toHaveLength(12);
    expect(new Set(seen.map(row => row.id)).size).toBe(12);
    expect(seen[0].id).toBe("row-1");
    expect(seen[11].id).toBe("row-12");
    expect(state.totalProcessed).toBe(12);
  }, 120_000);

  it("fails loudly for an entity the connector does not have", async () => {
    const connector = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "secret" }),
    );
    await connector.loadDefinition();

    // The runner filters an unknown stream out silently, so without a guard
    // this would be a successful sync of zero rows — the failure mode a flow
    // whose entityFilter names a renamed entity hits, and never notices.
    await expect(
      connector.fetchEntityChunk({
        entity: "gadgets",
        onBatch: async () => undefined,
      }),
    ).rejects.toThrow(/no entity "gadgets"/);
  }, 120_000);
});

describe("the registry, which is how every caller reaches a connector", () => {
  beforeEach(async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);
  });

  /**
   * Nothing reaches a workspace connector by constructing one: the routes,
   * the orchestrator and the Inngest functions all go through the registry
   * with a `DataSourceConfig`, whose credential is `connection` and not
   * `config`. Testing only the class is how a registry that passed the raw
   * row — no config, no workspaceId — looked fine.
   */
  it("builds a working connector from a DataSourceConfig", async () => {
    const connector = await syncConnectorRegistry.getConnector({
      id: new Types.ObjectId().toString(),
      name: "Acme",
      type: "ws:acme",
      workspaceId: WS,
      active: true,
      connection: { apiKey: "secret" },
      settings: {},
    });

    expect(connector).not.toBeNull();
    // The entity list is warm: the registry awaited the definition before
    // handing the connector out, and callers ask synchronously.
    expect(connector!.getAvailableEntities()).toEqual(["widgets"]);
    // And the credential actually arrived — a connector built with an empty
    // config would fail this check with "401: bad key".
    await expect(connector!.testConnection()).resolves.toMatchObject({
      success: true,
    });
  }, 120_000);

  it("refuses to resolve a workspace connector without a workspace", async () => {
    await expect(
      syncConnectorRegistry.getConnector({
        id: new Types.ObjectId().toString(),
        name: "Acme",
        type: "ws:acme",
        active: true,
        connection: { apiKey: "secret" },
        settings: {},
      }),
    ).rejects.toThrow(/workspaceId/);
  }, 120_000);
});

describe("a connector whose entry file is not connector.ts", () => {
  it("runs the file connector.yaml names, not just at push time", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\nentry: src/index.ts\n",
      "connectors/acme/src/index.ts": CONNECTOR_TS,
    });

    const result = await syncConnectorsFromRepo(WS);
    expect(result.created).toBe(1);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    }).lean();
    expect(row?.status).toBe("indexed");
    expect(row?.entry).toBe("src/index.ts");

    // `spec` succeeded at push time regardless; what regressed before was
    // every command after it, which fell back to connector.ts and failed
    // with "No connector at .../connector.ts".
    const connector = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "secret" }),
    );
    await expect(connector.testConnection()).resolves.toMatchObject({
      success: true,
    });
    expect(await connector.resolveSchema("widgets")).toMatchObject({
      entity: "widgets",
    });
  }, 120_000);
});

describe("a spec that does not say what its fields are", () => {
  /**
   * The failure this guards against is silent: an empty field list means
   * `applySchemaEncryption` marks nothing secret and the API key is written
   * to Mongo in plaintext. Both ends refuse — the push, and the form.
   */
  it("is blocked at push time rather than indexed with no fields", () => {
    const missing = validateSpec({
      connectionSpecification: { type: "object" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("plaintext");

    // A connector that genuinely needs no credential is still fine.
    expect(
      validateSpec({ connectionSpecification: { properties: {} } }),
    ).toEqual({ ok: true });
  });

  it("throws rather than returning an empty credential form", () => {
    expect(() => connectionSpecificationToForm({ type: "object" })).toThrow(
      /properties/,
    );
    expect(() => connectionSpecificationToForm(undefined)).toThrow(
      /connectionSpecification/,
    );
    expect(connectionSpecificationToForm({ properties: {} })).toEqual({
      fields: [],
    });
  });
});

describe("a connector that cannot run", () => {
  it("is blocked with the reason, and refused as a data source type", async () => {
    await push({
      "connectors/broken/connector.yaml": "runtime: node\n",
      "connectors/broken/connector.ts":
        "export default { not: 'a connector' };\n",
    });

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "broken",
    }).lean();
    expect(row?.status).toBe("blocked");
    expect(row?.blockedReason).toContain("defineConnector");

    const exists = await connectorTypeExists("ws:broken", WS);
    expect(exists.ok).toBe(false);
    if (!exists.ok) expect(exists.reason).toContain("blocked");
  }, 120_000);

  it("names the unsupported runtime instead of failing obscurely", async () => {
    await push({
      "connectors/imported/connector.yaml": "runtime: declarative\n",
      "connectors/imported/manifest.yaml": "version: 1\n",
    });

    await syncConnectorsFromRepo(WS);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "imported",
    }).lean();
    expect(row?.status).toBe("blocked");
    expect(row?.blockedReason).toContain("not available yet");
  }, 120_000);

  it("does not stop the connectors pushed alongside it from landing", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
      "connectors/broken/connector.yaml": "runtime: node\n",
      "connectors/broken/connector.ts": "throw new Error('boom');\n",
    });

    const result = await syncConnectorsFromRepo(WS);
    expect(result.created).toBe(1);
    expect(result.blocked).toBe(1);
    const acme = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    }).lean();
    expect(acme?.status).toBe("indexed");
  }, 120_000);
});

describe("recording a real connection test", () => {
  beforeEach(async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);
  });

  const rowNow = () =>
    ConnectorDefinition.findOne({ workspaceId: WS, slug: "acme" }).lean();

  const sourceShaNow = async (): Promise<string> => {
    const row = await rowNow();
    if (!row) throw new Error("expected the acme connector to be indexed");
    return row.sourceSha;
  };

  it("is the only thing that can make a connector verified", async () => {
    expect((await rowNow())?.status).toBe("indexed");

    await recordConnectionCheck({
      workspaceId: WS,
      slug: "acme",
      sourceSha: await sourceShaNow(),
      success: true,
    });

    const row = await rowNow();
    expect(row?.status).toBe("verified");
    expect(row?.lastCheckedAt).toBeInstanceOf(Date);
  }, 120_000);

  it("demotes a verified connector when its credential stops working", async () => {
    await recordConnectionCheck({
      workspaceId: WS,
      slug: "acme",
      sourceSha: await sourceShaNow(),
      success: true,
    });
    await recordConnectionCheck({
      workspaceId: WS,
      slug: "acme",
      sourceSha: await sourceShaNow(),
      success: false,
      message: "401: this key was revoked",
    });

    const row = await rowNow();
    // Still offerable — the connector runs, the key does not — but no longer
    // claiming a verification that does not hold.
    expect(row?.status).toBe("indexed");
    expect(row?.lastCheckError).toContain("revoked");
    expect(row?.blockedReason).toBeUndefined();
  }, 120_000);

  it("cannot talk a blocked connector back up", async () => {
    await ConnectorDefinition.updateOne(
      { workspaceId: WS, slug: "acme" },
      { $set: { status: "blocked", blockedReason: "spec failed" } },
    );

    await recordConnectionCheck({
      workspaceId: WS,
      slug: "acme",
      sourceSha: await sourceShaNow(),
      success: true,
    });

    expect((await rowNow())?.status).toBe("blocked");
  }, 120_000);

  it("does not apply a check result to code pushed during the check", async () => {
    const testedSourceSha = await sourceShaNow();
    await ConnectorDefinition.updateOne(
      { workspaceId: WS, slug: "acme" },
      { $set: { sourceSha: "1".repeat(40), status: "indexed" } },
    );

    const recorded = await recordConnectionCheck({
      workspaceId: WS,
      slug: "acme",
      sourceSha: testedSourceSha,
      success: true,
    });

    expect(recorded).toBe(false);
    expect((await rowNow())?.status).toBe("indexed");
    expect((await rowNow())?.lastCheckedAt).toBeUndefined();
  }, 120_000);
});

describe("a connector folder too large to be code", () => {
  it("is blocked from its size alone, without being read into the API", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
      // Over the 2MB cap on its own.
      "connectors/hoarder/connector.yaml": "runtime: node\n",
      "connectors/hoarder/connector.ts": CONNECTOR_TS,
      "connectors/hoarder/dump.json": "x".repeat(3 * 1024 * 1024),
    });

    const result = await syncConnectorsFromRepo(WS);
    expect(result.blocked).toBe(1);

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "hoarder",
    }).lean();
    expect(row?.status).toBe("blocked");
    expect(row?.blockedReason).toContain("byte limit");

    // The connector pushed alongside it still lands: one oversized folder is
    // not a reason to fail the commit.
    expect(result.created).toBe(1);
  }, 120_000);
});

describe("reconciling repeatedly", () => {
  it("leaves an unchanged connector alone", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    expect((await syncConnectorsFromRepo(WS)).created).toBe(1);
    const again = await syncConnectorsFromRepo(WS);
    expect(again.unchanged).toBe(1);
    expect(again.created + again.updated).toBe(0);
  }, 120_000);

  it("re-runs spec when the code changes", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    await push(
      {
        "connectors/acme/connector.ts": CONNECTOR_TS.replace(
          '"1.2.0"',
          '"1.3.0"',
        ),
      },
      "bump version",
    );
    const result = await syncConnectorsFromRepo(WS);
    expect(result.updated).toBe(1);

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    }).lean();
    expect((row?.spec as any)?.mako?.version).toBe("1.3.0");
  }, 120_000);

  it("runs again when a newer push arrives during an active reconcile", async () => {
    const started = path.join(tmpRoot, "connector-reconcile-started");
    await fs.rm(started, { force: true });
    const slowConnector = CONNECTOR_TS.replace(
      'import { defineConnector } from "@makoai/connector-sdk";',
      `import { defineConnector } from "@makoai/connector-sdk";
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(started)}, "started");
await new Promise(resolve => setTimeout(resolve, 1000));`,
    );
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": slowConnector,
    });

    const first = syncConnectorsFromRepo(WS);
    const deadline = Date.now() + 10_000;
    let reconcileStarted = false;
    while (!reconcileStarted) {
      try {
        await fs.access(started);
        reconcileStarted = true;
      } catch {
        if (Date.now() >= deadline) {
          throw new Error("the first reconcile never started its connector");
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    await push(
      {
        "connectors/acme/connector.ts": CONNECTOR_TS.replace(
          'version: "1.2.0"',
          'version: "2.0.0"',
        ),
      },
      "replace connector while reconciliation is running",
    );
    const second = syncConnectorsFromRepo(WS);
    await Promise.all([first, second]);

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    }).lean();
    expect((row?.spec as any)?.mako?.version).toBe("2.0.0");
  }, 120_000);

  it("drops the index row when the folder is deleted", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    const repoDir = repoDirFor(WS);
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        deletes: [
          "connectors/acme/connector.yaml",
          "connectors/acme/connector.ts",
        ],
      },
      {
        message: "remove connector",
        author: { name: "T", email: "t@example.com" },
      },
    );

    const result = await syncConnectorsFromRepo(WS);
    expect(result.removed).toBe(1);
    expect(
      await ConnectorDefinition.findOne({ workspaceId: WS, slug: "acme" }),
    ).toBeNull();
  }, 120_000);

  it("does not delete the index when no repository can be resolved", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    const empty = new Types.ObjectId().toString();
    await ConnectorDefinition.create({
      workspaceId: new Types.ObjectId(empty),
      slug: "ghost",
      runtime: "node",
      sha: "0".repeat(40),
      sourceSha: "0".repeat(40),
      status: "indexed",
      entities: [],
    });
    await syncConnectorsFromRepo(empty);
    expect(
      await ConnectorDefinition.findOne({ workspaceId: empty, slug: "ghost" }),
    ).not.toBeNull();
  }, 120_000);
});

describe("the SDK installed in a persistent sync box", () => {
  it("repairs an incomplete cached runtime before executing it", async () => {
    await push({
      "connectors/acme/connector.yaml": "runtime: node\n",
      "connectors/acme/connector.ts": CONNECTOR_TS,
    });
    await syncConnectorsFromRepo(WS);

    const ctx = syncBoxContext(WS);
    const versions = path.join(
      getSandboxProvider().scratch(ctx),
      "connector-runtime",
      "versions",
    );
    let runtimeId: string | undefined;
    for (const candidate of await fs.readdir(versions)) {
      try {
        const marker = await fs.readFile(
          path.join(versions, candidate, ".materialized"),
          "utf8",
        );
        if (marker === candidate) {
          runtimeId = candidate;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!runtimeId) {
      throw new Error("expected a materialized connector runtime");
    }

    const runtimeRoot = path.join(versions, runtimeId);
    await fs.writeFile(
      path.join(
        runtimeRoot,
        "node_modules",
        "@makoai",
        "connector-sdk",
        "src",
        "run.js",
      ),
      "throw new Error('stale connector runtime');\n",
    );
    await fs.rm(path.join(runtimeRoot, ".materialized"));

    const connector = new SandboxedConnector(
      dataSourceFor("ws:acme", { apiKey: "secret" }),
    );
    await expect(connector.testConnection()).resolves.toMatchObject({
      success: true,
    });
  }, 120_000);
});
