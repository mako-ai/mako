/**
 * SCENARIOS — a workspace connector's CREDENTIALS across every rename path.
 *
 * The one invariant, checked after every step of every scenario through the
 * path a sync, a flow run, CDC and a probe actually take
 * (`getSourceConnection` → `getConnectorFor` → `testConnection`), for EVERY
 * connection in the workspace:
 *
 *   a connection's secret is decrypted for, and run by, the definition id
 *   it is bound to — the code materialized in the box is that row's folder
 *   at that row's revision, and the plaintext reaches no other code — or it
 *   fails closed (nothing decrypted, nothing run).
 *
 * Which definition a connection is "for" changes only by an explicit act: a
 * person re-pointing or re-binding it (PUT), or an author's same-push fold
 * (`aliases: [x]` while deleting x). Everything else — UI/REST/MCP renames,
 * laptop `git mv` (bare, with an edit, with aliases), copies, alias edits,
 * deletes, restores, renames back, two claimants, a NEW folder at an old
 * slug, crashes between the git commit and the index update, concurrent
 * renames, the stamping migration — must keep the binding or fail closed.
 *
 * Real bare repos, real Mongo (mongodb-memory-server), the real source
 * connection routes, the real manager/registry/resolver/reconcile; only
 * the sandbox is replaced by a recorder that "runs" whatever folder it is
 * handed and reports which connector's code that was and which config it
 * received.
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
import yaml from "js-yaml";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// ── The sandbox recorder ────────────────────────────────────────────
const box = vi.hoisted(() => ({
  dirs: new Map<string, Map<string, Uint8Array>>(),
  runs: [] as Array<{
    command: string;
    dir: string;
    token: string;
    slug: string;
    config: Record<string, unknown> | undefined;
  }>,
}));

vi.mock("../../connectors/workspace/sync-box", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../connectors/workspace/sync-box")
    >();
  const tokenOf = (files: Map<string, Uint8Array> | undefined): string => {
    const code = files?.get("connector.ts");
    if (!code) return "(none)";
    const m = /CODE:([\w-]+)/.exec(new TextDecoder().decode(code));
    return m ? m[1] : "(unmarked)";
  };
  return {
    ...actual,
    hasConnectorRuntime: vi.fn(async () => true),
    materializeConnector: vi.fn(
      async (input: {
        slug: string;
        sourceSha: string;
        files: Map<string, Uint8Array>;
      }) => {
        const dir = `/box/${input.slug}/${input.sourceSha}`;
        box.dirs.set(dir, input.files);
        return dir;
      },
    ),
    runConnectorCommand: vi.fn(
      async (input: {
        connectorDir: string;
        command: string;
        config?: Record<string, unknown>;
      }) => {
        const files = box.dirs.get(input.connectorDir);
        const token = tokenOf(files);
        box.runs.push({
          command: input.command,
          dir: input.connectorDir,
          token,
          slug: input.connectorDir.split("/")[2] ?? "",
          config: input.config,
        });
        const ok = { exitCode: 0, malformed: [], stderr: "", timedOut: false };
        if (input.command === "spec") {
          // `plain-*` connectors declare apiKey as NOT secret: decrypting a
          // credential by the wrong connector's schema shows up as
          // ciphertext (or plaintext) reaching the wrong code.
          const secret = !token.startsWith("plain");
          return {
            ...ok,
            messages: [
              {
                type: "SPEC",
                spec: {
                  connectionSpecification: {
                    type: "object",
                    required: ["apiKey"],
                    properties: {
                      apiKey: {
                        type: "string",
                        ...(secret ? { airbyte_secret: true } : {}),
                      },
                      region: { type: "string" },
                    },
                  },
                  mako: {
                    name: `Connector ${token}`,
                    version: "1.0.0",
                    entities: { widgets: {} },
                  },
                },
              },
            ],
          };
        }
        return {
          ...ok,
          messages: [
            {
              type: "CONNECTION_STATUS",
              connectionStatus: { status: "SUCCEEDED", message: token },
            },
          ],
        };
      },
    ),
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
  authType: "session" as string,
  user: { id: "u1" } as { id: string } | undefined,
  role: "member" as string | undefined,
}));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    if (auth.user) c.set("user", auth.user);
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async (ws: string) => ws === WS_ID.value),
    getMember: vi.fn(async () => (auth.role ? { role: auth.role } : null)),
    isAdmin: vi.fn(async () => auth.role === "admin" || auth.role === "owner"),
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
const WS_ID = vi.hoisted(() => ({ value: "" }));

// A commit landing on main inside a rename's read→commit window (a laptop
// push, another rename), fired once, only for the rename's own commit.
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
      if (hook && /^Rename connector/.test(args[3]?.message ?? "")) {
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
  repoExists,
  resolveCommit,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { syncConnectorsFromRepo } from "../../connectors/workspace/reconcile.service";
import { parseConnectorFile } from "../../connectors/workspace/connector-file";
import { sourceConnectionRoutes } from "../../routes/source-connections";
import { objectRoutes } from "../../routes/objects";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { encryptString } from "../../services/crypto.service";
import { renameObject, resolveObjectRef } from "../registry";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { up as stampMigration } from "../../migrations/2026-10-06-150000_stamp_workspace_connector_definitions";
import { missingInputConditionalGrant } from "../../agent-lib/capabilities/runtime";
import { capabilityGrantsFromScopes } from "../../auth/api-key-scopes";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const ctx = () => ({ workspaceId: WS, userId: "u1", role: "member" });

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.DATABASE_URL ??= "mongodb://unused/mako";
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conn-cred-scenarios-"));
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

/** Expected binding per connection: the definition id, or null = must fail closed. */
let expected: Map<string, { defId: string | null; secret: string }>;

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  WS_ID.value = WS;
  auth.authType = "session";
  auth.user = { id: "u1" };
  auth.role = "member";
  race.beforeRenameCommit = undefined;
  box.runs.length = 0;
  expected = new Map();
  await ConnectorDefinition.deleteMany({});
  await SourceConnection.deleteMany({});
  await initRepo(repoDirFor(WS), { "README.md": "# workspace\n" });
  await bindTestWorkspaceRepo(WS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────

const YAML = "runtime: node\nentry: connector.ts\n";

/**
 * A connector's code. Unrelated tokens produce unrelated code (git must not
 * pair them as a rename); `edit` adds a line to the same code (still a
 * rename to git at the 75% bar).
 */
function code(token: string, edit = ""): string {
  const lines = [
    `// CODE:${token}`,
    'import { defineConnector } from "@makoai/connector-sdk";',
  ];
  for (let i = 0; i < 24; i++) {
    lines.push(
      `const k${i} = "${createHash("sha256").update(`${token}:${i}`).digest("hex")}";`,
    );
  }
  lines.push(
    `export default defineConnector({ name: "${token}", version: "1.0.0", config: { required: ["apiKey"], properties: { apiKey: { type: "string" } } }, entities: {} });`,
  );
  if (edit) lines.push(`// ${edit}`);
  return `${lines.join("\n")}\n`;
}

async function push(
  mutation: Parameters<typeof commitBlobsOnBranch>[2],
  message = "laptop push",
): Promise<string> {
  const repoDir = repoDirFor(WS);
  if (!(await repoExists(repoDir))) await initRepo(repoDir, {});
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author: { name: "Laptop", email: "laptop@example.com" },
  });
  return result.commitOid;
}

