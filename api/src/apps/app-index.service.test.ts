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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
} from "../database/workspace-schema";
import { User } from "../database/schema";
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
  HistoryScanError,
  MAX_ALIASES_PER_APP,
  aliasesForMoves,
  aliasesFromHistory,
  assignAppIds,
  catchUpHistory,
  discoverApps,
  findAppInSnapshot,
  findAppInSnapshotVia,
  historyCatchUpFor,
  invalidateAppsIndexCache,
  loadAppsIndex,
  manifestRenamesInHistory,
  mergeAliases,
  resolveAppRef,
  syncAppsIndexFromRepo,
  walkHistory,
  type AppIndexRow,
  type ManifestHistoryEvent,
} from "./app-index.service";
import { derivedAppId, parseAppManifest } from "./app-paths";
import {
  createAppFolder,
  createProject,
  createProjectWith,
  deleteAppFolder,
  ensureProjectRow,
  moveAppFolder,
  moveProject,
  projectFromIndexRow,
  renameProject,
  resolveProjectRef,
  readFile,
  globFiles,
  stampAppId,
  supersessionWarnings,
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

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(moved).toEqual({
      from: "apps/a",
      to: "apps/Sales/a",
      warnings: [],
    });
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

  it("leave the tree oid alone when the manifest already has an id and the name does not change, so nothing rebuilds", async () => {
    // A stamped app filed elsewhere under its own name — into a folder, or
    // carried along by a folder move: its tree oid is untouched and
    // deploy-on-push sees nothing to rebuild. The index remembers the old
    // path on its own; the manifest is not written.
    const before = await resolveCommit(repoDirFor(WS), MAIN);
    const oid = await treeOidOf("apps/Sales/CH/b");
    const b = (await resolveProjectRef(WS, B_ID))!;
    await moveProject(b, { scope: "workspace", folderSegments: ["Ops"] });
    expect(await treeOidOf("apps/Ops/b")).toBe(oid);
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
    expect(
      parseAppManifest(await fileAt("apps/Ops/b/mako.json"), "b").aliases,
    ).toEqual([]);
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)?.aliases,
    ).toEqual(["apps/Sales/CH/b"]);
    expect((await resolveProjectRef(WS, "Sales/CH/b"))?._id.toString()).toBe(
      B_ID,
    );

    // A RENAME is the one move that writes the manifest (the old name
    // becomes an alias there, same commit), so it rebuilds once: the tree
    // differs by that file and nothing else.
    await moveProject(b, {
      scope: "workspace",
      folderSegments: ["Ops"],
      slug: "b-renamed",
    });
    expect(await treeOidOf("apps/Ops/b-renamed/bindings")).toBe(
      await treeOidOf("apps/Sales/CH/b/bindings", before!),
    );
    const renamed = await resolveCommit(repoDirFor(WS), MAIN);
    expect(
      await appFolderChanged(WS, repoDirFor(WS), B_ID, after!, renamed!),
    ).toBe(true);
    await externalCommit({ "apps/Ops/b-renamed/src/new.ts": "changed" });
    const changed = await resolveCommit(repoDirFor(WS), MAIN);
    expect(
      await appFolderChanged(WS, repoDirFor(WS), B_ID, renamed!, changed!),
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
    ).rejects.toThrow("An app already uses the link /apps/a.");
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

  it("authors the create commit as the person who created it, like a rename", async () => {
    // A user of their own: the author lookup is cached per process.
    const CREATOR = new Types.ObjectId().toString();
    await User.create({ _id: CREATOR, email: "creator@example.com" });
    const authorOfHead = async () =>
      (
        await runGit([
          "-C",
          repoDirFor(WS),
          "log",
          "-1",
          "--format=%an <%ae>|%cn <%ce>",
          MAIN,
        ])
      ).stdout.trim();
    await createProject({ workspaceId: WS, title: "Mine", userId: CREATOR });
    expect(await authorOfHead()).toBe(
      "creator <creator@example.com>|Mako <bot@mako.ai>",
    );
    // Nobody behind the call (a workspace API key): Mako, as before.
    await createProject({ workspaceId: WS, title: "Keyed" });
    expect(await authorOfHead()).toBe("Mako <bot@mako.ai>|Mako <bot@mako.ai>");
  });

  it("says whose old link a new app takes over", async () => {
    // A: a → Ops/report (its manifest keeps "a"). A new app titled "A"
    // lands at apps/a: /apps/a opens it from now on.
    const A = (await resolveProjectRef(WS, "a"))!;
    await moveProject(A, {
      scope: "workspace",
      folderSegments: ["Ops"],
      slug: "report",
    });
    const { project, takenOver } = await createProjectWith({
      workspaceId: WS,
      title: "A",
      userId: USER,
    });
    expect(project.path).toBe("apps/a");
    expect(takenOver).toEqual([
      {
        name: "a",
        appId: A._id.toString(),
        path: "apps/Ops/report",
        title: "A",
        takenOver: true,
      },
    ]);
    expect(
      await supersessionWarnings(WS, USER, "admin", project.title, takenOver),
    ).toEqual([
      '/apps/a used to open "A" (apps/Ops/report); it now opens "A".',
    ]);
    expect(findAppInSnapshot(await loadAppsIndex(WS), "a")?.appId).toBe(
      project._id.toString(),
    );
    // Nested, it takes no bare name: nothing to say.
    expect(
      (
        await createProjectWith({
          workspaceId: WS,
          title: "A",
          userId: USER,
          folder: { scope: "workspace", folderSegments: ["Sales"] },
        })
      ).takenOver,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aliases: a renamed app's old names keep resolving
// ---------------------------------------------------------------------------

const row = (path: string, extra: Partial<AppIndexRow> = {}): AppIndexRow => ({
  appId: new Types.ObjectId().toHexString(),
  path,
  slug: path.split("/").pop()!,
  scope: path.startsWith("users/") ? "private" : "workspace",
  treeOid: "t",
  title: path,
  hasManifestId: true,
  aliases: [],
  schedules: [],
  ...extra,
});

describe("alias resolution (pure)", () => {
  const live = row("apps/y");
  const renamed = row("apps/x", { aliases: ["y", "old", "apps/Sales/old"] });
  const snapshot = { sha: "", apps: [live, renamed], folders: [] };

  it("lets a current name beat an alias, always", () => {
    expect(findAppInSnapshot(snapshot, "y")?.appId).toBe(live.appId);
    expect(findAppInSnapshot(snapshot, "apps/y")?.appId).toBe(live.appId);
    expect(findAppInSnapshotVia(snapshot, "y")?.via).toBe("current");
  });

  it("resolves an alias nothing current claims, bare or with apps/", () => {
    expect(findAppInSnapshotVia(snapshot, "old")).toEqual({
      app: renamed,
      via: "alias",
    });
    expect(findAppInSnapshot(snapshot, "apps/old")?.appId).toBe(renamed.appId);
    expect(findAppInSnapshot(snapshot, "/old/")?.appId).toBe(renamed.appId);
    // A path alias answers its path forms, not its bare folder name: a
    // nested name never was a link on its own.
    expect(findAppInSnapshot(snapshot, "apps/Sales/old")?.appId).toBe(
      renamed.appId,
    );
    expect(findAppInSnapshot(snapshot, "Sales/old")?.appId).toBe(renamed.appId);
    expect(findAppInSnapshot(snapshot, "nope")).toBeNull();
  });

  it("resolves an alias two apps claim to neither", () => {
    const other = row("apps/z", { aliases: ["old"] });
    const both = { sha: "", apps: [live, renamed, other], folders: [] };
    expect(findAppInSnapshot(both, "old")).toBeNull();
    // The unambiguous path alias still works.
    expect(findAppInSnapshot(both, "apps/Sales/old")?.appId).toBe(
      renamed.appId,
    );
  });

  it("lets a renamed top-level app keep its link over a nested or personal app that took the bare name", () => {
    const moved = row("apps/report-v2", { aliases: ["report"] });
    const nested = row("apps/Sales/report");
    const personal = row("users/u1/apps/report");
    for (const other of [nested, personal]) {
      const snap = { sha: "", apps: [moved, other], folders: [] };
      expect(findAppInSnapshotVia(snap, "report")).toEqual({
        app: moved,
        via: "alias",
      });
      // The other app is still reachable by path and by id.
      expect(findAppInSnapshot(snap, other.path)?.appId).toBe(other.appId);
      expect(findAppInSnapshot(snap, other.appId)?.appId).toBe(other.appId);
    }
    // No alias: a unique nested name resolves as before.
    expect(
      findAppInSnapshot({ sha: "", apps: [nested], folders: [] }, "report")
        ?.appId,
    ).toBe(nested.appId);
    // A nested app's path alias never answers the bare name.
    expect(
      findAppInSnapshot(
        {
          sha: "",
          apps: [row("apps/x", { aliases: ["apps/Sales/report"] })],
          folders: [],
        },
        "report",
      ),
    ).toBeNull();
  });

  it("treats a bare name several nested apps share as final: no fall-through to a third app's alias", () => {
    const apps = [
      row("apps/Sales/kpi"),
      row("apps/Ops/kpi"),
      row("apps/Finance/kpi-v2", { aliases: ["apps/Finance/kpi"] }),
    ];
    expect(findAppInSnapshot({ sha: "", apps, folders: [] }, "kpi")).toBeNull();
    // …but a top-level old name of the third app would still win.
    const withTopLevelPast = [
      ...apps.slice(0, 2),
      row("apps/Finance/kpi-v2", { aliases: ["kpi"] }),
    ];
    expect(
      findAppInSnapshotVia(
        { sha: "", apps: withTopLevelPast, folders: [] },
        "kpi",
      ),
    ).toMatchObject({ via: "alias", app: { path: "apps/Finance/kpi-v2" } });
  });
});

describe("aliasesForMoves (pure)", () => {
  it("records the old slug in the manifest on a rename, never the new name", () => {
    const a = row("apps/a");
    const plan = aliasesForMoves([a], [{ from: "apps/a", to: "apps/b" }]);
    expect(plan.get("apps/a")).toEqual({
      newPath: "apps/b",
      add: ["a"],
      indexOnly: [],
      drop: ["b", "apps/b"],
    });
  });

  it("records a same-name move's old path in the index only — the manifest stays as it is", () => {
    const a = row("apps/a");
    expect(
      aliasesForMoves([a], [{ from: "apps/a", to: "apps/Sales/a" }]).get(
        "apps/a",
      ),
    ).toEqual({
      newPath: "apps/Sales/a",
      add: [],
      indexOnly: ["apps/a"],
      drop: ["a", "apps/Sales/a"],
    });
    const nested = row("apps/Sales/CH/b");
    expect(
      aliasesForMoves(
        [nested],
        [{ from: "apps/Sales/CH/b", to: "apps/Ops/b" }],
      ).get("apps/Sales/CH/b"),
    ).toMatchObject({ add: [], indexOnly: ["apps/Sales/CH/b"] });
  });

  it("records a nested or personal app's old PATH, never its bare name, when the name changes", () => {
    const nested = row("apps/Sales/CH/b");
    expect(
      aliasesForMoves(
        [nested],
        [{ from: "apps/Sales/CH/b", to: "apps/Ops/b2" }],
      ).get("apps/Sales/CH/b"),
    ).toMatchObject({ add: ["apps/Sales/CH/b"], indexOnly: [] });
    // A personal rename must not plant a bare name that collides with a
    // workspace app's old link.
    const personal = row("users/u1/apps/report");
    expect(
      aliasesForMoves(
        [personal],
        [{ from: "users/u1/apps/report", to: "users/u1/apps/report-old" }],
      ).get("users/u1/apps/report"),
    ).toMatchObject({ add: ["users/u1/apps/report"], indexOnly: [] });
  });

  it("covers every app under a moved folder without touching a manifest", () => {
    const apps = [row("apps/Sales/CH/b"), row("apps/Sales/c"), row("apps/x")];
    const plan = aliasesForMoves(apps, [
      { from: "apps/Sales", to: "apps/Revenue" },
    ]);
    expect([...plan.keys()].sort()).toEqual([
      "apps/Sales/CH/b",
      "apps/Sales/c",
    ]);
    for (const [path, p] of plan) {
      expect(p.add).toEqual([]);
      expect(p.indexOnly).toEqual([path]);
    }
    expect(plan.get("apps/Sales/c")?.drop).toEqual(["c", "apps/Revenue/c"]);
  });
});

describe("aliasesFromHistory (pure)", () => {
  const rename = (from: string, to: string, id?: string) =>
    ({ kind: "rename", from, to, id }) as ManifestHistoryEvent;
  const create = (path: string, id?: string) =>
    ({ kind: "create", path, id }) as ManifestHistoryEvent;

  it("walks each app back through its renames, newest first", () => {
    const apps = [row("apps/traffic-performance"), row("apps/Ops/x")];
    const events = [
      // newest
      rename("apps/seller-media-buying-3", "apps/traffic-performance"),
      rename("apps/Sales/seller-media", "apps/seller-media-buying-3"),
      // Another app once passed through traffic-performance's old name,
      // BEFORE it: not this app's history.
      rename("apps/Ops/x", "apps/seller-media-buying-3"),
      rename("apps/seller-media-buying-3", "apps/Ops/x"),
    ];
    const out = aliasesFromHistory(apps, events);
    expect(out.get("apps/traffic-performance")).toEqual([
      "seller-media-buying-3",
      "apps/Sales/seller-media",
    ]);
    // Ops/x came FROM seller-media-buying-3 (the oldest rename), but another
    // app arrived at that name afterwards: the most recent holder owns the
    // link, so for Ops/x the name is superseded, not an alias.
    expect(out.get("apps/Ops/x")).toBeUndefined();
    expect(walkHistory(apps, events).get("apps/Ops/x")).toEqual({
      aliases: [],
      superseded: ["seller-media-buying-3"],
      arrived: ["apps/Ops/x"],
    });
  });

  it("attributes by id and stops at the app's creation, so a new app at an old name inherits nothing", () => {
    const A = "a".repeat(24);
    const B = "b".repeat(24);
    const apps = [
      row("apps/y", { appId: A, hasManifestId: true }),
      row("apps/x", { appId: B, hasManifestId: true }),
    ];
    const events = [
      create("apps/x", B), // B born where A used to be
      rename("apps/x", "apps/y", A),
      rename("apps/p", "apps/x", A),
      create("apps/p", A),
    ];
    const out = aliasesFromHistory(apps, events);
    // "x" is where B arrived after A left: B's link now, superseded for A.
    expect(out.get("apps/y")).toEqual(["p"]);
    expect(walkHistory(apps, events).get("apps/y")).toEqual({
      aliases: ["p"],
      superseded: ["x"],
      arrived: ["y", "x", "p"],
    });
    expect(out.get("apps/x")).toBeUndefined();
    // Even without the creation record, an id that is not B's is not B's past.
    expect(
      aliasesFromHistory(apps, events.slice(1)).get("apps/x"),
    ).toBeUndefined();
    // An unstamped app (derived id) still stops at its own creation.
    expect(
      aliasesFromHistory(
        [row("apps/x", { hasManifestId: false })],
        [create("apps/x"), rename("apps/p", "apps/x")],
      ).get("apps/x"),
    ).toBeUndefined();
    // A creation at the current path under ANOTHER id stops the walk too:
    // whatever was there before was not this app, and git could not tell
    // the two manifests apart (a dropped mismatched pair reports one).
    expect(
      aliasesFromHistory(
        [row("apps/x", { appId: B, hasManifestId: true })],
        [create("apps/x", A), rename("apps/p", "apps/x")],
      ).get("apps/x"),
    ).toBeUndefined();
  });
});

describe("walkHistory (pure)", () => {
  const rename = (from: string, to: string, id?: string) =>
    ({ kind: "rename", from, to, id }) as ManifestHistoryEvent;
  const create = (path: string, id?: string) =>
    ({ kind: "create", path, id }) as ManifestHistoryEvent;
  const A = "a".repeat(24);
  const C = "c".repeat(24);

  it("gives a reused name to its most recent holder: the older claim is superseded, not an alias", () => {
    // A: foo → bar. C created at foo, then renamed foo → foo-v2.
    const events = [
      rename("apps/foo", "apps/foo-v2", C),
      create("apps/foo", C),
      rename("apps/foo", "apps/bar", A),
      create("apps/foo", A),
    ];
    const apps = [
      row("apps/bar", { appId: A, hasManifestId: true }),
      row("apps/foo-v2", { appId: C, hasManifestId: true }),
    ];
    const out = walkHistory(apps, events);
    expect(out.get("apps/bar")).toEqual({
      aliases: [],
      superseded: ["foo"],
      arrived: ["bar", "foo"],
    });
    expect(out.get("apps/foo-v2")).toEqual({
      aliases: ["foo"],
      superseded: [],
      arrived: ["foo-v2", "foo"],
    });
    // Before C was renamed away, "foo" was C's current name; after, the
    // link follows C — one claimant, never two.
    const snap = {
      sha: "",
      folders: [],
      apps: apps.map(a => ({
        ...a,
        aliases: withoutSupersededList(
          out.get(a.path)!.aliases,
          out.get(a.path)!.superseded,
        ),
      })),
    };
    expect(findAppInSnapshotVia(snap, "foo")).toMatchObject({
      via: "alias",
      app: { appId: C },
    });
  });

  it("counts an id-less newcomer at an old name as an arrival: the older claim is superseded on every rebuild", () => {
    // B: foo → bar (stamped). C, with NO id in its manifest (most apps),
    // created at apps/foo and renamed foo → foo-v2 from a laptop.
    const B = "b".repeat(24);
    const events = [
      rename("apps/foo", "apps/foo-v2"),
      create("apps/foo"),
      rename("apps/foo", "apps/bar", B),
      create("apps/foo", B),
    ];
    const apps = [
      row("apps/bar", { appId: B, hasManifestId: true }),
      row("apps/foo-v2", { hasManifestId: false }),
    ];
    const out = walkHistory(apps, events);
    expect(out.get("apps/bar")).toEqual({
      aliases: [],
      superseded: ["foo"],
      arrived: ["bar", "foo"],
    });
    expect(out.get("apps/foo-v2")).toEqual({
      aliases: ["foo"],
      superseded: [],
      arrived: ["foo-v2", "foo"],
    });
    // An id-less app's own chain is still followed in full.
    expect(
      walkHistory(
        [row("apps/z", { hasManifestId: false })],
        [
          rename("apps/y", "apps/z"),
          rename("apps/x", "apps/y"),
          create("apps/x"),
        ],
      ).get("apps/z"),
    ).toEqual({
      aliases: ["y", "x"],
      superseded: [],
      arrived: ["z", "y", "x"],
    });
  });

  it("gives a name back when the newcomer is deleted: the newest event at the old name decides", () => {
    const del = (path: string, id?: string) =>
      ({ kind: "delete", path, id }) as ManifestHistoryEvent;
    const apps = [row("apps/bar", { appId: A, hasManifestId: true })];
    const base = [rename("apps/foo", "apps/bar", A), create("apps/foo", A)];
    // B created at foo, then deleted: foo is A's again.
    expect(
      walkHistory(apps, [del("apps/foo"), create("apps/foo"), ...base]).get(
        "apps/bar",
      ),
    ).toEqual({ aliases: ["foo"], superseded: [], arrived: ["bar", "foo"] });
    // …unless someone else arrived after that deletion.
    expect(
      walkHistory(apps, [
        create("apps/foo", C),
        del("apps/foo"),
        create("apps/foo"),
        ...base,
      ]).get("apps/bar"),
    ).toEqual({ aliases: [], superseded: ["foo"], arrived: ["bar", "foo"] });
    // B renamed away keeps the name (its alias): still held, superseded.
    expect(
      walkHistory(apps, [
        rename("apps/foo", "apps/foo-v2"),
        create("apps/foo"),
        ...base,
      ]).get("apps/bar"),
    ).toEqual({ aliases: [], superseded: ["foo"], arrived: ["bar", "foo"] });
  });

  it("decides a name an app left twice by its LAST departure: reclaimed, it is the app's own again", () => {
    // A: foo → bar; B created at foo, then foo → baz; A: bar → foo → qux.
    const B = "b".repeat(24);
    const events = [
      rename("apps/foo", "apps/qux", A),
      rename("apps/bar", "apps/foo", A),
      rename("apps/foo", "apps/baz", B),
      create("apps/foo", B),
      rename("apps/foo", "apps/bar", A),
      create("apps/foo", A),
    ];
    const out = walkHistory(
      [
        row("apps/qux", { appId: A, hasManifestId: true }),
        row("apps/baz", { appId: B, hasManifestId: true }),
      ],
      events,
    );
    // Not ALSO superseded for its first stint, which B ended.
    expect(out.get("apps/qux")).toMatchObject({
      aliases: ["foo", "bar"],
      superseded: [],
    });
    // B left foo before A came back: B's claim is the superseded one.
    expect(out.get("apps/baz")).toMatchObject({
      aliases: [],
      superseded: ["foo"],
    });
  });

  it("records a folder moved under the same name by its old path, so the bare name still finds it", () => {
    // A was apps/report, moved (laptop, before the upgrade) into
    // apps/Sales/report; B is apps/Ops/report.
    const B = "b".repeat(24);
    const apps = [
      row("apps/Sales/report", { appId: A, hasManifestId: true }),
      row("apps/Ops/report", { appId: B, hasManifestId: true }),
    ];
    const out = walkHistory(apps, [
      rename("apps/report", "apps/Sales/report", A),
      create("apps/report", A),
      create("apps/Ops/report", B),
    ]);
    expect(out.get("apps/Sales/report")?.aliases).toEqual(["apps/report"]);
    const served = mergeAliases(
      [out.get("apps/Sales/report")!.aliases],
      ["report", "apps/Sales/report"],
    );
    expect(served).toEqual(["apps/report"]);
    expect(
      findAppInSnapshotVia(
        {
          sha: "",
          folders: [],
          apps: [
            row("apps/Sales/report", { appId: A, aliases: served }),
            row("apps/Ops/report", { appId: B }),
          ],
        },
        "report",
      ),
    ).toMatchObject({ via: "alias", app: { appId: A } });
  });
});

function withoutSupersededList(
  aliases: string[],
  superseded: string[],
): string[] {
  return aliases.filter(alias => !superseded.includes(alias));
}

describe("mergeAliases (pure)", () => {
  it("keeps the NEWEST names when capping, each once, and never the app's own", () => {
    const old = Array.from({ length: 30 }, (_, i) => `old-${i}`);
    const merged = mergeAliases([["newest", "own"], old], ["own"]);
    expect(merged).toHaveLength(MAX_ALIASES_PER_APP);
    expect(merged[0]).toBe("newest");
    expect(merged).not.toContain("own");
    expect(merged).toContain("old-0");
    expect(merged).not.toContain("old-29");
  });
});

describe("moves record aliases", () => {
  it("write the old slug and path into the moved manifest, in the move's own commit", async () => {
    const before = await resolveCommit(repoDirFor(WS), MAIN);
    const b = (await resolveProjectRef(WS, B_ID))!;
    await moveProject(b, {
      scope: "workspace",
      folderSegments: ["Ops"],
      slug: "b-renamed",
    });
    const after = await resolveCommit(repoDirFor(WS), MAIN);
    // Exactly one commit, and the alias is in it.
    const { stdout } = await runGit([
      "-C",
      repoDirFor(WS),
      "rev-list",
      "--count",
      `${before}..${after}`,
    ]);
    expect(stdout.trim()).toBe("1");
    const manifest = parseAppManifest(
      await fileAt("apps/Ops/b-renamed/mako.json"),
      "b-renamed",
    );
    expect(manifest.id).toBe(B_ID);
    // A nested app's old name is its PATH: its link was the id, and a bare
    // "b" must not claim some top-level app's old link.
    expect(manifest.aliases).toEqual(["apps/Sales/CH/b"]);
    // Every old ref opens the app; the new name is never an alias.
    for (const ref of ["apps/Sales/CH/b", "Sales/CH/b", B_ID]) {
      expect((await resolveProjectRef(WS, ref))?._id.toString()).toBe(B_ID);
    }
    const indexed = (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)!;
    expect(indexed.aliases).toEqual(["apps/Sales/CH/b"]);
    expect(indexed.aliases).not.toContain("b-renamed");

    // Renamed back: the name in between becomes the alias (slug and, for
    // a nested app, path), the current name is dropped from the list, and
    // older history stays.
    await moveProject(b, {
      scope: "workspace",
      folderSegments: ["Ops"],
      slug: "b",
    });
    expect(
      parseAppManifest(await fileAt("apps/Ops/b/mako.json"), "b").aliases,
    ).toEqual(["apps/Sales/CH/b", "apps/Ops/b-renamed"]);
    expect((await resolveProjectRef(WS, "Ops/b-renamed"))?._id.toString()).toBe(
      B_ID,
    );
  });

  it("a current name always wins over another app's alias", async () => {
    const a = (await resolveProjectRef(WS, "a"))!;
    await moveProject(a, {
      scope: "workspace",
      folderSegments: [],
      slug: "a2",
    });
    expect((await resolveProjectRef(WS, "a"))?._id.toString()).toBe(
      a._id.toString(),
    );
    // A new app takes the old name: it is the one "a" means now.
    const fresh = await createProject({
      workspaceId: WS,
      title: "Fresh",
      slug: "a",
      userId: USER,
    });
    expect((await resolveProjectRef(WS, "a"))?._id.toString()).toBe(
      fresh._id.toString(),
    );
    expect((await resolveProjectRef(WS, "a2"))?._id.toString()).toBe(
      a._id.toString(),
    );
  });

  it("a folder move records the old path of every app inside in the INDEX, rebuilding nothing", async () => {
    const before = await resolveCommit(repoDirFor(WS), MAIN);
    const oid = await treeOidOf("apps/Sales/CH/b");
    await moveAppFolder(
      WS,
      { scope: "workspace", folderSegments: ["Sales"] },
      { scope: "workspace", folderSegments: ["Revenue"] },
      { userId: USER },
    );
    // The manifest is untouched: same tree, no rebuild.
    expect(await treeOidOf("apps/Revenue/CH/b")).toBe(oid);
    expect(
      await appFolderChanged(
        WS,
        repoDirFor(WS),
        B_ID,
        before!,
        (await resolveCommit(repoDirFor(WS), MAIN))!,
      ),
    ).toBe(false);
    expect(
      parseAppManifest(await fileAt("apps/Revenue/CH/b/mako.json"), "b")
        .aliases,
    ).toEqual([]);
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)?.aliases,
    ).toEqual(["apps/Sales/CH/b"]);
    expect((await resolveProjectRef(WS, "Sales/CH/b"))?._id.toString()).toBe(
      B_ID,
    );
    // A rebuild from nothing (another instance, a wiped index) is told by
    // history, so it finds the old path too.
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)?.aliases,
    ).toEqual(["apps/Sales/CH/b"]);
  });

  it("a copy of an app claims none of its aliases, and gives them up in the file when stamped or moved", async () => {
    const a = (await resolveProjectRef(WS, "a"))!;
    await moveProject(a, {
      scope: "workspace",
      folderSegments: [],
      slug: "a-renamed",
    });
    const manifestWithAliases = await fileAt("apps/a-renamed/mako.json");
    expect(parseAppManifest(manifestWithAliases, "x").aliases).toEqual(["a"]);
    // Copied as-is from a checkout (`cp -r`), twice: same id, same aliases.
    await externalCommit({
      "apps/a-copy/mako.json": manifestWithAliases!,
      "apps/a-copy2/mako.json": manifestWithAliases!,
    });
    const snapshot = await loadAppsIndex(WS);
    const copy = snapshot.apps.find(x => x.path === "apps/a-copy")!;
    const copy2 = snapshot.apps.find(x => x.path === "apps/a-copy2")!;
    expect(copy.duplicateOf).toBe(a._id.toString());
    expect(copy.aliases).toEqual([]);
    // The old name still opens the original, not "neither".
    expect(findAppInSnapshotVia(snapshot, "a")).toMatchObject({
      app: { appId: a._id.toString() },
      via: "alias",
    });

    // Stamped: its own id, the source's aliases gone from the file.
    await stampAppId(WS, copy, { userId: USER });
    const stamped = parseAppManifest(
      await fileAt("apps/a-copy/mako.json"),
      "a-copy",
    );
    expect(stamped.id).toBe(copy.appId);
    expect("aliases" in stamped.raw).toBe(false);

    // Renamed instead (the dialog, rename_object, app_move_app): the move
    // stamps the copy's id and must strip the aliases the same way, or the
    // rename would hand the copy the original's old link again.
    await moveProject(
      projectFromIndexRow(WS, copy2),
      { scope: "workspace", folderSegments: [], slug: "a-copy3" },
      { userId: USER },
    );
    const moved = parseAppManifest(
      await fileAt("apps/a-copy3/mako.json"),
      "a-copy3",
    );
    expect(moved.id).toBe(copy2.appId);
    expect(moved.aliases).toEqual(["a-copy2"]);
    const after = await loadAppsIndex(WS);
    expect(after.apps.find(x => x.path === "apps/a-copy3")?.duplicateOf).toBe(
      undefined,
    );
    expect(findAppInSnapshotVia(after, "a")).toMatchObject({
      app: { appId: a._id.toString() },
      via: "alias",
    });
  });

  it("refuse to move an app whose manifest cannot be parsed, leaving it in place", async () => {
    await externalCommit({ "apps/a/mako.json": "{ this is not json" });
    const a = (await resolveProjectRef(WS, "a"))!;
    await expect(
      moveProject(a, { scope: "workspace", folderSegments: [], slug: "a2" }),
    ).rejects.toThrow(/cannot be parsed/);
    expect(await fileAt("apps/a/mako.json")).toBe("{ this is not json");
    expect(await fileAt("apps/a2/mako.json")).toBeNull();
  });
});

