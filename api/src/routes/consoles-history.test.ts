/**
 * A console's history routes read ITS OWN file only — across its renames
 * and moves, never into another console's:
 *
 * - `git log --follow` also follows COPIES (it always runs copy detection):
 *   a Workspace copy of a private console ("Save as copy", Duplicate) must
 *   not list the private console's commits nor read its file — at any
 *   commit, its current text included.
 * - A name the console moved away from can be taken by another console (a
 *   NEW private console at the old private path): the old name is readable
 *   through this console only at this console's own commits.
 * - An earlier console that held the same path before this one was created
 *   is not this console's history either.
 * - Restore only takes this console's own commits.
 * - The normal case still works: a renamed and moved console lists every
 *   commit under the name it had, diffs and restores a pre-rename version.
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
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import { ConsoleManager } from "../utils/console-manager";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { consoleRoutes } from "./consoles";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let app: Hono;
const WS = new Types.ObjectId().toString();
const ALICE = new Types.ObjectId().toString(); // owns the private consoles
const BOB = new Types.ObjectId().toString(); // any other member
const manager = new ConsoleManager();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consoles-history-"));
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

type Commit = {
  oid: string;
  subject: string;
  path: string;
  previousPath?: string;
};
type Body = {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  commits?: Commit[];
  versions?: { before: string | null; after: string | null };
};

async function req(
  method: string,
  url: string,
  as: string,
  body?: unknown,
  role = "member",
) {
  who.id = as;
  who.role = role;
  const res = await app.request(`/api/workspaces/${WS}/consoles${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const save = (
  name: string,
  code: string,
  owner: string,
  access: "private" | "workspace",
) =>
  manager.saveConsole(name, code, WS, owner, undefined, undefined, undefined, {
    access,
    language: "sql",
  });

const head = async () =>
  (await resolveCommit(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`))!;
const pathOf = async (id: unknown) => (await SavedConsole.findById(id))!.path!;
const fileAt = async (rel: string) =>
  (await readBlob(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`, rel))
    .contents;
const versions = (id: unknown, sha: string, rel?: string) =>
  req(
    "GET",
    `/${id}/git/file-versions?sha=${sha}${
      rel ? `&path=${encodeURIComponent(rel)}` : ""
    }`,
    BOB,
  );

const PAYROLL =
  "SELECT name, salary\nFROM payroll\nWHERE team = 'exec'\nORDER BY salary DESC\n";
const SECRET =
  "SELECT name, salary, ssn\nFROM payroll\nWHERE team = 'exec' -- SECRET-LATER\nORDER BY salary DESC\n";

describe("a copy does not reach the console it was copied from", () => {
  it("Save as copy: a Workspace copy of a private console lists and reads only itself", async () => {
    const priv = await save("Payroll", PAYROLL, ALICE, "private");
    const privPath = await pathOf(priv._id);
    // Alice saves a Workspace copy — the same text — then keeps working
    // privately.
    const pub = await save("Payroll (shared)", PAYROLL, ALICE, "workspace");
    const pubPath = await pathOf(pub._id);
    const put = await req("PUT", `/${priv._id}`, ALICE, {
      content: SECRET,
      isSaved: true,
    });
    expect(put.status).toBe(200);
    const privHistory = (await req("GET", `/${priv._id}/history`, ALICE)).body
      .commits!;
    const sha = await head();

    // Control: Bob cannot read the private console.
    expect((await req("GET", `/${priv._id}/history`, BOB)).status).toBe(404);

    // The copy's history is the copy's: its creation, nothing before it.
    const hist = await req("GET", `/${pub._id}/history`, BOB);
    expect(hist.status).toBe(200);
    expect(hist.body.commits!.map(c => c.path)).toEqual([pubPath]);
    expect(hist.body.commits!.map(c => c.previousPath)).toEqual([undefined]);
    const privOids = new Set(privHistory.map(c => c.oid));
    expect(hist.body.commits!.some(c => privOids.has(c.oid))).toBe(false);

    // Its creation reads as a creation: no "before" from the private file.
    const own = await versions(pub._id, hist.body.commits![0].oid);
    expect(own.status).toBe(200);
    expect(own.body.versions).toMatchObject({ before: null });
    expect(own.body.versions!.after).toContain("FROM payroll");

    // The private file is not readable through the copy — at the head
    // (her current text), at her commits, at the copy's own commit.
    for (const at of [sha, ...privHistory.map(c => c.oid)]) {
      const r = await versions(pub._id, at, privPath);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("SECRET-LATER");
    }
    expect(
      (await versions(pub._id, hist.body.commits![0].oid, privPath)).status,
    ).toBe(403);
    // Nor the private console's commits, under the copy's own name...
    const privCreated = privHistory[privHistory.length - 1].oid;
    expect((await versions(pub._id, privCreated)).status).toBe(403);
    // ...except the head, which reads the copy's own file as it is now.
    expect(privHistory[0].oid).toBe(sha);
    const now = await versions(pub._id, sha);
    expect(now.status).toBe(200);
    expect(now.body.versions!.after).toContain("FROM payroll");
    expect(now.body.versions!.after).not.toContain("SECRET-LATER");
    const changes = await req(
      "GET",
      `/${pub._id}/git/commit?sha=${privCreated}`,
      BOB,
    );
    expect(changes.status).toBe(200);
    expect(changes.body).toMatchObject({ commit: { files: [] } });
  });

  it("Duplicate: my copy of a console shared with me never reads the original after the owner unshares it", async () => {
    const orig = await save("Margin", PAYROLL, ALICE, "private");
    const origPath = await pathOf(orig._id);
    await SavedConsole.updateOne(
      { _id: orig._id },
      { $set: { sharedWith: [{ userId: BOB, role: "viewer" }] } },
    );
    const dup = await req("POST", `/${orig._id}/duplicate`, BOB);
    expect(dup.status).toBe(201);
    const copyId = dup.body.data!.id as string;
    const copyPath = await pathOf(copyId);
    expect(copyPath.startsWith(`users/${BOB}/`)).toBe(true);
    // Alice takes the share back and keeps working privately.
    await SavedConsole.updateOne(
      { _id: orig._id },
      { $set: { sharedWith: [] } },
    );
    const put = await req("PUT", `/${orig._id}`, ALICE, {
      content: SECRET,
      isSaved: true,
    });
    expect(put.status).toBe(200);
    expect((await req("GET", `/${orig._id}/history`, BOB)).status).toBe(404);

    const hist = await req("GET", `/${copyId}/history`, BOB);
    expect(hist.status).toBe(200);
    expect(hist.body.commits!.map(c => c.path)).toEqual([copyPath]);
    const r = await versions(copyId, await head(), origPath);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("SECRET-LATER");
  });

  it("Restore takes only the console's own commits: another console's commit is refused, nothing is copied in", async () => {
    const priv = await save("Payroll", PAYROLL, ALICE, "private");
    const pub = await save("Payroll (shared)", PAYROLL, ALICE, "workspace");
    const pubPath = await pathOf(pub._id);
    await req("PUT", `/${priv._id}`, ALICE, { content: SECRET, isSaved: true });
    const privHistory = (await req("GET", `/${priv._id}/history`, ALICE)).body
      .commits!;

    // An admin can write the Workspace console, not read the private one.
    for (const c of privHistory) {
      const r = await req(
        "POST",
        `/${pub._id}/restore`,
        BOB,
        { sha: c.oid },
        "admin",
      );
      expect(r.status).toBe(404);
    }
    expect(await fileAt(pubPath)).not.toContain("SECRET-LATER");
    expect((await SavedConsole.findById(pub._id))!.code).toBe(PAYROLL);
  });
});

describe("a name the console no longer has", () => {
  it("moved private -> Workspace, then a NEW private console takes the old name: the old name reads only the console's own commits", async () => {
    const a = await save(
      "Report",
      "SELECT 1 AS public_report\n",
      ALICE,
      "private",
    );
    const oldPath = await pathOf(a._id);
    const mv = await req("PATCH", `/${a._id}/move`, ALICE, {
      folderId: null,
      access: "workspace",
    });
    expect(mv.status).toBe(200);
    const newPath = await pathOf(a._id);
    expect(newPath).toBe("consoles/Report.sql");
    const b = await save(
      "Report",
      "SELECT ssn FROM people -- PRIVATE-NEW\n",
      ALICE,
      "private",
    );
    expect(await pathOf(b._id)).toBe(oldPath);
    const bHistory = (await req("GET", `/${b._id}/history`, ALICE)).body
      .commits!;
    expect((await req("GET", `/${b._id}/history`, BOB)).status).toBe(404);

    // Its history: the move and its creation under the old name — not the
    // new private console's commits.
    const hist = await req("GET", `/${a._id}/history`, BOB);
    expect(hist.status).toBe(200);
    const commits = hist.body.commits!;
    expect(commits.map(c => [c.path, c.previousPath])).toEqual([
      [newPath, oldPath],
      [oldPath, undefined],
    ]);
    expect(commits.some(c => bHistory.some(x => x.oid === c.oid))).toBe(false);

    // The old name at the head (or at the new console's commits): refused.
    for (const at of [await head(), ...bHistory.map(c => c.oid)]) {
      const r = await versions(a._id, at, oldPath);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("PRIVATE-NEW");
    }
    // The old name at the console's own commits: its own old text.
    const created = await versions(a._id, commits[1].oid, oldPath);
    expect(created.status).toBe(200);
    expect(created.body.versions).toEqual({
      before: null,
      after: "SELECT 1 AS public_report\n",
      binary: false,
    });
    // The move: before under the old name, after under the new one.
    const moved = await versions(a._id, commits[0].oid, newPath);
    expect(moved.status).toBe(200);
    expect(moved.body.versions!.before).toContain("public_report");
    expect(moved.body.versions!.after).toContain("public_report");
    const movedFrom = await versions(a._id, commits[0].oid, oldPath);
    expect(movedFrom.status).toBe(200);
    expect(movedFrom.body.versions!.after).toBeNull();
    expect(movedFrom.body.versions!.before).toContain("public_report");
  });

  it("an earlier console that held the same path is not this console's history", async () => {
    const x = await save("Plan", "SELECT 'OLD-SECRET'\n", ALICE, "private");
    const oldPath = await pathOf(x._id);
    const xHistory = (await req("GET", `/${x._id}/history`, ALICE)).body
      .commits!;
    expect(await manager.deleteConsole(x._id.toString(), WS)).toBe(true);
    const y = await save("Plan", "SELECT 'public plan'\n", ALICE, "private");
    expect(await pathOf(y._id)).toBe(oldPath);
    expect(
      (
        await req("PATCH", `/${y._id}/move`, ALICE, {
          folderId: null,
          access: "workspace",
        })
      ).status,
    ).toBe(200);

    const hist = await req("GET", `/${y._id}/history`, BOB);
    expect(hist.status).toBe(200);
    expect(hist.body.commits).toHaveLength(2); // its creation and the move
    expect(
      hist.body.commits!.some(c => xHistory.some(h => h.oid === c.oid)),
    ).toBe(false);
    expect(hist.body.commits!.some(c => /^delete/.test(c.subject))).toBe(false);
    for (const c of xHistory) {
      const r = await versions(y._id, c.oid, oldPath);
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain("OLD-SECRET");
    }
  });

  it("a console in the trash has no history to read (its path is free for another console)", async () => {
    const t = await save("Trash", "SELECT 1\n", ALICE, "private");
    await SavedConsole.updateOne(
      { _id: t._id },
      { $set: { sharedWith: [{ userId: BOB, role: "viewer" }] } },
    );
    expect((await req("GET", `/${t._id}/history`, BOB)).status).toBe(200);
    expect(await manager.softDeleteConsole(t._id.toString(), WS, ALICE)).toBe(
      true,
    );
    await save("Trash", "SELECT 'PRIVATE-NEXT'\n", ALICE, "private");
    expect((await req("GET", `/${t._id}/history`, BOB)).status).toBe(404);
    expect((await versions(t._id, await head())).status).toBe(404);
  });
});

describe("the normal case", () => {
  it("a renamed and moved console lists every commit under the name it had, diffs it, and restores a pre-rename version", async () => {
    const c = await save("first", "SELECT 1\n", ALICE, "workspace");
    const put = await req("PUT", `/${c._id}`, ALICE, {
      content: "SELECT 2\n",
      isSaved: true,
    });
    expect(put.status).toBe(200);
    expect(
      (await req("PATCH", `/${c._id}/rename`, ALICE, { name: "renamed" }))
        .status,
    ).toBe(200);
    const folder = await manager.createFolder(
      "Finance",
      WS,
      ALICE,
      undefined,
      false,
      "workspace",
    );
    expect(
      (
        await req("PATCH", `/${c._id}/move`, ALICE, {
          folderId: folder._id.toString(),
        })
      ).status,
    ).toBe(200);

    const hist = await req("GET", `/${c._id}/history`, BOB);
    expect(hist.status).toBe(200);
    const commits = hist.body.commits!;
    expect(commits.map(x => x.path)).toEqual([
      "consoles/Finance/renamed.sql",
      "consoles/renamed.sql",
      "consoles/first.sql",
      "consoles/first.sql",
    ]);
    // A pre-rename commit reads under the name it had then.
    const edit = await versions(c._id, commits[2].oid, "consoles/first.sql");
    expect(edit.status).toBe(200);
    expect(edit.body.versions!.before).toContain("SELECT 1");
    expect(edit.body.versions!.after).toContain("SELECT 2");
    // Its path omitted: the name it had in that commit.
    const implicit = await versions(c._id, commits[2].oid);
    expect(implicit.body.versions).toEqual(edit.body.versions);
    // Today's name at an old commit is not this console then.
    expect(
      (await versions(c._id, commits[2].oid, "consoles/Finance/renamed.sql"))
        .status,
    ).toBe(403);
    // The head, current name: readable even when the head did not touch it.
    expect(
      (await versions(c._id, commits[0].oid, "consoles/Finance/renamed.sql"))
        .status,
    ).toBe(200);

    // Restore the version from before the rename: a new commit, the
    // console keeps its name and folder.
    const restored = await req("POST", `/${c._id}/restore`, ALICE, {
      sha: commits[3].oid,
    });
    expect(restored.status).toBe(200);
    expect(await pathOf(c._id)).toBe("consoles/Finance/renamed.sql");
    expect(await fileAt("consoles/Finance/renamed.sql")).toContain("SELECT 1");
    const after = await req("GET", `/${c._id}/history`, BOB);
    expect(after.body.commits).toHaveLength(5);
  });
});
