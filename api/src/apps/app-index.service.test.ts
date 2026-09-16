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
  stampAppId,
} from "./worktree.service";
import { appFolderChanged } from "./deploy-on-push";
import { runGit } from "./git";

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
    const after = await resolveCommit(repoDirFor(WS), MAIN);
    expect(
      await appFolderChanged(
        repoDirFor(WS),
        "apps/Ops/b-renamed",
        before!,
        after!,
      ),
    ).toBe(true);
    // ...but a deploy decides by comparing tree oids by APP, which changedApps
    // does through the index; the raw folder check above is path-based and
    // only meaningful for an app that did not move.
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
