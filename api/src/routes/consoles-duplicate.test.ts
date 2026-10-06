/**
 * Explorer "Duplicate", and where a console shared with someone sits.
 *
 * - A push the index sync applies never stores `mongoOptions: null` (it
 *   made every later Duplicate of that console fail validation — 500 —
 *   AFTER the copy's file had been committed; the next sync surfaced the
 *   copy unannounced).
 * - Duplicate tolerates rows that already hold the null, validates before
 *   committing, and takes the commit back when the insert still fails.
 * - The copy is the copier's: My Consoles, in their folder of the same
 *   path or at the root — the tree and the breadcrumb agree on it.
 * - Another member's private console shared with me is listed under
 *   "Shared with me", not "Workspace".
 *
 * Real routes, a real bare repo, mongodb-memory-server; auth stubbed.
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
import { Hono } from "hono";

const who = vi.hoisted(() => ({ id: "", role: "member" }));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: who.id, email: "u@example.com" });
    c.set("memberRole", who.role);
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => true,
    getMember: async () => ({ role: who.role }),
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      roles.includes(who.role),
  },
}));
vi.mock("../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));

import { ConsoleFolder, SavedConsole } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  repoDirFor,
} from "../apps/repository.service";
import { serializeConsoleFile } from "../apps/console-files";
import {
  derivedConsoleId,
  syncConsolesIndexFromRepo,
} from "../apps/workspace-consoles.service";
import { ConsoleManager, type ConsoleFile } from "../utils/console-manager";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { consoleRoutes } from "./consoles";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let app: Hono;
const WS = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const EDITOR = new Types.ObjectId().toString();
const manager = new ConsoleManager();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consoles-duplicate-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = new Hono();
  app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await SavedConsole.deleteMany({});
  await ConsoleFolder.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function consolePaths(): Promise<string[]> {
  return (await listTree(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`))
    .map(e => e.path)
    .filter(p => /\.(sql|js)$/.test(p))
    .sort();
}

type Body = {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  myConsoles?: ConsoleFile[];
  sharedWithWorkspace?: ConsoleFile[];
  sharedWithMe?: ConsoleFile[];
};

async function req(method: string, url: string, as: string, role = "member") {
  who.id = as;
  who.role = role;
  const res = await app.request(`/api/workspaces/${WS}/consoles${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const save = (
  name: string,
  owner: string,
  access: "private" | "workspace",
  folderId?: string,
) =>
  manager.saveConsole(
    name,
    "SELECT 1\n",
    WS,
    owner,
    undefined,
    undefined,
    undefined,
    { access, language: "sql", folderId },
  );

/** A laptop push: commit straight to main, then the index sync. */
async function push(files: Record<string, string>): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes: files },
    { message: "laptop", author: { name: "L", email: "l@example.com" } },
  );
  await syncConsolesIndexFromRepo(WS, OWNER);
}

/** The raw stored document (no Mongoose casting in the way). */
async function rawRow(id: string): Promise<Record<string, unknown> | null> {
  return mongoose.connection
    .collection("savedconsoles")
    .findOne({ _id: new Types.ObjectId(id) });
}

const names = (nodes: ConsoleFile[] | undefined) =>
  (nodes ?? []).map(n => n.name);

describe("a push never stores mongoOptions: null", () => {
  it("leaves it out for a SQL console, keeps a real pair, and unsets it when the file drops it", async () => {
    await save("seed", OWNER, "workspace"); // adopt the repo
    await push({
      "consoles/Ghost.sql": serializeConsoleFile({
        name: "Ghost",
        language: "sql",
        code: "SELECT 'laptop'",
      }),
      "consoles/orders.mongodb.js": serializeConsoleFile({
        name: "orders",
        language: "mongodb",
        code: "db.orders.find({})",
        mongoOptions: { collection: "orders", operation: "find" },
      }),
    });
    const ghost = derivedConsoleId(WS, "consoles/Ghost.sql").toString();
    const orders = derivedConsoleId(
      WS,
      "consoles/orders.mongodb.js",
    ).toString();
    const ghostRow = await rawRow(ghost);
    expect(ghostRow).not.toBeNull();
    expect("mongoOptions" in (ghostRow ?? {})).toBe(false);
    expect((await rawRow(orders))?.mongoOptions).toEqual({
      collection: "orders",
      operation: "find",
    });

    await push({
      "consoles/orders.mongodb.js": serializeConsoleFile({
        name: "orders",
        language: "mongodb",
        code: "db.orders.find({ x: 1 })",
      }),
    });
    expect("mongoOptions" in ((await rawRow(orders)) ?? {})).toBe(false);
  });
});

