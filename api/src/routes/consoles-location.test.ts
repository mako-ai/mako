/**
 * A rename or a move answers WHERE the console is now, and nothing else
 * moves it behind the editor's back. The editor retargets an open tab from
 * these answers (and from the revision sync), and its Cmd+S sends no place
 * at all — so a tab that missed a rename can never save the console back
 * to its old name or folder. Real routes, a real bare repo,
 * mongodb-memory-server; auth and membership stubbed per request.
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
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { serializeConsoleFile } from "../apps/console-files";
import { derivedConsoleId } from "../apps/workspace-consoles.service";
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consoles-location-"));
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
  await SavedConsole.deleteMany({});
  await ConsoleFolder.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`, rel))
      .contents;
  } catch {
    return null;
  }
}

async function consolePaths(): Promise<string[]> {
  return (await listTree(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`))
    .map(e => e.path)
    .filter(p => p.endsWith(".sql"));
}

type Body = {
  success?: boolean;
  error?: string;
  console?: Record<string, unknown>;
  data?: Record<string, unknown>;
  changed?: Array<Record<string, unknown>>;
  myConsoles?: ConsoleFile[];
  sharedWithWorkspace?: ConsoleFile[];
  sharedWithMe?: ConsoleFile[];
};

async function req(
  method: string,
  url: string,
  body: unknown,
  as: string,
  role = "member",
) {
  who.id = as;
  who.role = role;
  const res = await app.request(`/api/workspaces/${WS}/consoles${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const save = (
  name: string,
  code: string,
  owner: string,
  access: "private" | "workspace",
  folderId?: string,
) =>
  manager.saveConsole(name, code, WS, owner, undefined, undefined, undefined, {
    access,
    language: "sql",
    folderId,
  });

describe("a rename or a move answers where the console is now", () => {
  it("PATCH /rename: the new name, folder chain, visibility and revision", async () => {
    const finance = await manager.createFolder(
      "Finance",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    const c = await save(
      "Revenue Daily",
      "SELECT 1\n",
      OWNER,
      "private",
      finance._id.toString(),
    );
    const before = (await SavedConsole.findById(c._id))!;
    const r = await req(
      "PATCH",
      `/${c._id}/rename`,
      { name: "Revenue by Day" },
      OWNER,
    );
    expect(r.status).toBe(200);
    expect(r.body.console).toMatchObject({
      id: c._id.toString(),
      name: "Revenue by Day",
      path: "Finance/Revenue by Day",
      folderId: finance._id.toString(),
      // Private itself, but in a workspace folder: the workspace sees it.
      access: "workspace",
      draftRevision: (before.draftRevision ?? 1) + 1,
      isSaved: true,
    });
  });

  it("PATCH /move: one request moves + renames and answers the new place", async () => {
    const team = await manager.createFolder(
      "Team",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    const c = await save("a", "SELECT 1\n", OWNER, "workspace");
    const r = await req(
      "PATCH",
      `/${c._id}/move`,
      { folderId: team._id.toString(), name: "b" },
      OWNER,
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      name: "b",
      path: "Team/b",
      folderId: team._id.toString(),
      access: "workspace",
    });
    expect(await consolePaths()).toEqual(["consoles/Team/b.sql"]);
  });

  it("PATCH /move without a folderId renames in place — a shared editor's console stays in the owner's private folder", async () => {
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
      "SELECT 1\n",
      OWNER,
      "private",
      drafts._id.toString(),
    );
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { sharedWith: [{ userId: EDITOR, role: "editor" }] } },
    );
    const r = await req(
      "PATCH",
      `/${c._id}/move`,
      { name: "Secret Margin v2" },
      EDITOR,
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      name: "Secret Margin v2",
      path: "Team Drafts/Secret Margin v2",
      folderId: drafts._id.toString(),
      access: "private",
    });
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.folderId?.toString()).toBe(drafts._id.toString());
    expect(row.path).toBe(
      `users/${OWNER}/consoles/Team Drafts/Secret Margin v2.sql`,
    );
    // Moving it to the root (an explicit null) is still a move — and one
    // that keeps it private, so the editor may make it.
    const root = await req(
      "PATCH",
      `/${c._id}/move`,
      { folderId: null },
      EDITOR,
    );
    expect(root.status).toBe(200);
    expect(root.body.data).toMatchObject({ path: "Secret Margin v2" });
  });

  it("an admin's name-only Rename / Move of a console shared with them is PATCH /rename: it stays in its owner's folder", async () => {
    const ADMIN = new Types.ObjectId().toString();
    const drafts = await manager.createFolder(
      "Team Drafts",
      WS,
      OWNER,
      undefined,
      false,
      "private",
    );
    const c = await save(
      "Q",
      "SELECT 1\n",
      OWNER,
      "private",
      drafts._id.toString(),
    );
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { sharedWith: [{ userId: ADMIN, role: "editor" }] } },
    );
    // The admin's tree lists it under "Shared with me" — not in My
    // Consoles or Workspace — so the dialog renames it in place.
    const list = await req("GET", "", undefined, ADMIN, "admin");
    expect((list.body.sharedWithMe ?? []).map(n => n.name)).toEqual(["Q"]);
    const r = await req(
      "PATCH",
      `/${c._id}/rename`,
      { name: "Q2" },
      ADMIN,
      "admin",
    );
    expect(r.status).toBe(200);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.name).toBe("Q2");
    expect(row.folderId?.toString()).toBe(drafts._id.toString());
    expect(row.path).toBe(`users/${OWNER}/consoles/Team Drafts/Q2.sql`);
  });

  it("a rename onto a taken name is refused with the server's reason", async () => {
    await save("taken", "SELECT 1\n", OWNER, "workspace");
    const c = await save("mine", "SELECT 2\n", OWNER, "workspace");
    const r = await req("PATCH", `/${c._id}/rename`, { name: "taken" }, OWNER);
    expect(r.status).toBe(409);
    // In the explorer's words, never the repo path.
    expect(r.body.error).toBe(
      "A console named 'taken' already exists in Workspace.",
    );
    const m = await req(
      "PATCH",
      `/${c._id}/move`,
      { folderId: null, name: "taken" },
      OWNER,
    );
    expect(m.status).toBe(409);
    expect(m.body.error).toBe(
      "A console named 'taken' already exists in Workspace.",
    );
    expect((await SavedConsole.findById(c._id))?.name).toBe("mine");
  });

  it("the revision sync carries the place, so a tab in another window retargets", async () => {
    const team = await manager.createFolder(
      "Team",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    const c = await save("a", "SELECT 1\n", OWNER, "private");
    const before = (await SavedConsole.findById(c._id))!;
    await req(
      "PATCH",
      `/${c._id}/move`,
      { folderId: team._id.toString(), name: "b" },
      OWNER,
    );
    const r = await req(
      "POST",
      "/revisions-sync",
      { revisions: { [c._id.toString()]: before.draftRevision ?? 1 } },
      OWNER,
    );
    expect(r.status).toBe(200);
    expect(r.body.changed?.[0]).toMatchObject({
      id: c._id.toString(),
      name: "b",
      path: "Team/b",
      folderId: team._id.toString(),
      access: "workspace",
      content: "SELECT 1\n",
    });
  });

  it("the tree says per console whether the caller may write it (a shared editor may rename)", async () => {
    const c = await save("shared", "SELECT 1\n", OWNER, "private");
    await save("not-shared", "SELECT 2\n", OWNER, "workspace");
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { sharedWith: [{ userId: EDITOR, role: "editor" }] } },
    );
    const r = await req("GET", "", undefined, EDITOR);
    expect(r.status).toBe(200);
    // The private console shared with them is under "Shared with me".
    expect((r.body.sharedWithMe ?? []).map(n => n.name)).toEqual(["shared"]);
    const nodes = [
      ...(r.body.myConsoles ?? []),
      ...(r.body.sharedWithWorkspace ?? []),
      ...(r.body.sharedWithMe ?? []),
    ];
    const byName = new Map(nodes.map(n => [n.name, n]));
    expect(byName.get("shared")?.canWrite).toBe(true);
    expect(byName.get("not-shared")?.canWrite).toBe(false);
  });
});

describe("a save never moves a console back", () => {
  it("a stale tab's save (old name, old revision) is refused BEFORE anything moves", async () => {
    const c = await save("Revenue Daily", "SELECT 1\n", OWNER, "workspace");
    const loaded = (await SavedConsole.findById(c._id))!;
    // Another window renames it.
    const renamed = await req(
      "PATCH",
      `/${c._id}/rename`,
      { name: "Revenue by Day" },
      OWNER,
    );
    expect(renamed.status).toBe(200);
    // The stale window saves with the path and revision it loaded.
    const r = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 2\n",
        path: "Revenue Daily",
        isSaved: true,
        access: "workspace",
        expectedVersion: loaded.version,
        expectedDraftRevision: loaded.draftRevision,
      },
      OWNER,
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("version_conflict");
    expect(await consolePaths()).toEqual(["consoles/Revenue by Day.sql"]);
    expect((await SavedConsole.findById(c._id))?.name).toBe("Revenue by Day");
  });

  it("Cmd+S without a place saves the content where the console is", async () => {
    const team = await manager.createFolder(
      "Team",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    const c = await save(
      "x",
      "SELECT 1\n",
      OWNER,
      "workspace",
      team._id.toString(),
    );
    const row = (await SavedConsole.findById(c._id))!;
    const r = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 2\n",
        isSaved: true,
        expectedVersion: row.version,
        expectedDraftRevision: row.draftRevision,
      },
      OWNER,
    );
    expect(r.status).toBe(200);
    expect(await consolePaths()).toEqual(["consoles/Team/x.sql"]);
    expect(await fileAt("consoles/Team/x.sql")).toContain("SELECT 2");
  });

  it("Cmd+S without a place on a git-only console (no row yet) replaces its file, never a second 'Untitled'", async () => {
    // Adopt the repo (first write), then a laptop push nobody has indexed.
    await save("seed", "SELECT 0\n", OWNER, "workspace");
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "consoles/Team/report.sql": serializeConsoleFile({
            name: "report",
            language: "sql",
            code: "SELECT 'laptop'",
          }),
        },
      },
      { message: "laptop", author: { name: "L", email: "l@example.com" } },
    );
    const id = derivedConsoleId(WS, "consoles/Team/report.sql").toString();
    await SavedConsole.deleteOne({ _id: new Types.ObjectId(id) });
    const r = await req(
      "PUT",
      `/${id}`,
      { content: "SELECT 'edited'", isSaved: true },
      OWNER,
      "admin",
    );
    expect(r.status).toBe(200);
    expect(await fileAt("consoles/Team/report.sql")).toContain(
      "SELECT 'edited'",
    );
    expect((await consolePaths()).sort()).toEqual([
      "consoles/Team/report.sql",
      "consoles/seed.sql",
    ]);
  });
});
