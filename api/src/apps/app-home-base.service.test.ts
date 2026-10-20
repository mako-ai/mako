/**
 * The Apps home's memo (app-home-base.service): one build per workspace
 * shared by concurrent requests, rebuilt when main moves or an admin mark
 * changes — and never trusted for who may see what.
 *
 * Real bare repo under a temp APPS_GIT_ROOT and in-memory Mongo, like the
 * index suite.
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
  AppLifecycleState,
  AppProject,
  AppUsageDaily,
  WorkspaceUserHandle,
} from "../database/workspace-schema";
import { invalidateOwnerDirectory } from "./user-handles.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "./repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";
import { invalidateAppsIndexCache, loadAppsIndex } from "./app-index.service";
import {
  FRESH_MS,
  feedSignalsFrom,
  invalidateAppsHomeBase,
  listHomeDiscoveryApps,
  loadHomeBase,
  usageStatsFrom,
  visibleHomeAppIds,
} from "./app-home-base.service";
import {
  getAppUsageStats,
  invalidateCommitAuthors,
  recordAppUsage,
} from "./app-usage.service";
import { loadFeedSignals } from "./app-feed.service";
import { setAppVerified } from "./app-lifecycle.service";
import { appKeyOf, derivedAppId } from "./app-paths";
import { RequestTimings, runWithTimings } from "../middleware/server-timing";

let mongo: MongoMemoryServer;
let tmpRoot: string;

const WS = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();

const manifest = (title: string) =>
  JSON.stringify({ schemaVersion: 1, title }, null, 2) + "\n";
const idOf = (path: string) => derivedAppId(WS, appKeyOf(path)).toHexString();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-home-base-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await AppUsageDaily.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await Promise.all([
    AppIndexEntry.deleteMany({}),
    AppIndexHead.deleteMany({}),
    AppProject.deleteMany({}),
    AppUsageDaily.deleteMany({}),
    AppLifecycleState.deleteMany({}),
    WorkspaceUserHandle.deleteMany({}),
  ]);
  invalidateOwnerDirectory();
  invalidateAppsIndexCache();
  invalidateAppsHomeBase();
  invalidateCommitAuthors();
  await unbindTestWorkspaceRepo(WS);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "README.md": "x\n",
    "apps/a/mako.json": manifest("A"),
    "apps/b/mako.json": manifest("B"),
  });
  await bindTestWorkspaceRepo(WS);
});

async function commit(writes: Record<string, string>, email = "dev@x.test") {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes: [] },
    { message: "edit", author: { name: "Dev", email } },
  );
}

/** Count the queries a block sends to one collection. */
async function countQueries<T>(
  collection: string,
  fn: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  let queries = 0;
  mongoose.set("debug", (name: string) => {
    if (name === collection) queries++;
  });
  try {
    return { result: await fn(), queries };
  } finally {
    mongoose.set("debug", false);
  }
}

describe("single-flight", () => {
  it("concurrent requests share one build", async () => {
    const { result, queries } = await countQueries("app_usage_daily", () =>
      Promise.all([
        loadHomeBase(WS),
        loadHomeBase(WS),
        listHomeDiscoveryApps(WS, USER, "member"),
        visibleHomeAppIds(WS, USER, "member"),
      ]),
    );
    expect(queries).toBe(1);
    expect(result[0]).toBe(result[1]);
    expect(result[2].map(a => a.path).sort()).toEqual(["apps/a", "apps/b"]);
    // And a second wave is served from the memo, no query at all.
    const again = await countQueries("app_usage_daily", () => loadHomeBase(WS));
    expect(again.queries).toBe(0);
    expect(again.result).toBe(result[0]);
  });
});