/** The git endpoint's push hook, as far as connectors go. */
async function pushAndSync(
  mutation: Parameters<typeof commitBlobsOnBranch>[2],
  message?: string,
) {
  await push(mutation, message);
  return syncConnectorsFromRepo(WS);
}

function folder(slug: string, token: string, yaml = YAML, edit = "") {
  return {
    [`connectors/${slug}/connector.yaml`]: yaml,
    [`connectors/${slug}/connector.ts`]: code(token, edit),
  };
}

async function pathsUnder(slug: string): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  return (await listTree(repoDirFor(WS), head!))
    .map(e => e.path)
    .filter(p => p.startsWith(`connectors/${slug}/`))
    .map(p => p.slice(`connectors/${slug}/`.length))
    .sort();
}

/** `git mv connectors/<from> connectors/<to>` (+ optional yaml/edit). */
function gitMv(
  from: string,
  to: string,
  token: string,
  opts: { yaml?: string; edit?: string } = {},
) {
  return {
    writes: folder(to, token, opts.yaml ?? YAML, opts.edit ?? ""),
    deletes: [
      `connectors/${from}/connector.yaml`,
      `connectors/${from}/connector.ts`,
    ],
  };
}

async function defId(slug: string): Promise<string> {
  const row = await ConnectorDefinition.findOne({ workspaceId: WS, slug });
  if (!row) throw new Error(`no definition at ${slug}`);
  return String(row._id);
}

