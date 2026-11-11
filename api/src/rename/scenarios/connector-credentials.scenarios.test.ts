/**
 * SCENARIOS: a workspace connector's connections across every rename path.
 *
 * One invariant, checked after every step of every scenario, for EVERY
 * connection in the workspace, through the path a sync, a flow run and a
 * probe take (`getSourceConnection` → `getConnectorFor` → `testConnection`)
 * and through the connection gateway (`connectionRequest`):
 *
 *   a connection's config is decrypted for, and run by, the definition it
 *   is bound to (the code in the box is that definition's folder at its
 *   revision, and the plaintext reaches no other code), or it is closed:
 *   nothing decrypted, nothing run, a 409 that never carries a secret.
 *
 * Which definition a connection is for changes only when a person re-points
 * or re-saves it. Renames (UI, REST, MCP), laptop `git mv` (bare, edited,
 * with aliases), copies, alias edits, deletes, restores, a new folder at an
 * old slug, crashes between the commit and the index, concurrent renames
 * and the stamping migration all keep the binding or close the connection.
 *
 * Real bare repos, real Mongo (mongodb-memory-server), the real routes,
 * manager, registry, resolver and index sync. Only the sandbox is replaced,
 * by a recorder that "runs" the folder it is handed and reports which
 * connector's code that was and which config it received; and the gateway's
 * outbound request, by a recorder of the config it would have sent.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import * as yaml from "js-yaml";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// ── The sandbox recorder ────────────────────────────────────────────
type Run = {
  command: string;
  token: string;
  slug: string;
  config?: Record<string, unknown>;
};
const box = vi.hoisted(() => ({
  dirs: new Map<string, Map<string, Uint8Array>>(),
  runs: [] as Run[],
}));
vi.mock("../../connectors/workspace/sync-box", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../connectors/workspace/sync-box")
    >();
  return {
    ...actual,
    hasConnectorRuntime: async () => true,
    materializeConnector: async (input: {
      slug: string;
      sourceSha: string;
      files: Map<string, Uint8Array>;
    }) => {
      const dir = `/box/${input.slug}/${input.sourceSha}`;
      box.dirs.set(dir, input.files);
      return dir;
    },
    runConnectorCommand: async (input: {
      connectorDir: string;
      command: string;
      config?: Record<string, unknown>;
    }) => {
      const code = box.dirs.get(input.connectorDir)?.get("connector.ts");
      const token =
        /CODE:([\w-]+)/.exec(new TextDecoder().decode(code))?.[1] ?? "(none)";
      box.runs.push({
        command: input.command,
        token,
        slug: input.connectorDir.split("/")[2] ?? "",
        config: input.config,
      });
      const ok = { exitCode: 0, malformed: [], stderr: "", timedOut: false };
      if (input.command !== "spec") {
        const connectionStatus = { status: "SUCCEEDED", message: token };
        return {
          ...ok,
          messages: [{ type: "CONNECTION_STATUS", connectionStatus }],
        };
      }
      const apiKey = { type: "string", airbyte_secret: true };
      const spec = {
        connectionSpecification: {
          type: "object",
          required: ["apiKey"],
          properties: { apiKey, region: { type: "string" } },
        },
        mako: { name: `Connector ${token}`, entities: { widgets: {} } },
      };
      return { ...ok, messages: [{ type: "SPEC", spec }] };
    },
  };
});

vi.mock("../../services/database-connection.service", () => ({
  databaseConnectionService: {
    getMainConnection: async () => ({
      db: (mongoose.connection as unknown as { db: unknown }).db,
    }),
  },
}));

const auth = vi.hoisted(() => ({
  authType: "session",
  role: "member" as string | undefined,
  workspace: "",
}));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    c.set("user", { id: "u1" });
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async (ws: string) => ws === auth.workspace,
    getMember: async () => (auth.role ? { role: auth.role } : null),
    isAdmin: async () => auth.role === "admin" || auth.role === "owner",
    getOwnerIds: async () => [],
  },
}));
// The built-in connector catalog: only `stripe` exists here.
vi.mock("../../connectors/registry", () => ({
  connectorRegistry: {
    hasConnector: (type: string) => type === "stripe",
    getConnectorFor: () => null,
    ready: async () => undefined,
    getAllMetadata: () => [],
  },
}));

// The gateway. `open`: pretend a call profile exists for `ws:` types (none
// does today), so the config the gateway would send is observable.
const gateway = vi.hoisted(() => ({
  open: false,
  sent: [] as Array<{ type: string; apiKey: unknown }>,
}));
vi.mock("../../connections/callable", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connections/callable")>();
  const profile = {
    type: "ws",
    baseUrl: () => "https://api.example.test",
    baseUrlFields: [],
    credential: (config: Record<string, unknown>) => ({
      type: "bearer" as const,
      token: String(config.apiKey),
    }),
  };
  return {
    ...actual,
    callableFor: (type: string) =>
      gateway.open && type.startsWith("ws:")
        ? profile
        : actual.callableFor(type),
  };
});
vi.mock("../../connections/forward", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connections/forward")>();
  return {
    ...actual,
    send: async (connection: {
      type: string;
      config?: Record<string, unknown>;
    }) => {
      gateway.sent.push({
        type: connection.type,
        apiKey: connection.config?.apiKey,
      });
      return { status: 200, headers: {}, body: null };
    },
  };
});

// A commit landing on main inside a rename's read→commit window, fired
// once, only for the rename's own commit.
const race = vi.hoisted(() => ({
  beforeRenameCommit: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      const hook = race.beforeRenameCommit;
      if (hook && args[3].message.startsWith("Rename connector")) {
        race.beforeRenameCommit = undefined;
        await hook();
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});

import {
  ConnectorDefinition,
  SourceConnection,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { syncConnectorsFromRepo } from "../../connectors/workspace/reconcile.service";
import { parseConnectorFile } from "../../connectors/workspace/connector-file";
import {
  UNBOUND_CONNECTOR_DEFINITION_ID,
  readConnectorFolder,
} from "../../connectors/workspace/resolver";
import {
  newKeyRequest,
  submitKey,
} from "../../connectors/connection-key-request.service";
import { connectionRequest } from "../../connections/proxy.service";
import { sourceConnectionRoutes } from "../../routes/source-connections";
import { objectRoutes } from "../../routes/objects";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { encryptString } from "../../services/crypto.service";
import { renameObject, resolveObjectRef } from "../registry";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { createConnectionWriteTools } from "../../agent-lib/tools/connection-write-tools";
import { createConnectorTools } from "../../agent-lib/tools/connector-tools";
import { up as bindMigration } from "../../migrations/2026-11-11-120000_bind_workspace_connector_connections";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = "";
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const ctx = () => ({ workspaceId: WS, userId: "u1", role: "member" });

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  process.env.DATABASE_URL ??= "mongodb://unused/mako";
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connector-bindings-"));
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

/** Per connection: the definition it must run on (null = must be closed). */
let expected: Map<string, { def: string | null; secret: string }>;

