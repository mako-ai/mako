/**
 * App lifecycle + curation: the stale / unviewed planner, the archive move,
 * "Share with workspace", and the dry-run default.
 *
 * The planner is pure; everything else runs on a real bare repo under a
 * temp APPS_GIT_ROOT and in-memory Mongo (the app-index suite's harness).
 * The claims under test:
 *
 *  - nothing is judged "unused" before usage has been recorded for the
 *    whole window, and young or verified apps are never staled;
 *  - a stale app is noticed first and archived only 14 days later, unless
 *    someone opened or edited it meanwhile;
 *  - the job is a DRY RUN unless the workspace is enforced: it then writes
 *    no state, sends nothing and commits nothing;
 *  - archiving is a commit moving the folder to archive/<path>, which the
 *    index no longer lists;
 *  - sharing a personal app moves it into apps/ with its description, and
 *    makes it workspace content.
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
import type { Context, Next } from "hono";

// The routes run for real (membership, roles, the repo); only the signed-in
// identity is supplied.
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
import { invalidateAppsIndexCache, loadAppsIndex } from "./app-index.service";
import {
  archiveProject,
  moveProject,
  resolveProjectRef,
  withManifestDescription,
} from "./worktree.service";
import {
  LIFECYCLE_RULES,
  getAppLifecyclePlan,
  lastCommitByAppPath,
  lifecycleEnforced,
  onAppOpened,
  pausedScheduleAppIds,
  planAppLifecycle,
  runAppLifecycle,
  setAppVerified,
  verifiedAppIds,
  type LifecycleAppInput,
} from "./app-lifecycle.service";
import { emailService } from "../services/email.service";
import { invalidateOwnerDirectory } from "./user-handles.service";
import { recordAppUsage } from "./app-usage.service";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T06:00:00Z");
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);

function input(over: Partial<LifecycleAppInput> = {}): LifecycleAppInput {
  return {
    appId: "a".repeat(24),
    path: "apps/report",
    title: "Report",
    createdAt: ago(200),
    lastCommitAt: ago(100),
    lastOpenedAt: null,
    lastNonAuthorOpenedAt: null,
    scheduled: false,
    verified: false,
    state: null,
    ...over,
  };
}

const ctx = { now: NOW, usageSince: ago(120) };

describe("planAppLifecycle", () => {
  it("notices an app nobody else opened and nobody committed to in 60 days", () => {
    const [entry] = planAppLifecycle([input()], ctx);
    expect(entry.actions).toEqual(["notify-stale"]);
    expect(entry.archiveOn).toBe("2026-11-03");
  });

  it("judges nothing before usage covers the whole window", () => {
    expect(planAppLifecycle([input()], { now: NOW, usageSince: null })).toEqual(
      [],
    );
    expect(
      planAppLifecycle([input({ scheduled: true })], {
        now: NOW,
        usageSince: ago(20),
      }),
    ).toEqual([]);
    // 45 days of usage: enough for the 30-day pause, not the 60-day stale.
    const [entry] = planAppLifecycle([input({ scheduled: true })], {
      now: NOW,
      usageSince: ago(45),
    });
    expect(entry.actions).toEqual(["pause-schedules"]);
  });

  it("keeps an app someone else opened, or someone committed to", () => {
    expect(
      planAppLifecycle([input({ lastNonAuthorOpenedAt: ago(59) })], ctx),
    ).toEqual([]);
    expect(planAppLifecycle([input({ lastCommitAt: ago(10) })], ctx)).toEqual(
      [],
    );
  });

  it("an author's own opens do not keep an app from going stale", () => {
    const [entry] = planAppLifecycle(
      [input({ lastOpenedAt: ago(1), scheduled: true })],
      ctx,
    );
    // ...but they do keep its schedules running.
    expect(entry.actions).toEqual(["notify-stale"]);
  });

  it("leaves young and verified apps alone", () => {
    expect(
      planAppLifecycle(
        [input({ createdAt: ago(LIFECYCLE_RULES.minAgeDays - 1) })],
        ctx,
      ),
    ).toEqual([]);
    expect(planAppLifecycle([input({ verified: true })], ctx)).toEqual([]);
  });

  it("archives 14 days after the notice, and not a day before", () => {
    const state = { staleSince: ago(13) };
    const [waiting] = planAppLifecycle([input({ state })], ctx);
    expect(waiting.actions).toEqual([]);
    expect(waiting.archiveOn).toBe("2026-10-21");
    const [due] = planAppLifecycle(
      [input({ state: { staleSince: ago(14) } })],
      ctx,
    );
    expect(due.actions).toEqual(["archive"]);
  });

  it("cancels a pending archive when anyone opens or edits the app", () => {
    const state = { staleSince: ago(10) };
    for (const over of [
      { lastOpenedAt: ago(2) },
      { lastCommitAt: ago(3) },
      { verified: true },
    ]) {
      const [entry] = planAppLifecycle([input({ state, ...over })], ctx);
      expect(entry.actions).toEqual(["clear-stale"]);
    }
  });

  it("pauses schedules of an app nobody opened in 30 days, and resumes on the next open", () => {
    const [pause] = planAppLifecycle(
      [
        input({
          scheduled: true,
          lastCommitAt: ago(5),
          lastOpenedAt: ago(31),
        }),
      ],
      ctx,
    );
    expect(pause.actions).toEqual(["pause-schedules"]);
    // Unscheduled apps have nothing to pause.
    expect(planAppLifecycle([input({ lastCommitAt: ago(5) })], ctx)).toEqual(
      [],
    );
    const [resume] = planAppLifecycle(
      [
        input({
          scheduled: true,
          lastCommitAt: ago(5),
          lastOpenedAt: ago(1),
          state: { schedulesPausedAt: ago(4) },
        }),
      ],
      ctx,
    );
    expect(resume.actions).toEqual(["resume-schedules"]);
  });
});

describe("lifecycleEnforced", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("is a dry run unless the workspace is named (or all are)", () => {
    vi.stubEnv("APPS_LIFECYCLE_ENFORCE", "");
    expect(lifecycleEnforced("ws1")).toBe(false);
    vi.stubEnv("APPS_LIFECYCLE_ENFORCE", "ws0, ws1");
    expect(lifecycleEnforced("ws1")).toBe(true);
    expect(lifecycleEnforced("ws2")).toBe(false);
    vi.stubEnv("APPS_LIFECYCLE_ENFORCE", "all");
    expect(lifecycleEnforced("ws2")).toBe(true);
  });
});

describe("withManifestDescription", () => {
  it("sets the description and keeps every other key", () => {
    const out = withManifestDescription(
      JSON.stringify({ id: "x", title: "T", entry: "src/main.tsx" }),
      "  Weekly pipeline  ",
    );
    expect(JSON.parse(out!)).toEqual({
      id: "x",
      title: "T",
      entry: "src/main.tsx",
      description: "Weekly pipeline",
    });
    expect(withManifestDescription("{not json", "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real repo
// ---------------------------------------------------------------------------

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-lifecycle-test-"));
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
// Personal trees are named by handle, resolved to the owner by the mapping.
const HANDLE = "owner";
const OLD_ID = new Types.ObjectId().toHexString();
const FRESH_ID = new Types.ObjectId().toHexString();
const MINE_ID = new Types.ObjectId().toHexString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const REAL_NOW = Date.now();
const manifest = (title: string, id: string) =>
  `${JSON.stringify({ id, schemaVersion: 1, title }, null, 2)}\n`;

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  await AppIndexEntry.deleteMany({});
  await AppIndexHead.deleteMany({});
  await AppProject.deleteMany({});
  await AppLifecycleState.deleteMany({});
  await WorkspaceUserHandle.deleteMany({});
  await WorkspaceUserHandle.create({
    workspaceId: new Types.ObjectId(WS),
    userId: OWNER,
    handle: HANDLE,
  });
  invalidateOwnerDirectory();
  await mongoose.connection.db!.collection("app_usage_daily").deleteMany({});
  await unbindTestWorkspaceRepo(WS);
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  // Everything committed 100 days ago: no app has a recent commit.
  await initRepo(
    repoDirFor(WS),
    {
      "README.md": "x\n",
      "apps/old/mako.json": manifest("Old", OLD_ID),
      "apps/old/src/main.tsx": "export {}\n",
      "apps/Sales/fresh/mako.json": manifest("Fresh", FRESH_ID),
      [`users/${HANDLE}/apps/mine/mako.json`]: manifest("Mine", MINE_ID),
    },
    {
      author: {
        name: "Laptop",
        email: "laptop@example.com",
        date: new Date(REAL_NOW - 100 * DAY),
      },
    },
  );
  await bindTestWorkspaceRepo(WS);
  await loadAppsIndex(WS);
});

describe("lastCommitByAppPath", () => {
  it("finds each app's newest commit in one walk, and none older than `since`", async () => {
    const sha = (await resolveCommit(repoDirFor(WS), MAIN))!;
    const paths = ["apps/old", "apps/Sales/fresh"];
    const all = await lastCommitByAppPath(
      repoDirFor(WS),
      sha,
      paths,
      new Date(REAL_NOW - 200 * DAY),
    );
    expect([...all.keys()].sort()).toEqual(paths.sort());
    const recent = await lastCommitByAppPath(
      repoDirFor(WS),
      sha,
      paths,
      new Date(REAL_NOW - 61 * DAY),
    );
    expect(recent.size).toBe(0);
  });

  it("ignores a sweeping commit that touched many apps at once", async () => {
    const sha = (await resolveCommit(repoDirFor(WS), MAIN))!;
    const since = new Date(REAL_NOW - 200 * DAY);
    const paths = ["apps/old", "apps/Sales/fresh"];
    // The seed commit touched both: a chore by the 1-app threshold.
    const swept = await lastCommitByAppPath(
      repoDirFor(WS),
      sha,
      paths,
      since,
      1,
    );
    expect(swept.size).toBe(0);
    const edit = await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "apps/old/src/main.tsx": "export const x = 1;\n" } },
      { message: "edit one app" },
    );
    const after = await lastCommitByAppPath(
      repoDirFor(WS),
      edit.commitOid,
      paths,
      since,
      1,
    );
    expect([...after.keys()]).toEqual(["apps/old"]);
  });
});

describe("archiveProject", () => {
  it("moves the folder to archive/<path>; the index stops listing it; a second archive keeps both", async () => {
    await AppProject.create({
      _id: new Types.ObjectId(OLD_ID),
      workspaceId: new Types.ObjectId(WS),
      title: "Old",
      slug: "old",
      path: "apps/old",
      access: "workspace",
      createdBy: OWNER,
    });
    const moved = await archiveProject(WS, "apps/old");
    expect(moved).toEqual({ from: "apps/old", to: "archive/apps/old" });
    expect(await fileAt("archive/apps/old/src/main.tsx")).toBe("export {}\n");
    expect(await fileAt("apps/old/mako.json")).toBeNull();
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.map(a => a.path)).not.toContain("apps/old");
    expect(snapshot.apps.some(a => a.path.startsWith("archive/"))).toBe(false);
    // The row keeps its state but gives up its address.
    const row = await AppProject.findById(OLD_ID).lean();
    expect(row?.path).toBeUndefined();

    // A new app at the same address, archived too: both copies are kept.
    const NEW_ID = new Types.ObjectId().toHexString();
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "apps/old/mako.json": manifest("Old again", NEW_ID) } },
      { message: "recreate" },
    );
    invalidateAppsIndexCache(WS);
    const again = await archiveProject(WS, "apps/old");
    expect(again.to).toMatch(/^archive\/apps\/old-\d{4}-\d{2}-\d{2}$/);
    expect(await fileAt("archive/apps/old/mako.json")).toBe(
      manifest("Old", OLD_ID),
    );
    expect(await fileAt(`${again.to}/mako.json`)).toBe(
      manifest("Old again", NEW_ID),
    );
  });
});

describe("share with workspace", () => {
  it("moves a personal app into apps/ with its description, as workspace content", async () => {
    const project = await resolveProjectRef(WS, MINE_ID);
    expect(project).not.toBeNull();
    const moved = await moveProject(
      project!,
      { scope: "workspace", folderSegments: [] },
      { userId: OWNER, description: "Pipeline by stage, weekly" },
    );
    expect(moved.to).toBe("apps/mine");
    const written = JSON.parse((await fileAt("apps/mine/mako.json"))!);
    expect(written).toMatchObject({
      id: MINE_ID,
      title: "Mine",
      description: "Pipeline by stage, weekly",
    });
    const row = (await loadAppsIndex(WS)).apps.find(a => a.appId === MINE_ID);
    expect(row).toMatchObject({ scope: "workspace", path: "apps/mine" });
  });
});

describe("runAppLifecycle", () => {
  async function seedUsageHistory() {
    await mongoose.connection.db!.collection("app_usage_daily").insertOne({
      workspaceId: new Types.ObjectId(WS),
      appId: FRESH_ID,
      userId: OWNER,
      day: new Date(REAL_NOW - 90 * DAY).toISOString().slice(0, 10),
      opens: 1,
      activeSeconds: 0,
    });
    await User.create({ _id: OWNER, email: "owner@example.com" }).catch(
      () => undefined,
    );
    await AppProject.create({
      _id: new Types.ObjectId(OLD_ID),
      workspaceId: new Types.ObjectId(WS),
      title: "Old",
      slug: "old",
      path: "apps/old",
      access: "workspace",
      owner_id: OWNER,
      createdBy: OWNER,
    });
  }

  it("is a dry run by default: plans, but writes, sends and commits nothing", async () => {
    await seedUsageHistory();
    const send = vi.spyOn(emailService, "sendAppLifecycleEmail");
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    // Index rows were created just now: look from 20 days on, past minAge.
    const later = new Date(REAL_NOW + 20 * DAY);
    const plan = await runAppLifecycle(WS, later);
    expect(plan.mode).toBe("dry-run");
    expect(plan.counts["notify-stale"]).toBe(3);
    expect(await AppLifecycleState.countDocuments({})).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    // The admin report is the same plan.
    const report = await getAppLifecyclePlan(WS, later);
    expect(report.counts).toEqual(plan.counts);
    send.mockRestore();
  });

  it("enforced: notices the owner, then archives 14 days later as the Mako bot", async () => {
    await seedUsageHistory();
    await setAppVerified(WS, FRESH_ID, true, OWNER);
    vi.stubEnv("APPS_LIFECYCLE_ENFORCE", WS);
    const send = vi.spyOn(emailService, "sendAppLifecycleEmail");

    const day20 = new Date(REAL_NOW + 20 * DAY);
    const first = await runAppLifecycle(WS, day20);
    expect(first.mode).toBe("enforce");
    // Old (owned) + Mine (personal); Fresh is verified.
    expect(first.counts["notify-stale"]).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("owner@example.com");
    const state = await AppLifecycleState.findOne({ appId: OLD_ID }).lean();
    expect(state?.staleSince?.getTime()).toBe(day20.getTime());

    // A week later: still counting down, nothing moves.
    const day27 = new Date(REAL_NOW + 27 * DAY);
    expect((await runAppLifecycle(WS, day27)).counts.archive).toBe(0);
    expect(await fileAt("apps/old/mako.json")).not.toBeNull();

    // The owner opens "Mine": its archive is cancelled.
    await onAppOpened(WS, MINE_ID);

    const day35 = new Date(REAL_NOW + 35 * DAY);
    const third = await runAppLifecycle(WS, day35);
    expect(third.counts.archive).toBe(1);
    expect(await fileAt("archive/apps/old/mako.json")).not.toBeNull();
    expect(await fileAt(`users/${HANDLE}/apps/mine/mako.json`)).not.toBeNull();
    const { stdout } = await import("./git").then(g =>
      g.runGit(["-C", repoDirFor(WS), "log", "-1", "--format=%an <%ae>"]),
    );
    expect(stdout.trim()).toBe("Mako <bot@mako.ai>");
    const receipt = await AppLifecycleState.findOne({ appId: OLD_ID }).lean();
    expect(receipt).toMatchObject({
      archivedFrom: "apps/old",
      archivedTo: "archive/apps/old",
    });
    expect(receipt?.staleSince).toBeUndefined();
    send.mockRestore();
  });
});

describe("hooks", () => {
  it("paused schedules are listed for the scheduler until the next open", async () => {
    await AppLifecycleState.create({
      workspaceId: new Types.ObjectId(WS),
      appId: OLD_ID,
      schedulesPausedAt: new Date(),
    });
    expect([...(await pausedScheduleAppIds())]).toEqual([OLD_ID]);
    await onAppOpened(WS, OLD_ID);
    expect((await pausedScheduleAppIds()).size).toBe(0);
  });

  it("a recorded open resumes paused schedules; a heartbeat does not", async () => {
    await AppLifecycleState.create({
      workspaceId: new Types.ObjectId(WS),
      appId: OLD_ID,
      schedulesPausedAt: new Date(),
      staleSince: new Date(),
    });
    const usage = {
      workspaceId: WS,
      appId: OLD_ID,
      userId: OWNER,
      source: "app" as const,
    };
    await recordAppUsage({ ...usage, kind: "heartbeat" });
    await new Promise(r => setTimeout(r, 50));
    expect((await pausedScheduleAppIds()).size).toBe(1);
    await recordAppUsage({ ...usage, kind: "open" });
    // Fire-and-forget: the usage write does not wait for it.
    for (let i = 0; i < 50 && (await pausedScheduleAppIds()).size; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect((await pausedScheduleAppIds()).size).toBe(0);
    const row = await AppLifecycleState.findOne({ appId: OLD_ID }).lean();
    expect(row?.staleSince).toBeUndefined();
  });

  it("verified marks record who and are listed per workspace", async () => {
    await setAppVerified(WS, OLD_ID, true, OWNER);
    const row = await AppLifecycleState.findOne({ appId: OLD_ID }).lean();
    expect(row?.verifiedBy).toBe(OWNER);
    expect([...(await verifiedAppIds(WS))]).toEqual([OLD_ID]);
    await setAppVerified(WS, OLD_ID, false, OWNER);
    expect((await verifiedAppIds(WS)).size).toBe(0);
  });
});

describe("routes", () => {
  const router = createRouter();
  router.route("/api/workspaces/:workspaceId/apps", appsRoutes);
  const ADMIN = new Types.ObjectId().toString();
  const MEMBER = new Types.ObjectId().toString();
  const call = (method: string, url: string, body?: unknown) =>
    router.request(`/api/workspaces/${WS}/apps${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    await WorkspaceMember.deleteMany({});
    await WorkspaceMember.create([
      { workspaceId: new Types.ObjectId(WS), userId: ADMIN, role: "admin" },
      { workspaceId: new Types.ObjectId(WS), userId: MEMBER, role: "member" },
      { workspaceId: new Types.ObjectId(WS), userId: OWNER, role: "member" },
    ]);
  });

  it("the plan is for admins only, and says it is a dry run", async () => {
    identity.userId = MEMBER;
    expect((await call("GET", "/lifecycle/plan")).status).toBe(403);
    identity.userId = ADMIN;
    const res = await call("GET", "/lifecycle/plan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { mode: string; appsConsidered: number };
    };
    expect(body.plan).toMatchObject({ mode: "dry-run", appsConsidered: 3 });
  });

  it("only admins verify; the app list carries the mark", async () => {
    identity.userId = MEMBER;
    const denied = await call("PUT", `/${OLD_ID}/verified`, {
      verified: true,
    });
    expect(denied.status).toBe(403);
    identity.userId = ADMIN;
    const ok = await call("PUT", `/${OLD_ID}/verified`, { verified: true });
    expect(ok.status).toBe(200);
    const list = (await (await call("GET", "")).json()) as {
      apps: Array<{ id: string; verified: boolean }>;
    };
    expect(list.apps.find(a => a.id === OLD_ID)?.verified).toBe(true);
    expect(list.apps.find(a => a.id === FRESH_ID)?.verified).toBe(false);
    // The Apps home (its badge) reads the same mark.
    const home = (await (await call("GET", "/discovery")).json()) as {
      apps: Array<{ id: string; verified: boolean }>;
    };
    expect(home.apps.find(a => a.id === OLD_ID)?.verified).toBe(true);
    expect(home.apps.find(a => a.id === FRESH_ID)?.verified).toBe(false);
  });

  it("share with workspace: the owner only, with a description", async () => {
    const share = (description: string) =>
      call("POST", `/${MINE_ID}/share-with-workspace`, { description });
    identity.userId = MEMBER;
    expect([403, 404]).toContain((await share("x")).status);
    identity.userId = OWNER;
    expect((await share("  ")).status).toBe(400);
    const ok = await share("Pipeline by stage");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { to: string }).to).toBe("apps/mine");
    const written = JSON.parse((await fileAt("apps/mine/mako.json")) ?? "{}");
    expect(written).toMatchObject({ description: "Pipeline by stage" });
    // Already in the workspace: nothing to share (or no longer theirs to move).
    expect([403, 409]).toContain((await share("again")).status);
  });
});