describe("the index learns aliases on its own", () => {
  it("from a laptop git mv it sees between two syncs, kept across later syncs", async () => {
    await loadAppsIndex(WS);
    // `git mv apps/Sales/CH/b apps/Ops/b2` pushed as-is: nothing in the
    // manifest says where it came from.
    const manifest = await fileAt("apps/Sales/CH/b/mako.json");
    const sql = await fileAt("apps/Sales/CH/b/bindings/rows.sql");
    await externalCommit(
      {
        "apps/Ops/b2/mako.json": manifest!,
        "apps/Ops/b2/bindings/rows.sql": sql!,
      },
      ["apps/Sales/CH/b/mako.json", "apps/Sales/CH/b/bindings/rows.sql"],
      "git mv",
    );
    let indexed = (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)!;
    expect(indexed.path).toBe("apps/Ops/b2");
    expect(indexed.aliases).toEqual(["apps/Sales/CH/b"]);
    // The file is untouched — the index remembers for it.
    expect(
      parseAppManifest(await fileAt("apps/Ops/b2/mako.json"), "b2").aliases,
    ).toEqual([]);
    expect((await resolveProjectRef(WS, "Sales/CH/b"))?._id.toString()).toBe(
      B_ID,
    );

    await externalCommit({ "README.md": "y\n" });
    indexed = (await loadAppsIndex(WS)).apps.find(a => a.appId === B_ID)!;
    expect(indexed.aliases).toEqual(["apps/Sales/CH/b"]);
  });

  it("from git history, so an app renamed before aliases existed gets its old link back", async () => {
    // Two renames before the index was ever built: a plain `git mv` of an
    // unstamped app, and a stamped app moved AND edited in one commit
    // (the case git's rename detection misses on a tiny file).
    const aManifest = await fileAt("apps/a/mako.json");
    const aMain = await fileAt("apps/a/src/main.tsx");
    const aFixture = await fileAt("apps/a/fixtures/mako.json");
    await externalCommit(
      {
        "apps/seller-media-buying-3/mako.json": aManifest!,
        "apps/seller-media-buying-3/src/main.tsx": aMain!,
        "apps/seller-media-buying-3/fixtures/mako.json": aFixture!,
      },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "git mv a",
    );
    await externalCommit(
      {
        "apps/traffic-performance/mako.json": aManifest!,
        "apps/traffic-performance/src/main.tsx": aMain!,
        "apps/traffic-performance/fixtures/mako.json": aFixture!,
      },
      [
        "apps/seller-media-buying-3/mako.json",
        "apps/seller-media-buying-3/src/main.tsx",
        "apps/seller-media-buying-3/fixtures/mako.json",
      ],
      "git mv again",
    );
    const sql = await fileAt("apps/Sales/CH/b/bindings/rows.sql");
    await externalCommit(
      {
        "apps/Ops/b2/mako.json": manifest("B edited on the way", B_ID),
        "apps/Ops/b2/bindings/rows.sql": sql!,
      },
      ["apps/Sales/CH/b/mako.json", "apps/Sales/CH/b/bindings/rows.sql"],
      "move and edit b",
    );
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    const events = await manifestRenamesInHistory(repoDirFor(WS), head!);
    // The fixture manifest inside app "a" moved too; it is not an app, so
    // aliasesFromHistory never walks it, but the scan reports it.
    expect(
      events.filter(e => e.kind === "rename" && !e.to.endsWith("/fixtures")),
    ).toEqual([
      { kind: "rename", from: "apps/Sales/CH/b", to: "apps/Ops/b2", id: B_ID },
      {
        kind: "rename",
        from: "apps/seller-media-buying-3",
        to: "apps/traffic-performance",
        id: undefined,
      },
      {
        kind: "rename",
        from: "apps/a",
        to: "apps/seller-media-buying-3",
        id: undefined,
      },
    ]);
    // Where each app began (the fixture's creation is reported too).
    expect(
      events
        .filter(e => e.kind === "create")
        .map(e => (e.kind === "create" ? e.path : ""))
        .sort(),
    ).toEqual([
      "apps/Sales/CH/b",
      "apps/a",
      "apps/a/fixtures",
      `users/${USER}/apps/c`,
    ]);

    const snapshot = await loadAppsIndex(WS);
    const tp = snapshot.apps.find(a => a.path === "apps/traffic-performance")!;
    expect(tp.aliases).toEqual(["seller-media-buying-3", "a"]);
    expect(findAppInSnapshotVia(snapshot, "seller-media-buying-3")).toEqual({
      app: tp,
      via: "alias",
    });
    expect(snapshot.apps.find(a => a.appId === B_ID)?.aliases).toEqual([
      "apps/Sales/CH/b",
    ]);

    // An index built before this feature (an older schema) is rebuilt and
    // picks the history up — the deploy path for every app renamed so far.
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $set: { schemaVersion: 1 } },
    );
    await AppIndexEntry.updateMany(
      { workspaceId: WS },
      { $set: { indexAliases: [] } },
    );
    invalidateAppsIndexCache();
    expect((await resolveAppRef(WS, "seller-media-buying-3"))?.path).toBe(
      "apps/traffic-performance",
    );
  });

  it("never hands one app's old name to a new app born at it, nor relearns it on a rebuild", async () => {
    // A: apps/p → apps/x → apps/y (stamped, so history knows its id);
    // then a NEW app B is created at apps/x.
    const A_ID = new Types.ObjectId().toHexString();
    const B2_ID = new Types.ObjectId().toHexString();
    await externalCommit({ "apps/p/mako.json": manifest("P", A_ID) });
    await externalCommit(
      { "apps/x/mako.json": manifest("P", A_ID) },
      ["apps/p/mako.json"],
      "mv p x",
    );
    await externalCommit(
      { "apps/y/mako.json": manifest("P", A_ID) },
      ["apps/x/mako.json"],
      "mv x y",
    );
    await externalCommit({ "apps/x/mako.json": manifest("New X", B2_ID) });
    let snapshot = await loadAppsIndex(WS);
    // "x" is B's now (it arrived there after A left): not A's alias.
    expect(snapshot.apps.find(a => a.appId === A_ID)?.aliases).toEqual(["p"]);
    expect(snapshot.apps.find(a => a.appId === B2_ID)?.aliases).toEqual([]);
    expect(findAppInSnapshot(snapshot, "p")?.appId).toBe(A_ID);
    // "x" is B's current name now: current beats A's alias.
    expect(findAppInSnapshot(snapshot, "x")?.appId).toBe(B2_ID);

    // A deleted: its old link dies rather than opening the unrelated B —
    // on this sync and on a rebuild from scratch.
    await externalCommit({}, ["apps/y/mako.json"], "delete A");
    snapshot = await loadAppsIndex(WS);
    expect(findAppInSnapshot(snapshot, "p")).toBeNull();
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.appId === B2_ID)?.aliases).toEqual([]);
    expect(findAppInSnapshot(snapshot, "p")).toBeNull();
  });

  it("retries a failed history scan on the next sync instead of recording it as done", async () => {
    await expect(
      manifestRenamesInHistory(repoDirFor(WS), "no-such-ref"),
    ).rejects.toBeInstanceOf(HistoryScanError);

    // A rename before the first build, found by the scan at build time.
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/a-old/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "mv a a-old",
    );
    const sha = await resolveCommit(repoDirFor(WS), MAIN);
    await loadAppsIndex(WS);
    let head = await AppIndexHead.findOne({ workspaceId: WS }).lean();
    expect(head?.historyScannedSha).toBe(sha);

    // What a scan that failed at build time leaves behind: the rows, no
    // mark of a scan, no history aliases. The next sync must scan all of
    // history, not just the commits since — and only then set the mark.
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $unset: { historyScannedSha: 1 } },
    );
    await AppIndexEntry.updateMany(
      { workspaceId: WS },
      { $set: { indexAliases: [] } },
    );
    invalidateAppsIndexCache();
    await externalCommit({ "README.md": "z\n" });
    const next = await resolveCommit(repoDirFor(WS), MAIN);
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.path === "apps/a-old")?.aliases).toEqual([
      "a",
    ]);
    head = await AppIndexHead.findOne({ workspaceId: WS }).lean();
    expect(head?.historyScannedSha).toBe(next);
  });

  it("retries a failed scan in the background on the next load, even when main did not move", async () => {
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/a-old/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "mv a a-old",
    );
    const sha = await resolveCommit(repoDirFor(WS), MAIN);
    await loadAppsIndex(WS);
    // The build's scan failed: rows, no mark, no history aliases.
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $unset: { historyScannedSha: 1 } },
    );
    await AppIndexEntry.updateMany(
      { workspaceId: WS },
      { $set: { indexAliases: [] } },
    );
    invalidateAppsIndexCache();
    // The read itself does not pay for the scan…
    const served = await loadAppsIndex(WS);
    expect(served.apps.find(a => a.path === "apps/a-old")?.aliases).toEqual([]);
    // …the catch-up behind it does, once, and marks the scan done.
    await historyCatchUpFor(WS);
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.path === "apps/a-old")
        ?.aliases,
    ).toEqual(["a"]);
    expect(
      (await AppIndexHead.findOne({ workspaceId: WS }).lean())
        ?.historyScannedSha,
    ).toBe(sha);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(sha);
  });

  it("a catch-up that writes late, after another instance re-indexed at a newer main, cannot take an alias away", async () => {
    // Instance A: rows at S, scan owed. Instance B: a laptop move pushed
    // as S2, synced (its scan succeeds), its index aliases recorded. A then
    // writes what it computed at S — which must change nothing.
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/a-old/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "mv a a-old",
    );
    const S = (await resolveCommit(repoDirFor(WS), MAIN))!;
    await loadAppsIndex(WS);
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $unset: { historyScannedSha: 1 } },
    );
    await AppIndexEntry.updateMany(
      { workspaceId: WS },
      { $set: { indexAliases: [] } },
    );
    invalidateAppsIndexCache();

    let S2 = "";
    await catchUpHistory(WS, repoDirFor(WS), S, {
      beforeWrite: async () => {
        await externalCommit(
          { "apps/Ops/a-old/mako.json": aManifest! },
          ["apps/a-old/mako.json"],
          "git mv a-old Ops/a-old",
        );
        S2 = (await resolveCommit(repoDirFor(WS), MAIN))!;
        await syncAppsIndexFromRepo(WS);
      },
    });
    const row = await AppIndexEntry.findOne({
      workspaceId: WS,
      path: "apps/Ops/a-old",
    }).lean();
    expect(row?.indexedSha).toBe(S2);
    // B's laptop-move alias survived A's late write, and A's older history
    // alias is there because B's scan found it too.
    expect(row?.indexAliases).toContain("apps/a-old");
    expect(row?.indexAliases).toContain("a");
    const head = await AppIndexHead.findOne({ workspaceId: WS }).lean();
    expect(head?.sha).toBe(S2);
    expect(head?.historyScannedSha).toBe(S2);
  });

  it("serves aliases another instance caught up with, once the pending-scan memo ages out", async () => {
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/a-old/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "mv a a-old",
    );
    const sha = (await resolveCommit(repoDirFor(WS), MAIN))!;
    await loadAppsIndex(WS);
    const caughtUp = (await AppIndexEntry.findOne({
      workspaceId: WS,
      path: "apps/a-old",
    }).lean())!.indexAliases;
    expect(caughtUp).toEqual(["a"]);
    // Scan owed; this instance tried a catch-up a moment ago (throttled),
    // so what it serves comes from the rows as they are.
    const pending = async () => {
      await AppIndexHead.updateOne(
        { workspaceId: WS },
        { $unset: { historyScannedSha: 1 } },
      );
      await AppIndexEntry.updateMany(
        { workspaceId: WS },
        { $set: { indexAliases: [] } },
      );
    };
    await pending();
    invalidateAppsIndexCache();
    await loadAppsIndex(WS);
    await historyCatchUpFor(WS);
    await pending();
    invalidateAppsIndexCache(WS);
    const stale = await loadAppsIndex(WS);
    expect(stale.apps.find(a => a.path === "apps/a-old")?.aliases).toEqual([]);
    // Another instance finishes the catch-up: rows and mark in Mongo,
    // nothing told this process.
    await AppIndexEntry.updateOne(
      { workspaceId: WS, path: "apps/a-old" },
      { $set: { indexAliases: caughtUp } },
    );
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $set: { historyScannedSha: sha } },
    );
    // Within the TTL the memo answers…
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.path === "apps/a-old")
        ?.aliases,
    ).toEqual([]);
    // …past it, the rows do, and main never moved.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.path === "apps/a-old")
        ?.aliases,
    ).toEqual(["a"]);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(sha);
  });

  it("reports a manifest git pairs with another app's as that app's creation, so the walk stops there", async () => {
    // Two long, near-identical manifests under different ids, one deleted
    // and one added in a single commit: git's -M calls it a rename; the ids
    // say it is not.
    const Q = new Types.ObjectId().toHexString();
    const R = new Types.ObjectId().toHexString();
    const long = (id: string) =>
      JSON.stringify(
        { id, title: "Q", description: "x".repeat(400), entry: "src/main.tsx" },
        null,
        2,
      ) + "\n";
    await externalCommit({ "apps/q/mako.json": long(Q) });
    await externalCommit(
      { "apps/r/mako.json": long(R) },
      ["apps/q/mako.json"],
      "replace q by r",
    );
    const sha = await resolveCommit(repoDirFor(WS), MAIN);
    const events = await manifestRenamesInHistory(repoDirFor(WS), sha!);
    expect(events.find(e => e.kind === "rename" && e.to === "apps/r")).toBe(
      undefined,
    );
    expect(events).toContainEqual({ kind: "create", path: "apps/r", id: R });
    expect(
      (await loadAppsIndex(WS)).apps.find(a => a.path === "apps/r")?.aliases,
    ).toEqual([]);
    expect(await resolveAppRef(WS, "q")).toBeNull();
  });

  it("fails the scan loudly when git cannot be read, rather than scanning without ids", async () => {
    await expect(
      manifestRenamesInHistory(path.join(tmpRoot, "no-such-repo"), "main"),
    ).rejects.toBeInstanceOf(HistoryScanError);
  });
});