describe("freshness", () => {
  it("serves a stale base once and replaces it in the background", async () => {
    const first = await loadHomeBase(WS);
    first.builtAt = Date.now() - FRESH_MS - 1;
    // Served as is, never waited on.
    expect(await loadHomeBase(WS)).toBe(first);
    await expect.poll(() => loadHomeBase(WS)).not.toBe(first);
  });

  it("rebuilds when main moves on this instance", async () => {
    const before = await listHomeDiscoveryApps(WS, USER, "member");
    expect(before.map(a => a.path)).not.toContain("apps/c");
    await commit({ "apps/c/mako.json": manifest("C") });
    // What the explorer's list does on every load: fetch, read main.
    await loadAppsIndex(WS);
    const after = await listHomeDiscoveryApps(WS, USER, "member");
    expect(after.map(a => a.path)).toContain("apps/c");
  });

  it("does not re-read a year of history when no app changed", async () => {
    await loadHomeBase(WS);
    await commit({ "dbt/models/x.sql": "select 1\n" });
    await loadAppsIndex(WS);
    const timings = new RequestTimings();
    const base = await runWithTimings(timings, () => loadHomeBase(WS));
    expect(timings.spans.has("base.build")).toBe(true);
    expect(timings.spans.has("authors.gitLog")).toBe(false);
    expect(base.snapshot.sha).toBe(await currentMain());
  });

  it("an admin's verified mark shows on the next request", async () => {
    const before = await listHomeDiscoveryApps(WS, USER, "member");
    expect(before.find(a => a.path === "apps/a")?.verified).toBe(false);
    await setAppVerified(WS, idOf("apps/a"), true, USER);
    const after = await listHomeDiscoveryApps(WS, USER, "member");
    expect(after.find(a => a.path === "apps/a")?.verified).toBe(true);
  });
});

describe("visibility is never memoized", () => {
  it("an app made private disappears from the very next request", async () => {
    const a = idOf("apps/a");
    expect(await visibleHomeAppIds(WS, USER, "member")).toContain(a);
    const base = await loadHomeBase(WS);
    await AppProject.create({
      _id: new Types.ObjectId(a),
      workspaceId: new Types.ObjectId(WS),
      title: "A",
      slug: "a",
      path: "apps/a",
      access: "private",
      owner_id: OTHER,
      createdBy: OTHER,
    });
    // Same memo…
    expect(await loadHomeBase(WS)).toBe(base);
    // …different answer.
    expect(await visibleHomeAppIds(WS, USER, "member")).not.toContain(a);
    const cards = await listHomeDiscoveryApps(WS, USER, "member");
    expect(cards.map(c => c.id)).not.toContain(a);
    // Its owner still sees it, with their email resolved on the spot.
    const theirs = await listHomeDiscoveryApps(WS, OTHER, "member");
    expect(theirs.find(c => c.id === a)?.ownerId).toBe(OTHER);
  });
});

describe("usage from the memo", () => {
  it("matches the uncached stats and feed signals exactly", async () => {
    const a = idOf("apps/a");
    const b = idOf("apps/b");
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const open = (userId: string, appId: string, at: Date) =>
      recordAppUsage({
        workspaceId: WS,
        appId,
        userId,
        kind: "open",
        source: "app",
        at,
      });
    await open(USER, a, daysAgo(1));
    await open(USER, a, daysAgo(3));
    await open(USER, b, daysAgo(40));
    await open(OTHER, a, daysAgo(2));
    await open(OTHER, b, daysAgo(10));
    await open(OTHER, b, daysAgo(60));

    const base = await loadHomeBase(WS);
    for (const days of [7, 28, 90]) {
      const cached = usageStatsFrom(base, days);
      const fresh = await getAppUsageStats(WS, { days, now });
      expect(Object.fromEntries(cached)).toEqual(Object.fromEntries(fresh));
    }
    const viewer = { id: USER };
    const signals = feedSignalsFrom(base, viewer);
    const expected = await loadFeedSignals(WS, viewer, now);
    expect(Object.fromEntries(signals.popularity)).toEqual(
      Object.fromEntries(expected.popularity),
    );
    expect(Object.fromEntries(signals.mine)).toEqual(
      Object.fromEntries(expected.mine),
    );
    expect(Object.fromEntries(signals.coUsage)).toEqual(
      Object.fromEntries(expected.coUsage),
    );
  });
});

async function currentMain(): Promise<string> {
  return (await loadAppsIndex(WS, { freshen: false })).sha;
}