async function useWorkspace(id: string, fresh = false): Promise<void> {
  WS = id;
  auth.workspace = id;
  if (fresh) {
    await initRepo(repoDirFor(id), { "README.md": "# workspace\n" });
    await bindTestWorkspaceRepo(id);
  }
}

beforeEach(async () => {
  auth.authType = "session";
  auth.role = "member";
  race.beforeRenameCommit = undefined;
  gateway.open = false;
  box.runs.length = 0;
  expected = new Map();
  await ConnectorDefinition.deleteMany({});
  await SourceConnection.deleteMany({});
  await useWorkspace(new Types.ObjectId().toString(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────

const YAML = "runtime: node\nentry: connector.ts\n";

/**
 * A connector's code. Different tokens give unrelated code (git must not
 * pair them as a rename); `edit` adds a line to the same code (still a
 * rename to git at the 75% bar).
 */
function code(token: string, edit = ""): string {
  const lines = [`// CODE:${token}`];
  for (let i = 0; i < 24; i++) {
    const digest = createHash("sha256").update(`${token}:${i}`).digest("hex");
    lines.push(`const k${i} = "${digest}";`);
  }
  if (edit) lines.push(`// ${edit}`);
  return `${lines.join("\n")}\n`;
}

function folder(slug: string, token: string, yamlText = YAML, edit = "") {
  return {
    [`connectors/${slug}/connector.yaml`]: yamlText,
    [`connectors/${slug}/connector.ts`]: code(token, edit),
  };
}

const filesOf = (slug: string) => Object.keys(folder(slug, ""));

/** `git mv connectors/<from> connectors/<to>`, with an optional yaml/edit. */
function gitMv(
  from: string,
  to: string,
  token: string,
  opts: { yaml?: string; edit?: string } = {},
) {
  return {
    writes: folder(to, token, opts.yaml, opts.edit),
    deletes: filesOf(from),
  };
}

type Mutation = Parameters<typeof commitBlobsOnBranch>[2];

async function push(mutation: Mutation): Promise<void> {
  await commitBlobsOnBranch(repoDirFor(WS), DEFAULT_BRANCH, mutation, {
    message: "laptop push",
    author: { name: "Laptop", email: "laptop@example.com" },
  });
}

/** The git endpoint's push hook, as far as connectors go. */
async function pushAndSync(mutation: Mutation) {
  await push(mutation);
  return syncConnectorsFromRepo(WS);
}

async function pathsUnder(slug: string): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  return (await listTree(repoDirFor(WS), head ?? ""))
    .map(e => e.path)
    .filter(p => p.startsWith(`connectors/${slug}/`))
    .sort();
}

async function defId(slug: string): Promise<string> {
  const row = await ConnectorDefinition.findOne({
    workspaceId: WS,
    slug,
    removedAt: null,
  });
  if (!row) throw new Error(`no live definition at ${slug}`);
  return String(row._id);
}

const def = (id: string) => ConnectorDefinition.findById(id);

function req(method: string, url: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}${url}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}
const sources = (method: string, url: string, body?: unknown) =>
  req(method, `/connections/sources${url}`, body);

let secretSeq = 0;

/** A connection made through the real create route. */
async function createConnection(
  type: string,
  expectFor: string | null,
): Promise<string> {
  const secret = `sk-live-${++secretSeq}-${Math.random().toString(36).slice(2)}`;
  const res = await sources("POST", "", {
    name: `conn ${secretSeq}`,
    type,
    config: { apiKey: secret, region: "eu" },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const id = ((await res.json()) as { data: { _id: string } }).data._id;
  await SourceConnection.updateOne({ _id: id }, { $set: { liveReads: true } });
  expected.set(id, { def: expectFor, secret });
  return id;
}

/** A connection as stored before bindings existed (the raw collection). */
async function legacyConnection(
  type: string,
  expectFor: string | null,
  doc: Record<string, unknown> = {},
): Promise<string> {
  const secret = `sk-legacy-${++secretSeq}`;
  const { insertedId } = await SourceConnection.collection.insertOne({
    workspaceId: new Types.ObjectId(WS),
    name: `legacy ${secretSeq}`,
    type,
    config: { apiKey: encryptString(secret), region: "eu" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
    createdBy: "u1",
    isActive: true,
    liveReads: true,
    ...doc,
  });
  expected.set(String(insertedId), { def: expectFor, secret });
  return String(insertedId);
}

type Outcome =
  { ran: false; error: string } | { ran: true; check: Run; apiKey: unknown };

/** The path every sync, flow run and probe takes. */
async function runCredential(id: string): Promise<Outcome> {
  const before = box.runs.length;
  const checks = () =>
    box.runs.slice(before).filter(run => run.command === "check");
  try {
    const ds = await sourceConnectionManager.getSourceConnection(id);
    if (!ds) return { ran: false, error: "not found" };
    const connector = await syncConnectorRegistry.getConnectorFor(ds);
    if (!connector) return { ran: false, error: "no connector" };
    const result = await connector.testConnection();
    expect(checks()).toHaveLength(result.success ? 1 : 0);
    return result.success
      ? { ran: true, check: checks()[0], apiKey: checks()[0].config?.apiKey }
      : { ran: false, error: result.message };
  } catch (error) {
    // Refused before anything ran: nothing decrypted reached a box.
    expect(checks()).toEqual([]);
    return { ran: false, error: String((error as Error).message) };
  }
}

/** The token of the code a definition runs now (its folder at its sha). */
async function tokenOf(row: { slug: string; sha: string }): Promise<string> {
  const files = await readConnectorFolder(WS, row.slug, row.sha);
  return (
    /CODE:([\w-]+)/.exec(
      new TextDecoder().decode(files.get("connector.ts")),
    )?.[1] ?? ""
  );
}

/** One request through the gateway, with a call profile for `ws:` types. */
async function throughGateway(id: string) {
  gateway.open = true;
  gateway.sent.length = 0;
  try {
    await connectionRequest({
      workspaceId: WS,
      connection: id,
      request: { method: "GET", path: "/widgets" },
    });
    return { sent: [...gateway.sent], error: null };
  } catch (error) {
    return {
      sent: [...gateway.sent],
      error: error as { status?: number; message: string },
    };
  } finally {
    gateway.open = false;
  }
}

/**
 * THE invariant, for every connection of the workspace: its config runs on
 * the definition it is bound to (and only there), or nothing runs.
 */
async function assertCredentials(label: string): Promise<void> {
  const runsBefore = box.runs.length;
  const rows = await SourceConnection.collection
    .find({ workspaceId: { $in: [new Types.ObjectId(WS), WS] } })
    .toArray();
  for (const row of rows) {
    const id = String(row._id);
    const at = `${label}: ${row.name} (${row.type})`;
    if (!String(row.type).startsWith("ws:")) {
      expect(row.connectorDefinitionId, at).toBeFalsy();
      continue;
    }
    const want = expected.get(id);
    if (!want) throw new Error(`${at}: untracked connection`);
    expect(row.config.apiKey, `${at} stored in plaintext`).not.toBe(
      want.secret,
    );
    const bound = want.def ? await def(want.def) : null;
    const outcome = await runCredential(id);
    const call = await throughGateway(id);
    // A row an old writer stored with a string workspace id is one the
    // gateway's own lookup never finds: 404, nothing sent.
    const found = typeof row.workspaceId !== "string";
    if (!bound || bound.removedAt) {
      // Closed: nothing ran, and the gateway says so without the secret.
      expect(outcome, `${at} must be closed`).toMatchObject({ ran: false });
      expect(outcome).not.toMatchObject({
        error: expect.stringContaining(want.secret),
      });
      expect([call.error?.status, call.sent], at).toEqual([
        found ? 409 : 404,
        [],
      ]);
      expect(call.error?.message).not.toContain(want.secret);
      continue;
    }
    expect(outcome, `${at} must run its definition`).toMatchObject({
      ran: true,
      apiKey: want.secret,
      check: { slug: bound.slug, token: await tokenOf(bound) },
    });
    expect([call.error?.status, call.sent], at).toEqual(
      found
        ? [undefined, [{ type: row.type, apiKey: want.secret }]]
        : [404, []],
    );
  }
  // And no secret reached code other than its own definition's folder.
  for (const run of box.runs.slice(runsBefore)) {
    if (run.command !== "check") continue;
    const owner = [...expected.values()].find(
      want => want.secret === run.config?.apiKey,
    );
    expect(owner?.def, `${label}: an unexpected secret ran`).toBeTruthy();
    expect(run.slug, `${label}: a secret ran in another folder`).toBe(
      (await def(owner?.def ?? ""))?.slug,
    );
  }
}

/** What `assertCredentials` expects of one connection. */
function tracked(id: string): { def: string | null; secret: string } {
  const entry = expected.get(id);
  if (!entry) throw new Error(`untracked connection ${id}`);
  return entry;
}

/** Every connection expected on `from` is expected on `to` (null = closed). */
function retarget(from: string, to: string | null): void {
  for (const want of expected.values()) if (want.def === from) want.def = to;
}

const rename = (from: string, to: string) =>
  renameObject(ctx(), "connector", { ref: from, slug: to });

const resolvedId = async (ref: string) =>
  (await resolveObjectRef(ctx(), "connector", ref))?.id;

/** Make the first `updateMany` of connections typed `type` fail, once. */
function failConnectionMoveOnce(type: string): void {
  const original = SourceConnection.updateMany.bind(SourceConnection);
  let fired = false;
  vi.spyOn(SourceConnection, "updateMany").mockImplementation(((
    filter: Record<string, unknown>,
    ...rest: unknown[]
  ) => {
    if (!fired && filter?.type === type) {
      fired = true;
      throw new Error("mongo went away");
    }
    return (original as (...a: unknown[]) => unknown)(filter, ...rest);
  }) as never);
}

// ── Scenarios ───────────────────────────────────────────────────────

describe("renames made in Mako keep every connection on its definition", () => {
  it("rename, rename back, a→b→c over MCP, and creates through old names", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    const Z = await defId("zed");
    await createConnection("ws:acme", A);
    await createConnection("ws:zed", Z);
    const legacy = await legacyConnection("ws:acme", A);
    await assertCredentials("start");

    const first = await rename("acme", "acme-crm");
    expect([first.id, first.aliasesAdded]).toEqual([A, ["acme"]]);
    await assertCredentials("after acme→acme-crm");
    // ONE commit: the folder moved, the old slug written into the file.
    expect(await pathsUnder("acme")).toEqual([]);
    const moved = await readBlob(
      repoDirFor(WS),
      MAIN,
      "connectors/acme-crm/connector.yaml",
    );
    expect(moved.contents).toBe(`${YAML}aliases:\n  - acme\n`);
    // Its connections follow, and the one saved before bindings is bound.
    const types = await SourceConnection.find({ workspaceId: WS }).lean();
    expect(types.map(c => c.type).sort()).toEqual([
      "ws:acme-crm",
      "ws:acme-crm",
      "ws:zed",
    ]);
    expect(
      String((await SourceConnection.findById(legacy))?.connectorDefinitionId),
    ).toBe(A);
    // An old name in a create is stored as the current one, bound to A.
    const viaAlias = await createConnection("ws:acme", A);
    expect((await SourceConnection.findById(viaAlias))?.type).toBe(
      "ws:acme-crm",
    );
    await assertCredentials("create through the alias");

    // Rename back: the same definition, the names swapped.
    expect((await rename("acme-crm", "acme")).id).toBe(A);
    const row = await def(A);
    expect([row?.slug, row?.aliases, row?.status]).toEqual([
      "acme",
      ["acme-crm"],
      "indexed",
    ]);
    await assertCredentials("after rename back");

    // a→b→c through the MCP tool.
    const exec = createRenameTools(WS, "u1").rename_object.execute as (
      input: Record<string, unknown>,
      opts: unknown,
    ) => Promise<{ success: boolean; id?: string }>;
    const opts = { toolCallId: "t", messages: [] };
    const m1 = await exec(
      { kind: "connector", ref: "ws:acme", slug: "b" },
      opts,
    );
    const m2 = await exec({ kind: "connector", ref: "acme", slug: "c" }, opts);
    expect([m1.success, m2.success, m1.id, m2.id]).toEqual([true, true, A, A]);
    await createConnection("ws:acme-crm", A);
    await assertCredentials("after a→b→c over MCP");
    for (const ref of ["acme", "acme-crm", "b", "ws:b", "c", A]) {
      expect([ref, await resolvedId(ref)]).toEqual([ref, A]);
    }
    expect((await def(Z))?.slug).toBe("zed");
  });

  it("no-op renames, bad slugs, taken names and viewers change nothing", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await rename("zed", "zed-v2"); // `zed` is now an old name of zed-v2
    const head = await resolveCommit(repoDirFor(WS), MAIN);

    for (const same of ["acme", "acme ", " acme", "acme\n", "ws:acme"]) {
      const noop = await rename("acme", same);
      expect(noop.warnings.join(" ")).toMatch(/Nothing to change/);
    }
    const refused: Array<[string, number]> = [
      ["", 400],
      [" ", 400],
      ["Acme", 400],
      ["../acme2", 400],
      ["acme/x", 400],
      ["acme.", 400],
      ["2026", 400],
      ["con", 400],
      ["a".repeat(65), 400],
      ["é", 400],
      ["acme\u0000", 400],
      ["ws:", 400],
      ["zed-v2", 409],
      ["ws:zed-v2", 409],
      // Another connector's old name still names that connector.
      ["zed", 409],
    ];
    for (const [slug, status] of refused) {
      const outcome = await rename("acme", slug).then(
        r => `accepted: ${r.after.slug}`,
        (e: { status?: number }) => e.status,
      );
      expect([JSON.stringify(slug), outcome]).toEqual([
        JSON.stringify(slug),
        status,
      ]);
    }
    await expect(
      renameObject(ctx(), "connector", { ref: "acme", title: "Acme" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(rename("nope", "x")).rejects.toMatchObject({ status: 404 });
    await expect(
      renameObject({ ...ctx(), role: "viewer" }, "connector", {
        ref: "acme",
        slug: "acme2",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    expect((await def(A))?.slug).toBe("acme");
    await assertCredentials("after refusals");
  });

  it("POST /objects/connector/rename: signed-in members rename, an API key is refused, old names resolve", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    const post = (slug: string) =>
      req("POST", "/objects/connector/rename", { ref: A, slug });

    auth.authType = "apiKey";
    expect((await post("acme-crm")).status).toBe(403);
    auth.authType = "session";
    auth.role = "viewer";
    expect((await post("acme-crm")).status).toBe(403);
    expect((await def(A))?.slug).toBe("acme");
    for (const role of ["member", "admin", "owner"]) {
      auth.role = role;
      const res = await post(`acme-${role}`);
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await def(A))?.slug).toBe(`acme-${role}`);
      await assertCredentials(`renamed by ${role}`);
    }
    const resolve = (ref: string) =>
      req(
        "GET",
        `/objects/resolve?${new URLSearchParams({ kind: "connector", ref })}`,
      );
    const old = await resolve("acme");
    expect(await old.json()).toMatchObject({
      resolved: { id: A, via: "alias" },
    });
    for (const ref of ["../acme", "ws:", "%2e%2e", "a".repeat(900)]) {
      expect([ref.slice(0, 9), (await resolve(ref)).status]).toEqual([
        ref.slice(0, 9),
        404,
      ]);
    }
  });

  it("slugs YAML would read as a boolean or null: the file parses, aliases are strings, connections stay bound", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    const old: string[] = [];
    let current = "acme";
    for (const to of ["true", "no", "null", "yes", "off", "y"]) {
      expect((await rename(current, to)).id).toBe(A);
      old.push(current);
      current = to;
      const text = (
        await readBlob(repoDirFor(WS), MAIN, `connectors/${to}/connector.yaml`)
      ).contents;
      expect((yaml.load(text) as { aliases: unknown[] }).aliases).toEqual(old);
      expect(parseConnectorFile(text)).toMatchObject({ ok: true });
      for (const name of old) expect(await resolvedId(name)).toBe(A);
      await assertCredentials(`renamed to ${to}`);
    }
    // A later push: nothing re-runs spec (aliases are not code), same id.
    const specs = () => box.runs.filter(run => run.command === "spec").length;
    const before = specs();
    await pushAndSync({ writes: { "README.md": "# touched\n" } });
    expect([await defId("y"), specs()]).toEqual([A, before]);
  });
});

describe("laptop pushes (the index sync)", () => {
  it("bare git mv, mv + edit, mv + rewrite (not a rename), mv + rewrite WITH aliases", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    const c1 = await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    await createConnection("ws:zed", await defId("zed"));

    // 1. A bare `git mv` (no alias written): git detects it.
    let pass = await pushAndSync(gitMv("acme", "acme2", "A"));
    expect(pass.renamed).toEqual([{ from: "acme", to: "acme2" }]);
    const row = await def(A);
    expect([row?.slug, row?.aliases, row?.detectedAliases]).toEqual([
      "acme2",
      ["acme"],
      ["acme"],
    ]);
    await assertCredentials("bare git mv");

    // 2. Move + edit in one commit (75% alike or more): same definition.
    pass = await pushAndSync(gitMv("acme2", "acme3", "A", { edit: "tweak" }));
    expect(pass.renamed).toEqual([{ from: "acme2", to: "acme3" }]);
    expect(await defId("acme3")).toBe(A);
    await assertCredentials("git mv + edit");

    // 3. Move + full rewrite, no alias: a delete and a create. A's
    //    connections are closed, never given to the new code.
    pass = await pushAndSync(gitMv("acme3", "acme4", "N"));
    expect([pass.renamed, pass.removed, pass.created]).toEqual([[], 1, 1]);
    const N = await defId("acme4");
    expect(N).not.toBe(A);
    await assertCredentials("git mv + rewrite"); // A is a tombstone: closed
    const late = { name: "late", type: "ws:acme", config: { apiKey: "x" } };
    expect((await sources("POST", "", late)).status).toBe(400);
    // A person re-points c1 at the new folder: the one explicit act.
    const repoint = await sources("PUT", `/${c1}`, { type: "ws:acme4" });
    expect(repoint.status, await repoint.clone().text()).toBe(200);
    tracked(c1).def = N;
    await assertCredentials("re-pointed");

    // 4. Move + full rewrite WITH `aliases: [acme4]`: the author's
    //    statement makes it a rename.
    pass = await pushAndSync(
      gitMv("acme4", "acme5", "N2", { yaml: `${YAML}aliases: [acme4]\n` }),
    );
    expect(pass.renamed).toEqual([{ from: "acme4", to: "acme5" }]);
    const moved = await def(N);
    expect([moved?.slug, moved?.detectedAliases]).toEqual(["acme5", []]);
    await assertCredentials("rewrite with alias");
  });

  it("a copied folder is a new connector: no alias and no connection, before or after the original is deleted", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await rename("acme", "acme-crm");
    // cp -r connectors/acme-crm connectors/acme-copy (yaml lists acme)
    await pushAndSync({
      writes: folder("acme-copy", "A", `${YAML}aliases:\n  - acme\n`),
    });
    const C = await defId("acme-copy");
    const copy = await def(C);
    expect([copy?.aliases, copy?.retiredAliases]).toEqual([[], ["acme"]]);
    expect(await resolvedId("acme")).toBe(A);
    await createConnection("ws:acme-copy", C);
    await createConnection("ws:acme", A);
    await assertCredentials("after the copy");

    // The original is deleted: its connections are closed, and the copy
    // (identical code) does not get them, nor the old name.
    await pushAndSync({ deletes: filesOf("acme-crm") });
    await assertCredentials("original deleted");
    await pushAndSync({ writes: { "README.md": "# later\n" } });
    expect((await def(C))?.aliases).toEqual([]);
    expect(await resolvedId("acme")).toBeUndefined();
  });

  it("aliases added to or removed from connector.yaml never move a connection", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("other", "O") },
    });
    const A = await defId("acme");
    const O = await defId("other");
    await createConnection("ws:acme", A);
    await createConnection("ws:other", O);
    // Saved long ago for a connector called `ghost`, never bound.
    await legacyConnection("ws:ghost", null);

    // other's yaml claims `acme` (live) and `ghost` (nobody's).
    const claim = `${YAML}aliases: [acme, ghost]\n`;
    await pushAndSync({ writes: { "connectors/other/connector.yaml": claim } });
    const o = await def(O);
    expect([o?.aliases, o?.retiredAliases]).toEqual([["ghost"], ["acme"]]);
    await createConnection("ws:acme", A);
    await createConnection("ws:ghost", O); // a NEW write through the alias
    // The old ws:ghost connection was saved for nothing `other` can prove
    // to be: an alias is not a binding, it stays closed.
    await assertCredentials("aliases added");

    await pushAndSync({ writes: { "connectors/other/connector.yaml": YAML } });
    expect((await def(O))?.aliases).toEqual([]);
    await assertCredentials("aliases removed");
  });

  it("an old name two folders claim at once is given to neither", async () => {
    await pushAndSync({
      writes: { ...folder("p", "P"), ...folder("w", "W") },
    });
    const P = await defId("p");
    await createConnection("ws:p", P);
    await legacyConnection("ws:p", P);
    // One push deletes p while a new folder AND an existing one list it.
    const heir = `${YAML}aliases: [p]\n`;
    const pass = await pushAndSync({
      writes: {
        ...folder("q", "P", heir),
        "connectors/w/connector.yaml": heir,
      },
      deletes: filesOf("p"),
    });
    expect([pass.renamed, pass.removed]).toEqual([[], 1]);
    for (const slug of ["q", "w"]) {
      const row = await def(await defId(slug));
      expect([slug, row?.aliases, row?.retiredAliases]).toEqual([
        slug,
        [],
        ["p"],
      ]);
    }
    expect(await resolvedId("p")).toBeUndefined();
    await assertCredentials("two claimants"); // p is a tombstone: closed
    // The claim does not come back from the files on a later push.
    await pushAndSync({ writes: { "README.md": "# later\n" } });
    expect(await resolvedId("p")).toBeUndefined();
    await assertCredentials("later push");
  });

  it("a NEW folder at an old slug: the renamed connector keeps its connections and the newcomer gets none", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await rename("acme", "acme-crm");
    // A's own connection whose type still says ws:acme, and one saved
    // before bindings existed, typed by the old name.
    const stale = await createConnection("ws:acme-crm", A);
    await SourceConnection.updateOne({ _id: stale }, { type: "ws:acme" });
    const legacy = await legacyConnection("ws:acme", null);
    await assertCredentials("before the newcomer");

    await pushAndSync({ writes: folder("acme", "NEW") });
    const N = await defId("acme");
    expect(N).not.toBe(A);
    const a = await def(A);
    expect([a?.aliases, a?.retiredAliases]).toEqual([[], ["acme"]]);
    expect((await SourceConnection.findById(stale))?.type).toBe("ws:acme-crm");
    // The pre-binding connection is locked, not handed to the new code.
    expect(
      String((await SourceConnection.findById(legacy))?.connectorDefinitionId),
    ).toBe(UNBOUND_CONNECTOR_DEFINITION_ID);
    await createConnection("ws:acme", N);
    await assertCredentials("after the newcomer");
    // The form says why, and saving it with its type re-binds on purpose.
    const shown = (await (await sources("GET", `/${legacy}`)).json()) as {
      data: { connectorBinding?: { problem: string; message: string } };
    };
    expect(shown.data.connectorBinding).toMatchObject({
      problem: "definition-gone",
      message: expect.stringMatching(/a different connector has since taken/),
    });
    const rebind = await sources("PUT", `/${legacy}`, { type: "ws:acme" });
    expect(rebind.status).toBe(200);
    tracked(legacy).def = N;
    await assertCredentials("re-bound by a person");
    // Deleting the newcomer does not hand `acme` back to the first one.
    await pushAndSync({ deletes: filesOf("acme") });
    expect(await resolvedId("acme")).toBeUndefined();
    await assertCredentials("newcomer deleted");
  });

  it("same push: git mv acme acme2 AND a new acme: the definition stays with the folder that kept the path", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await pushAndSync({
      writes: { ...folder("acme2", "A"), ...folder("acme", "NEW") },
    });
    expect(await defId("acme")).toBe(A);
    const A2 = await defId("acme2");
    expect((await def(A2))?.aliases).toEqual([]);
    await createConnection("ws:acme2", A2);
    await assertCredentials("move + new folder in one push");
  });

  it("two workspaces with the same slugs never touch each other; a binding to another workspace's definition is closed", async () => {
    const ws1 = WS;
    const ws2 = new Types.ObjectId().toString();
    await useWorkspace(ws2, true);
    await pushAndSync({ writes: folder("acme", "W2") });
    const A2 = await defId("acme");
    await createConnection("ws:acme", A2);
    await useWorkspace(ws1);
    await pushAndSync({ writes: folder("acme", "W1") });
    const A1 = await defId("acme");
    await createConnection("ws:acme", A1);
    await legacyConnection("ws:acme", null, {
      connectorDefinitionId: new Types.ObjectId(A2),
    });
    await assertCredentials("ws1 start");

    await rename("acme", "acme-one");
    expect([await resolvedId(A2), await resolvedId("acme")]).toEqual([
      undefined,
      A1,
    ]);
    await assertCredentials("ws1 after rename");
    await useWorkspace(ws2);
    const other = await def(A2);
    expect([other?.slug, other?.aliases]).toEqual(["acme", []]);
    await assertCredentials("ws2 untouched");
  });
});