describe("a name reused after a rename", () => {
  const manifestOf = async (path: string) =>
    parseAppManifest(await fileAt(`${path}/mako.json`), path);

  it("follows its most recent holder when that app is renamed in turn, in one commit, with a warning", async () => {
    // A: foo → bar (alias foo). C created at apps/foo. C: foo → foo-v2.
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/foo/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "a is foo",
    );
    const A = (await resolveProjectRef(WS, "foo"))!;
    await moveProject(A, {
      scope: "workspace",
      folderSegments: [],
      slug: "bar",
    });
    expect((await manifestOf("apps/bar")).aliases).toEqual(["foo"]);
    const C_ID = new Types.ObjectId().toHexString();
    await externalCommit({ "apps/foo/mako.json": manifest("Foo v2", C_ID) });
    expect(findAppInSnapshotVia(await loadAppsIndex(WS), "foo")).toMatchObject({
      via: "current",
      app: { appId: C_ID },
    });

    const before = await resolveCommit(repoDirFor(WS), MAIN);
    const aOid = await treeOidOf("apps/bar");
    const C = (await resolveProjectRef(WS, C_ID))!;
    const result = await renameProject(C, { slug: "foo-v2" }, { userId: USER });
    expect(result.aliasesAdded).toEqual(["foo"]);
    expect(result.superseded).toEqual([
      { name: "foo", appId: A._id.toString(), path: "apps/bar", title: "A" },
    ]);
    // One commit: C's manifest gained the alias. A's manifest — which may
    // be anyone's, even a private app the caller cannot see — is NOT
    // touched (no rebuild of A); the index supersedes its claim instead.
    const { stdout } = await runGit([
      "-C",
      repoDirFor(WS),
      "rev-list",
      "--count",
      `${before}..${await resolveCommit(repoDirFor(WS), MAIN)}`,
    ]);
    expect(stdout.trim()).toBe("1");
    expect((await manifestOf("apps/foo-v2")).aliases).toEqual(["foo"]);
    expect((await manifestOf("apps/bar")).aliases).toEqual(["foo"]);
    expect(await treeOidOf("apps/bar")).toBe(aOid);
    expect(
      (
        await AppIndexEntry.findOne({
          workspaceId: WS,
          path: "apps/bar",
        }).lean()
      )?.supersededAliases,
    ).toEqual(["foo"]);
    let snapshot = await loadAppsIndex(WS);
    expect(findAppInSnapshotVia(snapshot, "foo")).toMatchObject({
      via: "alias",
      app: { appId: C_ID },
    });
    // Only "foo" is superseded; "a" (where it began) is still its own.
    expect(snapshot.apps.find(a => a.path === "apps/bar")?.aliases).toEqual([
      "a",
    ]);
    // A rebuild from history agrees.
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    snapshot = await loadAppsIndex(WS);
    expect(findAppInSnapshotVia(snapshot, "foo")).toMatchObject({
      via: "alias",
      app: { appId: C_ID },
    });
    // Only "foo" is superseded; "a" (where it began) is still its own.
    expect(snapshot.apps.find(a => a.path === "apps/bar")?.aliases).toEqual([
      "a",
    ]);
  });

  it("follows its most recent holder after a laptop rename too, overriding the older manifest's claim", async () => {
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/foo/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "a is foo",
    );
    const A = (await resolveProjectRef(WS, "foo"))!;
    await moveProject(A, {
      scope: "workspace",
      folderSegments: [],
      slug: "bar",
    });
    const C_ID = new Types.ObjectId().toHexString();
    await externalCommit({ "apps/foo/mako.json": manifest("Foo v2", C_ID) });
    await loadAppsIndex(WS);
    // `git mv apps/foo apps/foo-v2`, pushed as-is: nobody rewrote A's file.
    await externalCommit(
      { "apps/foo-v2/mako.json": manifest("Foo v2", C_ID) },
      ["apps/foo/mako.json"],
      "git mv foo foo-v2",
    );
    let snapshot = await loadAppsIndex(WS);
    expect((await manifestOf("apps/bar")).aliases).toEqual(["foo"]);
    // Only "foo" is superseded; "a" (where it began) is still its own.
    expect(snapshot.apps.find(a => a.path === "apps/bar")?.aliases).toEqual([
      "a",
    ]);
    expect(
      (
        await AppIndexEntry.findOne({
          workspaceId: WS,
          path: "apps/bar",
        }).lean()
      )?.supersededAliases,
    ).toEqual(["foo"]);
    expect(findAppInSnapshotVia(snapshot, "foo")).toMatchObject({
      via: "alias",
      app: { appId: C_ID },
    });
    // The resolver every route uses, and a rebuild from history, agree.
    expect((await resolveProjectRef(WS, "foo"))?._id.toString()).toBe(C_ID);
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    snapshot = await loadAppsIndex(WS);
    expect(findAppInSnapshotVia(snapshot, "foo")).toMatchObject({
      via: "alias",
      app: { appId: C_ID },
    });
  });
});