describe("Duplicate", () => {
  it("copies a console whose row holds mongoOptions: null (an older sync wrote it)", async () => {
    const c = await save("Ghost", OWNER, "workspace");
    await mongoose.connection
      .collection("savedconsoles")
      .updateOne({ _id: c._id }, { $set: { mongoOptions: null } });

    const r = await req("POST", `/${c._id}/duplicate`, OWNER);

    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      name: "Ghost copy",
      folderId: null,
      access: "private",
    });
    const copy = await SavedConsole.findById(r.body.data?.id as string);
    expect(copy?.path).toBe(`users/${OWNER}/consoles/Ghost copy.sql`);
    expect(await consolePaths()).toEqual([
      "consoles/Ghost.sql",
      `users/${OWNER}/consoles/Ghost copy.sql`,
    ]);
  });

  it("commits nothing when the copy's row cannot be inserted, and says so", async () => {
    const c = await save("Ghost", OWNER, "workspace");
    const before = await consolePaths();
    vi.spyOn(SavedConsole.prototype, "save").mockRejectedValueOnce(
      new Error("insert failed"),
    );

    const r = await req("POST", `/${c._id}/duplicate`, OWNER);

    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toBeTruthy();
    // The commit was taken back: no orphan file for a later sync to
    // surface unannounced.
    expect(await consolePaths()).toEqual(before);
    expect(await SavedConsole.countDocuments({ name: "Ghost copy" })).toBe(0);
  });

  it("a copy of a console shared with me lands at the root of MY consoles — not in the owner's folder", async () => {
    const drafts = await manager.createFolder(
      "Team Drafts",
      WS,
      OWNER,
      undefined,
      false,
      "private",
    );
    const c = await save(
      "Secret Margin",
      OWNER,
      "private",
      drafts._id.toString(),
    );
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { sharedWith: [{ userId: EDITOR, role: "editor" }] } },
    );

    const r = await req("POST", `/${c._id}/duplicate`, EDITOR);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      name: "Secret Margin copy",
      folderId: null,
    });
    const copy = await SavedConsole.findById(r.body.data?.id as string);
    expect(copy?.path).toBe(`users/${EDITOR}/consoles/Secret Margin copy.sql`);

    // The tree agrees: the copy at the root of My Consoles, the original
    // under Shared with me — never under Workspace.
    const list = await req("GET", "", EDITOR);
    expect(names(list.body.myConsoles)).toEqual(["Secret Margin copy"]);
    expect(names(list.body.sharedWithMe)).toEqual(["Secret Margin"]);
    expect(list.body.sharedWithMe?.[0]?.path).toBe("Secret Margin");
    expect(names(list.body.sharedWithWorkspace)).toEqual([]);
  });

  it("a copy lands in MY folder of the same name when I have one", async () => {
    const theirs = await manager.createFolder(
      "Team Drafts",
      WS,
      OWNER,
      undefined,
      false,
      "private",
    );
    const mine = await manager.createFolder(
      "Team Drafts",
      WS,
      EDITOR,
      undefined,
      false,
      "private",
    );
    const c = await save(
      "Secret Margin",
      OWNER,
      "private",
      theirs._id.toString(),
    );
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { sharedWith: [{ userId: EDITOR, role: "viewer" }] } },
    );

    const r = await req("POST", `/${c._id}/duplicate`, EDITOR);
    expect(r.status).toBe(201);
    expect(r.body.data?.folderId).toBe(mine._id.toString());
    const copy = await SavedConsole.findById(r.body.data?.id as string);
    expect(copy?.path).toBe(
      `users/${EDITOR}/consoles/Team Drafts/Secret Margin copy.sql`,
    );

    const list = await req("GET", "", EDITOR);
    const myDrafts = list.body.myConsoles?.find(n => n.name === "Team Drafts");
    expect(names(myDrafts?.children as ConsoleFile[])).toEqual([
      "Secret Margin copy",
    ]);
  });

  it("an OLD copy (filed in the owner's private folder, its file under mine) is listed where its breadcrumb says", async () => {
    // What a copy made before copies were filed in the copier's folders
    // looks like: the file under MY "Team Drafts", the row pointing at the
    // OWNER's private "Team Drafts", and no folder record of mine. The tree
    // listed it at the root of My Consoles; the breadcrumb, from the file,
    // said "My Consoles › Team Drafts".
    const theirs = await manager.createFolder(
      "Team Drafts",
      WS,
      OWNER,
      undefined,
      false,
      "private",
    );
    const mine = await manager.createFolder(
      "Team Drafts",
      WS,
      EDITOR,
      undefined,
      false,
      "private",
    );
    const old = await save(
      "Secret Margin copy",
      EDITOR,
      "private",
      mine._id.toString(),
    );
    expect((await SavedConsole.findById(old._id))?.path).toBe(
      `users/${EDITOR}/consoles/Team Drafts/Secret Margin copy.sql`,
    );
    await ConsoleFolder.deleteOne({ _id: mine._id });
    await SavedConsole.updateOne(
      { _id: old._id },
      { $set: { folderId: theirs._id } },
    );

    const list = await req("GET", "", EDITOR);
    expect(names(list.body.myConsoles)).toEqual(["Team Drafts"]);
    const myDrafts = list.body.myConsoles?.[0];
    expect(names(myDrafts?.children as ConsoleFile[])).toEqual([
      "Secret Margin copy",
    ]);
    // The row now names MY folder (a record was made for the file's).
    const row = await SavedConsole.findById(old._id);
    const folder = await ConsoleFolder.findById(row?.folderId);
    expect(folder).toMatchObject({ name: "Team Drafts", access: "private" });
    expect(folder?.ownerId?.toString()).toBe(EDITOR);
    // The owner's tree is untouched: their folder, not the copy.
    const ownerList = await req("GET", "", OWNER);
    const ownerDrafts = ownerList.body.myConsoles?.find(
      n => n.name === "Team Drafts",
    );
    expect(ownerDrafts?.id).toBe(theirs._id.toString());
    expect(names(ownerDrafts?.children as ConsoleFile[])).toEqual([]);
    // And the breadcrumb's source agrees with the tree.
    const content = await req("GET", `/content?id=${old._id}`, EDITOR);
    expect((content.body as Record<string, unknown>).path).toBe(
      "Team Drafts/Secret Margin copy",
    );
  });

  it("a copy of a Workspace console is private, so never filed into the workspace folder", async () => {
    const finance = await manager.createFolder(
      "finance",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    const c = await save("Alpha", OWNER, "workspace", finance._id.toString());

    const r = await req("POST", `/${c._id}/duplicate`, OWNER);
    expect(r.status).toBe(201);
    expect(r.body.data?.folderId).toBeNull();

    const list = await req("GET", "", OWNER);
    expect(names(list.body.myConsoles)).toEqual(["Alpha copy"]);
  });
});