describe("a deleted folder: closed, and the same definition when it comes back", () => {
  const closedEverywhere = async (id: string) => {
    const { secret } = tracked(id);
    const before = await SourceConnection.findById(id).lean();
    for (const [method, url, body] of [
      ["PUT", `/${id}`, { config: { apiKey: "new", region: "us" } }],
      ["POST", `/${id}/test`, undefined],
      ["GET", `/${id}/entities`, undefined],
      ["POST", `/${id}/probe`, { entity: "widgets" }],
      ["POST", `/${id}/reveal-secret`, { field: "apiKey" }],
    ] as const) {
      const res = await sources(method, url, body);
      const text = await res.text();
      expect([url, res.status]).toEqual([url, 409]);
      expect(JSON.parse(text)).toMatchObject({
        code: "connector_binding",
        error: expect.stringMatching(/re-bind/),
      });
      expect(text).not.toContain(secret);
    }
    // MCP: no config change, no field list, nothing of the secret.
    const update = (await (
      createConnectionWriteTools(WS, "u1").update_connection.execute as (
        input: unknown,
        opts: unknown,
      ) => Promise<{ error?: string }>
    )({ connectionId: id, config: { region: "us" } }, {})) as {
      error?: string;
    };
    expect(update.error).toMatch(/re-bind/);
    const inspected = JSON.stringify(
      await (
        createConnectorTools(WS).inspect_connection.execute as (
          input: unknown,
          opts: unknown,
        ) => Promise<unknown>
      )({ connectionId: id }, {}),
    );
    expect(inspected).toContain('"configFields":[]');
    expect(inspected).not.toContain(secret);
    // The gateway as it ships (no call profile for ws: types): 409 too.
    await expect(
      connectionRequest({
        workspaceId: WS,
        connection: id,
        request: { method: "GET", path: "/" },
      }),
    ).rejects.toMatchObject({ name: "ConnectionRequestError", status: 409 });
    expect((await SourceConnection.findById(id).lean())?.config).toEqual(
      before?.config,
    );
  };

  it("delete → every path answers 409 without a secret; restore at the SAME slug → the same id, and bound and pre-binding connections run again", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    const c1 = await createConnection("ws:acme", A);
    const legacy = await legacyConnection("ws:acme", A);
    // A connection still waiting for its key through a key link.
    const link = newKeyRequest({ fields: ["apiKey"], requestedBy: "u1" });
    const pending = await SourceConnection.create({
      workspaceId: WS,
      name: "pending",
      type: "ws:acme",
      connectorDefinitionId: A,
      config: { region: "eu" },
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
      createdBy: "u1",
      isActive: false,
      keyRequest: link.keyRequest,
    });
    expected.set(String(pending._id), { def: null, secret: "sk-pasted" });

    const gone = await pushAndSync({ deletes: filesOf("acme") });
    expect(gone.removed).toBe(1);
    expect((await def(A))?.removedAt).toBeInstanceOf(Date);
    await assertCredentials("deleted"); // A is a tombstone: all closed
    await closedEverywhere(c1);
    // A pasted key is not stored for a connector that is gone.
    await expect(
      submitKey({
        workspaceId: WS,
        token: link.token,
        userId: "u1",
        values: { apiKey: "sk-pasted" },
        confirmedDestination: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await SourceConnection.findById(pending._id))?.config).toEqual({
      region: "eu",
    });
    // A save that does not name the type re-binds nothing.
    expect((await sources("PUT", `/${legacy}`, { name: "x" })).status).toBe(
      200,
    );
    await assertCredentials("name-only save");

    // git revert: the folder is back at the same slug.
    const back = await pushAndSync({ writes: folder("acme", "A") });
    expect([back.revived, back.created]).toEqual([1, 0]);
    expect(await defId("acme")).toBe(A);
    await SourceConnection.deleteOne({ _id: pending._id });
    expected.delete(String(pending._id));
    await assertCredentials("restored: same definition, nothing re-saved");
    // Restored with other code is still that connector, edited in place.
    await pushAndSync({ deletes: filesOf("acme") });
    await pushAndSync({ writes: folder("acme", "A-v2") });
    expect(await defId("acme")).toBe(A);
    await assertCredentials("restored with new code");
  });

  it("delete, another connector renamed INTO the slug, the original restored elsewhere: its connections stay closed", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("other", "O") },
    });
    const A = await defId("acme");
    const O = await defId("other");
    const bound = await createConnection("ws:acme", A);
    const legacy = await legacyConnection("ws:acme", A);
    await createConnection("ws:other", O);
    await pushAndSync({ deletes: filesOf("acme") });
    await assertCredentials("acme deleted");

    // In Mako the rename is refused while connections still belong there.
    await expect(rename("other", "acme")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/2 connections still belong/),
    });
    expect((await def(O))?.slug).toBe("other");
    // A push cannot be refused: `git mv connectors/other connectors/acme`.
    const pass = await pushAndSync(gitMv("other", "acme", "O"));
    expect([pass.renamed, pass.revived]).toEqual([
      [{ from: "other", to: "acme" }],
      0,
    ]);
    expect(await defId("acme")).toBe(O);
    expect(await def(A)).toBeNull(); // the tombstone gave the slug up
    retarget(A, null);
    await assertCredentials("other took the slug");
    expect(
      String((await SourceConnection.findById(legacy))?.connectorDefinitionId),
    ).toBe(UNBOUND_CONNECTOR_DEFINITION_ID);

    // The original comes back under another name: a new definition.
    await pushAndSync({ writes: folder("acme-old", "A") });
    expect(await defId("acme-old")).not.toBe(A);
    await assertCredentials("original restored elsewhere");
    // Re-pointing is the explicit act that reopens one.
    const repoint = await sources("PUT", `/${bound}`, { type: "ws:acme-old" });
    expect(repoint.status).toBe(200);
    tracked(bound).def = await defId("acme-old");
    await assertCredentials("re-pointed by a person");
  });

  it("restore AFTER the slug was taken and freed again: a new definition, the old connections stay closed", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("other", "O") },
    });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    await pushAndSync({ deletes: filesOf("acme") });
    await pushAndSync(gitMv("other", "acme", "O")); // taken
    await pushAndSync(gitMv("acme", "other", "O")); // and freed again
    retarget(A, null);
    await assertCredentials("slug taken, then freed");

    const back = await pushAndSync({ writes: folder("acme", "A") });
    expect([back.revived, back.created]).toEqual([0, 1]);
    expect(await defId("acme")).not.toBe(A);
    await assertCredentials("restored after the slug was taken");
  });

  it("a rename in Mako into a removed connector's slug with no connections left drops the tombstone", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("other", "O") },
    });
    const A = await defId("acme");
    const O = await defId("other");
    await createConnection("ws:other", O);
    await pushAndSync({ deletes: filesOf("acme") });
    expect((await rename("other", "acme")).id).toBe(O);
    expect([await defId("acme"), await def(A)]).toEqual([O, null]);
    await assertCredentials("renamed into a free tombstone");
  });
});