describe("a name reused and then given up", () => {
  // A: foo → bar in the UI (manifest alias "foo"); an id-less B created at
  // apps/foo; then B goes. The name returns to A — on the incremental
  // sync, on a rebuild from history, and whether or not the index was read
  // between the commits (what the sync sees must not change the answer).
  const setup = async () => {
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/foo/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "a is foo",
    );
    const A = (await resolveProjectRef(WS, "foo"))!;
    await renameProject(A, { slug: "bar" }, { userId: USER });
    expect(
      parseAppManifest(await fileAt("apps/bar/mako.json"), "bar").aliases,
    ).toEqual(["foo"]);
    return A._id.toString();
  };
  const who = async (ref: string) => {
    const found = findAppInSnapshotVia(await loadAppsIndex(WS), ref);
    return found ? `${found.app.path} via=${found.via}` : null;
  };
  const rebuilt = async (ref: string) => {
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    return who(ref);
  };

  for (const readBetween of [false, true]) {
    it(`deleted newcomer, ${readBetween ? "with" : "without"} an index read between the commits`, async () => {
      await setup();
      await externalCommit({ "apps/foo/mako.json": manifest("Newcomer") });
      if (readBetween) expect(await who("foo")).toBe("apps/foo via=current");
      await externalCommit({}, ["apps/foo/mako.json"], "delete newcomer");
      expect(await who("foo")).toBe("apps/bar via=alias");
      expect(
        (
          await AppIndexEntry.findOne({
            workspaceId: WS,
            path: "apps/bar",
          }).lean()
        )?.supersededAliases,
      ).toEqual([]);
      expect(await rebuilt("foo")).toBe("apps/bar via=alias");
      await externalCommit({ "README.md": "y\n" });
      expect(await who("foo")).toBe("apps/bar via=alias");
      // The scan says the newcomer ended.
      const events = await manifestRenamesInHistory(
        repoDirFor(WS),
        (await resolveCommit(repoDirFor(WS), MAIN))!,
        { workspaceId: WS },
      );
      expect(events).toContainEqual({
        kind: "delete",
        path: "apps/foo",
        id: undefined,
      });
    });
  }

  it("a newcomer that moves away keeps the name (its own alias) — consistently, incremental and rebuilt", async () => {
    await setup();
    await externalCommit({ "apps/foo/mako.json": manifest("Newcomer") });
    expect(await who("foo")).toBe("apps/foo via=current");
    await externalCommit(
      { "apps/foo-v2/mako.json": manifest("Newcomer") },
      ["apps/foo/mako.json"],
      "git mv foo foo-v2",
    );
    expect(await who("foo")).toBe("apps/foo-v2 via=alias");
    expect(await rebuilt("foo")).toBe("apps/foo-v2 via=alias");
    // And when THAT app is deleted too, the name is A's again.
    await externalCommit({}, ["apps/foo-v2/mako.json"], "delete newcomer");
    expect(await who("foo")).toBe("apps/bar via=alias");
    expect(await rebuilt("foo")).toBe("apps/bar via=alias");
  });

  // Laptop pushes reach Mako on its next fetch, so several commits often
  // land between two index reads: the sync sees only where they ended.
  const laptopMove = async (from: string, to: string, contents: string) =>
    externalCommit(
      { [`apps/${to}/mako.json`]: contents },
      [`apps/${from}/mako.json`],
      `git mv ${from} ${to}`,
    );
  const supersededOf = async (path: string) =>
    (await AppIndexEntry.findOne({ workspaceId: WS, path }).lean())
      ?.supersededAliases;

  for (const renamedBy of ["the UI", "a laptop"] as const) {
    for (const withId of [false, true]) {
      it(`a newcomer created at the old name AND moved away between two index reads keeps it — A renamed by ${renamedBy}, newcomer ${withId ? "with" : "without"} an id`, async () => {
        if (renamedBy === "the UI") {
          await setup();
        } else {
          // A is known at apps/foo; its `git mv` to bar lands in the same
          // window as the newcomer's two commits.
          const aManifest = (await fileAt("apps/a/mako.json"))!;
          await externalCommit(
            { "apps/foo/mako.json": aManifest },
            [
              "apps/a/mako.json",
              "apps/a/src/main.tsx",
              "apps/a/fixtures/mako.json",
            ],
            "a is foo",
          );
          expect(await who("foo")).toBe("apps/foo via=current");
          await laptopMove("foo", "bar", aManifest);
        }
        const newcomer = manifest(
          "Newcomer",
          withId ? new Types.ObjectId().toHexString() : undefined,
        );
        await externalCommit({ "apps/foo/mako.json": newcomer });
        await laptopMove("foo", "foo-v2", newcomer);
        expect(await who("foo")).toBe("apps/foo-v2 via=alias");
        expect(await supersededOf("apps/bar")).toEqual(["foo"]);
        expect(await rebuilt("foo")).toBe("apps/foo-v2 via=alias");
        // The newcomer goes: the name is A's again, both ways.
        await externalCommit({}, ["apps/foo-v2/mako.json"], "delete newcomer");
        expect(await who("foo")).toBe("apps/bar via=alias");
        expect(await supersededOf("apps/bar")).toEqual([]);
        expect(await rebuilt("foo")).toBe("apps/bar via=alias");
      });
    }
  }

  it("the background catch-up of a failed scan agrees too, for a newcomer created and moved away in the gap", async () => {
    await setup();
    expect(await who("foo")).toBe("apps/bar via=alias");
    const scannedTo = (await resolveCommit(repoDirFor(WS), MAIN))!;
    const newcomer = manifest("Newcomer");
    await externalCommit({ "apps/foo/mako.json": newcomer });
    await laptopMove("foo", "foo-v2", newcomer);
    await loadAppsIndex(WS);
    // What a sync whose history scan FAILED leaves behind: no history
    // aliases, nothing superseded, the scan mark where the last good one
    // ended. The next load serves that and schedules the catch-up.
    await AppIndexHead.updateOne(
      { workspaceId: WS },
      { $set: { historyScannedSha: scannedTo } },
    );
    await AppIndexEntry.updateMany(
      { workspaceId: WS },
      { $set: { indexAliases: [], supersededAliases: [] } },
    );
    invalidateAppsIndexCache();
    expect(await who("foo")).toBe("apps/bar via=alias");
    await historyCatchUpFor(WS);
    expect(await who("foo")).toBe("apps/foo-v2 via=alias");
    expect(await supersededOf("apps/bar")).toEqual(["foo"]);
    expect(await rebuilt("foo")).toBe("apps/foo-v2 via=alias");
  });

  it("a name the older app took back and left again is the older app's — incremental, forced and fresh rebuild alike", async () => {
    // A: foo → bar (UI). B created at foo, renamed foo → baz. A renamed
    // bar → foo, then foo → qux. A held foo LAST: /apps/foo opens A.
    const aId = await setup();
    await externalCommit({ "apps/foo/mako.json": manifest("B") });
    expect(await who("foo")).toBe("apps/foo via=current");
    const B = (await resolveProjectRef(WS, "foo"))!;
    await renameProject(B, { slug: "baz" }, { userId: USER });
    await renameProject(
      (await resolveProjectRef(WS, aId))!,
      { slug: "foo" },
      { userId: USER },
    );
    await renameProject(
      (await resolveProjectRef(WS, aId))!,
      { slug: "qux" },
      { userId: USER },
    );
    expect(await who("foo")).toBe("apps/qux via=alias");
    await syncAppsIndexFromRepo(WS, { force: true });
    invalidateAppsIndexCache(WS);
    expect(await who("foo")).toBe("apps/qux via=alias");
    expect(await rebuilt("foo")).toBe("apps/qux via=alias");
    // B keeps the names that are its own.
    expect(await who("baz")).toBe("apps/baz via=current");
  });

  for (const read of ["never", "between", "not between"] as const) {
    for (const withId of [false, true]) {
      it(`an old name only the INDEX knew comes back when the newcomer at it goes — index read ${read}, newcomer ${withId ? "with" : "without"} an id`, async () => {
        // A: `git mv apps/foo apps/bar` (no manifest alias: the index alone
        // knows "foo"); a newcomer created at apps/foo; later deleted.
        const aManifest = (await fileAt("apps/a/mako.json"))!;
        await externalCommit(
          { "apps/foo/mako.json": aManifest },
          [
            "apps/a/mako.json",
            "apps/a/src/main.tsx",
            "apps/a/fixtures/mako.json",
          ],
          "a is foo",
        );
        if (read !== "never") {
          expect(await who("foo")).toBe("apps/foo via=current");
        }
        await laptopMove("foo", "bar", aManifest);
        if (read === "between") {
          expect(await who("foo")).toBe("apps/bar via=alias");
        }
        await externalCommit({
          "apps/foo/mako.json": manifest(
            "Newcomer",
            withId ? new Types.ObjectId().toHexString() : undefined,
          ),
        });
        expect(await who("foo")).toBe("apps/foo via=current");
        // While the newcomer holds it, A keeps the name (parked, or simply
        // shadowed by the newcomer's current name) — never drops it.
        const held = await AppIndexEntry.findOne({
          workspaceId: WS,
          path: "apps/bar",
        }).lean();
        expect(held?.indexAliases).toContain("foo");
        await externalCommit({}, ["apps/foo/mako.json"], "delete newcomer");
        expect(await who("foo")).toBe("apps/bar via=alias");
        expect(await supersededOf("apps/bar")).toEqual([]);
        expect(await rebuilt("foo")).toBe("apps/bar via=alias");
      });
    }
  }
});