describe("the tree listing's folder repair never costs the listing", () => {
  /** A laptop push straight to main, with NO index sync after it. */
  const pushOnly = (files: Record<string, string>) =>
    commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: files },
      { message: "laptop", author: { name: "L", email: "l@example.com" } },
    );

  it("a whitespace-only folder name: every member's tree still lists everything, and no record is written", async () => {
    await save("Anchor", OWNER, "workspace");
    await save("Mine", EDITOR, "private");
    await pushOnly({ "consoles/ /y.sql": "SELECT 2\n" });

    // It used to answer 200 with EVERY section empty, for every member
    // (the repair's ValidationError reached the listing's catch-all).
    const owner = await req("GET", "", OWNER);
    expect(owner.status).toBe(200);
    expect(names(owner.body.sharedWithWorkspace)).toEqual(["Anchor", "y"]);
    const editor = await req("GET", "", EDITOR);
    expect(names(editor.body.myConsoles)).toEqual(["Mine"]);
    expect(names(editor.body.sharedWithWorkspace)).toEqual(["Anchor", "y"]);
    expect(await ConsoleFolder.countDocuments({})).toBe(0);
  });

  it("a padded folder name ('Team '): listed at its nearest ancestor, no stray 'Team' record, not repaired on every listing", async () => {
    await save("Anchor", OWNER, "workspace");
    const finance = await manager.createFolder(
      "finance",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    await pushOnly({
      "consoles/Team /x.sql": "SELECT 1\n",
      "consoles/finance/ /w.sql": "SELECT 3\n",
    });
    for (let i = 0; i < 3; i++) {
      const list = await req("GET", "", OWNER);
      expect(list.status).toBe(200);
      expect(names(list.body.sharedWithWorkspace)).toEqual([
        "finance",
        "Anchor",
        "x",
      ]);
      const fin = list.body.sharedWithWorkspace?.find(
        n => n.name === "finance",
      );
      expect(names(fin?.children as ConsoleFile[])).toEqual(["w"]);
    }
    const folders = await ConsoleFolder.find({}).lean();
    expect(folders.map(f => f.name)).toEqual(["finance"]);
    expect(folders[0]._id.toString()).toBe(finance._id.toString());
  });

  it("a repair that fails lists what there is", async () => {
    await save("Anchor", OWNER, "workspace");
    await pushOnly({ "consoles/Fin/z.sql": "SELECT 4\n" });
    vi.spyOn(ConsoleFolder, "create").mockRejectedValue(
      new Error("mongo is down"),
    );
    const list = await req("GET", "", OWNER);
    expect(list.status).toBe(200);
    expect(names(list.body.sharedWithWorkspace)).toEqual(["Anchor", "z"]);
  });
});