describe("re-pointing and re-binding are a person's acts", () => {
  it("PUT type: to a live connector moves the binding; through an alias it is stored canonical; to nothing it is a 400", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    const Z = await defId("zed");
    const c = await createConnection("ws:acme", A);
    await rename("zed", "zed-v2");

    const moved = await sources("PUT", `/${c}`, { type: "ws:zed" });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const row = await SourceConnection.findById(c).lean();
    expect([row?.type, String(row?.connectorDefinitionId)]).toEqual([
      "ws:zed-v2",
      Z,
    ]);
    tracked(c).def = Z;
    await assertCredentials("re-pointed through an alias");

    // A name nothing answers to (workspace or built-in): refused, like a
    // create. An unbound connection must not wait there for a later folder.
    for (const type of ["ws:future", "no-such-builtin", "../connectors/x"]) {
      const bad = await sources("PUT", `/${c}`, { type });
      expect([type, bad.status]).toEqual([type, 400]);
    }
    expect((await SourceConnection.findById(c).lean())?.type).toBe("ws:zed-v2");
    await pushAndSync({ writes: folder("future", "F") });
    await assertCredentials("a folder later takes that name");

    // A built-in connector is an explicit re-point that unbinds it.
    expect((await sources("PUT", `/${c}`, { type: "stripe" })).status).toBe(
      200,
    );
    const builtin = await SourceConnection.findById(c).lean();
    expect([builtin?.type, builtin?.connectorDefinitionId]).toEqual([
      "stripe",
      undefined,
    ]);
    expected.delete(c);
    await assertCredentials("re-pointed at a built-in");
  });

  it("naming the connection's own type re-binds only a connection with no live binding, and only in the app", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("other", "O") },
    });
    const A = await defId("acme");
    const O = await defId("other");
    const live = await createConnection("ws:acme", A);
    const lost = await createConnection("ws:other", O);
    const stamp = async (id: string) =>
      String((await SourceConnection.findById(id))?.connectorDefinitionId);

    // Saved before bindings existed and still resolving by its slug:
    // naming its type binds it to what it already runs on, from any client.
    const legacy = await legacyConnection("ws:acme", A);
    auth.authType = "apiKey";
    const bind = await sources("PUT", `/${legacy}`, { type: "ws:acme" });
    expect([bind.status, await stamp(legacy)]).toEqual([200, A]);
    auth.authType = "session";

    // Bound to a live definition: naming the same type moves nothing, even
    // when that type has come to name another connector.
    await SourceConnection.updateOne({ _id: live }, { type: "ws:other" });
    const shown = (await (await sources("GET", `/${live}`)).json()) as {
      data: { connectorBinding?: { problem: string } };
    };
    expect(shown.data.connectorBinding?.problem).toBe("name-moved");
    tracked(live).def = null;
    await assertCredentials("type names another connector");
    expect(
      (await sources("PUT", `/${live}`, { type: "ws:other" })).status,
    ).toBe(200);
    expect(await stamp(live)).toBe(A);
    await SourceConnection.updateOne({ _id: live }, { type: "ws:acme" });
    tracked(live).def = A;

    // Its definition is gone for good: `other` deleted, its slug taken.
    await pushAndSync({ deletes: filesOf("other") });
    await pushAndSync(gitMv("acme", "other", "A"));
    tracked(lost).def = null;
    await assertCredentials("definition gone");
    auth.authType = "apiKey";
    const viaKey = await sources("PUT", `/${lost}`, { type: "ws:other" });
    expect(viaKey.status).toBe(403);
    expect(await stamp(lost)).toBe(O);
    auth.authType = "session";
    // Re-bind and a config edit in ONE save: the type is applied first.
    const secret = "sk-re-entered";
    const save = await sources("PUT", `/${lost}`, {
      type: "ws:other",
      config: { apiKey: secret },
    });
    expect(save.status, await save.clone().text()).toBe(200);
    expect(await stamp(lost)).toBe(A);
    expected.set(lost, { def: A, secret });
    await assertCredentials("re-bound on purpose");
  });
});