function req(method: string, url: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/connections/sources${url}`, {
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

let secretSeq = 0;

/** A credential entered through the real create route. */
async function createConnection(
  type: string,
  expectFor: string | null,
): Promise<string> {
  const secret = `sk-live-${++secretSeq}-${Math.random().toString(36).slice(2)}`;
  const res = await req("POST", "", {
    name: `conn ${type}`,
    type,
    config: { apiKey: secret, region: "eu" },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const id = ((await res.json()) as { data: { _id: string } }).data._id;
  expected.set(id, { defId: expectFor, secret });
  return id;
}

/** A connection saved before definitions were stamped (no binding). */
async function legacyConnection(
  type: string,
  expectFor: string | null,
): Promise<string> {
  const secret = `sk-legacy-${++secretSeq}`;
  const row = await SourceConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name: `legacy ${type}`,
    type,
    config: { apiKey: encryptString(secret), region: "eu" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
    createdBy: "u1",
  });
  expected.set(String(row._id), { defId: expectFor, secret });
  return String(row._id);
}

type Outcome =
  | { ran: false; error: string }
  | { ran: true; token: string; slug: string; apiKey: unknown };

/** The credential path every sync/flow/CDC/probe takes. */
async function runCredential(id: string): Promise<Outcome> {
  const before = box.runs.length;
  try {
    const ds = await sourceConnectionManager.getSourceConnection(id);
    if (!ds) return { ran: false, error: "not found" };
    const connector = await syncConnectorRegistry.getConnectorFor(ds);
    if (!connector) return { ran: false, error: "no connector" };
    const result = await connector.testConnection();
    const checks = box.runs.slice(before).filter(r => r.command === "check");
    if (!result.success) {
      expect(checks).toEqual([]);
      return { ran: false, error: result.message };
    }
    expect(checks).toHaveLength(1);
    return {
      ran: true,
      token: checks[0].token,
      slug: checks[0].slug,
      apiKey: checks[0].config?.apiKey,
    };
  } catch (error) {
    // Failed before anything ran: nothing decrypted reached a box.
    expect(box.runs.slice(before).filter(r => r.command === "check")).toEqual(
      [],
    );
    return {
      ran: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The token of the code a definition runs now (its folder at its sha). */
async function tokenOfDefinition(id: string): Promise<string | null> {
  const row = await ConnectorDefinition.findOne({ workspaceId: WS, _id: id });
  if (!row) return null;
  const { readConnectorFolder } = await import(
    "../../connectors/workspace/resolver"
  );
  const files = await readConnectorFolder(WS, row.slug, row.sha);
  const m = /CODE:([\w-]+)/.exec(
    new TextDecoder().decode(files.get("connector.ts")),
  );
  return m ? m[1] : null;
}

/**
 * THE invariant, for every connection in the workspace: its secret runs
 * on its bound definition's code (and only there), or nothing runs.
 */
async function assertCredentials(label: string): Promise<void> {
  const runsBefore = box.runs.length;
  const all = await SourceConnection.find({ workspaceId: WS }).lean();
  for (const row of all) {
    const id = String(row._id);
    if (!String(row.type).startsWith("ws:")) {
      // A built-in connector: never bound to a workspace definition.
      expect(row.connectorDefinitionId, `${label}: ${row.name}`).toBeFalsy();
      continue;
    }
    const want = expected.get(id);
    if (!want) throw new Error(`${label}: untracked connection ${id}`);
    // At rest the secret is ciphertext (never the plaintext).
    expect(
      (row.config as { apiKey?: string }).apiKey,
      `${label}: ${row.name} stored in plaintext`,
    ).not.toBe(want.secret);
    const outcome = await runCredential(id);
    if (want.defId === null) {
      expect(
        outcome,
        `${label}: ${row.name} (${row.type}) must fail closed`,
      ).toMatchObject({ ran: false });
      continue;
    }
    expect(
      outcome,
      `${label}: ${row.name} (${row.type}) must run its definition`,
    ).toMatchObject({ ran: true });
    if (!outcome.ran) continue;
    const def = await ConnectorDefinition.findOne({
      workspaceId: WS,
      _id: want.defId,
    });
    expect(def, `${label}: bound definition vanished`).not.toBeNull();
    expect(outcome.slug, `${label}: ${row.name} ran another folder`).toBe(
      def!.slug,
    );
    expect(outcome.token, `${label}: ${row.name} ran other code`).toBe(
      await tokenOfDefinition(want.defId),
    );
    expect(outcome.apiKey, `${label}: ${row.name} decrypted wrongly`).toBe(
      want.secret,
    );
  }
  // And no secret reached code other than its own definition's folder.
  for (const run of box.runs
    .slice(runsBefore)
    .filter(r => r.command === "check")) {
    const apiKey = run.config?.apiKey;
    const owner = [...expected.values()].find(w => w.secret === apiKey);
    expect(owner, `${label}: an unknown secret ran`).toBeDefined();
    expect(owner!.defId, `${label}: a fail-closed secret ran`).not.toBeNull();
    const def = await ConnectorDefinition.findById(owner!.defId);
    expect(run.slug, `${label}: a secret ran in another folder`).toBe(
      def?.slug,
    );
  }
}

async function rename(from: string, to: string) {
  return renameObject(ctx(), "connector", { ref: from, slug: to });
}

// ── Scenarios ───────────────────────────────────────────────────────

describe("UI / REST / MCP renames keep every credential on its definition", () => {
  it("rename (service), rename back, a→b→c, MCP rename_object, and creates through old names", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    const Z = await defId("zed");
    await createConnection("ws:acme", A);
    await createConnection("ws:zed", Z);
    await legacyConnection("ws:acme", A); // unstamped, typed by the live slug
    await assertCredentials("start");

    const r1 = await rename("acme", "acme-crm");
    expect(r1.id).toBe(A);
    await assertCredentials("after acme→acme-crm");
    // An old name in a create is stored canonical and bound to the same id.
    await createConnection("ws:acme", A);
    await assertCredentials("create through the alias");

    // Rename back: same row, alias swap.
    const r2 = await rename("acme-crm", "acme");
    expect(r2.id).toBe(A);
    const row = await ConnectorDefinition.findById(A);
    expect([row?.slug, row?.aliases]).toEqual(["acme", ["acme-crm"]]);
    await assertCredentials("after rename back");

    // a→b→c quickly, through the MCP tool.
    const tool = createRenameTools(WS, "u1").rename_object;
    const exec = tool.execute as (
      input: Record<string, unknown>,
      opts: unknown,
    ) => Promise<{ success: boolean; id?: string; error?: string }>;
    const m1 = await exec(
      { kind: "connector", ref: "ws:acme", slug: "b" },
      { toolCallId: "t1", messages: [] },
    );
    const m2 = await exec(
      { kind: "connector", ref: "acme", slug: "c" },
      { toolCallId: "t2", messages: [] },
    );
    expect([m1.success, m2.success, m1.id, m2.id]).toEqual([true, true, A, A]);
    expect(
      (await ConnectorDefinition.findById(A))?.aliases?.slice().sort(),
    ).toEqual(["acme", "acme-crm", "b"]);
    await createConnection("ws:acme-crm", A);
    await assertCredentials("after a→b→c over MCP");
    // Every old name resolves to the same id; Z is untouched.
    for (const ref of ["acme", "acme-crm", "b", "ws:b", A]) {
      expect((await resolveObjectRef(ctx(), "connector", ref))?.id).toBe(A);
    }
    expect((await ConnectorDefinition.findById(Z))?.slug).toBe("zed");
  });

  it("an API key holding only query:read cannot rename a connector over MCP; git:write can", () => {
    const readOnly = new Set([
      "artifact-write",
      "schedule-write",
      ...capabilityGrantsFromScopes(["query:read"]),
    ]);
    expect(
      missingInputConditionalGrant(
        "rename_object",
        { kind: "connector" },
        readOnly as never,
      ),
    ).toMatchObject({ grant: "git-write" });
    const gitWrite = new Set([
      ...readOnly,
      ...capabilityGrantsFromScopes(["git:write"]),
    ]);
    expect(
      missingInputConditionalGrant(
        "rename_object",
        { kind: "connector" },
        gitWrite as never,
      ),
    ).toBeNull();
  });

  it("no-op renames, hostile slugs and taken names change nothing (and never move a credential)", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await createConnection("ws:zed", await defId("zed"));
    const head = await resolveCommit(repoDirFor(WS), MAIN);

    // Its own name — also padded: surrounding whitespace is trimmed (a
    // safe normalization), so these are no-ops, not new names.
    for (const same of ["acme", "acme ", " acme", "acme\n", "ws:acme"]) {
      const noop = await rename("acme", same);
      expect(noop.warnings.join(" "), JSON.stringify(same)).toMatch(
        /Nothing to change/,
      );
    }
    const hostile = [
      "",
      " ",
      "Acme",
      "ACME",
      "../acme2",
      "acme/x",
      "/acme",
      "acme\\x",
      "~acme",
      "%2e%2e",
      "acme.",
      "con:",
      "a".repeat(65),
      "a".repeat(1000),
      "é",
      "é",
      "acme​",
      "acme\u0000",
      "‮emca",
      "😀",
      "zed",
      "ws:zed",
      "ws:",
    ];
    for (const slug of hostile) {
      const outcome = await rename("acme", slug).then(
        r => `accepted: ${r.after.slug}`,
        (e: { status?: number }) => e.status,
      );
      expect([JSON.stringify(slug), outcome]).toEqual([
        JSON.stringify(slug),
        slug === "zed" || slug === "ws:zed" ? 409 : 400,
      ]);
    }
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme");
    await assertCredentials("after refusals");
  });
});

describe("laptop pushes (git endpoint → push sync)", () => {
  it("bare git mv, git mv + edit, git mv + rewrite (not a rename), git mv + rewrite WITH aliases, and the re-bind", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    const Z = await defId("zed");
    const c1 = await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    await createConnection("ws:zed", Z);

    // 1. Bare `git mv` (no alias written): git detects it.
    let pass = await pushAndSync(gitMv("acme", "acme2", "A"));
    expect(pass.renamed).toEqual([{ from: "acme", to: "acme2" }]);
    expect(await defId("acme2")).toBe(A);
    await assertCredentials("bare git mv");

    // 2. Move + edit in one commit (still ≥75% alike): same definition,
    //    its new code runs the credential.
    pass = await pushAndSync(gitMv("acme2", "acme3", "A", { edit: "tweak" }));
    expect(pass.renamed).toEqual([{ from: "acme2", to: "acme3" }]);
    expect(await defId("acme3")).toBe(A);
    await assertCredentials("git mv + edit");

    // 3. Move + full rewrite, no alias: git cannot call it a rename, so it
    //    is a delete + a create — A's credentials fail closed, never handed
    //    to the new code.
    pass = await pushAndSync(gitMv("acme3", "acme4", "N"));
    expect(pass.renamed).toEqual([]);
    const N = await defId("acme4");
    expect(N).not.toBe(A);
    for (const [, want] of expected) if (want.defId === A) want.defId = null;
    await assertCredentials("git mv + rewrite");
    // POST through an old name of the gone connector: nothing answers.
    const refused = await req("POST", "", {
      name: "late",
      type: "ws:acme",
      config: { apiKey: "x" },
    });
    expect(refused.status).toBe(400);

    // The person re-binds c1 explicitly: PUT its type at the new folder.
    const rebind = await req("PUT", `/${c1}`, { type: "ws:acme4" });
    expect(rebind.status, await rebind.clone().text()).toBe(200);
    expected.get(c1)!.defId = N;
    await assertCredentials("explicit re-bind");

    // 4. Move + full rewrite WITH `aliases: [acme4]` in the new yaml: the
    //    author's statement makes it a rename (same row, same credentials).
    pass = await pushAndSync(
      gitMv("acme4", "acme5", "N2", { yaml: `${YAML}aliases: [acme4]\n` }),
    );
    expect(pass.renamed).toEqual([{ from: "acme4", to: "acme5" }]);
    expect(await defId("acme5")).toBe(N);
    await assertCredentials("rewrite with alias");
  });

  it("a copied folder is a new connector: it inherits no alias and no credential, before or after the original is deleted", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await rename("acme", "acme-crm"); // A now answers to `acme` as an alias
    await createConnection("ws:acme", A); // canonicalized to acme-crm

    // cp -r connectors/acme-crm connectors/acme-copy (yaml says aliases: [acme])
    const yamlWithAlias = (await import("../../apps/repository.service"))
      .readBlob;
    const a2 = await yamlWithAlias(
      repoDirFor(WS),
      MAIN,
      "connectors/acme-crm/connector.yaml",
    );
    expect(a2.contents).toContain("- acme");
    await pushAndSync({
      writes: {
        "connectors/acme-copy/connector.yaml": a2.contents,
        "connectors/acme-copy/connector.ts": code("A"),
      },
    });
    const C = await defId("acme-copy");
    const copyRow = await ConnectorDefinition.findById(C);
    expect([copyRow?.aliases, copyRow?.retiredAliases]).toEqual([[], ["acme"]]);
    expect((await resolveObjectRef(ctx(), "connector", "acme"))?.id).toBe(A);
    await createConnection("ws:acme-copy", C);
    // A create through the old name still binds the original, not the copy.
    await createConnection("ws:acme", A);
    await assertCredentials("after copy");

    // The original is deleted later: its credentials fail closed — the copy
    // (identical code!) never adopts them.
    await pushAndSync({
      deletes: [
        "connectors/acme-crm/connector.yaml",
        "connectors/acme-crm/connector.ts",
      ],
    });
    for (const [, want] of expected) if (want.defId === A) want.defId = null;
    await assertCredentials("original deleted");
    expect(await resolveObjectRef(ctx(), "connector", "acme")).toBeNull();
  });

  it("aliases added to / removed from connector.yaml never move a credential; a legacy connection typed by an alias stays closed", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("other", "O") },
    });
    const A = await defId("acme");
    const O = await defId("other");
    await createConnection("ws:acme", A);
    await createConnection("ws:other", O);
    // Saved long ago for a connector called `ghost`, never stamped.
    await legacyConnection("ws:ghost", null);
    await assertCredentials("start");

    // other's yaml claims `acme` (live) and `ghost` (nobody's).
    await pushAndSync({
      writes: {
        "connectors/other/connector.yaml": `${YAML}aliases: [acme, ghost]\n`,
      },
    });
    const o = await ConnectorDefinition.findById(O);
    expect([o?.aliases, o?.retiredAliases]).toEqual([["ghost"], ["acme"]]);
    // A create through ws:acme is acme's; through ws:ghost is other's.
    await createConnection("ws:acme", A);
    await createConnection("ws:ghost", O);
    // The legacy ws:ghost credential was entered for nobody `other` can
    // prove to be: it stays closed.
    await assertCredentials("aliases added");

    // The alias is removed again: nothing moves.
    await pushAndSync({ writes: { "connectors/other/connector.yaml": YAML } });
    expect((await ConnectorDefinition.findById(O))?.aliases).toEqual([]);
    await assertCredentials("aliases removed");
  });

  it("delete → fail closed; restore is a NEW connector (still closed); only an explicit re-bind reopens it", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    const c1 = await createConnection("ws:acme", A);
    const c2 = await createConnection("ws:acme", A);
    await pushAndSync({
      deletes: [
        "connectors/acme/connector.yaml",
        "connectors/acme/connector.ts",
      ],
    });
    expected.get(c1)!.defId = null;
    expected.get(c2)!.defId = null;
    await assertCredentials("deleted");
    // A config edit on a credential whose connector is gone: 409, nothing written.
    const before = await SourceConnection.findById(c1).lean();
    const edit = await req("PUT", `/${c1}`, { config: { apiKey: "new" } });
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { code?: string }).code).toBe(
      "connector_binding",
    );
    expect((await SourceConnection.findById(c1).lean())?.config).toEqual(
      before?.config,
    );
    // Every route that would decrypt or run it says how to re-bind (409),
    // and nothing secret is in any answer — the admin's reveal included.
    auth.role = "admin";
    for (const [method, url, b] of [
      ["POST", `/${c1}/test`, undefined],
      ["GET", `/${c1}/entities`, undefined],
      ["POST", `/${c1}/probe`, { entity: "widgets" }],
      ["POST", `/${c1}/reveal-secret`, { field: "apiKey" }],
    ] as const) {
      const res = await req(method, url, b);
      const text = await res.text();
      expect([url, res.status]).toEqual([url, 409]);
      expect(JSON.parse(text)).toMatchObject({ code: "connector_binding" });
      expect(text).not.toContain(expected.get(c1)!.secret);
    }
    auth.role = "member";

    // git revert: the same folder comes back — a NEW definition.
    await pushAndSync({ writes: folder("acme", "A") });
    const R = await defId("acme");
    expect(R).not.toBe(A);
    await assertCredentials("restored");
    // A PUT that does not name the type does not re-bind.
    const renamed = await req("PUT", `/${c2}`, { name: "renamed" });
    expect(renamed.status).toBe(200);
    await assertCredentials("name-only PUT");
    // Naming its own type is the explicit re-bind.
    const rebind = await req("PUT", `/${c1}`, { type: "ws:acme" });
    expect(rebind.status).toBe(200);
    expected.get(c1)!.defId = R;
    await assertCredentials("re-bound");
  });

  it("two claimants of one alias: nothing resolves the alias, each keeps its own credentials, and a newcomer at the alias gets none of them", async () => {
    await pushAndSync({
      writes: { ...folder("x1", "X1"), ...folder("x2", "X2") },
    });
    const X1 = await defId("x1");
    const X2 = await defId("x2");
    // Both claim `legacy` (forced: the index itself never lets two keep it).
    await ConnectorDefinition.updateMany(
      { workspaceId: WS, _id: { $in: [X1, X2] } },
      { $set: { aliases: ["legacy"], retiredAliases: [] } },
    );
    const own1 = await createConnection("ws:x1", X1);
    const own2 = await createConnection("ws:x2", X2);
    // Their own connections carry a stale type naming the shared alias.
    await SourceConnection.updateMany(
      { _id: { $in: [own1, own2] } },
      { $set: { type: "ws:legacy" } },
    );
    await legacyConnection("ws:legacy", null);
    const refused = await req("POST", "", {
      name: "ambiguous",
      type: "ws:legacy",
      config: { apiKey: "x" },
    });
    expect(refused.status).toBe(400);
    expect(await resolveObjectRef(ctx(), "connector", "legacy")).toBeNull();
    await assertCredentials("two claimants");

    // A NEW folder at `legacy`.
    await pushAndSync({ writes: folder("legacy", "L") });
    const L = await defId("legacy");
    await createConnection("ws:legacy", L);
    await assertCredentials("newcomer at the shared alias");
  });

  it("a NEW folder at an old slug: the renamed connector keeps its credentials (stale-typed or legacy ones too) and the newcomer gets none", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await rename("acme", "acme-crm");
    // A connection bound to A whose type still says ws:acme (a create that
    // raced the rename), and a pre-stamp legacy one typed by the old name.
    const stale = await createConnection("ws:acme-crm", A);
    await SourceConnection.updateOne(
      { _id: stale },
      { $set: { type: "ws:acme" } },
    );
    const legacy = await legacyConnection("ws:acme", null);
    await assertCredentials("before the newcomer");

    // Someone pushes a brand-new connector called `acme`.
    await pushAndSync({ writes: folder("acme", "NEW") });
    const N = await defId("acme");
    expect(N).not.toBe(A);
    await createConnection("ws:acme", N);
    await assertCredentials("after the newcomer");
    // The edit form says why, and its save (re-sending the type) is the
    // explicit re-bind.
    const shown = await req("GET", `/${legacy}`);
    const binding = (
      (await shown.json()) as {
        data: { connectorBinding?: { problem: string; message: string } };
      }
    ).data.connectorBinding;
    expect(binding?.problem).toBe("definition-gone");
    expect(binding?.message).toMatch(
      /a different connector has since taken that name/,
    );
    expect((await req("PUT", `/${legacy}`, { type: "ws:acme" })).status).toBe(
      200,
    );
    expected.get(legacy)!.defId = N;
    await assertCredentials("legacy re-bound by a person");
    // Laptop: the newcomer is renamed away again with git mv; A is untouched.
    await pushAndSync(gitMv("acme", "acme-new", "NEW"));
    expect(await defId("acme-new")).toBe(N);
    await assertCredentials("newcomer moved away");
  });

  it("same-push folds: one heir re-binds (the author's statement); two heirs or a stale template copy fold nothing", async () => {
    await pushAndSync({
      writes: { ...folder("x", "X"), ...folder("y", "Y"), ...folder("w", "W") },
    });
    const X = await defId("x");
    const Y = await defId("y");
    const W = await defId("w");
    const bound = await createConnection("ws:x", X);
    const legacy = await legacyConnection("ws:x", X);
    await createConnection("ws:w", W);
    await assertCredentials("start");
    // Delete x while y says `aliases: [x]`, in one push.
    await pushAndSync({
      writes: { "connectors/y/connector.yaml": `${YAML}aliases: [x]\n` },
      deletes: ["connectors/x/connector.yaml", "connectors/x/connector.ts"],
    });
    expected.get(bound)!.defId = Y;
    expected.get(legacy)!.defId = Y;
    await assertCredentials("folded into y");

    // Two heirs for one deleted folder: nobody's.
    await pushAndSync({ writes: { ...folder("p", "P"), ...folder("q", "Q") } });
    const onP = await createConnection("ws:p", await defId("p"));
    await pushAndSync({
      writes: {
        "connectors/q/connector.yaml": `${YAML}aliases: [p]\n`,
        "connectors/w/connector.yaml": `${YAML}aliases: [p]\n`,
      },
      deletes: ["connectors/p/connector.yaml", "connectors/p/connector.ts"],
    });
    expected.get(onP)!.defId = null;
    await assertCredentials("two heirs");
    expect(await resolveObjectRef(ctx(), "connector", "p")).toBeNull();

    // A stale template copy: `t` listed `s` while `s` was live (dropped and
    // retired for t then); deleting `s` later is no fold into `t`.
    await pushAndSync({ writes: { ...folder("s", "S") } });
    const onS = await createConnection("ws:s", await defId("s"));
    await pushAndSync({
      writes: {
        "connectors/t/connector.yaml": `${YAML}aliases: [s]\n`,
        "connectors/t/connector.ts": code("T"),
      },
    });
    await pushAndSync({
      deletes: ["connectors/s/connector.yaml", "connectors/s/connector.ts"],
    });
    expected.get(onS)!.defId = null;
    await assertCredentials("stale template copy");
  });

  it("same push: git mv acme acme2 AND a new acme — git calls acme modified, so acme's credentials stay with the folder that kept the path (never with a guess)", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await pushAndSync({
      writes: { ...folder("acme2", "A"), ...folder("acme", "NEW") },
    });
    // Git reports `connectors/acme` modified and `acme2` added: the
    // definition IS the folder at its path, so A is the row at `acme` and
    // runs what is there now; acme2 is a new, alias-less connector.
    expect(await defId("acme")).toBe(A);
    const A2 = await defId("acme2");
    expect((await ConnectorDefinition.findById(A2))?.aliases).toEqual([]);
    await createConnection("ws:acme2", A2);
    await assertCredentials("move + new folder in one push");
  });
});

describe("REST, roles, links and other workspaces", () => {
  async function objects(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    ws = WS,
  ): Promise<Response> {
    return Promise.resolve(
      app.request(`/api/workspaces/${ws}/objects${url}`, {
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

  it("POST /objects/connector/rename (signed-in UI) renames; an API key is refused; resolve answers old names", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);

    auth.authType = "apiKey";
    const key = await objects("POST", "/connector/rename", {
      ref: "acme",
      slug: "acme-crm",
    });
    expect(key.status).toBe(403);
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme");

    auth.authType = "session";
    for (const role of ["member", "admin", "owner"]) {
      auth.role = role;
      const slug = `acme-${role}`;
      const res = await objects("POST", "/connector/rename", {
        ref: (await ConnectorDefinition.findById(A))!.slug,
        slug,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await ConnectorDefinition.findById(A))?.slug).toBe(slug);
      await assertCredentials(`renamed by ${role}`);
    }
    const old = await objects(
      "GET",
      `/resolve?${new URLSearchParams({ kind: "connector", ref: "acme" })}`,
    );
    expect(old.status).toBe(200);
    expect(
      ((await old.json()) as { resolved: { id: string; via: string } })
        .resolved,
    ).toMatchObject({ id: A, via: "alias" });
    // Hostile refs to resolve: 404, never a crash.
    for (const ref of ["../acme", "ws:", "%2e%2e", "a".repeat(1000)]) {
      const r = await objects(
        "GET",
        `/resolve?${new URLSearchParams({ kind: "connector", ref })}`,
      );
      expect([ref.slice(0, 12), r.status]).toEqual([ref.slice(0, 12), 404]);
    }
  });

  it("two workspaces with the same slugs never touch each other; a stamp from another workspace fails closed", async () => {
    // Workspace 2 first.
    const ws1 = WS;
    const ws2 = new Types.ObjectId().toString();
    WS = ws2;
    WS_ID.value = ws2;
    await initRepo(repoDirFor(ws2), { "README.md": "# ws2\n" });
    await bindTestWorkspaceRepo(ws2);
    await pushAndSync({ writes: folder("acme", "W2") });
    const A2 = await defId("acme");
    await createConnection("ws:acme", A2);
    // Workspace 1.
    WS = ws1;
    WS_ID.value = ws1;
    await pushAndSync({ writes: folder("acme", "W1") });
    const A1 = await defId("acme");
    await createConnection("ws:acme", A1);
    // A forged binding to workspace 2's definition.
    const forged = await legacyConnection("ws:acme", null);
    await SourceConnection.updateOne(
      { _id: forged },
      { $set: { connectorDefinitionId: new Types.ObjectId(A2) } },
    );
    await assertCredentials("ws1 start");

    await rename("acme", "acme-one");
    expect(await resolveObjectRef(ctx(), "connector", A2)).toBeNull();
    expect((await resolveObjectRef(ctx(), "connector", "acme"))?.id).toBe(A1);
    await assertCredentials("ws1 after rename");
    // Workspace 2 is untouched: same slug, no alias, its credential runs.
    WS = ws2;
    WS_ID.value = ws2;
    const row2 = await ConnectorDefinition.findById(A2);
    expect([row2?.slug, row2?.aliases]).toEqual(["acme", []]);
    expect(await resolveObjectRef(ctx(), "connector", A1)).toBeNull();
    await assertCredentials("ws2 untouched");
    WS = ws1;
    WS_ID.value = ws1;
  });
});

describe("partial failure and concurrency", () => {
  it("UI rename: the git commit lands and the connection update crashes — nothing is stranded, the next push converges (same id, no duplicate)", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    const original = SourceConnection.updateMany.bind(SourceConnection);
    let fired = false;
    vi.spyOn(SourceConnection, "updateMany").mockImplementation(((
      filter: Record<string, unknown>,
      ...rest: unknown[]
    ) => {
      if (!fired && filter?.type === "ws:acme") {
        fired = true;
        throw new Error("mongo went away");
      }
      return (original as (...a: unknown[]) => unknown)(filter, ...rest);
    }) as never);
    await expect(rename("acme", "acme-crm")).rejects.toThrow(/mongo went away/);
    vi.mocked(SourceConnection.updateMany).mockRestore();
    expect(await pathsUnder("acme-crm")).toEqual([
      "connector.ts",
      "connector.yaml",
    ]);
    await assertCredentials("after the crash");
    await pushAndSync({ writes: { "README.md": "# next push\n" } });
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme-crm");
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      1,
    );
    await assertCredentials("converged");
  });

  it("UI rename: the git commit lands and the index write crashes — the next push converges", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    vi.spyOn(ConnectorDefinition.prototype, "save").mockRejectedValueOnce(
      new Error("mongo went away"),
    );
    await expect(rename("acme", "acme-crm")).rejects.toThrow(/mongo went away/);
    vi.mocked(ConnectorDefinition.prototype.save).mockRestore();
    await assertCredentials("after the crash");
    await pushAndSync({ writes: { "README.md": "# next push\n" } });
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme-crm");
    await assertCredentials("converged");
  });

  it("laptop push: the push sync crashes between the connections and the index — the next push converges", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    await push(gitMv("acme", "acme2", "A"));
    const original = SourceConnection.updateMany.bind(SourceConnection);
    let fired = false;
    vi.spyOn(SourceConnection, "updateMany").mockImplementation(((
      filter: Record<string, unknown>,
      ...rest: unknown[]
    ) => {
      if (!fired && filter?.type === "ws:acme") {
        fired = true;
        throw new Error("mongo went away");
      }
      return (original as (...a: unknown[]) => unknown)(filter, ...rest);
    }) as never);
    await expect(syncConnectorsFromRepo(WS)).rejects.toThrow(/mongo went away/);
    vi.mocked(SourceConnection.updateMany).mockRestore();
    await assertCredentials("after the crash");
    await pushAndSync({ writes: { "README.md": "# next push\n" } });
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme2");
    await assertCredentials("converged");
  });

  it("the git commit itself fails: nothing moves", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    race.beforeRenameCommit = async () => {
      throw new Error("disk full");
    };
    await expect(rename("acme", "acme-crm")).rejects.toThrow(/disk full/);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme");
    expect(
      (await SourceConnection.find({ workspaceId: WS }).lean())[0].type,
    ).toBe("ws:acme");
    await assertCredentials("commit failed");
  });

  it("two renames of the same connector at once: exactly one lands, git and the index agree", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    const outcomes = await Promise.allSettled([
      rename("acme", "left"),
      rename("acme", "right"),
    ]);
    const won = outcomes.filter(o => o.status === "fulfilled");
    expect(won).toHaveLength(1);
    const lost = outcomes.find(o => o.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(lost?.reason).toMatchObject({ status: expect.any(Number) });
    const row = await ConnectorDefinition.findById(A);
    expect(await pathsUnder(row!.slug)).toContain("connector.yaml");
    expect(await pathsUnder(row!.slug === "left" ? "right" : "left")).toEqual(
      [],
    );
    expect(await pathsUnder("acme")).toEqual([]);
    await assertCredentials("after the race");
  });

  it("a rename racing a laptop push that deletes the folder: refused (409); the delete wins and the credentials fail closed", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    const c = await createConnection("ws:acme", A);
    race.beforeRenameCommit = async () => {
      await pushAndSync({
        deletes: [
          "connectors/acme/connector.yaml",
          "connectors/acme/connector.ts",
        ],
      });
    };
    await expect(rename("acme", "acme-crm")).rejects.toMatchObject({
      status: 409,
    });
    expect(await ConnectorDefinition.findById(A)).toBeNull();
    expect(await pathsUnder("acme-crm")).toEqual([]);
    expected.get(c)!.defId = null;
    await assertCredentials("delete won");
  });

  it("a rename racing a laptop push that edits the code: refused (409), the edit is kept, nothing is half-moved", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    race.beforeRenameCommit = async () => {
      await pushAndSync({
        writes: { "connectors/acme/connector.ts": code("A", "hotfix") },
      });
    };
    await expect(rename("acme", "acme-crm")).rejects.toMatchObject({
      status: 409,
    });
    expect(await pathsUnder("acme-crm")).toEqual([]);
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme");
    await assertCredentials("edit won");
  });

  it("rename, push sync and connection creates interleaved: every credential lands on the one definition", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
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
    // An own connection whose type still says the old name (a create that
    // raced the rename) does not block renaming back to that name.
    const own = await createConnection("ws:acme-crm", A);
    await SourceConnection.updateOne(
      { _id: own },
      { $set: { type: "ws:acme" } },
    );
    await rename("acme-crm", "acme");
    expect((await ConnectorDefinition.findById(A))?.slug).toBe("acme");
    await assertCredentials("renamed back");
  });
});

describe("the stamping migration on realistic data", () => {
  it("binds by current slug only — across workspaces, alias-typed, deleted, foreign-stamped, string-workspace and built-in rows — and every credential then runs or fails closed", async () => {
    const raw = mongoose.connection.collection("connectors");
    const base = {
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
      createdBy: "u1",
      isActive: true,
    };
    /** A pre-stamp row, inserted the way old code left it. */
    const insert = async (
      doc: Record<string, unknown>,
      secret: string,
      expectFor: string | null,
    ): Promise<string> => {
      const { insertedId } = await raw.insertOne({
        ...base,
        name: `pre-stamp ${doc.type}`,
        ...doc,
        config: { apiKey: encryptString(secret), region: "eu" },
      });
      expected.set(String(insertedId), { defId: expectFor, secret });
      return String(insertedId);
    };

    // Workspace 2: its own `acme`.
    const ws1 = WS;
    const ws2 = new Types.ObjectId().toString();
    WS = ws2;
    WS_ID.value = ws2;
    await initRepo(repoDirFor(ws2), { "README.md": "# ws2\n" });
    await bindTestWorkspaceRepo(ws2);
    await pushAndSync({ writes: folder("acme", "W2") });
    const A2 = await defId("acme");
    await insert(
      { workspaceId: new Types.ObjectId(ws2), type: "ws:acme" },
      "s-ws2",
      A2,
    );
    // Workspace 1.
    WS = ws1;
    WS_ID.value = ws1;
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("beta", "B") },
    });
    await rename("beta", "beta-v2"); // `beta` is now only an alias
    const A = await defId("acme");
    const B = await defId("beta-v2");
    const wsOid = new Types.ObjectId(ws1);
    await insert({ workspaceId: wsOid, type: "ws:acme" }, "s-current", A);
    await insert({ workspaceId: wsOid, type: "ws:beta" }, "s-alias", null);
    await insert({ workspaceId: wsOid, type: "ws:gone" }, "s-gone", null);
    await insert(
      {
        workspaceId: wsOid,
        type: "ws:acme",
        connectorDefinitionId: new Types.ObjectId(A),
      },
      "s-stamped",
      A,
    );
    await insert(
      {
        workspaceId: wsOid,
        type: "ws:acme",
        connectorDefinitionId: new Types.ObjectId(A2),
      },
      "s-foreign",
      null,
    );
    await raw.insertOne({
      ...base,
      workspaceId: wsOid,
      name: "stripe",
      type: "stripe",
    });
    const noWorkspace = await insert({ type: "ws:acme" }, "s-nows", null);
    // workspaceId stored as a STRING by an old writer.
    const stringWs = await insert(
      { workspaceId: ws1, type: "ws:acme" },
      "s-stringws",
      A,
    );
    const stringWsOrphan = await insert(
      { workspaceId: ws1, type: "ws:nobody" },
      "s-stringws-orphan",
      null,
    );

    await stampMigration(mongoose.connection.db!);
    await stampMigration(mongoose.connection.db!); // idempotent

    const stamp = async (id: string) =>
      (await raw.findOne({ _id: new Types.ObjectId(id) }))
        ?.connectorDefinitionId;
    expect(String(await stamp(stringWs))).toBe(A);
    expect(await stamp(noWorkspace)).toBeUndefined();
    await assertCredentials("ws1 after the migration");
    expect(await runCredential(stringWs)).toMatchObject({
      ran: true,
      slug: "acme",
      apiKey: "s-stringws",
    });
    expect(await runCredential(noWorkspace)).toMatchObject({ ran: false });

    // Life after the migration: a rename, a newcomer at the alias, a
    // newcomer at the name only the string-workspace orphan carries.
    await rename("acme", "acme-x");
    await pushAndSync({
      writes: { ...folder("beta", "NEWBETA"), ...folder("nobody", "NOBODY") },
    });
    expect(await runCredential(stringWsOrphan)).toMatchObject({ ran: false });
    await assertCredentials("ws1 after rename + newcomer");
    expect(await runCredential(stringWs)).toMatchObject({
      ran: true,
      slug: "acme-x",
      apiKey: "s-stringws",
    });
    expect(B).not.toBe(await defId("beta"));

    WS = ws2;
    WS_ID.value = ws2;
    await assertCredentials("ws2 after the migration");
    WS = ws1;
    WS_ID.value = ws1;
  });
});

describe("slugs YAML would read as a boolean or null", () => {
  it("acme → true → no → null → yes → off → y: connector.yaml parses, aliases are exact strings, old names resolve, credentials stay bound", async () => {
    await pushAndSync({ writes: folder("acme", "A") });
    const A = await defId("acme");
    await createConnection("ws:acme", A);
    await legacyConnection("ws:acme", A);
    // Digit-led names are not connector slugs at all: refused, nothing moves.
    for (const bad of ["2026", "2026-10-06", "012", "0x1f", "1e3"]) {
      await expect(rename("acme", bad)).rejects.toMatchObject({ status: 400 });
    }
    const chain = ["true", "no", "null", "yes", "off", "y"];
    let current = "acme";
    const old: string[] = [];
    for (const to of chain) {
      const r = await rename(current, to);
      expect(r.id).toBe(A);
      old.push(current);
      current = to;
      const text = (
        await readBlob(
          repoDirFor(WS),
          MAIN,
          `connectors/${current}/connector.yaml`,
        )
      ).contents;
      const doc = yaml.load(text) as { aliases: unknown[] };
      expect(doc.aliases.every(a => typeof a === "string")).toBe(true);
      expect([...doc.aliases].sort()).toEqual([...old].sort());
      expect(parseConnectorFile(text)).toMatchObject({ ok: true });
      for (const name of old) {
        expect([
          name,
          (await resolveObjectRef(ctx(), "connector", name))?.id,
        ]).toEqual([name, A]);
      }
      await assertCredentials(`renamed to ${to}`);
    }
    // A laptop push after all that: the yaml still parses, nothing re-runs
    // spec (the aliases are not code), the row keeps its id.
    await pushAndSync({ writes: { "README.md": "# touched\n" } });
    expect(await defId("y")).toBe(A);
    await assertCredentials("after a later push");
  });
});

describe("re-pointing a connection is the one explicit act", () => {
  it("PUT type to a live connector moves the binding; through an alias it is canonical; to a name nothing answers it is refused", async () => {
    await pushAndSync({
      writes: { ...folder("acme", "A"), ...folder("zed", "Z") },
    });
    const A = await defId("acme");
    const Z = await defId("zed");
    const c = await createConnection("ws:acme", A);
    await rename("zed", "zed-v2"); // `zed` is an alias now
    await assertCredentials("start");

    const moved = await req("PUT", `/${c}`, { type: "ws:zed" });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const row = await SourceConnection.findById(c).lean();
    expect([row?.type, String(row?.connectorDefinitionId)]).toEqual([
      "ws:zed-v2",
      Z,
    ]);
    expected.get(c)!.defId = Z;
    await assertCredentials("re-pointed through an alias");

    // A name nothing answers: refused, like a create — an unbound credential
    // would otherwise wait there for whichever folder takes that name.
    const nowhere = await req("PUT", `/${c}`, { type: "ws:future" });
    expect(nowhere.status).toBe(400);
    expect((await SourceConnection.findById(c).lean())?.type).toBe("ws:zed-v2");
    await pushAndSync({ writes: folder("future", "F") });
    await assertCredentials("a folder later takes that name");

    // A built-in type no connector answers to: refused too; a real one is
    // an explicit re-point that unbinds it from every workspace connector.
    for (const type of ["no-such-builtin", "../connectors/workspace"]) {
      const bad = await req("PUT", `/${c}`, { type });
      expect([type, bad.status]).toEqual([type, 400]);
    }
    expect((await SourceConnection.findById(c).lean())?.type).toBe("ws:zed-v2");
    const builtin = await req("PUT", `/${c}`, { type: "stripe" });
    expect(builtin.status).toBe(200);
    const row2 = await SourceConnection.findById(c).lean();
    expect([row2?.type, row2?.connectorDefinitionId]).toEqual([
      "stripe",
      undefined,
    ]);
    expected.delete(c);
  });
});
