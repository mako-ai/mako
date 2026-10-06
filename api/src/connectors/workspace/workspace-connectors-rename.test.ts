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

// A commit landing on main inside a rename's read→commit window (another
// window's save, a laptop push). Fired once, only for the rename's commit.
const race = vi.hoisted(() => ({
  before: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      if (race.before && /^Rename connector/.test(args[3]?.message ?? "")) {
        const fn = race.before;
        race.before = undefined;
        await fn();
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});

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
  blobOid,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log,
  readBlob,
  readBlobsBatch,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  migrateSourceConnectionType,
  recordConnectionCheck,
  sourceShaOf,
  syncConnectorsFromRepo,
} from "./reconcile.service";
import {
  findConnectorDefinitionFor,
  findConnectorDefinitionRow,
  loadConnectorDefinition,
} from "./resolver";
import { connectorTypeExists, listWorkspaceConnectors } from "./catalog";
import {
  connectorFileIdentity,
  parseConnectorFile,
  stripConnectorAliases,
  withConnectorAlias,
} from "./connector-file";
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
  mutation: Parameters<typeof commitBlobsOnBranch>[2],
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

/** A connection BOUND to a definition by id (what create/update stamp). */
async function boundConnection(slug: string): Promise<string> {
  const row = await ConnectorDefinition.findOne({ workspaceId: WS, slug });
  if (!row) throw new Error(`no definition ${slug}`);
  const conn = await SourceConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name: `bound ${slug}`,
    type: `ws:${slug}`,
    connectorDefinitionId: row._id,
    config: { apiKey: `enc:${slug}`, region: "eu" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
    createdBy: "u1",
  });
  return String(conn._id);
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
    // No final line break in, none out: the block is introduced by one.
    expect(withConnectorAlias("runtime: node", "old")).toBe(
      "runtime: node\naliases:\n  - old",
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

  it("extends an existing list IN PLACE: comments and layout survive", () => {
    const block = [
      "# vendor: Acme",
      "runtime: node",
      "aliases:",
      "  - acme   # first name",
      "  - acme-v1",
      "entry: connector.ts  # keep",
      "",
    ].join("\n");
    expect(withConnectorAlias(block, "acme-v2")).toBe(
      [
        "# vendor: Acme",
        "runtime: node",
        "aliases:",
        "  - acme   # first name",
        "  - acme-v1",
        "  - acme-v2",
        "entry: connector.ts  # keep",
        "",
      ].join("\n"),
    );
    expect(
      withConnectorAlias("runtime: node\naliases: [a, b]  # c\n", "d"),
    ).toBe("runtime: node\naliases: [a, b, d]  # c\n");
    expect(withConnectorAlias("runtime: node\naliases: []\n", "d")).toBe(
      "runtime: node\naliases: [d]\n",
    );
    // A list this cannot extend in place is refused, never re-dumped.
    expect(
      withConnectorAlias("runtime: node\naliases: &x\n  - a\n", "d"),
    ).toBeNull();
    expect(
      withConnectorAlias("runtime: node\naliases: notalist\n", "d"),
    ).toBeNull();
  });

  it("the hash of a yaml without aliases is the pre-existing formula (deploying re-indexes nothing)", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const files = new Map([
      ["connector.yaml", enc(YAML)],
      ["connector.ts", enc("x")],
    ]);
    const legacy = blobOid(
      [...files.keys()]
        .sort()
        .map(n => `${n}:${blobOid(Buffer.from(files.get(n) as Uint8Array))}`)
        .join("\n"),
    );
    expect(sourceShaOf(files)).toBe(legacy);
    // Block and flow alias lists strip back to the same bytes.
    expect(stripConnectorAliases(`${YAML}aliases:\n  - a\n  - b\n`)).toBe(YAML);
    expect(stripConnectorAliases(`${YAML}aliases: [a, b]\n`)).toBe(YAML);
    expect(stripConnectorAliases(withConnectorAlias(YAML, "a")!)).toBe(YAML);
  });

  it("strip exactly inverts add: no final line break, CRLF, and a second alias", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    for (const y of [
      "runtime: node",
      "runtime: node\n",
      "runtime: node\n\n",
      "runtime: node\r\nentry: connector.ts",
      "runtime: node\r\nentry: connector.ts\r\n",
      "# c\r\nruntime: node\n", // mixed endings: a CRLF file ending in a bare LF
    ]) {
      const once = withConnectorAlias(y, "acme");
      expect(once, JSON.stringify(y)).not.toBeNull();
      expect(parseConnectorFile(once!)).toMatchObject({
        ok: true,
        value: { aliases: ["acme"] },
      });
      expect(connectorFileIdentity(once!), JSON.stringify(y)).toBe(y);
      const twice = withConnectorAlias(once!, "acme-v2");
      expect(parseConnectorFile(twice!)).toMatchObject({
        ok: true,
        value: { aliases: ["acme", "acme-v2"] },
      });
      expect(connectorFileIdentity(twice!), JSON.stringify(y)).toBe(y);
      // ...so the content hash — what `verified` is pinned to — holds.
      const sha = (yaml: string) =>
        sourceShaOf(
          new Map([
            ["connector.yaml", enc(yaml)],
            ["connector.ts", enc("x")],
          ]),
        );
      expect(sha(once!)).toBe(sha(y));
      expect(sha(twice!)).toBe(sha(y));
    }
    // A CRLF file gets CRLF lines, not a lone LF.
    expect(withConnectorAlias("runtime: node\r\n", "acme")).toBe(
      "runtime: node\r\naliases:\r\n  - acme\r\n",
    );
  });

  it("zero-indent block lists are items too; a shape the edit cannot keep parseable is refused", () => {
    const zero = "runtime: node\naliases:\n- a\nentry: connector.ts\n";
    expect(withConnectorAlias(zero, "b")).toBe(
      "runtime: node\naliases:\n- a\n- b\nentry: connector.ts\n",
    );
    expect(parseConnectorFile(withConnectorAlias(zero, "b")!)).toMatchObject({
      ok: true,
      value: { aliases: ["a", "b"] },
    });
    expect(stripConnectorAliases(zero)).toBe(
      "runtime: node\nentry: connector.ts\n",
    );
    // A multi-line flow list: extending it in place would break the file,
    // so the edit is refused; the hash falls back to the raw bytes.
    const multi =
      "runtime: node\naliases: [\n  a,\n  b ]\nentry: connector.ts\n";
    expect(parseConnectorFile(multi)).toMatchObject({
      ok: true,
      value: { aliases: ["a", "b"] },
    });
    expect(withConnectorAlias(multi, "c")).toBeNull();
    expect(stripConnectorAliases(multi)).toBe(multi);
  });

  it("the content hash ignores `aliases`: a rename is not new code", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const a = new Map([
      ["connector.yaml", enc(YAML)],
      ["connector.ts", enc("x")],
    ]);
    const b = new Map([
      ["connector.yaml", enc(`${YAML}aliases:\n  - acme\n`)],
      ["connector.ts", enc("x")],
    ]);
    const c = new Map([
      ["connector.yaml", enc("runtime: node\nentry: other.ts\n")],
      ["connector.ts", enc("x")],
    ]);
    expect(sourceShaOf(a)).toBe(sourceShaOf(b));
    expect(sourceShaOf(a)).not.toBe(sourceShaOf(c));
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
    // A check that ran under the old slug lands on the row only through
    // the connection's BINDING (an alias alone records nothing).
    expect(
      await recordConnectionCheck({
        workspaceId: WS,
        slug: "acme",
        sourceSha: row!.sourceSha,
        success: true,
      }),
    ).toBe(false);
    expect(
      await recordConnectionCheck({
        workspaceId: WS,
        slug: "acme",
        definitionId: String(row!._id),
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

  it("a NEW folder at a retired slug wins — and the old-typed connections are moved first", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    await renameWorkspaceConnector(ctx, { from: "acme", to: "acme-crm" });
    // A connection that still says ws:acme (created before the migration,
    // or by a client that bypassed canonicalization).
    const stale = await boundConnection("acme-crm");
    await SourceConnection.updateOne(
      { _id: stale },
      { $set: { type: "ws:acme" } },
    );
    const legacy = await connection("ws:acme"); // unbound, typed by the alias
    expect((await loadConnectorDefinition(WS, "acme")).slug).toBe("acme-crm");

    // Someone pushes a brand-new connector called `acme`.
    await push({
      writes: {
        "connectors/acme/connector.yaml": YAML,
        "connectors/acme/connector.ts": OTHER_TS,
      },
    });
    const result = await syncConnectorsFromRepo(WS);
    expect(result.created).toBe(1);
    const rows = await ConnectorDefinition.find({ workspaceId: WS }).sort({
      slug: 1,
    });
    expect(rows.map(r => [r.slug, r.aliases])).toEqual([
      ["acme", []],
      ["acme-crm", []], // the alias is gone: `acme` has one owner again
    ]);
    // The bound connection followed its connector (type made to match);
    // the unbound one typed by the alias is nobody's and stays as it is.
    expect((await SourceConnection.findById(stale))?.type).toBe("ws:acme-crm");
    expect((await SourceConnection.findById(legacy))?.type).toBe("ws:acme");
    expect((await loadConnectorDefinition(WS, "acme")).slug).toBe("acme");
  }, 60_000);

  it("a released alias stays released: later syncs do not resurrect it, and deleting the newcomer does not hand ws:<slug> back", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    await renameWorkspaceConnector(ctx, { from: "acme", to: "acme-crm" });
    await push({
      writes: {
        "connectors/acme/connector.yaml": YAML,
        "connectors/acme/connector.ts": OTHER_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    const fresh = await connection("ws:acme"); // made for the NEW acme
    const rowsNow = async () =>
      (
        await ConnectorDefinition.find({ workspaceId: WS }).sort({ slug: 1 })
      ).map(r => [r.slug, r.aliases, r.retiredAliases]);
    expect(await rowsNow()).toEqual([
      ["acme", [], []],
      ["acme-crm", [], ["acme"]],
    ]);
    // acme-crm's connector.yaml still says `aliases: [acme]`; two more syncs.
    await push({ writes: { "README.md": "# touched\n" } });
    await syncConnectorsFromRepo(WS);
    await push({ writes: { "README.md": "# touched again\n" } });
    await syncConnectorsFromRepo(WS);
    expect(await rowsNow()).toEqual([
      ["acme", [], []],
      ["acme-crm", [], ["acme"]],
    ]);
    // The newcomer is deleted: ws:acme resolves to NOTHING, never to acme-crm.
    await push({
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    expect(await rowsNow()).toEqual([["acme-crm", [], ["acme"]]]);
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
    expect((await SourceConnection.findById(fresh))?.type).toBe("ws:acme");
    // Renaming acme-crm back to acme is refused while the deleted
    // newcomer's connection still points at ws:acme (it would adopt it)…
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme-crm", to: "acme" }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "1 connection still points at ws:acme from a deleted connector; delete or re-point them first",
    });
    // …and allowed once that connection is gone: the live owner again.
    await SourceConnection.deleteOne({ _id: fresh });
    await renameWorkspaceConnector(ctx, { from: "acme-crm", to: "acme" });
    expect(await rowsNow()).toEqual([["acme", ["acme-crm"], []]]);
    expect(await findConnectorDefinitionRow(WS, "acme")).toMatchObject({
      via: "current",
    });
  }, 120_000);

  it("laptop git mv INTO another connector's retired/alias slug, then delete: the moved connector's connections are stranded, never adopted", async () => {
    // Z starts life as acme and is renamed to z (alias acme recorded).
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    await renameWorkspaceConnector(ctx, { from: "acme", to: "z" });
    await syncConnectorsFromRepo(WS);
    // An unrelated connector foo with its own connection.
    await push({
      writes: {
        "connectors/foo/connector.yaml": YAML,
        "connectors/foo/connector.ts": OTHER_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    const fooConn = await connection("ws:foo");
    // Laptop: git mv connectors/foo connectors/acme (the UI refuses this).
    await push({
      writes: {
        "connectors/acme/connector.yaml": YAML,
        "connectors/acme/connector.ts": OTHER_TS,
      },
      deletes: ["connectors/foo/connector.yaml", "connectors/foo/connector.ts"],
    });
    const pass = await syncConnectorsFromRepo(WS);
    expect(pass.renamed).toEqual([{ from: "foo", to: "acme" }]);
    expect((await SourceConnection.findById(fooConn))?.type).toBe("ws:acme");
    // Z released the name BEFORE foo took it: no two owners of `acme`.
    // (Z's only ever alias was `acme`; the rename's re-index is awaited,
    // so no pass from an earlier state can hand it anything else.)
    const z = await ConnectorDefinition.findOne({ workspaceId: WS, slug: "z" });
    expect(z?.aliases).not.toContain("acme");
    expect(z?.aliases).toEqual([]);
    expect(z?.retiredAliases).toEqual(["acme"]);
    expect((await loadConnectorDefinition(WS, "acme")).slug).toBe("acme");
    // The (renamed) foo connector is deleted.
    await push({
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    // ws:acme resolves to NOTHING — foo's credentials never reach Z's code.
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
    await expect(loadConnectorDefinition(WS, "acme")).rejects.toThrow(
      /No connector "acme"/,
    );
    expect((await SourceConnection.findById(fooConn))?.type).toBe("ws:acme");
    // Even after more syncs with Z's yaml still saying `aliases: [acme]`.
    await push({ writes: { "README.md": "# touched\n" } });
    await syncConnectorsFromRepo(WS);
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
  }, 120_000);

  it("deleting a connector retires its slug from every other connector's aliases", async () => {
    // `old` is deleted while `keeper` still lists it as an alias by hand.
    await pushAcme("old");
    await push({
      writes: {
        "connectors/keeper/connector.yaml": `${YAML}aliases: [old]\n`,
        "connectors/keeper/connector.ts": OTHER_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    // `old` is live, so keeper's alias claim was released at index time;
    // now delete `old` and make sure keeper never inherits it.
    const orphan = await connection("ws:old");
    await push({
      deletes: [
        "connectors/old/connector.yaml",
        "connectors/old/connector.ts",
        "connectors/old/lib/util.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    const keeper = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "keeper",
    });
    expect(keeper?.aliases).toEqual([]);
    expect(keeper?.retiredAliases).toEqual(["old"]);
    expect(await findConnectorDefinitionRow(WS, "old")).toBeNull();
    expect((await SourceConnection.findById(orphan))?.type).toBe("ws:old");
  }, 120_000);

  it("alias lifecycle: file edits remove file aliases, a copy drops aliases another row holds, delete retires aliases too, a sole claimant adopts", async () => {
    // 1. acme with a connection.
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    const conn = await connection("ws:acme");
    // 2. laptop: move + full rewrite (not detectable). C is orphaned: fail closed.
    await push({
      writes: {
        "connectors/acme-v2/connector.yaml": YAML,
        "connectors/acme-v2/connector.ts": OTHER_TS,
      },
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
        "connectors/acme/lib/util.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
    // 3. the documented fix: aliases: [acme] on acme-v2. The alias answers
    //    for LINKS; C — bound to nothing (legacy) and typed by a name that
    //    is now only an alias — is not adopted: it fails closed until a
    //    person re-points it. A connection BOUND to acme-v2 but still typed
    //    ws:acme gets its (cosmetic) type fixed.
    await push({
      writes: {
        "connectors/acme-v2/connector.yaml": `${YAML}aliases: [acme]\n`,
      },
    });
    await syncConnectorsFromRepo(WS);
    expect((await findConnectorDefinitionRow(WS, "acme"))?.row.slug).toBe(
      "acme-v2",
    );
    expect((await SourceConnection.findById(conn))?.type).toBe("ws:acme");
    expect(
      await findConnectorDefinitionFor(WS, { type: "ws:acme" }),
    ).toBeNull();
    const v2 = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme-v2",
    });
    const own = await SourceConnection.create({
      workspaceId: new Types.ObjectId(WS),
      name: "own",
      type: "ws:acme",
      connectorDefinitionId: v2!._id,
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
      createdBy: "u1",
    });
    await push({ writes: { "README.md": "# t\n" } });
    await syncConnectorsFromRepo(WS);
    expect((await SourceConnection.findById(own._id))?.type).toBe("ws:acme-v2");
    expect((await SourceConnection.findById(conn))?.type).toBe("ws:acme");
    // 4. a copy of the folder as a template keeps the alias in its yaml:
    //    dropped (and retired) for the copy — acme-v2 keeps it.
    await push({
      writes: {
        "connectors/other/connector.yaml": `${YAML}aliases: [acme]\n`,
        "connectors/other/connector.ts": CONNECTOR_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    const other = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "other",
    });
    expect(other?.aliases).toEqual([]);
    expect(other?.retiredAliases).toEqual(["acme"]);
    expect((await findConnectorDefinitionRow(WS, "acme"))?.row.slug).toBe(
      "acme-v2",
    );
    // 5. the author removes the alias from other's yaml: a file edit
    //    removes what the file added (nothing to remove here, stays []).
    await push({ writes: { "connectors/other/connector.yaml": YAML } });
    await syncConnectorsFromRepo(WS);
    expect(
      (await ConnectorDefinition.findOne({ workspaceId: WS, slug: "other" }))
        ?.aliases,
    ).toEqual([]);
    // 6. acme-v2 is deleted: its slug AND its aliases are retired on every
    //    remaining row; ws:acme resolves to nothing, never to `other`.
    await push({
      deletes: [
        "connectors/acme-v2/connector.yaml",
        "connectors/acme-v2/connector.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
    expect(await findConnectorDefinitionRow(WS, "acme-v2")).toBeNull();
    // `other` never claimed either name (its copied `acme` was retired at
    // creation), so there is nothing to retire on it — and nothing to adopt.
    const otherAfter = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "other",
    });
    expect(otherAfter?.aliases).toEqual([]);
    expect(otherAfter?.retiredAliases).toEqual(["acme"]);
    expect((await SourceConnection.findById(conn))?.type).toBe("ws:acme");
    // The bound connection's definition is gone: it fails closed by id.
    const ownAfter = await SourceConnection.findById(own._id);
    expect(ownAfter?.type).toBe("ws:acme-v2");
    expect(await findConnectorDefinitionFor(WS, ownAfter!)).toBeNull();
    // Git history must not reopen a retired name either.
    expect(await resolveConnector(ctx, "acme-v2")).toBeNull();
  }, 120_000);

  it("removing an alias from connector.yaml removes it from the index; a git-detected one stays", async () => {
    await pushAcme("acme", `${YAML}aliases: [old]\n`);
    await syncConnectorsFromRepo(WS);
    expect(
      (await ConnectorDefinition.findOne({ workspaceId: WS, slug: "acme" }))
        ?.aliases,
    ).toEqual(["old"]);
    await push({ writes: { "connectors/acme/connector.yaml": YAML } });
    await syncConnectorsFromRepo(WS);
    expect(
      (await ConnectorDefinition.findOne({ workspaceId: WS, slug: "acme" }))
        ?.aliases,
    ).toEqual([]);
    expect(await findConnectorDefinitionRow(WS, "old")).toBeNull();
    // A bare git mv (no alias in the file) is remembered as DETECTED and
    // survives file edits that do not mention it.
    await push({
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
    });
    expect((await syncConnectorsFromRepo(WS)).renamed).toEqual([
      { from: "acme", to: "acme-v2" },
    ]);
    await push({
      writes: { "connectors/acme-v2/connector.yaml": `${YAML}# touched\n` },
    });
    await syncConnectorsFromRepo(WS);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme-v2",
    });
    expect(row?.detectedAliases).toEqual(["acme"]);
    expect(row?.aliases).toEqual(["acme"]);
  }, 120_000);

  it("two claimants of an alias: no adoption; a new folder at the alias migrates nothing and retires both claims", async () => {
    await push({
      writes: {
        "connectors/x/connector.yaml": `${YAML}aliases: [acme]\n`,
        "connectors/x/connector.ts": CONNECTOR_TS,
        "connectors/y/connector.yaml": `${YAML}aliases: [acme]\n`,
        "connectors/y/connector.ts": OTHER_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    // Same pass, two files claiming `acme`: the first (slug order) keeps it,
    // the copy is dropped — one owner, never two.
    const x = await ConnectorDefinition.findOne({ workspaceId: WS, slug: "x" });
    const y = await ConnectorDefinition.findOne({ workspaceId: WS, slug: "y" });
    expect([x?.aliases, y?.aliases]).toEqual([["acme"], []]);
    // Force the ambiguous state by hand (two rows holding it) and add a
    // connection typed by the alias: nothing may adopt it.
    await ConnectorDefinition.updateOne(
      { _id: y!._id },
      { $set: { aliases: ["acme"], retiredAliases: [] } },
    );
    const conn = await connection("ws:acme");
    await push({ writes: { "README.md": "# touched\n" } });
    await syncConnectorsFromRepo(WS);
    expect((await SourceConnection.findById(conn))?.type).toBe("ws:acme");
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
    // A new folder at `acme`: with several claimants the connection is left
    // unresolvable (never handed to whichever Mongo returns first).
    await push({
      writes: {
        "connectors/acme/connector.yaml": YAML,
        "connectors/acme/connector.ts": CONNECTOR_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    expect((await SourceConnection.findById(conn))?.type).toBe("ws:acme");
    const rows = await ConnectorDefinition.find({
      workspaceId: WS,
      slug: { $in: ["x", "y"] },
    });
    expect(rows.map(r => r.aliases)).toEqual([[], []]);
    expect(rows.map(r => r.retiredAliases)).toEqual([["acme"], ["acme"]]);
    // The live `acme` now answers to it — ws:acme runs the NEW connector,
    // which is what `conn` typed ws:acme is (it was created for nobody else).
    expect((await findConnectorDefinitionRow(WS, "acme"))?.via).toBe("current");
  }, 120_000);

  it("the class, closed: a copy or a restore of the renamed connector never adopts a deleted connector's bound connection", async () => {
    // A: acme → acme2 (aliases: [acme]); B pushed at acme (A retires it);
    // a connection BOUND to B; B deleted (orphaned, fail closed).
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    await renameWorkspaceConnector(ctx, { from: "acme", to: "acme2" });
    await push({
      writes: {
        "connectors/acme/connector.yaml": YAML,
        "connectors/acme/connector.ts": OTHER_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    const connB = await boundConnection("acme");
    const bId = String(
      (await ConnectorDefinition.findOne({ workspaceId: WS, slug: "acme" }))!
        ._id,
    );
    await push({
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    expect(await findConnectorDefinitionRow(WS, "acme")).toBeNull();
    const a2yaml = (
      await readBlob(repoDirFor(WS), MAIN, "connectors/acme2/connector.yaml")
    ).contents;
    expect(a2yaml).toContain("- acme");

    // Template copy: cp -r acme2 acme3 — the copied `aliases: [acme]` is
    // dropped for the copy (acme2 retired it; retired anywhere = claimed).
    await push({
      writes: {
        "connectors/acme3/connector.yaml": a2yaml,
        "connectors/acme3/connector.ts": `${CONNECTOR_TS}// tweaked copy\n`,
      },
    });
    await syncConnectorsFromRepo(WS);
    const acme3 = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme3",
    });
    expect(acme3?.aliases).toEqual([]);
    expect(acme3?.retiredAliases).toEqual(["acme"]);
    let b = (await SourceConnection.findById(connB))!;
    expect(b.type).toBe("ws:acme");
    expect(String(b.connectorDefinitionId)).toBe(bId);
    expect(await findConnectorDefinitionFor(WS, b)).toBeNull();
    await expect(
      syncConnectorRegistry.getConfigSchemaForType("ws:acme", WS, b),
    ).rejects.toThrow(/no longer exists/);

    // Delete + restore acme2 (a git revert): the restored row re-reads
    // `aliases: [acme]` from its yaml — but B's connection is bound to B's
    // id, not to a name, so nothing adopts it: it still fails closed.
    await push({
      deletes: [
        "connectors/acme2/connector.yaml",
        "connectors/acme2/connector.ts",
        "connectors/acme2/lib/util.ts",
      ],
    });
    await syncConnectorsFromRepo(WS);
    await push({
      writes: {
        "connectors/acme2/connector.yaml": a2yaml,
        "connectors/acme2/connector.ts": CONNECTOR_TS,
        "connectors/acme2/lib/util.ts": "export const x = 1;\n",
      },
    });
    await syncConnectorsFromRepo(WS);
    b = (await SourceConnection.findById(connB))!;
    expect(b.type).toBe("ws:acme");
    expect(String(b.connectorDefinitionId)).toBe(bId);
    expect(await findConnectorDefinitionFor(WS, b)).toBeNull();
    // A connection whose TYPE now names a different live definition than
    // its stamp is refused too…
    const acme2Row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme2",
    });
    const mismatched = await SourceConnection.create({
      workspaceId: new Types.ObjectId(WS),
      name: "mismatched",
      type: "ws:acme3",
      connectorDefinitionId: acme2Row!._id,
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
      createdBy: "u1",
    });
    expect(await findConnectorDefinitionFor(WS, mismatched)).toBeNull();
    // …while a type naming nothing is fine for a bound one: the stamp wins.
    const cosmetic = await SourceConnection.create({
      workspaceId: new Types.ObjectId(WS),
      name: "cosmetic",
      type: "ws:no-such-slug",
      connectorDefinitionId: acme2Row!._id,
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
      createdBy: "u1",
    });
    expect((await findConnectorDefinitionFor(WS, cosmetic))?.row.slug).toBe(
      "acme2",
    );
    // Unbound (legacy) connections resolve by current slug only, never alias.
    expect(
      (await findConnectorDefinitionFor(WS, { type: "ws:acme2" }))?.via,
    ).toBe("current");
    expect(
      await findConnectorDefinitionFor(WS, { type: "ws:acme" }),
    ).toBeNull();
  }, 120_000);

  it("an explicit fold in one push (delete x, y says aliases: [x]) re-binds x's connections to y", async () => {
    await push({
      writes: {
        "connectors/x/connector.yaml": YAML,
        "connectors/x/connector.ts": OTHER_TS,
        "connectors/y/connector.yaml": YAML,
        "connectors/y/connector.ts": CONNECTOR_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    const bound = await boundConnection("x");
    const legacy = await connection("ws:x");
    await push({
      writes: { "connectors/y/connector.yaml": `${YAML}aliases: [x]\n` },
      deletes: ["connectors/x/connector.yaml", "connectors/x/connector.ts"],
    });
    await syncConnectorsFromRepo(WS);
    const y = await ConnectorDefinition.findOne({ workspaceId: WS, slug: "y" });
    expect(y?.aliases).toEqual(["x"]);
    expect(y?.retiredAliases).toEqual([]);
    for (const id of [bound, legacy]) {
      const c = (await SourceConnection.findById(id))!;
      expect(c.type).toBe("ws:y");
      expect(String(c.connectorDefinitionId)).toBe(String(y!._id));
    }
    await push({ writes: { "README.md": "# t\n" } });
    await syncConnectorsFromRepo(WS);
    expect(
      (await ConnectorDefinition.findOne({ workspaceId: WS, slug: "y" }))
        ?.aliases,
    ).toEqual(["x"]);
    expect((await findConnectorDefinitionRow(WS, "x"))?.row.slug).toBe("y");
  }, 120_000);

  it("a connector.yaml that is not UTF-8 is refused (400) and its bytes untouched", async () => {
    const raw = Buffer.concat([
      Buffer.from("# caf"),
      Buffer.from([0xe9]),
      Buffer.from("\nruntime: node\nentry: connector.ts\n"),
    ]);
    await push({
      writes: {
        "connectors/acme/connector.yaml": raw,
        "connectors/acme/connector.ts": CONNECTOR_TS,
      },
    });
    await syncConnectorsFromRepo(WS);
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "acme2" }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("not UTF-8"),
    });
    const after = (
      await readBlobsBatch(repoDirFor(WS), MAIN, [
        "connectors/acme/connector.yaml",
      ])
    ).get("connectors/acme/connector.yaml");
    expect(after?.equals(raw)).toBe(true);
    expect(await pathsAtMain()).not.toContain(
      "connectors/acme2/connector.yaml",
    );
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

  it("renames by id and by an old slug; a verified connector stays verified", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    });
    await ConnectorDefinition.updateOne(
      { _id: row!._id },
      { $set: { status: "verified" } },
    );

    const byId = await renameWorkspaceConnector(ctx, {
      from: String(row!._id),
      to: "acme-crm",
    });
    expect(byId.before.slug).toBe("acme");
    expect(byId.after.slug).toBe("acme-crm");
    expect(byId.warnings.join("\n")).not.toMatch(/indexed/);

    // By the OLD slug: the move is from the current one.
    const byAlias = await renameWorkspaceConnector(ctx, {
      from: "ws:acme",
      to: "acme-v3",
    });
    expect(byAlias).toMatchObject({
      id: String(row!._id),
      before: { slug: "acme-crm" },
      after: { slug: "acme-v3" },
      aliasesAdded: ["acme-crm"],
    });
    const after = await ConnectorDefinition.findById(row!._id);
    expect(after!.aliases).toEqual(["acme", "acme-crm"]);
    expect(after!.status).toBe("verified");
    // The push-time pass sees unchanged content (aliases are not hashed).
    const pass = await syncConnectorsFromRepo(WS);
    expect(pass.unchanged).toBe(1);
    expect((await ConnectorDefinition.findById(row!._id))!.status).toBe(
      "verified",
    );
  }, 60_000);

  it("moves keep file modes: an executable stays executable, a symlink stays a symlink, blobs move by oid", async () => {
    await pushAcme();
    await push({
      writes: {
        "connectors/acme/run.sh": "#!/bin/sh\necho hi\n",
        "connectors/acme/link": "connector.ts",
      },
      modes: {
        "connectors/acme/run.sh": "100755",
        "connectors/acme/link": "120000",
      },
    });
    await syncConnectorsFromRepo(WS);
    const head0 = await resolveCommit(repoDirFor(WS), MAIN);
    const before = Object.fromEntries(
      (await listTree(repoDirFor(WS), head0!))
        .filter(e => e.path.startsWith("connectors/acme/"))
        .map(e => [e.path.slice("connectors/acme/".length), [e.mode, e.oid]]),
    );
    expect(before["run.sh"][0]).toBe("100755");
    expect(before.link[0]).toBe("120000");

    await renameWorkspaceConnector(ctx, { from: "acme", to: "acme-crm" });
    const head1 = await resolveCommit(repoDirFor(WS), MAIN);
    const after = Object.fromEntries(
      (await listTree(repoDirFor(WS), head1!))
        .filter(e => e.path.startsWith("connectors/acme-crm/"))
        .map(e => [
          e.path.slice("connectors/acme-crm/".length),
          [e.mode, e.oid],
        ]),
    );
    for (const rel of ["run.sh", "link", "connector.ts", "lib/util.ts"]) {
      expect(after[rel], rel).toEqual(before[rel]); // same mode, same oid
    }
    expect(after["connector.yaml"][0]).toBe("100644");
    expect(after["connector.yaml"][1]).not.toBe(before["connector.yaml"][1]);
  }, 60_000);

  it("a commit landing inside the rename window (an edit AND an added file) refuses the rename; nothing moved, nothing lost", async () => {
    await pushAcme();
    await syncConnectorsFromRepo(WS);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    });
    race.before = async () => {
      await push(
        {
          writes: {
            "connectors/acme/connector.ts":
              "export const VERSION = 2; // concurrent fix\n",
            "connectors/acme/extra.ts": "export const added = true;\n",
          },
        },
        "concurrent fix",
      );
    };
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "acme-crm" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed on main while renaming"),
    });
    const paths = await pathsAtMain();
    expect(paths.filter(p => p.startsWith("connectors/acme-crm/"))).toEqual([]);
    expect(paths).toEqual(
      expect.arrayContaining([
        "connectors/acme/connector.ts",
        "connectors/acme/extra.ts",
      ]),
    );
    expect(
      (await readBlob(repoDirFor(WS), MAIN, "connectors/acme/connector.ts"))
        .contents,
    ).toContain("VERSION = 2");
    expect((await ConnectorDefinition.findById(row!._id))?.slug).toBe("acme");
    // With the window closed, the same rename goes through.
    const ok = await renameWorkspaceConnector(ctx, {
      from: "acme",
      to: "acme-crm",
    });
    expect(ok.after.slug).toBe("acme-crm");
    expect(await pathsAtMain()).toContain("connectors/acme-crm/extra.ts");
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

  it("a connector.yaml the edit cannot keep parseable: rename refused (409), nothing committed, row untouched", async () => {
    const multi =
      "runtime: node\naliases: [\n  legacy ]\nentry: connector.ts\n";
    await pushAcme("acme", multi);
    await syncConnectorsFromRepo(WS);
    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme",
    });
    expect(row?.aliases).toEqual(["legacy"]);
    const before = await log(repoDirFor(WS), MAIN, 50);
    await expect(
      renameWorkspaceConnector(ctx, { from: "acme", to: "acme-crm" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("edit connector.yaml by hand"),
    });
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before.length);
    expect(await pathsAtMain()).toContain("connectors/acme/connector.yaml");
    expect(
      (await readBlob(repoDirFor(WS), MAIN, "connectors/acme/connector.yaml"))
        .contents,
    ).toBe(multi);
    expect((await ConnectorDefinition.findById(row!._id))?.slug).toBe("acme");
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