describe("partial failure and concurrency", () => {
  const start = async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    return A;
  };
  const nextPush = () =>
    pushAndSync({ writes: { "README.md": `# ${Math.random()}\n` } });

  it("rename in Mako: the commit lands and moving the connections fails; the next index sync completes it", async () => {
    const A = await start();
    failConnectionMoveOnce("ws:acme");
    await expect(rename("acme", "acme-crm")).rejects.toThrow(/mongo went away/);
    vi.mocked(SourceConnection.updateMany).mockRestore();
    expect(await pathsUnder("acme-crm")).toHaveLength(2);
    expect((await def(A))?.slug).toBe("acme"); // the definition was not written
    await assertCredentials("after the crash");
    const pass = await nextPush();
    expect(pass.renamed).toEqual([{ from: "acme", to: "acme-crm" }]);
    expect((await def(A))?.slug).toBe("acme-crm");
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      1,
    );
    const types = await SourceConnection.distinct("type", { workspaceId: WS });
    expect(types).toEqual(["ws:acme-crm"]);
    await assertCredentials("converged");
  });

  it("rename in Mako: the connections moved and writing the definition fails; the next index sync completes it", async () => {
    const A = await start();
    vi.spyOn(ConnectorDefinition.prototype, "save").mockRejectedValueOnce(
      new Error("mongo went away"),
    );
    await expect(rename("acme", "acme-crm")).rejects.toThrow(/mongo went away/);
    vi.mocked(ConnectorDefinition.prototype.save).mockRestore();
    // Connections first, the definition last: they are bound by id to a
    // definition that still says `acme`, and keep running it.
    expect((await def(A))?.slug).toBe("acme");
    await assertCredentials("after the crash");
    await nextPush();
    expect((await def(A))?.slug).toBe("acme-crm");
    await assertCredentials("converged");
  });

  it("laptop push: the index sync stops between the connections and the definition; the next one completes it", async () => {
    const A = await start();
    await push(gitMv("acme", "acme2", "A"));
    failConnectionMoveOnce("ws:acme");
    await expect(syncConnectorsFromRepo(WS)).rejects.toThrow(/mongo went away/);
    vi.mocked(SourceConnection.updateMany).mockRestore();
    await assertCredentials("after the crash");
    await nextPush();
    expect((await def(A))?.slug).toBe("acme2");
    await assertCredentials("converged");
  });

  it("the commit itself fails: nothing moves", async () => {
    const A = await start();
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    race.beforeRenameCommit = async () => {
      throw new Error("disk full");
    };
    await expect(rename("acme", "acme-crm")).rejects.toThrow(/disk full/);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    expect((await def(A))?.slug).toBe("acme");
    const types = await SourceConnection.distinct("type", { workspaceId: WS });
    expect(types).toEqual(["ws:acme"]);
    await assertCredentials("commit failed");
  });

  it("two renames of one connector at once: exactly one lands, git and the index agree", async () => {
    const A = await start();
    const outcomes = await Promise.allSettled([
      rename("acme", "left"),
      rename("acme", "right"),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const lost = outcomes.find(o => o.status === "rejected");
    expect((lost as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
    });
    await syncConnectorsFromRepo(WS);
    const slug = (await def(A))?.slug ?? "";
    expect(await pathsUnder(slug)).toHaveLength(2);
    expect(await pathsUnder(slug === "left" ? "right" : "left")).toEqual([]);
    expect(await pathsUnder("acme")).toEqual([]);
    await assertCredentials("after the race");
  });

  it("a rename racing a push that deletes the folder or edits its code: refused (409), the push wins, nothing is half-moved", async () => {
    const A = await start();
    race.beforeRenameCommit = () =>
      pushAndSync({
        writes: { "connectors/acme/connector.ts": code("A", "hotfix") },
      }).then(() => undefined);
    await expect(rename("acme", "acme-crm")).rejects.toMatchObject({
      status: 409,
    });
    expect(await pathsUnder("acme-crm")).toEqual([]);
    expect((await def(A))?.slug).toBe("acme");
    await assertCredentials("the edit won");

    race.beforeRenameCommit = () =>
      pushAndSync({ deletes: filesOf("acme") }).then(() => undefined);
    await expect(rename("acme", "acme-crm")).rejects.toMatchObject({
      status: 409,
    });
    expect(await pathsUnder("acme-crm")).toEqual([]);
    expect((await def(A))?.removedAt).toBeInstanceOf(Date);
    await assertCredentials("the delete won"); // closed
  });

  it("a rename, index syncs and connection creates interleaved: every connection lands on the one definition", async () => {
    const A = await start();
    await Promise.all([
      rename("acme", "acme-crm"),
      syncConnectorsFromRepo(WS),
      createConnection("ws:acme", A),
      createConnection("ws:acme", A),
    ]);
    await Promise.all([
      syncConnectorsFromRepo(WS),
      createConnection("ws:acme", A),
      createConnection("ws:acme-crm", A),
    ]);
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      1,
    );
    await assertCredentials("interleaved");
    // Its own connection whose type still says the old name does not block
    // renaming back to that name.
    const own = await createConnection("ws:acme-crm", A);
    await SourceConnection.updateOne({ _id: own }, { type: "ws:acme" });
    await rename("acme-crm", "acme");
    expect((await def(A))?.slug).toBe("acme");
    await assertCredentials("renamed back");
  });
});

