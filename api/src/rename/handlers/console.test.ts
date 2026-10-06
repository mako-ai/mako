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
  initRepo,
  listTree,
  log,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
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

  it("refuses a title with a slash, a foreign extension, a taken path, and a no-op", async () => {
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
    await expect(
      renameObject(owner, "console", { ref: id, title: "a" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await treePaths()).toEqual(
      expect.arrayContaining(["consoles/a.sql", "consoles/b.sql"]),
    );
  });

  it("enforces the console's write ACL; re-scoping is the owner's call", async () => {
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
});
