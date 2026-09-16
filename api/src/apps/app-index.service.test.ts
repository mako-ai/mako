/**
 * Apps in real folders: the index that reads the tree at main, the identity
 * that rides in `mako.json`, and the moves that keep it.
 *
 * Real bare repos under a temp APPS_GIT_ROOT and in-memory Mongo, the same
 * harness as the consoles suite. The claims under test:
 *
 *  - an app is any folder with a manifest under apps/ or users/<id>/apps/,
 *    at any depth, and nothing inside an app is a second app;
 *  - an app without a manifest id keeps the id it always had (derived from
 *    `apps/<slug>`), so existing deployments and artifacts do not move;
 *  - a move is a commit that keeps the id — stamping it into the manifest
 *    when it was missing — and an app that already had one keeps the same
 *    tree oid, so deploy-on-push sees nothing to rebuild;
 *  - a copied folder that declares another app's id does not steal it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
} from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";
import {
  assignAppIds,
  discoverApps,
  invalidateAppsIndexCache,
  loadAppsIndex,
  resolveAppRef,
} from "./app-index.service";
import { derivedAppId, parseAppManifest } from "./app-paths";
import {
  createAppFolder,
  createProject,
  deleteAppFolder,
  ensureProjectRow,
  moveAppFolder,
  moveProject,
  resolveProjectRef,
  readFile,
  globFiles,
  stampAppId,
} from "./worktree.service";
import { appFolderChanged } from "./deploy-on-push";
import { runGit } from "./git";
import { canReadResource } from "../utils/resource-acl";
import { up as isolateAppIds } from "../migrations/2026-09-16-190000_app_identity_isolation";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-index-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const B_ID = new Types.ObjectId().toHexString();

const manifest = (title: string, id?: string) =>
  JSON.stringify({ ...(id ? { id } : {}), schemaVersion: 1, title }, null, 2) +
  "\n";

beforeEach(async () => {
  await AppIndexEntry.deleteMany({});
  await AppIndexHead.deleteMany({});
  await AppProject.deleteMany({});
  await unbindTestWorkspaceRepo(WS);
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "README.md": "x\n",
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": "export {}\n",
    // Something inside an app that looks like an app must not split it.
    "apps/a/fixtures/mako.json": manifest("Not an app"),
    "apps/Sales/CH/b/mako.json": manifest("B", B_ID),
    "apps/Sales/CH/b/bindings/rows.sql":
      "-- connection: c1\n-- schedule: 0 * * * *\nselect 1\n",
    "apps/Empty/.gitkeep": "",
    "apps/README.md": "stray file, not an app\n",
    [`users/${USER}/apps/c/mako.json`]: manifest("C"),
    "consoles/x.sql": "select 1\n",
  });
  await bindTestWorkspaceRepo(WS);
});

async function externalCommit(
  writes: Record<string, string>,
  deletes: string[] = [],
  message = "external edit",
) {
  const result = await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message, author: { name: "Laptop", email: "laptop@example.com" } },
  );
  invalidateAppsIndexCache(WS);
  return result;
}

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

async function treeOidOf(rel: string, ref = MAIN): Promise<string> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(WS),
    "rev-parse",
    `${ref}:${rel}`,
  ]);
  return stdout.trim();
}

describe("discoverApps", () => {
  it("does not promote a manifest-less project's directories to folders", () => {
    const out = discoverApps([
      { type: "tree", oid: "t1", path: "apps" },
      { type: "tree", oid: "t2", path: "apps/legacy" },
      { type: "blob", oid: "b1", path: "apps/legacy/package.json" },
      { type: "tree", oid: "t3", path: "apps/legacy/src" },
      { type: "blob", oid: "b2", path: "apps/legacy/src/main.tsx" },
      { type: "tree", oid: "t4", path: "apps/Sales" },
      { type: "blob", oid: "b3", path: "apps/Sales/.gitkeep" },
    ]);
    expect(out.apps).toEqual([]);
    expect(out.folders).toEqual(["apps/Sales"]);
  });

  it("is pure over a tree listing: apps at any depth, folders, nothing inside an app", () => {
    const out = discoverApps([
      { type: "tree", oid: "t1", path: "apps" },
      { type: "tree", oid: "t2", path: "apps/a" },
      { type: "blob", oid: "b1", path: "apps/a/mako.json" },
      { type: "tree", oid: "t3", path: "apps/a/fixtures" },
      { type: "blob", oid: "b2", path: "apps/a/fixtures/mako.json" },
      { type: "tree", oid: "t4", path: "apps/Sales" },
      { type: "tree", oid: "t5", path: "apps/Sales/CH" },
      { type: "tree", oid: "t6", path: "apps/Sales/CH/b" },
      { type: "blob", oid: "b3", path: "apps/Sales/CH/b/mako.json" },
      { type: "blob", oid: "b4", path: "apps/Sales/CH/b/bindings/rows.sql" },
      { type: "tree", oid: "t7", path: "apps/Empty" },
      { type: "blob", oid: "b5", path: "apps/Empty/.gitkeep" },
      { type: "blob", oid: "b6", path: "apps/README.md" },
      { type: "tree", oid: "t8", path: "users" },
      { type: "tree", oid: "t9", path: "users/u1" },
      { type: "tree", oid: "t10", path: "users/u1/apps" },
      { type: "tree", oid: "t11", path: "users/u1/apps/c" },
      { type: "blob", oid: "b7", path: "users/u1/apps/c/mako.json" },
      { type: "tree", oid: "t12", path: "users/u1/consoles" },
    ]);
    // Sorted by path, locale-aware (so "a" sorts before "Sales").
    expect(out.apps.map(a => [a.path, a.scope, a.ownerId, a.treeOid])).toEqual([
      ["apps/a", "workspace", undefined, "t2"],
      ["apps/Sales/CH/b", "workspace", undefined, "t6"],
      ["users/u1/apps/c", "private", "u1", "t11"],
    ]);
    expect(out.apps[1].bindingBlobs.get("rows")).toBe("b4");
    expect(out.folders).toEqual(["apps/Empty", "apps/Sales", "apps/Sales/CH"]);
  });
});

describe("the index", () => {
  it("rebuilds an older index at the same git sha before serving legacy permissions", async () => {
    const legacy = await AppProject.create({
      workspaceId: WS,
      slug: "a",
      title: "A",
      access: "private",
      createdBy: USER,
    });
    await loadAppsIndex(WS);
    await AppIndexEntry.updateOne(
      { workspaceId: WS, path: "apps/a" },
      { $set: { appId: derivedAppId(WS, "a").toHexString() } },
    );
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $unset: { schemaVersion: 1 } },
    );
    invalidateAppsIndexCache();
    const resolved = (await resolveProjectRef(WS, "a"))!;
    expect(resolved._id).toEqual(legacy._id);
    expect(canReadResource(resolved, "someone-else", "member")).toBe(false);
  });

  it("rebuilds duplicate index identities without touching app state, and migrates twice", async () => {
    const state = await AppProject.create({
      workspaceId: WS,
      slug: "a",
      title: "A",
      access: "private",
      createdBy: USER,
    });
    await loadAppsIndex(WS);
    await AppIndexEntry.collection.dropIndex("appId_1");
    const original = await AppIndexEntry.findOne({ appId: B_ID }).lean();
    if (!original || !mongoose.connection.db) {
      throw new Error("Missing fixture");
    }
    await AppIndexEntry.collection.insertOne({
      ...original,
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(),
    });
    await isolateAppIds(mongoose.connection.db);
    await isolateAppIds(mongoose.connection.db);
    expect(await AppIndexEntry.countDocuments()).toBe(0);
    expect(await AppIndexHead.countDocuments()).toBe(0);
    expect((await AppProject.findById(state._id))?.access).toBe("private");
    invalidateAppsIndexCache();
    expect((await resolveProjectRef(WS, "a"))?._id).toEqual(state._id);
  });

  it("preserves a legacy private app's random id, permissions and deployment", async () => {
    const legacy = await AppProject.create({
      workspaceId: WS,
      slug: "a",
      title: "A",
      access: "private",
      owner_id: USER,
      createdBy: USER,
      publishedSha: "a".repeat(40),
    });
    const resolved = (await resolveProjectRef(WS, "a"))!;
    expect(resolved._id.toString()).toBe(legacy._id.toString());
    expect(resolved.publishedSha).toBe(legacy.publishedSha);
    expect(canReadResource(resolved, "another-user", "member")).toBe(false);
    expect((await ensureProjectRow(resolved, USER))._id).toEqual(legacy._id);
    await moveProject(resolved, {
      scope: "workspace",
      folderSegments: ["Legacy"],
    });
    expect(
      parseAppManifest(await fileAt("apps/Legacy/a/mako.json"), "a").id,
    ).toBe(legacy.id);
    expect((await resolveProjectRef(WS, legacy.id))?.access).toBe("private");
  });

  it("gives a manifest claiming another workspace's state a separate id", async () => {
    const foreign = await AppProject.create({
      _id: B_ID,
      workspaceId: new Types.ObjectId(),
      slug: "foreign",
      title: "Foreign",
      access: "private",
      createdBy: "foreign-owner",
    });
    const resolved = (await resolveProjectRef(WS, "b"))!;
    expect(resolved._id.toString()).not.toBe(B_ID);
    const persisted = await ensureProjectRow(resolved, USER);
    expect(persisted.workspaceId.toString()).toBe(WS);
    expect((await AppProject.findById(B_ID))?.workspaceId).toEqual(
      foreign.workspaceId,
    );
    // Defense in depth: even a stale/forged caller shape cannot return foreign state.
    await expect(
      ensureProjectRow({ ...resolved, _id: foreign._id }, USER),
    ).rejects.toThrow();
  });

  it("arbitrates concurrent manifest claims from two workspaces atomically", async () => {
    const otherWS = new Types.ObjectId().toString();
    await initRepo(repoDirFor(otherWS), {
      "apps/copy/mako.json": manifest("Copy", B_ID),
    });
    await bindTestWorkspaceRepo(otherWS);
    try {
      const [first, second] = await Promise.all([
        loadAppsIndex(WS),
        loadAppsIndex(otherWS),
      ]);
      const original = first.apps.find(a => a.slug === "b")!;
      expect(original.appId).not.toBe(second.apps[0].appId);
      expect([original.appId, second.apps[0].appId]).toContain(B_ID);
    } finally {
      await unbindTestWorkspaceRepo(otherWS);
    }
  });

  it("does not give a duplicate fallback an id claimed by another app", () => {
    const fallback = derivedAppId(WS, "copy").toHexString();
    const ids = assignAppIds(
      WS,
      [
        { path: "apps/original", declaredId: B_ID },
        { path: "apps/copy", declaredId: B_ID },
        { path: "apps/third", declaredId: fallback },
      ],
      new Map([[B_ID, "apps/original"]]),
    );
    expect(new Set([...ids.values()].map(a => a.appId)).size).toBe(3);
  });

  it("lists every app folder with its identity, scope and schedules", async () => {
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.sha).toBe(await resolveCommit(repoDirFor(WS), MAIN));
    expect(snapshot.apps.map(a => a.path)).toEqual([
      "apps/a",
      "apps/Sales/CH/b",
      `users/${USER}/apps/c`,
    ]);
    const a = snapshot.apps.find(x => x.slug === "a")!;
    const b = snapshot.apps.find(x => x.slug === "b")!;
    const c = snapshot.apps.find(x => x.slug === "c")!;
    // No manifest id: the id every top-level app already had.
    expect(a.appId).toBe(derivedAppId(WS, "a").toHexString());
    expect(a.hasManifestId).toBe(false);
    expect(b.appId).toBe(B_ID);
    expect(b.hasManifestId).toBe(true);
    expect(b.schedules).toEqual([{ binding: "rows", cron: "0 * * * *" }]);
    expect(c.scope).toBe("private");
    expect(c.ownerId).toBe(USER);
    expect(snapshot.folders).toEqual([
      "apps/Empty",
      "apps/Sales",
      "apps/Sales/CH",
    ]);
    // Persisted, so every instance and the scheduler read the same rows.
    expect(
      await AppIndexEntry.countDocuments({
        workspaceId: new Types.ObjectId(WS),
      }),
    ).toBe(3);
    const head = await AppIndexHead.findOne({
      workspaceId: new Types.ObjectId(WS),
    }).lean();
    expect(head?.sha).toBe(snapshot.sha);
  });

  it("resolves a ref by id, by path (with or without apps/), and by slug", async () => {
    const b = (await resolveAppRef(WS, B_ID))!;
    expect(b.path).toBe("apps/Sales/CH/b");
    expect((await resolveAppRef(WS, "apps/Sales/CH/b"))?.appId).toBe(B_ID);
    expect((await resolveAppRef(WS, "Sales/CH/b"))?.appId).toBe(B_ID);
    expect((await resolveAppRef(WS, "b"))?.appId).toBe(B_ID);
    expect((await resolveAppRef(WS, "a"))?.path).toBe("apps/a");
    expect(await resolveAppRef(WS, "nope")).toBeNull();
    // A shared slug is ambiguous unless one of them is the top-level app.
    await externalCommit({ "apps/Other/a/mako.json": manifest("Other A") });
    expect((await resolveAppRef(WS, "a"))?.path).toBe("apps/a");
    await externalCommit({ "apps/Other/b/mako.json": manifest("Other B") });
    expect(await resolveAppRef(WS, "b")).toBeNull();
    expect((await resolveAppRef(WS, "Other/b"))?.path).toBe("apps/Other/b");
  });

  it("drops rows whose folder left main, and follows a manual git mv by id", async () => {
    await loadAppsIndex(WS);
    await externalCommit({}, [
      "apps/a/mako.json",
      "apps/a/src/main.tsx",
      "apps/a/fixtures/mako.json",
    ]);
    let snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.map(a => a.slug)).toEqual(["b", "c"]);

    // A `git mv` from a laptop: b's manifest carries its id, so the row
    // (and any project row) follows it to the new path.
    const row = await ensureProjectRow(
      (await resolveProjectRef(WS, B_ID))!,
      USER,
    );
    expect(row.path).toBe("apps/Sales/CH/b");
    await externalCommit(
      {
        "apps/Ops/b/mako.json": manifest("B", B_ID),
        "apps/Ops/b/bindings/rows.sql":
          "-- connection: c1\n-- schedule: 0 * * * *\nselect 1\n",
      },
      ["apps/Sales/CH/b/mako.json", "apps/Sales/CH/b/bindings/rows.sql"],
      "git mv apps/Sales/CH/b apps/Ops/b",
    );
    snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.appId === B_ID)?.path).toBe("apps/Ops/b");
    expect((await AppProject.findById(B_ID))?.path).toBe("apps/Ops/b");
  });

  it("does not let a copied folder steal its source's id", async () => {
    await loadAppsIndex(WS);
    await externalCommit({ "apps/b-copy/mako.json": manifest("B copy", B_ID) });
    const snapshot = await loadAppsIndex(WS);
    const original = snapshot.apps.find(a => a.path === "apps/Sales/CH/b")!;
    const copy = snapshot.apps.find(a => a.path === "apps/b-copy")!;
    expect(original.appId).toBe(B_ID);
    expect(copy.appId).toBe(derivedAppId(WS, "b-copy").toHexString());
    expect(copy.duplicateOf).toBe(B_ID);

    // Stamping gives the copy an identity of its own.
    await stampAppId(WS, copy, { userId: USER });
    const stamped = parseAppManifest(
      await fileAt("apps/b-copy/mako.json"),
      "b-copy",
    );
    expect(stamped.id).toBe(copy.appId);
    const after = (await loadAppsIndex(WS)).apps.find(
      a => a.path === "apps/b-copy",
    )!;
    expect(after.duplicateOf).toBeUndefined();
    expect(after.hasManifestId).toBe(true);
  });
});

describe("moves", () => {
  it("keep the id: stamped into the manifest when missing, and the project row follows", async () => {
    const a = (await resolveProjectRef(WS, "a"))!;
    const id = a._id.toString();
    expect(id).toBe(derivedAppId(WS, "a").toHexString());
    const row = await ensureProjectRow(a, USER);
    expect(row.path).toBe("apps/a");

    const moved = await moveProject(
      a,
      { scope: "workspace", folderSegments: ["Sales"] },
      { userId: USER },
    );
    expect(moved).toEqual({ from: "apps/a", to: "apps/Sales/a" });
    expect(await fileAt("apps/a/mako.json")).toBeNull();
    expect(
      parseAppManifest(await fileAt("apps/Sales/a/mako.json"), "a").id,
    ).toBe(id);
    // The nested fixture manifest moved along, untouched, and is still not an app.
    expect(await fileAt("apps/Sales/a/fixtures/mako.json")).not.toBeNull();
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(x => x.appId === id)?.path).toBe("apps/Sales/a");
    expect(snapshot.apps.map(x => x.slug).sort()).toEqual(["a", "b", "c"]);
    expect((await AppProject.findById(id))?.path).toBe("apps/Sales/a");
    // Every ref still resolves to the same app.
    expect((await resolveProjectRef(WS, id))?._id.toString()).toBe(id);
    expect((await resolveProjectRef(WS, "apps/Sales/a"))?._id.toString()).toBe(
      id,
    );
    expect((await resolveProjectRef(WS, "a"))?._id.toString()).toBe(id);
  });

  it("leave the tree oid alone when the manifest already has an id, so nothing rebuilds", async () => {
    const before = await resolveCommit(repoDirFor(WS), MAIN);
    const oid = await treeOidOf("apps/Sales/CH/b");
    const b = (await resolveProjectRef(WS, B_ID))!;
    await moveProject(b, {
      scope: "workspace",
      folderSegments: ["Ops"],
      slug: "b-renamed",
    });
    expect(await treeOidOf("apps/Ops/b-renamed")).toBe(oid);
    expect(
      await globFiles(b, "bindings/*.sql", undefined, undefined, before!),
    ).toEqual(["bindings/rows.sql"]);
    expect(
      (await readFile(b, "bindings/rows.sql", undefined, before!)).contents,
    ).toContain("select 1");
    const after = await resolveCommit(repoDirFor(WS), MAIN);
    expect(
      await appFolderChanged(WS, repoDirFor(WS), B_ID, before!, after!),
    ).toBe(false);
    await externalCommit({ "apps/Ops/b-renamed/src/new.ts": "changed" });
    const changed = await resolveCommit(repoDirFor(WS), MAIN);
    expect(
      await appFolderChanged(WS, repoDirFor(WS), B_ID, after!, changed!),
    ).toBe(true);
    await expect(
      appFolderChanged(WS, repoDirFor(WS), B_ID, "f".repeat(40), changed!),
    ).rejects.toThrow();
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)?.slug,
    ).toBe("b-renamed");
  });

  it("can file an app into (and out of) a personal tree", async () => {
    const b = (await resolveProjectRef(WS, B_ID))!;
    await moveProject(b, {
      scope: "private",
      ownerId: USER,
      folderSegments: ["Scratch"],
    });
    let row = (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)!;
    expect(row.path).toBe(`users/${USER}/apps/Scratch/b`);
    expect(row.scope).toBe("private");
    expect((await resolveProjectRef(WS, B_ID))?.access).toBe("private");
    await moveProject(b, { scope: "workspace", folderSegments: [] });
    row = (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)!;
    expect(row.path).toBe("apps/b");
    expect(row.scope).toBe("workspace");
  });

  it("refuse to land on an occupied path or inside another app", async () => {
    const b = (await resolveProjectRef(WS, B_ID))!;
    await expect(
      moveProject(b, { scope: "workspace", folderSegments: [], slug: "a" }),
    ).rejects.toThrow(/already exists/);
    await expect(
      moveProject(b, { scope: "workspace", folderSegments: ["a"] }),
    ).rejects.toThrow(/is an app, not a folder/);
    await expect(
      moveProject(b, {
        scope: "workspace",
        folderSegments: ["Empty"],
        slug: "../x",
      }),
    ).rejects.toThrow(/Invalid/);
  });
});

describe("folders", () => {
  it("are created as .gitkeep markers, renamed with their apps, and deleted only when empty", async () => {
    await createAppFolder(
      WS,
      { scope: "workspace", folderSegments: ["Marketing"] },
      { userId: USER },
    );
    expect(await fileAt("apps/Marketing/.gitkeep")).toBe("");
    expect((await loadAppsIndex(WS)).folders).toContain("apps/Marketing");
    await expect(
      createAppFolder(WS, {
        scope: "workspace",
        folderSegments: ["Marketing"],
      }),
    ).rejects.toThrow(/already exists/);

    const moved = await moveAppFolder(
      WS,
      { scope: "workspace", folderSegments: ["Sales"] },
      { scope: "workspace", folderSegments: ["Revenue"] },
      { userId: USER },
    );
    expect(moved).toEqual({ from: "apps/Sales", to: "apps/Revenue", apps: 1 });
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.appId === B_ID)?.path).toBe(
      "apps/Revenue/CH/b",
    );
    expect(snapshot.folders).toEqual([
      "apps/Empty",
      "apps/Marketing",
      "apps/Revenue",
      "apps/Revenue/CH",
    ]);

    await expect(
      deleteAppFolder(WS, { scope: "workspace", folderSegments: ["Revenue"] }),
    ).rejects.toThrow(/still holds 1 app/);
    await deleteAppFolder(WS, {
      scope: "workspace",
      folderSegments: ["Empty"],
    });
    expect(await fileAt("apps/Empty/.gitkeep")).toBeNull();
    expect((await loadAppsIndex(WS)).folders).not.toContain("apps/Empty");
  });

  it("a folder move stamps ids into every un-stamped app it carries", async () => {
    await externalCommit({ "apps/Sales/d/mako.json": manifest("D") });
    const dId = derivedAppId(WS, "Sales/d").toHexString();
    await moveAppFolder(
      WS,
      { scope: "workspace", folderSegments: ["Sales"] },
      { scope: "workspace", folderSegments: ["Revenue"] },
    );
    expect(
      parseAppManifest(await fileAt("apps/Revenue/d/mako.json"), "d").id,
    ).toBe(dId);
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.appId === dId)?.path,
    ).toBe("apps/Revenue/d");
  });
});

describe("identity across laptop moves", () => {
  it("follows an UNSTAMPED legacy app by tree oid when its folder is renamed from a checkout", async () => {
    // `apps/a` predates manifest ids: its identity is derived from its
    // path, and nothing in git names it. A laptop `git mv` keeps the tree.
    const aId = derivedAppId(WS, "a").toHexString();
    await loadAppsIndex(WS);
    const row = await ensureProjectRow(
      (await resolveProjectRef(WS, "a"))!,
      USER,
    );
    expect(row.path).toBe("apps/a");
    const oid = await treeOidOf("apps/a");
    const before = (await resolveCommit(repoDirFor(WS), MAIN))!;
    await externalCommit(
      {
        "apps/Sales/a/mako.json": manifest("A"),
        "apps/Sales/a/src/main.tsx": "export {}\n",
        "apps/Sales/a/fixtures/mako.json": manifest("Not an app"),
      },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "git mv apps/a apps/Sales/a",
    );
    const snapshot = await loadAppsIndex(WS);
    const moved = snapshot.apps.find(a => a.path === "apps/Sales/a");
    expect(moved?.appId).toBe(aId);
    expect(moved?.hasManifestId).toBe(false);
    expect(snapshot.apps.some(a => a.path === "apps/a")).toBe(false);
    expect((await AppProject.findById(aId))?.path).toBe("apps/Sales/a");
    expect(await treeOidOf("apps/Sales/a")).toBe(oid);
    // Deploy-on-push sees the same app with the same tree: nothing to do.
    const after = (await resolveCommit(repoDirFor(WS), MAIN))!;
    expect(await appFolderChanged(WS, repoDirFor(WS), aId, before, after)).toBe(
      false,
    );
  });

  it("gives a plain COPY of an unstamped app its own id while the original stays", async () => {
    const aId = derivedAppId(WS, "a").toHexString();
    await loadAppsIndex(WS);
    await externalCommit({
      "apps/a-copy/mako.json": manifest("A"),
      "apps/a-copy/src/main.tsx": "export {}\n",
      "apps/a-copy/fixtures/mako.json": manifest("Not an app"),
    });
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.path === "apps/a")?.appId).toBe(aId);
    const copy = snapshot.apps.find(a => a.path === "apps/a-copy");
    expect(copy?.appId).toBe(derivedAppId(WS, "a-copy").toHexString());
    expect(copy?.duplicateOf).toBeUndefined();
  });

  it("survives two stamped apps swapping folders in one commit", async () => {
    const d = await createProject({
      workspaceId: WS,
      title: "D",
      userId: USER,
      folder: { scope: "workspace", folderSegments: [] },
    });
    const dId = d._id.toString();
    const dManifest = (await fileAt("apps/d/mako.json"))!;
    const bManifest = (await fileAt("apps/Sales/CH/b/mako.json"))!;
    await ensureProjectRow((await resolveProjectRef(WS, B_ID))!, USER);
    // git mv apps/d tmp; git mv apps/Sales/CH/b apps/d; git mv tmp apps/Sales/CH/b
    await externalCommit(
      {
        "apps/d/mako.json": bManifest,
        "apps/d/bindings/rows.sql":
          "-- connection: c1\n-- schedule: 0 * * * *\nselect 1\n",
        "apps/Sales/CH/b/mako.json": dManifest,
      },
      ["apps/Sales/CH/b/bindings/rows.sql"],
      "swap b and d",
    );
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.appId === B_ID)?.path).toBe("apps/d");
    expect(snapshot.apps.find(a => a.appId === dId)?.path).toBe(
      "apps/Sales/CH/b",
    );
    expect((await AppProject.findById(B_ID))?.path).toBe("apps/d");
    expect((await AppProject.findById(dId))?.path).toBe("apps/Sales/CH/b");
  });

  it("frees a legacy row's path when a stamped manifest with another id lands there", async () => {
    const aId = derivedAppId(WS, "a").toHexString();
    await loadAppsIndex(WS);
    await ensureProjectRow((await resolveProjectRef(WS, "a"))!, USER);
    const newId = new Types.ObjectId().toHexString();
    await externalCommit({ "apps/a/mako.json": manifest("A2", newId) });
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.path === "apps/a")?.appId).toBe(newId);
    expect((await AppProject.findById(aId))?.path).toBeUndefined();
    // The new identity can now take the folder's state row.
    const row = await ensureProjectRow(
      (await resolveProjectRef(WS, newId))!,
      USER,
    );
    expect(row.path).toBe("apps/a");
  });

  it("never rebuilds the index backwards from an instance whose main is behind", async () => {
    const before = (await resolveCommit(repoDirFor(WS), MAIN))!;
    await externalCommit({ "apps/new/mako.json": manifest("New") });
    const fresh = await loadAppsIndex(WS);
    expect(fresh.apps.some(a => a.path === "apps/new")).toBe(true);
    // Another instance, still on the older commit, serves a read.
    await runGit(["-C", repoDirFor(WS), "update-ref", MAIN, before]);
    invalidateAppsIndexCache(WS);
    const stale = await loadAppsIndex(WS);
    expect(stale.sha).toBe(fresh.sha);
    expect(stale.apps.some(a => a.path === "apps/new")).toBe(true);
    expect((await AppIndexHead.findOne({ workspaceId: WS }))?.sha).toBe(
      fresh.sha,
    );
  });
});

describe("identity across laptop moves, second round", () => {
  it("follows an unstamped legacy app that was moved AND edited in one push (git rename detection)", async () => {
    const aId = derivedAppId(WS, "a").toHexString();
    await loadAppsIndex(WS);
    await ensureProjectRow((await resolveProjectRef(WS, "a"))!, USER);
    const before = (await resolveCommit(repoDirFor(WS), MAIN))!;
    await externalCommit(
      {
        "apps/Sales/a/mako.json": manifest("A"),
        "apps/Sales/a/src/main.tsx": "export const edited = true;\n",
        "apps/Sales/a/fixtures/mako.json": manifest("Not an app"),
      },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "git mv apps/a apps/Sales/a + edit",
    );
    const snapshot = await loadAppsIndex(WS);
    const moved = snapshot.apps.find(a => a.path === "apps/Sales/a");
    expect(moved?.appId).toBe(aId);
    expect((await AppProject.findById(aId))?.path).toBe("apps/Sales/a");
    // Edited, so it IS changed — under the same id, never as a new app.
    const after = (await resolveCommit(repoDirFor(WS), MAIN))!;
    expect(await appFolderChanged(WS, repoDirFor(WS), aId, before, after)).toBe(
      true,
    );
  });

  it("stamps an id once: a second stamp writes no commit", async () => {
    await loadAppsIndex(WS);
    await externalCommit({ "apps/b-copy/mako.json": manifest("B copy", B_ID) });
    const copy = (await loadAppsIndex(WS)).apps.find(
      a => a.path === "apps/b-copy",
    )!;
    await stampAppId(WS, copy, { userId: USER });
    const once = await resolveCommit(repoDirFor(WS), MAIN);
    const stamped = (await loadAppsIndex(WS)).apps.find(
      a => a.path === "apps/b-copy",
    )!;
    await stampAppId(WS, stamped, { userId: USER });
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(once);
  });

  it("refuses to scaffold inside another app", async () => {
    await expect(
      createProject({
        workspaceId: WS,
        title: "Inner",
        userId: USER,
        folder: { scope: "workspace", folderSegments: ["Sales", "CH", "b"] },
      }),
    ).rejects.toThrow(/is an app, not a folder/);
  });

  it("rewrites a pre-npm file: SDK dependency when the app moves deeper", async () => {
    await externalCommit({
      "apps/a/package.json": JSON.stringify(
        {
          name: "a",
          dependencies: { "@makoai/app-sdk": "file:../../packages/app-sdk" },
        },
        null,
        2,
      ),
    });
    const a = (await resolveProjectRef(WS, "a"))!;
    await moveProject(a, { scope: "workspace", folderSegments: ["Sales"] });
    const pkg = JSON.parse(
      (await fileAt("apps/Sales/a/package.json")) ?? "{}",
    ) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@makoai/app-sdk"]).toMatch(/^\^\d/);
  });
});

describe("visibility follows the tree", () => {
  it("a workspace app filed into a personal tree becomes private, and public again on the way back", async () => {
    const a = (await resolveProjectRef(WS, "a"))!;
    await ensureProjectRow(a, USER);
    await moveProject(
      a,
      { scope: "private", ownerId: USER, folderSegments: [] },
      { userId: USER },
    );
    let row = (await AppProject.findById(a._id))!;
    expect(row.path).toBe(`users/${USER}/apps/a`);
    expect(row.access).toBe("private");
    expect(row.owner_id).toBe(USER);
    expect(canReadResource(row, "someone-else", "member")).toBe(false);
    await moveProject(
      (await resolveProjectRef(WS, a._id.toString()))!,
      { scope: "workspace", folderSegments: [] },
      { userId: USER },
    );
    row = (await AppProject.findById(a._id))!;
    expect(row.path).toBe("apps/a");
    expect(row.access).toBe("workspace");
  });

  it("a laptop move into a personal tree is private too", async () => {
    const aId = derivedAppId(WS, "a").toHexString();
    await loadAppsIndex(WS);
    await ensureProjectRow((await resolveProjectRef(WS, "a"))!, USER);
    await externalCommit(
      {
        [`users/${USER}/apps/a/mako.json`]: manifest("A"),
        [`users/${USER}/apps/a/src/main.tsx`]: "export {}\n",
        [`users/${USER}/apps/a/fixtures/mako.json`]: manifest("Not an app"),
      },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
    );
    await loadAppsIndex(WS);
    const row = (await AppProject.findById(aId))!;
    expect(row.path).toBe(`users/${USER}/apps/a`);
    expect(row.access).toBe("private");
    expect(row.owner_id).toBe(USER);
  });
});

describe("ambiguous slugs", () => {
  it("resolve to nothing rather than to whichever row Mongo returns first", async () => {
    await externalCommit({ "apps/Ops/c/mako.json": manifest("Ops C") });
    await loadAppsIndex(WS);
    // "c" now names users/<USER>/apps/c and apps/Ops/c; neither is top-level.
    await ensureProjectRow((await resolveProjectRef(WS, "apps/Ops/c"))!, USER);
    expect(await resolveProjectRef(WS, "c")).toBeNull();
    expect((await resolveProjectRef(WS, "apps/Ops/c"))?.path).toBe(
      "apps/Ops/c",
    );
  });
});

describe("folder names", () => {
  it("accept non-ASCII letters, so apps/café is listed and manageable", async () => {
    await externalCommit({ "apps/café/mako.json": manifest("Café") });
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.path === "apps/café")?.slug).toBe("café");
  });
});

describe("createProject", () => {
  it("scaffolds into a folder with the row's id in the manifest", async () => {
    const project = await createProject({
      workspaceId: WS,
      title: "Hello",
      userId: USER,
      folder: { scope: "workspace", folderSegments: ["Sales", "CH"] },
    });
    expect(project.path).toBe("apps/Sales/CH/hello");
    const m = parseAppManifest(
      await fileAt("apps/Sales/CH/hello/mako.json"),
      "hello",
    );
    expect(m.id).toBe(project._id.toString());
    const pkg = JSON.parse(
      (await fileAt("apps/Sales/CH/hello/package.json")) ?? "{}",
    ) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@makoai/app-sdk"]).toMatch(/^\^\d/);
    expect(
      (await loadAppsIndex(WS)).apps.find(
        a => a.appId === project._id.toString(),
      )?.hasManifestId,
    ).toBe(true);

    // A second "Hello" in the same folder gets -2; in another folder, not.
    const second = await createProject({
      workspaceId: WS,
      title: "Hello",
      userId: USER,
      folder: { scope: "workspace", folderSegments: ["Sales", "CH"] },
    });
    expect(second.slug).toBe("hello-2");
    const personal = await createProject({
      workspaceId: WS,
      title: "Hello",
      userId: USER,
      folder: { scope: "private", folderSegments: [] },
    });
    expect(personal.path).toBe(`users/${USER}/apps/hello`);
    expect((await resolveProjectRef(WS, personal._id.toString()))?.access).toBe(
      "private",
    );
  });
});