describe("a name reused by an id-less app", () => {
  it("follows the newcomer on the incremental sync AND on a rebuild, UI and laptop alike", async () => {
    // B: foo → bar (stamped by the move). C: created at apps/foo with no
    // id (as most apps are), then renamed foo → foo-v2.
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/foo/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "a is foo",
    );
    const B = (await resolveProjectRef(WS, "foo"))!;
    await moveProject(B, {
      scope: "workspace",
      folderSegments: [],
      slug: "bar",
    });
    await externalCommit({ "apps/foo/mako.json": manifest("Foo v2") });
    const C = (await resolveProjectRef(WS, "foo"))!;
    expect(C._id.toString()).not.toBe(B._id.toString());

    // UI rename (stamps C in the move commit).
    const moved = await moveProject(
      C,
      { scope: "workspace", folderSegments: [], slug: "foo-v2" },
      { userId: USER, role: "admin" },
    );
    expect(moved.warnings).toEqual([
      '/apps/foo now opens "Foo v2"; it was also an old name of "A" (apps/bar), which no longer answers to it.',
    ]);
    const expectC = async () => {
      const snapshot = await loadAppsIndex(WS);
      expect(findAppInSnapshotVia(snapshot, "foo")).toMatchObject({
        via: "alias",
        app: { appId: C._id.toString() },
      });
      expect(snapshot.apps.find(a => a.path === "apps/bar")?.aliases).toEqual([
        "a",
      ]);
    };
    await expectC();
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    await expectC();

    // And a further laptop rename of the still id-less? No — C is stamped
    // now; rename it back from a laptop to prove the id-less walk of a
    // THIRD app: D created at apps/foo-v2's old name foo, id-less, moved by
    // git mv to apps/foo-v3 with no stamp at all.
    await externalCommit({ "apps/foo/mako.json": manifest("Foo v3") });
    await loadAppsIndex(WS);
    await externalCommit(
      { "apps/foo-v3/mako.json": manifest("Foo v3") },
      ["apps/foo/mako.json"],
      "git mv foo foo-v3",
    );
    const expectD = async () => {
      const snapshot = await loadAppsIndex(WS);
      const d = snapshot.apps.find(a => a.path === "apps/foo-v3")!;
      expect(d.hasManifestId).toBe(false);
      expect(findAppInSnapshotVia(snapshot, "foo")).toMatchObject({
        via: "alias",
        app: { appId: d.appId },
      });
      // C's manifest still spells "foo"; the index knows better.
      expect((await resolveProjectRef(WS, "foo"))?._id.toString()).toBe(
        d.appId,
      );
    };
    await expectD();
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    await expectD();
  });

  it("never touches another user's private app, and does not name it to a caller who cannot see it", async () => {
    // X filed `report` into their personal tree as `my-report` (alias
    // report there); admin Y renames a new workspace `report`.
    const X = new Types.ObjectId().toString();
    const aManifest = await fileAt("apps/a/mako.json");
    await externalCommit(
      { "apps/report/mako.json": aManifest! },
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "a is report",
    );
    const mine = (await resolveProjectRef(WS, "report"))!;
    await moveProject(
      mine,
      { scope: "private", ownerId: X, folderSegments: [], slug: "my-report" },
      { userId: X, role: "member" },
    );
    const theirs = `users/${X}/apps/my-report`;
    const theirManifest = await fileAt(`${theirs}/mako.json`);
    expect(parseAppManifest(theirManifest, "my-report").aliases).toEqual([
      "report",
    ]);
    const theirOid = await treeOidOf(theirs);
    await externalCommit({ "apps/report/mako.json": manifest("Report 2") });
    const fresh = (await resolveProjectRef(WS, "report"))!;
    const moved = await moveProject(
      fresh,
      { scope: "workspace", folderSegments: [], slug: "report-2" },
      { userId: USER, role: "admin" },
    );
    expect(await fileAt(`${theirs}/mako.json`)).toBe(theirManifest);
    expect(await treeOidOf(theirs)).toBe(theirOid);
    expect(moved.warnings).toEqual([
      '/apps/report now opens "Report 2"; it was also an old name of another app, which no longer answers to it.',
    ]);
    expect(
      findAppInSnapshotVia(await loadAppsIndex(WS), "report"),
    ).toMatchObject({ via: "alias", app: { appId: fresh._id.toString() } });
  });
});

