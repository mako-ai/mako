/**
 * Graceful rename of workspace connectors (api/src/rename): the folder
 * moves with `aliases:` in connector.yaml, the index row is re-keyed in
 * place (same _id), connections typed `ws:<old>` move to `ws:<new>` and
 * keep resolving — including the config schema that decides which fields
 * are encrypted — under BOTH names. A bare laptop `git mv` reconciles the
 * same way instead of deleting the definition.
 *
 * Real bare repos + mongodb-memory-server like workspace-connectors.test.ts;
 * the sync box is stubbed so no sandbox boots — `spec` is not what these
 * cases are about.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const SPEC = {
  connectionSpecification: {
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", title: "API key", airbyte_secret: true },
      region: { type: "string", default: "eu" },
    },
  },
  mako: { name: "Acme CRM", version: "1.0.0", entities: { widgets: {} } },
};

vi.mock("./sync-box", async importOriginal => ({
  ...(await importOriginal<typeof import("./sync-box")>()),
  hasConnectorRuntime: vi.fn(async () => true),
  materializeConnector: vi.fn(async () => "/tmp/connector-dir"),
  runConnectorCommand: vi.fn(async () => ({
    exitCode: 0,
    messages: [{ type: "SPEC", spec: SPEC }],
    malformed: [],
    stderr: "",
    timedOut: false,
  })),
}));

import {
  ConnectorDefinition,
  SourceConnection,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  migrateSourceConnectionType,
  recordConnectionCheck,
  syncConnectorsFromRepo,
} from "./reconcile.service";
import {
  findConnectorDefinitionRow,
  loadConnectorDefinition,
} from "./resolver";
import { connectorTypeExists, listWorkspaceConnectors } from "./catalog";
import { parseConnectorFile, withConnectorAlias } from "./connector-file";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import {
  renameWorkspaceConnector,
  resolveConnector,
} from "../../rename/connector";
import { connectorRenameHandler } from "../../rename/handlers/connector";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const ctx = { workspaceId: WS, userId: "u1", role: "member" };

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-rename-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.NODE_ENV = "development";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await ConnectorDefinition.deleteMany({});
  await SourceConnection.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "# workspace\n" });
  await bindTestWorkspaceRepo(WS);
});

const YAML = "# hand-written\nruntime: node\nentry: connector.ts\n";
const CONNECTOR_TS = [
  "// stand-in: spec is stubbed, this is what git pairs renames on",
  'import { defineConnector } from "@makoai/connector-sdk";',
  'export default defineConnector({ name: "acme", version: "1.0.0",',
  '  config: { required: ["apiKey"], properties: { apiKey: { type: "string" } } },',
  '  entities: { widgets: { primaryKey: ["id"], schema: { id: "string" }, async *read() {} } } });',
  "",
].join("\n");
const OTHER_TS = [
  "// an unrelated connector: different vendor, different shape, different code",
  'import { defineConnector } from "@makoai/connector-sdk";',
  "const PAGES = [1, 2, 3];",
  "async function* readInvoices(ctx, state) { for (const p of PAGES) yield { records: [], state: { p }, hasMore: false }; }",
  'export default defineConnector({ name: "zed", version: "0.3.1",',
  '  config: { required: ["token", "accountId"], properties: { token: { type: "string" }, accountId: { type: "string" } } },',
  '  entities: { invoices: { primaryKey: ["invoice_id"], cursorField: "issued_at", schema: { invoice_id: "string", issued_at: "timestamp", total: "number" }, read: readInvoices } } });',
  "",
].join("\n");

async function push(
  mutation: { writes?: Record<string, string | Buffer>; deletes?: string[] },
  message = "push",
): Promise<string> {
  const repoDir = repoDirFor(WS);
  if (!(await repoExists(repoDir))) await initRepo(repoDir, {});
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author: { name: "Test", email: "test@example.com" },
  });
  return result.commitOid;
}

async function pushAcme(slug = "acme", yaml = YAML): Promise<void> {
  await push({
    writes: {
      [`connectors/${slug}/connector.yaml`]: yaml,
      [`connectors/${slug}/connector.ts`]: CONNECTOR_TS,
      [`connectors/${slug}/lib/util.ts`]: "export const x = 1;\n",
    },
  });
}

async function connection(type: string): Promise<string> {
  const row = await SourceConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name: `conn ${type}`,
    type,
    config: { apiKey: "enc:…", region: "eu" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
    createdBy: "u1",
  });
  return String(row._id);
}

async function pathsAtMain(): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  return (await listTree(repoDirFor(WS), head!)).map(e => e.path).sort();
}

describe("connector.yaml aliases", () => {
  it("parse: a list of slugs, deduped; anything else is a refusal", () => {
    expect(
      parseConnectorFile("runtime: node\naliases: [acme, acme]\n"),
    ).toMatchObject({
      ok: true,
      value: { aliases: ["acme"] },
    });
    expect(parseConnectorFile("runtime: node\n")).toMatchObject({
      ok: true,
      value: { aliases: [] },
    });
    expect(
      parseConnectorFile("runtime: node\naliases: Bad_Slug\n"),
    ).toMatchObject({
      ok: false,
    });
  });

  it("withConnectorAlias appends without touching the author's bytes; extends an existing list; refuses junk", () => {
    expect(withConnectorAlias(YAML, "old")).toBe(`${YAML}aliases:\n  - old\n`);
    expect(withConnectorAlias("runtime: node", "old")).toBe(
      "runtime: node\naliases:\n  - old\n",
    );
    const extended = withConnectorAlias("runtime: node\naliases: [a]\n", "b");
    expect(parseConnectorFile(extended!)).toMatchObject({
      ok: true,
      value: { aliases: ["a", "b"] },
    });
    expect(withConnectorAlias("runtime: node\naliases: [a]\n", "a")).toBe(
      "runtime: node\naliases: [a]\n",
    );
    expect(withConnectorAlias("- not: a mapping\n", "x")).toBeNull();
    expect(withConnectorAlias("runtime: [unclosed\n", "x")).toBeNull();
  });
});

describe("resolution: slug → alias, one claimant only", () => {
  it("a live slug beats an alias; two claimants resolve to nothing", async () => {
    await ConnectorDefinition.create({
      workspaceId: WS,
      slug: "acme-crm",
      sha: "a",
      sourceSha: "s1",
      status: "indexed",
      entities: [],
      aliases: ["acme"],
      spec: SPEC,
    });
    expect(await findConnectorDefinitionRow(WS, "acme")).toMatchObject({
      via: "alias",
      row: { slug: "acme-crm" },
    });
    expect((await loadConnectorDefinition(WS, "acme")).slug).toBe("acme-crm");
    expect(await connectorTypeExists("ws:acme", WS)).toEqual({ ok: true });
    // The schema that decides what is encrypted resolves under the alias.
    const viaAlias = await syncConnectorRegistry.getConfigSchemaForType(
      "ws:acme",
      WS,
    );
    const viaSlug = await syncConnectorRegistry.getConfigSchemaForType(
      "ws:acme-crm",
      WS,
    );
    expect(viaAlias).toEqual(viaSlug);
    expect(
      viaAlias.fields.find((f: { name: string }) => f.name === "apiKey"),
    ).toMatchObject({
      encrypted: true,
    });

    await ConnectorDefinition.create({
      workspaceId: WS,
      slug: "acme",
      sha: "b",
      sourceSha: "s2",
      status: "indexed",
      entities: [],
      aliases: [],
    });
    expect(await findConnectorDefinitionRow(WS, "acme")).toMatchObject({
      via: "current",
      row: { slug: "acme" },
    });

    await ConnectorDefinition.create({
      workspaceId: WS,
      slug: "other",
      sha: "c",
      sourceSha: "s3",
      status: "indexed",
      entities: [],
      aliases: ["legacy"],
    });
    await ConnectorDefinition.create({
      workspaceId: WS,
      slug: "other2",
      sha: "d",
      sourceSha: "s4",
      status: "indexed",
      entities: [],
      aliases: ["legacy"],
    });
    expect(await findConnectorDefinitionRow(WS, "legacy")).toBeNull();
    await expect(loadConnectorDefinition(WS, "legacy")).rejects.toThrow(
      /No connector "legacy"/,
    );
    expect(await connectorTypeExists("ws:legacy", WS)).toMatchObject({
      ok: false,
    });
  });
});

describe("reconcile detects a rename instead of deleting", () => {
  it("explicit `aliases` in the moved folder: same row, alias recorded, connections moved", async () => {
    await pushAcme();
    expect((await syncConnectorsFromRepo(WS)).created).toBe(1);
    const before = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    });
    expect(before).not.toBeNull();
    const connId = await connection("ws:acme");

    // A laptop move that kept the record: aliases written by hand.
    await push({
      writes: {
        "connectors/acme-crm/connector.yaml": `${YAML}aliases: [acme]\n`,
        "connectors/acme-crm/connector.ts": CONNECTOR_TS,
        "connectors/acme-crm/lib/util.ts": "export const x = 1;\n",
      },
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
        "connectors/acme/lib/util.ts",
      ],
    });
    const result = await syncConnectorsFromRepo(WS);
    expect(result.renamed).toEqual([{ from: "acme", to: "acme-crm" }]);
    expect(result.removed).toBe(0);
    expect(result.created).toBe(0);

    const rows = await ConnectorDefinition.find({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(before!._id));
    expect(rows[0].slug).toBe("acme-crm");
    expect(rows[0].aliases).toEqual(["acme"]);
    expect((await SourceConnection.findById(connId))?.type).toBe("ws:acme-crm");
    expect((await listWorkspaceConnectors(WS))[0]).toMatchObject({
      type: "ws:acme-crm",
      aliases: ["acme"],
    });
  }, 60_000);

  it("a bare `git mv` (no alias): detected by git, alias recorded in the index", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    const before = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    });
    const connId = await connection("ws:acme");

    await push(
      {
        writes: {
          "connectors/acme-v2/connector.yaml": YAML,
          "connectors/acme-v2/connector.ts": CONNECTOR_TS,
          "connectors/acme-v2/lib/util.ts": "export const x = 1;\n",
        },
        deletes: [
          "connectors/acme/connector.yaml",
          "connectors/acme/connector.ts",
          "connectors/acme/lib/util.ts",
        ],
      },
      "git mv acme acme-v2",
    );
    const result = await syncConnectorsFromRepo(WS);
    expect(result.renamed).toEqual([{ from: "acme", to: "acme-v2" }]);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme-v2",
    });
    expect(String(row!._id)).toBe(String(before!._id));
    expect(row!.aliases).toEqual(["acme"]);
    // Unchanged content: the pass counts it as unchanged, nothing re-run.
    expect(result.unchanged).toBe(1);
    expect((await SourceConnection.findById(connId))?.type).toBe("ws:acme-v2");
    // Old-typed connections still resolve while any remain.
    expect((await loadConnectorDefinition(WS, "acme")).slug).toBe("acme-v2");
    // A check that ran under the old slug lands on the row.
    expect(
      await recordConnectionCheck({
        workspaceId: WS,
        slug: "acme",
        sourceSha: row!.sourceSha,
        success: true,
      }),
    ).toBe(true);
    expect((await ConnectorDefinition.findById(row!._id))?.status).toBe(
      "verified",
    );
  }, 60_000);

  it("an unrelated delete + create is still a delete + create", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    await push({
      writes: {
        "connectors/zed/connector.yaml": YAML,
        "connectors/zed/connector.ts": OTHER_TS,
      },
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
        "connectors/acme/lib/util.ts",
      ],
    });
    const result = await syncConnectorsFromRepo(WS);
    expect(result.renamed).toEqual([]);
    expect(result.removed).toBe(1);
    expect(result.created).toBe(1);
  }, 60_000);

  it("migrateSourceConnectionType is idempotent", async () => {
    const a = await connection("ws:old");
    await connection("ws:other");
    expect(await migrateSourceConnectionType(WS, "old", "new")).toBe(1);
    expect(await migrateSourceConnectionType(WS, "old", "new")).toBe(0);
    expect((await SourceConnection.findById(a))?.type).toBe("ws:new");
    expect(await SourceConnection.countDocuments({ type: "ws:other" })).toBe(1);
  });
});

describe("renameWorkspaceConnector (UI / REST / MCP)", () => {
  it("moves the folder with the alias in ONE commit, re-keys the row, moves connections", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    const before = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    });
    const c1 = await connection("ws:acme");
    const c2 = await connection("ws:acme");
    const commitsBefore = await log(repoDirFor(WS), MAIN, 50);

    const result = await renameWorkspaceConnector(ctx, {
      from: "ws:acme",
      to: "acme-crm",
    });

    const commitsAfter = await log(repoDirFor(WS), MAIN, 50);
    expect(commitsAfter.length).toBe(commitsBefore.length + 1);
    expect(commitsAfter[0].oid).toBe(result.commit);
    expect(commitsAfter[0].subject).toBe(
      'Rename connector "acme" -> "acme-crm"',
    );
    expect(result).toMatchObject({
      kind: "connector",
      id: String(before!._id),
      before: { slug: "acme", path: "connectors/acme/", title: "Acme CRM" },
      after: { slug: "acme-crm", path: "connectors/acme-crm/" },
      aliasesAdded: ["acme"],
    });
    expect(result.after.url).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(
      /2 connections moved from ws:acme to ws:acme-crm/,
    );

    const paths = await pathsAtMain();
    expect(paths.filter(p => p.startsWith("connectors/acme/"))).toEqual([]);
    expect(paths).toEqual(
      expect.arrayContaining([
        "connectors/acme-crm/connector.yaml",
        "connectors/acme-crm/connector.ts",
        "connectors/acme-crm/lib/util.ts",
      ]),
    );
    // The author's yaml bytes survive; the alias is appended.
    const yaml = (
      await readBlob(repoDirFor(WS), MAIN, "connectors/acme-crm/connector.yaml")
    ).contents;
    expect(yaml).toBe(`${YAML}aliases:\n  - acme\n`);

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme-crm",
    });
    expect(String(row!._id)).toBe(String(before!._id));
    expect(row!.aliases).toEqual(["acme"]);
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      1,
    );
    expect((await SourceConnection.findById(c1))?.type).toBe("ws:acme-crm");
    expect((await SourceConnection.findById(c2))?.type).toBe("ws:acme-crm");
    // Credentials untouched by the migration.
    expect((await SourceConnection.findById(c1))?.config).toMatchObject({
      apiKey: "enc:…",
    });

    // Both names resolve to the same encryption schema afterwards.
    const viaOld = await syncConnectorRegistry.getConfigSchemaForType(
      "ws:acme",
      WS,
    );
    const viaNew = await syncConnectorRegistry.getConfigSchemaForType(
      "ws:acme-crm",
      WS,
    );
    expect(viaOld).toEqual(viaNew);

    // The push-time reconcile sees the same rename and changes nothing more.
    const again = await syncConnectorsFromRepo(WS);
    expect(again.renamed).toEqual([]);
    expect(again.removed).toBe(0);
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      1,
    );
    expect(
      (await ConnectorDefinition.findOne({ workspaceId: WS }))?.aliases,
    ).toEqual(["acme"]);
  }, 60_000);

  it("refuses bad slugs, unknown sources, live targets, another connector's alias, and title changes", async () => {
    await pushAcme();
    await pushAcme("beta");
    await syncConnectorsFromRepo(WS);
    await ConnectorDefinition.updateOne(
      { workspaceId: WS, slug: "beta" },
      { $set: { aliases: ["beta-old"] } },
    );
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "Bad Slug" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "acme" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameWorkspaceConnector(ctx, { from: "ghost", to: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "beta" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "beta-old" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('previous slug of the connector "beta"'),
    });
    await expect(
      connectorRenameHandler.rename(ctx, { ref: "acme", title: "Acme Inc" }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("defineConnector"),
    });
    // Nothing moved.
    expect(await pathsAtMain()).toContain("connectors/acme/connector.yaml");
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      2,
    );
  }, 60_000);

  it("handler: resolves current, alias and git-history refs; renames through the service", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    expect(await connectorRenameHandler.resolve(ctx, "ws:acme")).toMatchObject({
      kind: "connector",
      via: "current",
      current: { slug: "acme", title: "Acme CRM", path: "connectors/acme/" },
    });
    expect(await resolveConnector(ctx, "nope")).toBeNull();

    const renamed = await connectorRenameHandler.rename(ctx, {
      ref: "acme",
      slug: "acme-crm",
    });
    expect(renamed.after.slug).toBe("acme-crm");
    expect(await connectorRenameHandler.resolve(ctx, "acme")).toMatchObject({
      via: "alias",
      id: renamed.id,
      current: { slug: "acme-crm" },
    });

    // A bare git mv NOT yet reconciled: the index still says acme-crm, git
    // says the folder is acme-v3 now — resolve follows git.
    await push(
      {
        writes: {
          "connectors/acme-v3/connector.yaml": `${YAML}aliases:\n  - acme\n`,
          "connectors/acme-v3/connector.ts": CONNECTOR_TS,
          "connectors/acme-v3/lib/util.ts": "export const x = 1;\n",
        },
        deletes: [
          "connectors/acme-crm/connector.yaml",
          "connectors/acme-crm/connector.ts",
          "connectors/acme-crm/lib/util.ts",
        ],
      },
      "git mv acme-crm acme-v3",
    );
    await syncConnectorsFromRepo(WS);
    expect(await connectorRenameHandler.resolve(ctx, "acme-crm")).toMatchObject(
      {
        via: "alias",
        current: { slug: "acme-v3" },
      },
    );
    expect(
      (await ConnectorDefinition.findOne({ workspaceId: WS }))?.aliases,
    ).toEqual(expect.arrayContaining(["acme", "acme-crm"]));
  }, 60_000);
});