describe("the binding migration on realistic data", () => {
  it("binds by current slug only, across workspaces and id forms, twice, and every connection then runs or is closed", async () => {
    const ws1 = WS;
    const ws2 = new Types.ObjectId().toString();
    await useWorkspace(ws2, true);
    await pushAndSync({ writes: folder("acme", "W2") });
    const A2 = await defId("acme");
    await legacyConnection("ws:acme", A2);
    await useWorkspace(ws1);
    await pushAndSync({
      writes: {
        ...folder("acme", "A"),
        ...folder("beta", "B"),
        ...folder("dead", "D"),
      },
    });
    await rename("beta", "beta-v2"); // `beta` is now only an old name
    await pushAndSync({ deletes: filesOf("dead") }); // a tombstone
    const A = await defId("acme");
    const current = await legacyConnection("ws:acme", A);
    const viaAlias = await legacyConnection("ws:beta", null);
    const removed = await legacyConnection("ws:dead", null);
    const nothing = await legacyConnection("ws:gone", null);
    const bound = await legacyConnection("ws:acme", A, {
      connectorDefinitionId: new Types.ObjectId(A),
    });
    const foreign = await legacyConnection("ws:acme", null, {
      connectorDefinitionId: new Types.ObjectId(A2),
    });
    // workspaceId stored as a STRING by an old writer.
    const stringWs = await legacyConnection("ws:acme", A, { workspaceId: ws1 });
    const orphan = await legacyConnection("ws:nobody", null, {
      workspaceId: ws1,
    });
    await legacyConnection("stripe", null, { config: {} });

    const db = mongoose.connection.db as NonNullable<
      typeof mongoose.connection.db
    >;
    await bindMigration(db);
    await bindMigration(db);

    const stamp = async (id: string) => {
      const row = await SourceConnection.collection.findOne({
        _id: new Types.ObjectId(id),
      });
      return row?.connectorDefinitionId
        ? String(row.connectorDefinitionId)
        : null;
    };
    expect(
      await Promise.all(
        [
          current,
          viaAlias,
          removed,
          nothing,
          bound,
          foreign,
          stringWs,
          orphan,
        ].map(stamp),
      ),
    ).toEqual([A, null, null, null, A, A2, A, null]);
    await assertCredentials("ws1 after the migration");

    // Life after it: a rename, and newcomers at the names the unbound
    // connections carry.
    await rename("acme", "acme-x");
    await pushAndSync({
      writes: {
        ...folder("beta", "NEWBETA"),
        ...folder("gone", "NEWGONE"),
        ...folder("nobody", "NOBODY"),
      },
    });
    expect([
      await stamp(viaAlias),
      await stamp(nothing),
      await stamp(orphan),
    ]).toEqual(Array(3).fill(UNBOUND_CONNECTOR_DEFINITION_ID));
    await assertCredentials("ws1 after a rename and newcomers");
    expect(await runCredential(stringWs)).toMatchObject({
      ran: true,
      check: { slug: "acme-x" },
    });
    await useWorkspace(ws2);
    await assertCredentials("ws2 after the migration");
  });
});