describe("resolveProjectRef", () => {
  it("prefers an app whose folder left main (its row remains) over a live app that holds its name as an alias", async () => {
    const a = (await resolveProjectRef(WS, "a"))!;
    const row = await ensureProjectRow(a, USER);
    expect(row.slug).toBe("a");
    // The folder goes (a published app keeps its row until it is deleted).
    await externalCommit(
      {},
      ["apps/a/mako.json", "apps/a/src/main.tsx", "apps/a/fixtures/mako.json"],
      "delete folder a",
    );
    // A live app that claims "a" as an old name, from a laptop edit.
    const T = new Types.ObjectId().toHexString();
    await externalCommit({
      "apps/tmp/mako.json":
        JSON.stringify({ id: T, title: "Tmp", aliases: ["a"] }, null, 2) + "\n",
    });
    expect(findAppInSnapshotVia(await loadAppsIndex(WS), "a")).toMatchObject({
      via: "alias",
      app: { appId: T },
    });
    // The resolver every route and tool uses: current state first.
    expect((await resolveProjectRef(WS, "a"))?._id.toString()).toBe(
      a._id.toString(),
    );
    expect((await resolveProjectRef(WS, "apps/a"))?._id.toString()).toBe(
      a._id.toString(),
    );
    expect(
      (await resolveProjectRef(WS, a._id.toString()))?._id.toString(),
    ).toBe(a._id.toString());
    expect((await resolveProjectRef(WS, "tmp"))?._id.toString()).toBe(T);
    // Once the state row is gone, the alias answers.
    await AppProject.deleteOne({ _id: a._id });
    expect((await resolveProjectRef(WS, "a"))?._id.toString()).toBe(T);
  });
});
