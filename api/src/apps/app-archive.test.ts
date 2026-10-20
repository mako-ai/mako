/**
 * Archived apps: listing `archive/` from main with the list's visibility,
 * restoring with the move rules, 409 on a taken address, and a fresh
 * lifecycle grace period after a restore.
 *
 * Real bare repo under a temp APPS_GIT_ROOT + in-memory Mongo (the
 * lifecycle suite's harness); routes run for real with a stubbed identity.
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
import type { Context, Next } from "hono";

const identity = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (c: Context, next: Next) => {
    c.set("user", { id: identity.userId, email: "x@example.com" });
    await next();
  },
}));

import { createRouter } from "../openapi/core";
import { appsRoutes } from "../routes/apps";
import {
  AppIndexEntry,
  AppIndexHead,
  AppLifecycleState,
  AppProject,
  WorkspaceMember,
  WorkspaceUserHandle,
} from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
} from "./repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";
import { invalidateAppsIndexCache, loadAppsIndex } from "./app-index.service";
import { archiveProject } from "./worktree.service";
import { invalidateOwnerDirectory } from "./user-handles.service";
import {
  archiveCommitsIn,
  archivedFoldersIn,
  invalidateArchiveCache,
  originalPathOf,
} from "./app-archive.service";
import {
  planAppLifecycle,
  type LifecycleAppInput,
} from "./app-lifecycle.service";

describe("pure parts", () => {
  it("derives the original path, suffix or not", () => {
    expect(originalPathOf("archive/apps/old")).toBe("apps/old");
    expect(originalPathOf("archive/apps/Sales/old-2026-10-20")).toBe(
      "apps/Sales/old",
    );
    expect(originalPathOf("archive/apps/old-2026-10-20-3")).toBe("apps/old");
    expect(originalPathOf("archive/users/joan/apps/x")).toBe(
      "users/joan/apps/x",
    );
    expect(originalPathOf("archive/notes/x")).toBeNull();
    expect(originalPathOf("apps/x")).toBeNull();
  });

  it("finds app folders in an ls-tree, not their nested folders", () => {
    const tree = [
      "100644 blob aaa\tarchive/apps/old/mako.json",
      "100644 blob bbb\tarchive/apps/old/thumbnail.png",
      "100644 blob ccc\tarchive/apps/old/vendor/mako.json",
      "100644 blob ddd\tarchive/notes/mako.json",
      "100644 blob eee\tarchive/users/joan/apps/x/mako.json",
    ].join("\n");
    expect(archivedFoldersIn(tree)).toEqual([
      {
        path: "archive/apps/old",
        originalPath: "apps/old",
        manifestOid: "aaa",
        thumbnail: { file: "thumbnail.png", oid: "bbb" },
      },
      {
        path: "archive/users/joan/apps/x",
        originalPath: "users/joan/apps/x",
        manifestOid: "eee",
        thumbnail: null,
      },
    ]);
  });

  it("dates each folder by the newest commit that added it", () => {
    const log =
      "\0" +
      "2026-10-20T06:00:00+00:00\0Mako\0bot@mako.ai\n\narchive/apps/old/mako.json\narchive/apps/old/a.ts\n" +
      "\0" +
      "2026-01-01T00:00:00+00:00\0Joan\0joan@x\n\narchive/apps/old/mako.json\n";
    expect(archiveCommitsIn(log).get("archive/apps/old")).toEqual({
      at: "2026-10-20T06:00:00+00:00",
      name: "Mako",
      email: "bot@mako.ai",
    });
  });

  it("does not stale an app restored within the grace period", () => {
    const now = new Date("2026-10-20T06:00:00Z");
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const app = (state: LifecycleAppInput["state"]): LifecycleAppInput => ({
      appId: "a".repeat(24),
      path: "apps/report",
      title: "Report",
      createdAt: ago(300),
      lastCommitAt: ago(100),
      lastOpenedAt: null,
      lastNonAuthorOpenedAt: null,
      scheduled: true,
      verified: false,
      state,
    });
    const ctx = { now, usageSince: ago(200) };
    expect(planAppLifecycle([app({ restoredAt: ago(5) })], ctx)).toEqual([]);
    const [later] = planAppLifecycle([app({ restoredAt: ago(90) })], ctx);
    expect(later.actions).toContain("notify-stale");
  });
});

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-archive-test-"));
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
const OWNER = new Types.ObjectId().toString();
const MEMBER = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();
const HANDLE = "owner";
const OLD_ID = new Types.ObjectId().toHexString();
const MINE_ID = new Types.ObjectId().toHexString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const manifest = (title: string, id: string, description?: string) =>
  `${JSON.stringify({ id, schemaVersion: 1, title, ...(description ? { description } : {}) }, null, 2)}\n`;

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

const router = createRouter();
router.route("/api/workspaces/:workspaceId/apps", appsRoutes);
const call = (method: string, url: string, body?: unknown) =>
  router.request(`/api/workspaces/${WS}/apps${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const listAs = async (userId: string) => {
  identity.userId = userId;
  const res = await call("GET", "/archived");
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      apps: Array<{
        path: string;
        originalPath: string;
        appId?: string;
        title: string;
        description?: string;
        archivedAt?: string;
        archivedBy?: { email: string };
        thumbnail: { oid: string } | null;
      }>;
    }
  ).apps;
};
const restoreAs = (userId: string, archived: string) => {
  identity.userId = userId;
  return call("POST", "/archived/restore", { path: archived });
};

beforeEach(async () => {
  await Promise.all([
    AppIndexEntry.deleteMany({}),
    AppIndexHead.deleteMany({}),
    AppProject.deleteMany({}),
    AppLifecycleState.deleteMany({}),
    WorkspaceUserHandle.deleteMany({}),
    WorkspaceMember.deleteMany({}),
  ]);
  await WorkspaceUserHandle.create({
    workspaceId: new Types.ObjectId(WS),
    userId: OWNER,
    handle: HANDLE,
  });
  await WorkspaceMember.create([
    { workspaceId: new Types.ObjectId(WS), userId: OWNER, role: "member" },
    { workspaceId: new Types.ObjectId(WS), userId: MEMBER, role: "member" },
    { workspaceId: new Types.ObjectId(WS), userId: VIEWER, role: "viewer" },
  ]);
  invalidateOwnerDirectory();
  invalidateArchiveCache();
  await unbindTestWorkspaceRepo(WS);
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "README.md": "x\n",
    "apps/old/mako.json": manifest("Old", OLD_ID, "Weekly numbers"),
    "apps/old/thumbnail.png": "png-bytes",
    "apps/old/src/main.tsx": "export {}\n",
    [`users/${HANDLE}/apps/mine/mako.json`]: manifest("Mine", MINE_ID),
  });
  await bindTestWorkspaceRepo(WS);
  await loadAppsIndex(WS);
  await archiveProject(WS, "apps/old", {
    author: { name: "Mako", email: "bot@mako.ai" },
  });
  await archiveProject(WS, `users/${HANDLE}/apps/mine`);
  await AppLifecycleState.create({
    workspaceId: new Types.ObjectId(WS),
    appId: OLD_ID,
    staleSince: new Date("2026-09-01"),
    staleNotifiedTo: ["owner@example.com"],
    archivedAt: new Date(),
    archivedFrom: "apps/old",
    archivedTo: "archive/apps/old",
  });
});

describe("GET /apps/archived", () => {
  it("lists workspace archives for members, a personal one only for its owner", async () => {
    const member = await listAs(MEMBER);
    expect(member.map(a => a.path)).toEqual(["archive/apps/old"]);
    expect(member[0]).toMatchObject({
      originalPath: "apps/old",
      appId: OLD_ID,
      title: "Old",
      description: "Weekly numbers",
      archivedBy: { email: "bot@mako.ai" },
    });
    expect(member[0].thumbnail?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(member[0].archivedAt).toBeTruthy();

    const owner = await listAs(OWNER);
    expect(owner.map(a => a.path).sort()).toEqual([
      "archive/apps/old",
      `archive/users/${HANDLE}/apps/mine`,
    ]);
  });

  it("serves an archived thumbnail only to someone who may see the app", async () => {
    identity.userId = MEMBER;
    const ok = await call(
      "GET",
      `/archived/thumbnail?path=${encodeURIComponent("archive/apps/old")}`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("png-bytes");
    const hidden = await call(
      "GET",
      `/archived/thumbnail?path=${encodeURIComponent(`archive/users/${HANDLE}/apps/mine`)}`,
    );
    expect(hidden.status).toBe(404);
  });
});

describe("POST /apps/archived/restore", () => {
  it("needs an editing role for the Workspace tree, the owner for a personal one", async () => {
    expect((await restoreAs(VIEWER, "archive/apps/old")).status).toBe(403);
    // Not visible to another member: the same 404 as a missing path.
    expect(
      (await restoreAs(MEMBER, `archive/users/${HANDLE}/apps/mine`)).status,
    ).toBe(404);
    expect((await restoreAs(MEMBER, "archive/apps/nope")).status).toBe(404);
    const mine = await restoreAs(OWNER, `archive/users/${HANDLE}/apps/mine`);
    expect(mine.status).toBe(200);
    expect(await fileAt(`users/${HANDLE}/apps/mine/mako.json`)).toBe(
      manifest("Mine", MINE_ID),
    );
  });

  it("moves it back under the same id and resets its lifecycle clock", async () => {
    const res = await restoreAs(MEMBER, "archive/apps/old");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      from: "archive/apps/old",
      to: "apps/old",
      appId: OLD_ID,
    });
    expect(await fileAt("apps/old/src/main.tsx")).toBe("export {}\n");
    expect(await fileAt("archive/apps/old/mako.json")).toBeNull();
    invalidateAppsIndexCache(WS);
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.find(a => a.appId === OLD_ID)?.path).toBe("apps/old");
    expect((await listAs(MEMBER)).map(a => a.path)).toEqual([]);

    const state = await AppLifecycleState.findOne({ appId: OLD_ID }).lean();
    expect(state?.restoredAt).toBeInstanceOf(Date);
    expect(state?.restoredBy).toBe(MEMBER);
    expect(state?.staleSince).toBeUndefined();
    expect(state?.staleNotifiedTo).toBeUndefined();
    expect(state?.archivedTo).toBeUndefined();
  });

  it("refuses with 409 when the original address is taken", async () => {
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "apps/old/mako.json": manifest(
            "Newcomer",
            new Types.ObjectId().toHexString(),
          ),
        },
      },
      { message: "a new app at the old address" },
    );
    invalidateAppsIndexCache(WS);
    invalidateArchiveCache(WS);
    const res = await restoreAs(MEMBER, "archive/apps/old");
    expect(res.status).toBe(409);
    expect(await fileAt("archive/apps/old/mako.json")).not.toBeNull();
    const state = await AppLifecycleState.findOne({ appId: OLD_ID }).lean();
    expect(state?.restoredAt).toBeUndefined();
  });
});
