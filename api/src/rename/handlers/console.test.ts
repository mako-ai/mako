/**
 * The console rename handler end to end: a real bare repo under a temp
 * APPS_GIT_ROOT, mongodb-memory-server for the index — the same rig as
 * workspace-consoles.service.test.ts, pointed at the rename contract.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ConsoleFolder, SavedConsole } from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import {
  adoptWorkspaceConsoles,
  syncConsolesIndexFromRepo,
} from "../../apps/workspace-consoles.service";
import { ConsoleManager } from "../../utils/console-manager";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../../apps/bind-test-workspace-repo";
import { renameObject, resolveObjectRef } from "../registry";
import { RenameError } from "../types";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const OWNER = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const manager = new ConsoleManager();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rename-console-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await unbindTestWorkspaceRepo(WS);
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

async function treePaths(): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  if (!head) return [];
  return (await listTree(repoDirFor(WS), head)).map(e => e.path).sort();
}

async function seed(
  name: string,
  access: "workspace" | "private" = "workspace",
) {
  return manager.saveConsole(
    name,
    "SELECT 1",
    WS,
    OWNER,
    undefined,
    undefined,
    undefined,
    { access, language: "sql" },
  );
}

const owner = { workspaceId: WS, userId: OWNER, role: "member" };
const other = { workspaceId: WS, userId: OTHER, role: "member" };
const apiKey = { workspaceId: WS };

describe("resolve", () => {
  it("answers by id, by repo path, by folder-qualified name, and by a unique bare name", async () => {
    const saved = await seed("report");
    const id = saved._id.toString();
    for (const ref of [id, "consoles/report.sql", "report"]) {
      const hit = await resolveObjectRef(owner, "console", ref);
      expect(hit, ref).toMatchObject({
        kind: "console",
        id,
        via: "current",
        current: {
          title: "report",
          path: "consoles/report.sql",
          url: `/c/${id}`,
        },
      });
    }
    expect(await resolveObjectRef(owner, "console", "nope")).toBeNull();
  });

  it("a bare name two folders' consoles share resolves to nothing; a qualified name or a root console wins", async () => {
    const teamDup = await seed("dup-a");
    const opsDup = await seed("dup-b");
    await renameObject(owner, "console", {
      ref: teamDup._id.toString(),
      slug: "Team/dup",
    });
    await renameObject(owner, "console", {
      ref: opsDup._id.toString(),
      slug: "Ops/dup",
    });
    expect(await resolveObjectRef(owner, "console", "dup")).toBeNull();
    expect((await resolveObjectRef(owner, "console", "Team/dup"))?.id).toBe(
      teamDup._id.toString(),
    );
    // A console AT the root is exactly "dup": it wins over nested namesakes,
    // the same rule apps use for a bare slug.
    const rootDup = await seed("dup");
    expect((await resolveObjectRef(owner, "console", "dup"))?.id).toBe(
      rootDup._id.toString(),
    );
  });

  it("after a git-born console is renamed, a new file at its old name resolves and renames on its own", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "consoles/report.sql": "SELECT 'original'\n" } },
      { message: "laptop" },
    );
    await syncConsolesIndexFromRepo(WS, OWNER);
    const old = (await resolveObjectRef(owner, "console", "report"))!.id;
    await renameObject(owner, "console", { ref: old, title: "report-old" });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "consoles/report.sql": "SELECT 'brand new'\n" } },
      { message: "laptop again" },
    );
    // Not yet synced: resolve finds the new file, not the renamed row.
    const resolved = await resolveObjectRef(owner, "console", "report");
    expect(resolved?.current.path).toBe("consoles/report.sql");
    expect(resolved?.id).not.toBe(old);
    // The new file has no known pusher (owner "git"): a plain member may
    // not write a workspace console without an editor role; an admin may.
    await expect(
      renameObject(owner, "console", { ref: "report", title: "report-new" }),
    ).rejects.toMatchObject({ status: 403 });
    const result = await renameObject({ ...owner, role: "admin" }, "console", {
      ref: "report",
      title: "report-new",
    });
    expect(result.id).not.toBe(old);
    expect(result.before.path).toBe("consoles/report.sql");
    expect(result.after.path).toBe("consoles/report-new.sql");
    expect(await treePaths()).toEqual(
      expect.arrayContaining([
        "consoles/report-old.sql",
        "consoles/report-new.sql",
      ]),
    );
    expect(await treePaths()).not.toContain("consoles/report.sql");
    expect((await SavedConsole.findById(old))?.path).toBe(
      "consoles/report-old.sql",
    );
  });

  it("a lookup never makes the reader the owner of unindexed consoles; the write rule decides renames", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "consoles/alpha.sql": "SELECT 'a'\n",
          "consoles/beta.sql": "SELECT 'b'\n",
        },
      },
      { message: "laptop push by a teammate" },
    );
    const hit = await resolveObjectRef(other, "console", "alpha");
    expect(hit?.current.path).toBe("consoles/alpha.sql");
    for (const path of ["consoles/alpha.sql", "consoles/beta.sql"]) {
      const row = await SavedConsole.findOne({ workspaceId: WS, path });
      expect(row?.owner_id).not.toBe(OTHER);
      expect(row?.createdBy).not.toBe(OTHER);
    }
    const beta = (await SavedConsole.findOne({
      workspaceId: WS,
      path: "consoles/beta.sql",
    }))!;
    // OTHER (a member) can neither take it private nor rename it…
    await expect(
      renameObject(other, "console", {
        ref: beta._id.toString(),
        slug: `users/${OTHER}/consoles/beta.sql`,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      renameObject(other, "console", {
        ref: beta._id.toString(),
        title: "beta-2",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await SavedConsole.findById(beta._id))?.path).toBe(
      "consoles/beta.sql",
    );
    // …an admin can rename it, and so can a member once the row grants
    // workspace members an editor role — the ordinary write rules.
    const asAdmin = await renameObject({ ...other, role: "admin" }, "console", {
      ref: beta._id.toString(),
      title: "beta-admin",
    });
    expect(asAdmin.after.path).toBe("consoles/beta-admin.sql");
    await SavedConsole.updateOne(
      { _id: beta._id },
      { $set: { workspaceRole: "editor" } },
    );
    const asEditor = await renameObject(other, "console", {
      ref: beta._id.toString(),
      title: "beta-editor",
    });
    expect(asEditor.after.path).toBe("consoles/beta-editor.sql");
    // Still nobody's private console.
    await expect(
      renameObject(other, "console", {
        ref: beta._id.toString(),
        slug: `users/${OTHER}/consoles/beta-editor.sql`,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a ref that names a folder must match that folder; only a bare name falls back to the leaf", async () => {
    const report = await seed("report");
    await renameObject(owner, "console", {
      ref: report._id.toString(),
      slug: "Live/report",
    });
    expect(
      await resolveObjectRef(owner, "console", "Archive/report"),
    ).toBeNull();
    expect((await resolveObjectRef(owner, "console", "Live/report"))?.id).toBe(
      report._id.toString(),
    );
    expect((await resolveObjectRef(owner, "console", "report"))?.id).toBe(
      report._id.toString(),
    );
  });

  it("does not leak a private console to another member", async () => {
    const mine = await seed("secret", "private");
    expect(
      await resolveObjectRef(other, "console", mine._id.toString()),
    ).toBeNull();
    expect(
      await resolveObjectRef(owner, "console", mine._id.toString()),
    ).not.toBeNull();
    // A workspace API key (no user) sees it, as the console tools do.
    expect(
      await resolveObjectRef(apiKey, "console", mine._id.toString()),
    ).not.toBeNull();
  });
});

describe("rename", () => {
  it("title renames the file in place: same id, one commit, old file gone", async () => {
    const saved = await seed("old");
    const commitsBefore = (await log(repoDirFor(WS), MAIN, 50)).length;
    const result = await renameObject(owner, "console", {
      ref: saved._id.toString(),
      title: "new",
    });
    expect(result).toMatchObject({
      kind: "console",
      id: saved._id.toString(),
      before: { title: "old", path: "consoles/old.sql" },
      after: { title: "new", path: "consoles/new.sql", url: `/c/${saved._id}` },
      aliasesAdded: [],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    const history = await log(repoDirFor(WS), MAIN, 50);
    expect(history.length).toBe(commitsBefore + 1);
    expect(history[0]?.subject).toBe("rename: new");
    expect(await treePaths()).toEqual(
      expect.arrayContaining(["consoles/new.sql"]),
    );
    expect(await treePaths()).not.toContain("consoles/old.sql");
    expect((await SavedConsole.findById(saved._id))?.name).toBe("new");
  });

  it("slug moves into a folder chain (created on demand) in one commit, by path or by `Folder/name`", async () => {
    const saved = await seed("moving");
    const first = await renameObject(owner, "console", {
      ref: saved._id.toString(),
      slug: "consoles/Sales/EMEA/moving.sql",
    });
    expect(first.after.path).toBe("consoles/Sales/EMEA/moving.sql");
    expect((await log(repoDirFor(WS), MAIN, 5))[0]?.subject).toBe(
      "move: moving",
    );
    expect(await ConsoleFolder.countDocuments({ workspaceId: WS })).toBe(2);

    const second = await renameObject(owner, "console", {
      ref: "consoles/Sales/EMEA/moving.sql",
      slug: "Sales/renamed-too",
    });
    expect(second.after).toMatchObject({
      title: "renamed-too",
      path: "consoles/Sales/renamed-too.sql",
    });
    expect(await treePaths()).not.toContain("consoles/Sales/EMEA/moving.sql");
  });

  it("a slug naming the console's current place — short or full form — is a no-op success", async () => {
    const report = await seed("report");
    const id = report._id.toString();
    await renameObject(owner, "console", { ref: id, slug: "Team/report" });
    const expected = {
      kind: "console",
      id,
      aliasesAdded: [],
      warnings: ["Nothing to change: it already has that name."],
    };
    const short = await renameObject(owner, "console", {
      ref: id,
      slug: "Team/report",
    });
    expect(short).toMatchObject(expected);
    expect(short.after).toEqual(short.before);
    expect(short.after.path).toBe("consoles/Team/report.sql");
    expect(short.commit).toBeUndefined();
    const full = await renameObject(owner, "console", {
      ref: id,
      slug: "consoles/Team/report.sql",
    });
    expect(full).toMatchObject(expected);
    expect(full.after).toEqual(short.after);
    // Title alongside the short form, both current: still nothing to do.
    const both = await renameObject(owner, "console", {
      ref: id,
      slug: "Team/report",
      title: "report",
    });
    expect(both.warnings).toEqual(expected.warnings);
  });

  it("a private path files the console into the OWNER'S private folder, not the workspace folder of that name", async () => {
    const team = await manager.createFolder(
      "Team",
      WS,
      OWNER,
      undefined,
      false,
      "workspace",
    );
    const c = await manager.saveConsole(
      "report",
      "SELECT 'secret'\n",
      WS,
      OWNER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql", folderId: team._id.toString() },
    );
    expect(c.path).toBe("consoles/Team/report.sql");
    const res = await renameObject(owner, "console", {
      ref: c._id.toString(),
      slug: `users/${OWNER}/consoles/Team/report.sql`,
    });
    expect(res.after.path).toBe(`users/${OWNER}/consoles/Team/report.sql`);
    const row = (await SavedConsole.findById(c._id))!;
    expect(row.access).toBe("private");
    expect(row.folderId?.toString()).not.toBe(team._id.toString());
    const privateTeam = await ConsoleFolder.findById(row.folderId);
    expect(privateTeam?.name).toBe("Team");
    expect(privateTeam?.ownerId?.toString()).toBe(OWNER);
    expect(
      ConsoleManager.resolveAccess({
        access: privateTeam?.access,
        isPrivate: privateTeam?.isPrivate,
      } as never),
    ).toBe("private");
    expect(await manager.canReadWithInheritance(row, OTHER)).toBe(false);
    const split = await manager.listConsolesSplit(WS, OTHER, "member");
    const flat = (
      items: Array<{ id?: string; children?: unknown[] }>,
    ): Array<{ id?: string }> =>
      items.flatMap(i => [i, ...flat((i.children ?? []) as never[])]);
    expect(
      flat(split.sharedWithWorkspace as never[]).some(
        i => i.id === c._id.toString(),
      ),
    ).toBe(false);
    // A shared editor cannot do the reverse (into a workspace folder by path).
    const secret = await manager.saveConsole(
      "secret",
      "SELECT 1\n",
      WS,
      OWNER,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: secret._id },
      { $set: { sharedWith: [{ userId: OTHER, role: "editor" }] } },
    );
    // Nor move it at all — even within the owner's own tree: a shared
    // editor renames it where it is.
    await expect(
      renameObject(other, "console", {
        ref: secret._id.toString(),
        slug: `users/${OWNER}/consoles/Team/secret.sql`,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const kept = (await SavedConsole.findById(secret._id))!;
    expect(kept.path).toBe(`users/${OWNER}/consoles/secret.sql`);
    expect(
      await manager.canReadWithInheritance(
        kept,
        new Types.ObjectId().toString(),
      ),
    ).toBe(false);
    await expect(
      renameObject(other, "console", {
        ref: secret._id.toString(),
        slug: "secret-2",
      }),
    ).resolves.toMatchObject({
      after: { path: `users/${OWNER}/consoles/secret-2.sql` },
    });
  });

  it("a full path without its extension is the console's file type, never a folder called 'consoles'", async () => {
    const c = await seed("report");
    const id = c._id.toString();
    const moved = await renameObject(owner, "console", {
      ref: id,
      slug: "consoles/Team/report",
    });
    expect(moved.after.path).toBe("consoles/Team/report.sql");
    expect(
      await ConsoleFolder.countDocuments({ workspaceId: WS, name: "consoles" }),
    ).toBe(0);
    const priv = await renameObject(owner, "console", {
      ref: id,
      slug: `users/${OWNER}/consoles/Team/report`,
    });
    expect(priv.after.path).toBe(`users/${OWNER}/consoles/Team/report.sql`);
    expect(
      await ConsoleFolder.countDocuments({ workspaceId: WS, name: "users" }),
    ).toBe(0);
    await expect(
      renameObject(owner, "console", {
        ref: id,
        slug: "users/somebody/report",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await ConsoleFolder.countDocuments({ workspaceId: WS })).toBe(2);
  });

  it("refuses a title with a slash, a foreign extension, a taken path; a no-op succeeds", async () => {
    const a = await seed("a");
    await seed("b");
    const id = a._id.toString();
    await expect(
      renameObject(owner, "console", { ref: id, title: "Team/a" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(owner, "console", { ref: id, slug: "a.js" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(owner, "console", { ref: id, title: "b" }),
    ).rejects.toMatchObject({ status: 409 });
    // The same answer for every kind (registry.ts): nothing to do, no commit.
    const noop = await renameObject(owner, "console", { ref: id, title: "a" });
    expect(noop.warnings[0]).toMatch(/Nothing to change/);
    expect(noop.commit).toBeUndefined();
    expect(await treePaths()).toEqual(
      expect.arrayContaining(["consoles/a.sql", "consoles/b.sql"]),
    );
  });

  it("enforces the console's write ACL; re-scoping is not a member's call", async () => {
    const mine = await seed("mine", "private");
    const id = mine._id.toString();
    await expect(
      renameObject(other, "console", { ref: id, title: "theirs" }),
    ).rejects.toBeInstanceOf(RenameError);
    const shared = await seed("shared");
    await expect(
      renameObject(other, "console", {
        ref: shared._id.toString(),
        slug: `users/${OTHER}/consoles/shared.sql`,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // The owner may move their private console into the workspace tree…
    const moved = await renameObject(owner, "console", {
      ref: id,
      slug: "consoles/Public/mine.sql",
    });
    expect(moved.after.path).toBe("consoles/Public/mine.sql");
    expect((await SavedConsole.findById(id))?.access).toBe("workspace");
    // …and a workspace API key renames without a per-user ACL.
    const viaKey = await renameObject(apiKey, "console", {
      ref: id,
      title: "by key",
    });
    expect(viaKey.after.path).toBe("consoles/Public/by key.sql");
  });

  it("re-scoping is the owner's or a workspace admin's call; a shared editor is refused", async () => {
    const ADMIN = new Types.ObjectId().toString();
    const admin = { workspaceId: WS, userId: ADMIN, role: "admin" };
    const shown = await seed("shown");
    const id = shown._id.toString();
    // A shared editor may write it, but not take it out of the workspace.
    await SavedConsole.updateOne(
      { _id: shown._id },
      { $set: { sharedWith: [{ userId: OTHER, role: "editor" }] } },
    );
    await expect(
      renameObject(other, "console", {
        ref: id,
        slug: `users/${OWNER}/consoles/shown.sql`,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await SavedConsole.findById(id))?.access).toBe("workspace");
    // A workspace admin may — under the owner's private root, as always.
    const result = await renameObject(admin, "console", {
      ref: id,
      slug: `users/${OWNER}/consoles/shown.sql`,
    });
    expect(result.after.path).toBe(`users/${OWNER}/consoles/shown.sql`);
    const row = (await SavedConsole.findById(id))!;
    expect(row.access).toBe("private");
    expect(row.owner_id).toBe(OWNER);
    expect(await treePaths()).toContain(`users/${OWNER}/consoles/shown.sql`);
    expect(await treePaths()).not.toContain("consoles/shown.sql");
  });
});
