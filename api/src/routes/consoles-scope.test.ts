/**
 * Who can see a console changes only by its owner, on EVERY route: the
 * editor's save (with and without a path), the explorer's rename, a folder
 * drag, a restore. Real routes against a real bare repo and
 * mongodb-memory-server; auth and membership are stubbed so the acting
 * user can be switched per request.
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
    c.set("memberRole", "member");
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
  initRepo,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { ConsoleManager } from "../utils/console-manager";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { consoleRoutes } from "./consoles";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let app: Hono;
const WS = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const EDITOR = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const manager = new ConsoleManager();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consoles-scope-"));
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
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
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

const shareWith = (id: Types.ObjectId, userId: string) =>
  SavedConsole.updateOne(
    { _id: id },
    { $set: { sharedWith: [{ userId, role: "editor" }] } },
  );

const readable = async (id: Types.ObjectId, userId: string) =>
  manager.canReadWithInheritance((await SavedConsole.findById(id))!, userId);

describe("scoped folders on the editor's save and the explorer's rename (finding 1)", () => {
  it("a private console's 'Team/x' is the owner's private Team, not the workspace Team of that name", async () => {
    const wsTeam = await manager.createFolder(
      "Team",
      WS,
      OTHER,
      undefined,
      false,
      "workspace",
    );
    const myTeam = await manager.createFolder(
      "Team",
      WS,
      OWNER,
      undefined,
      false,
      "private",
    );
    const c = await save("x", "SELECT 'owner secret'\n", OWNER, "private");
    const r = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 'owner secret'\n",
        isSaved: true,
        path: "Team/x",
        access: "private",
      },
      OWNER,
    );
    expect(r.status).toBe(200);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.folderId?.toString()).toBe(myTeam._id.toString());
    expect(row.folderId?.toString()).not.toBe(wsTeam._id.toString());
    expect(row.path).toBe(`users/${OWNER}/consoles/Team/x.sql`);
    expect(await readable(c._id, OTHER)).toBe(false);

    const c2 = await save("y", "SELECT 'owner secret y'\n", OWNER, "private");
    const r2 = await req(
      "PATCH",
      `/${c2._id}/rename`,
      { name: "Team/y" },
      OWNER,
    );
    expect(r2.status).toBe(200);
    const row2 = (await SavedConsole.findById(c2._id))!;
    expect(row2.folderId?.toString()).toBe(myTeam._id.toString());
    expect(await readable(c2._id, OTHER)).toBe(false);
  });

  it("a shared editor's plain Cmd+S keeps the console in the owner's private folder", async () => {
    const wsTeam = await manager.createFolder(
      "Team",
      WS,
      OTHER,
      undefined,
      false,
      "workspace",
    );
    const myTeam = await manager.createFolder(
      "Team",
      WS,
      OWNER,
      undefined,
      false,
      "private",
    );
    const c = await save(
      "x",
      "SELECT 'owner secret'\n",
      OWNER,
      "private",
      myTeam._id.toString(),
    );
    expect(c.path).toBe(`users/${OWNER}/consoles/Team/x.sql`);
    await shareWith(c._id, EDITOR);
    const before = (await SavedConsole.findById(c._id))!;
    const r = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 'owner secret v2'\n",
        path: "Team/x",
        isSaved: true,
        access: "private",
        expectedVersion: before.version,
        expectedDraftRevision: before.draftRevision,
      },
      EDITOR,
    );
    expect(r.status).toBe(200);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.folderId?.toString()).toBe(myTeam._id.toString());
    expect(row.folderId?.toString()).not.toBe(wsTeam._id.toString());
    expect(row.access).toBe("private");
    expect(await readable(c._id, OTHER)).toBe(false);
    expect(await fileAt(`users/${OWNER}/consoles/Team/x.sql`)).toContain("v2");
  });
});

describe("folder drag without access (finding 2)", () => {
  it("a shared editor cannot drag a folder holding the owner's private console under a workspace folder", async () => {
    const pub = await manager.createFolder(
      "Public",
      WS,
      OTHER,
      undefined,
      false,
      "workspace",
    );
    const c = await save("secret", "SELECT 'secret'\n", OWNER, "private");
    await shareWith(c._id, EDITOR);
    const mine = await manager.createFolder(
      "Mine",
      WS,
      EDITOR,
      undefined,
      false,
      "private",
    );
    expect(
      await manager.moveConsole(
        c._id.toString(),
        WS,
        mine._id.toString(),
        undefined,
        EDITOR,
      ),
    ).toBe(true);
    expect(await readable(c._id, OTHER)).toBe(false);
    const r = await req(
      "PATCH",
      `/folders/${mine._id}/move`,
      { parentId: pub._id.toString() },
      EDITOR,
    );
    expect(r.status).toBe(403);
    expect(
      (await ConsoleFolder.findById(mine._id))?.parentId ?? null,
    ).toBeNull();
    expect(await readable(c._id, OTHER)).toBe(false);
    // Saying "private" does not make a folder under a workspace folder
    // private: judged on where it lands, not on the flag.
    const flagged = await req(
      "PATCH",
      `/folders/${mine._id}/move`,
      { parentId: pub._id.toString(), access: "private" },
      EDITOR,
    );
    expect(flagged.status).toBe(403);
    expect(
      (await ConsoleFolder.findById(mine._id))?.parentId ?? null,
    ).toBeNull();
    expect(await readable(c._id, OTHER)).toBe(false);
    // The editor may still drag it under another private folder of theirs.
    const other = await manager.createFolder(
      "Archive",
      WS,
      EDITOR,
      undefined,
      false,
      "private",
    );
    const ok = await req(
      "PATCH",
      `/folders/${mine._id}/move`,
      { parentId: other._id.toString() },
      EDITOR,
    );
    expect(ok.status).toBe(200);
    expect(await readable(c._id, OTHER)).toBe(false);
  });
});

describe("explicit save without a path (finding 3)", () => {
  it("a shared editor cannot re-scope the owner's private console through a save, nor land it on another file", async () => {
    const theirs = await save(
      "x",
      "SELECT 'other workspace x'\n",
      OTHER,
      "workspace",
    );
    expect(theirs.path).toBe("consoles/x.sql");
    const c = await save("y", "SELECT 'owner secret'\n", OWNER, "private");
    await manager.relocateConsole(
      c._id.toString(),
      WS,
      { name: "x" },
      { userId: OWNER },
    );
    await shareWith(c._id, EDITOR);
    const r = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 'owner secret'\n",
        isSaved: true,
        access: "workspace",
      },
      EDITOR,
    );
    expect(r.status).toBe(403);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.access).toBe("private");
    expect(row.path).toBe(`users/${OWNER}/consoles/x.sql`);
    expect(await fileAt("consoles/x.sql")).toContain("other workspace x");
    expect(
      await SavedConsole.countDocuments({
        path: "consoles/x.sql",
        is_deleted: { $ne: true },
      }),
    ).toBe(1);
  });

  it("an owner's save with a title that is another console's name is refused; the owner's own re-scope works", async () => {
    const theirs = await save(
      "target",
      "SELECT 'other target'\n",
      OTHER,
      "workspace",
    );
    const c = await save("mine", "SELECT 'mine'\n", OWNER, "workspace");
    const r = await req(
      "PUT",
      `/${c._id}`,
      { content: "SELECT 'mine v2'\n", isSaved: true, title: "target" },
      OWNER,
    );
    expect(r.status).toBe(409);
    expect(await fileAt("consoles/target.sql")).toContain("other target");
    expect((await SavedConsole.findById(theirs._id))?.path).toBe(
      "consoles/target.sql",
    );
    expect((await SavedConsole.findById(c._id))?.name).toBe("mine");
    // Renaming to a free name, and the owner's own access flip, go through.
    const ok = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 'mine v2'\n",
        isSaved: true,
        title: "mine-2",
        access: "private",
      },
      OWNER,
    );
    expect(ok.status).toBe(200);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.path).toBe(`users/${OWNER}/consoles/mine-2.sql`);
    expect(await fileAt(`users/${OWNER}/consoles/mine-2.sql`)).toContain(
      "mine v2",
    );
    expect(await fileAt("consoles/mine.sql")).toBeNull();
  });
});

describe("draft autosave on a saved console (finding 3, the other branch)", () => {
  it("never renames or re-scopes it in the index behind the file's back", async () => {
    const theirs = await save(
      "target",
      "SELECT 'other target'\n",
      OTHER,
      "workspace",
    );
    const c = await save("mine", "SELECT 'owner secret'\n", OWNER, "private");
    await shareWith(c._id, EDITOR);
    const r = await req(
      "PUT",
      `/${c._id}`,
      {
        content: "SELECT 'edited'\n",
        title: "target",
        access: "workspace",
      },
      EDITOR,
    );
    expect(r.status).toBe(200);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.code).toBe("SELECT 'edited'\n");
    expect(row.name).toBe("mine");
    expect(row.access).toBe("private");
    expect(await readable(c._id, OTHER)).toBe(false);
    // The next plain Cmd+S stays on the console's own file.
    const saved = await req(
      "PUT",
      `/${c._id}`,
      { content: "SELECT 'edited'\n", isSaved: true },
      OWNER,
    );
    expect(saved.status).toBe(200);
    expect(await fileAt(`users/${OWNER}/consoles/mine.sql`)).toContain(
      "edited",
    );
    expect(await fileAt("consoles/target.sql")).toContain("other target");
    expect((await SavedConsole.findById(theirs._id))?.path).toBe(
      "consoles/target.sql",
    );
  });
});

describe("restore (finding 4)", () => {
  it("needs write access and a deleted console, and brings back the committed file, not the draft", async () => {
    const c = await save("rep", "SELECT 'reviewed'\n", OWNER, "workspace");
    const committed = (await fileAt("consoles/rep.sql"))!;
    // The owner's autosave leaves a draft on the row.
    expect(
      (
        await req(
          "PUT",
          `/${c._id}`,
          { content: "SELECT 'half-typed draft'\n" },
          OWNER,
        )
      ).status,
    ).toBe(200);
    // Not deleted: nobody restores it, and nothing is committed.
    expect((await req("PATCH", `/${c._id}/restore`, {}, OTHER)).status).toBe(
      403,
    );
    expect((await req("PATCH", `/${c._id}/restore`, {}, OWNER)).status).toBe(
      409,
    );
    expect(await fileAt("consoles/rep.sql")).toBe(committed);
    // Deleted, then restored by the owner: the committed file comes back.
    expect(await manager.softDeleteConsole(c._id.toString(), WS, OWNER)).toBe(
      true,
    );
    expect(await fileAt("consoles/rep.sql")).toBeNull();
    expect((await req("PATCH", `/${c._id}/restore`, {}, OTHER)).status).toBe(
      403,
    );
    const r = await req("PATCH", `/${c._id}/restore`, {}, OWNER);
    expect(r.status).toBe(200);
    expect(await fileAt("consoles/rep.sql")).toBe(committed);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.is_deleted).toBe(false);
    expect(row.code).toBe("SELECT 'half-typed draft'\n"); // still a draft on the row
  });
});

describe("restore keeps what was committed (finding 4)", () => {
  it("brings the chart back as committed, and a save never resurrects a deleted console", async () => {
    const c = await save("chart", "SELECT 1\n", OWNER, "workspace");
    expect(
      (
        await req(
          "PUT",
          `/${c._id}`,
          {
            content: "SELECT 1\n",
            isSaved: true,
            chartSpec: { mark: "bar" },
          },
          OWNER,
        )
      ).status,
    ).toBe(200);
    const committedChart = await fileAt("consoles/chart.chart.json");
    expect(committedChart).toContain("bar");
    // A draft changes the chart on the row only.
    await req(
      "PUT",
      `/${c._id}`,
      { content: "SELECT 2\n", chartSpec: { mark: "line" } },
      OWNER,
    );
    expect(await manager.softDeleteConsole(c._id.toString(), WS, OWNER)).toBe(
      true,
    );
    // Cmd+S from a tab still open on the deleted console: refused.
    const resurrect = await req(
      "PUT",
      `/${c._id}`,
      { content: "SELECT 2\n", isSaved: true },
      OWNER,
    );
    expect(resurrect.status).toBe(409);
    expect(await fileAt("consoles/chart.sql")).toBeNull();
    expect((await req("PATCH", `/${c._id}/restore`, {}, OWNER)).status).toBe(
      200,
    );
    expect(await fileAt("consoles/chart.sql")).toBe("SELECT 1\n");
    expect(await fileAt("consoles/chart.chart.json")).toBe(committedChart);
  });
});

describe("audit: every other route that writes a console's name, folder or access", () => {
  it("POST / with another member's console id neither saves over it nor publishes it", async () => {
    const c = await save("x", "SELECT 'owner secret'\n", OWNER, "private");
    const body = {
      id: c._id.toString(),
      path: "x",
      content: "SELECT 'pwned'\n",
      access: "workspace",
    };
    expect((await req("POST", "", body, OTHER)).status).toBe(403);
    await shareWith(c._id, EDITOR);
    expect((await req("POST", "", body, EDITOR)).status).toBe(403);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.code).toBe("SELECT 'owner secret'\n");
    expect(row.access).toBe("private");
    expect(await fileAt(`users/${OWNER}/consoles/x.sql`)).toContain(
      "owner secret",
    );
    expect(await fileAt("consoles/x.sql")).toBeNull();
    expect(await readable(c._id, OTHER)).toBe(false);
  });

  it("PUT by path never saves over another member's console that shares its name", async () => {
    const secret = await save("x", "SELECT 'owner secret'\n", OWNER, "private");
    const r = await req(
      "PUT",
      "/x",
      { content: "SELECT 'other x'\n", access: "workspace" },
      OTHER,
    );
    expect(r.status).toBe(200);
    const row = (await SavedConsole.findById(secret._id))!;
    expect(row.code).toBe("SELECT 'owner secret'\n");
    expect(row.access).toBe("private");
    expect(await fileAt(`users/${OWNER}/consoles/x.sql`)).toContain(
      "owner secret",
    );
    expect(await fileAt("consoles/x.sql")).toContain("other x");
    // A workspace console the caller may only read: refused, not overwritten.
    const shown = await save("rep", "SELECT 'reviewed'\n", OWNER, "workspace");
    const ro = await req(
      "PUT",
      "/rep",
      { content: "SELECT 'pwned'\n", access: "workspace" },
      OTHER,
    );
    expect(ro.status).toBe(403);
    expect((await SavedConsole.findById(shown._id))?.code).toBe(
      "SELECT 'reviewed'\n",
    );
    expect(await fileAt("consoles/rep.sql")).toContain("reviewed");
  });

  it("the save conflict dialog never hands back a console the caller cannot read", async () => {
    await save("x", "SELECT 'owner secret'\n", OWNER, "private");
    await save("y", "SELECT 'owner secret y'\n", OWNER, "private");
    const fresh = new Types.ObjectId().toString();
    const put = await req(
      "PUT",
      `/${fresh}`,
      {
        content: "SELECT 'mine'\n",
        isSaved: true,
        path: "x",
        access: "private",
      },
      OTHER,
    );
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain("owner secret");
    expect(await fileAt(`users/${OTHER}/consoles/x.sql`)).toContain("mine");
    const post = await req(
      "POST",
      "",
      {
        id: new Types.ObjectId().toString(),
        path: "y",
        content: "SELECT 'mine too'\n",
        access: "workspace",
      },
      OTHER,
    );
    expect(post.status).toBe(201);
    expect(JSON.stringify(post.body)).not.toContain("owner secret");
    expect(await fileAt("consoles/y.sql")).toContain("mine too");
    expect(await fileAt(`users/${OWNER}/consoles/x.sql`)).toContain(
      "owner secret",
    );
    expect(await fileAt(`users/${OWNER}/consoles/y.sql`)).toContain(
      "owner secret y",
    );
  });

  it("the sharing dialog's access is the owner's call, and moves the file", async () => {
    const shown = await save("w", "SELECT 'w'\n", OWNER, "workspace");
    // An admin manages sharing, but who sees the console is its owner's.
    const admin = await req(
      "PATCH",
      `/${shown._id}/sharing`,
      { access: "private" },
      OTHER,
      "admin",
    );
    expect(admin.status).toBe(403);
    expect((await SavedConsole.findById(shown._id))?.access).toBe("workspace");
    expect(await fileAt("consoles/w.sql")).toContain("'w'");
    // …the workspace role is still theirs to set.
    expect(
      (
        await req(
          "PATCH",
          `/${shown._id}/sharing`,
          { workspaceRole: "editor" },
          OTHER,
          "admin",
        )
      ).status,
    ).toBe(200);
    // The owner publishes their own: the row and the file move together.
    const mine = await save("s", "SELECT 's'\n", OWNER, "private");
    const pub = await req(
      "PATCH",
      `/${mine._id}/sharing`,
      { access: "workspace" },
      OWNER,
    );
    expect(pub.status).toBe(200);
    const row = (await SavedConsole.findById(mine._id))!;
    expect(row.access).toBe("workspace");
    expect(row.path).toBe("consoles/s.sql");
    expect(await fileAt("consoles/s.sql")).toContain("'s'");
    expect(await fileAt(`users/${OWNER}/consoles/s.sql`)).toBeNull();
  });

  it("a duplicate is a read, and a second copy gets its own file", async () => {
    const secret = await save("s", "SELECT 'owner secret'\n", OWNER, "private");
    expect(
      (await req("POST", `/${secret._id}/duplicate`, {}, OTHER)).status,
    ).toBe(404);
    const shown = await save("w", "SELECT 'w'\n", OWNER, "workspace");
    const one = await req("POST", `/${shown._id}/duplicate`, {}, OTHER);
    const two = await req("POST", `/${shown._id}/duplicate`, {}, OTHER);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    const copies = await SavedConsole.find({ owner_id: OTHER }).sort({
      createdAt: 1,
    });
    expect(copies.map(c => c.path).sort()).toEqual([
      `users/${OTHER}/consoles/w copy (2).sql`,
      `users/${OTHER}/consoles/w copy.sql`,
    ]);
  });
});
