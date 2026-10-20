/**
 * App lifecycle + curation (app discovery, phase 5).
 *
 * Two rules, run once a day by `appsLifecycleFunction`:
 *
 *  - STALE: nobody but its authors opened the app in 60 days AND no commit
 *    touched its folder in 60 days → its owner is told, and 14 days later
 *    the folder is archived (moved to `archive/<path>` on main, by the Mako
 *    bot) unless someone opened or edited it in between.
 *  - UNVIEWED: nobody at all opened the app in 30 days → its binding
 *    schedules are skipped by the scheduler (the SQL front matter is not
 *    touched) until the next open, which resumes them (`onAppOpened`).
 *
 * Safety, in this order:
 *  - Everything is DRY-RUN unless `APPS_LIFECYCLE_ENFORCE` names the
 *    workspace (or is `all`). A dry run writes no state, sends no email and
 *    commits nothing: it logs what it would do. `GET .../apps/lifecycle/plan`
 *    shows the same plan to workspace admins.
 *  - "Nobody opened it in N days" is only claimed once usage has been
 *    recorded for N days: before that the window predates tracking and every
 *    app would look unused.
 *  - Apps younger than 14 days and admin-verified apps are never staled.
 *
 * The planner is pure (`planAppLifecycle`) and unit-tested; gathering and
 * applying are separate so the plan endpoint and the job share one code path.
 */
import mongoose, { Types } from "mongoose";
import { loggers } from "../logging";
import {
  AppIndexEntry,
  AppLifecycleState,
  AppProject,
  Workspace,
  WorkspaceMember,
  type IAppLifecycleState,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import { loadAppsIndex, type AppIndexRow } from "./app-index.service";
import { SWEEP_COMMIT_APP_LIMIT, getAppUsageStats } from "./app-usage.service";
import { runGit } from "./git";
import { archiveProject, repoForWorkspace } from "./worktree.service";
import { APPS_DIR, USERS_DIR } from "./app-paths";
import { renderEmail } from "../emails/render";
import { AppStaleNoticeTemplate } from "../emails/AppStaleNoticeEmail";
import { emailService } from "../services/email.service";

const log = loggers.api("apps-lifecycle");

const DAY_MS = 24 * 60 * 60 * 1000;

export const LIFECYCLE_RULES = {
  /** No non-author open and no commit for this long → stale. */
  staleDays: 60,
  /** Notice → archive. */
  archiveGraceDays: 14,
  /** No open at all for this long → binding schedules paused. */
  unviewedDays: 30,
  /** Apps younger than this are left alone. */
  minAgeDays: 14,
} as const;

/** The committer of archive moves. */
export const LIFECYCLE_BOT_AUTHOR = { name: "Mako", email: "bot@mako.ai" };

/** Collection Lane A's usage service writes (shared contract). */
const USAGE_COLLECTION = "app_usage_daily";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * `APPS_LIFECYCLE_ENFORCE`: unset (the default) = dry run everywhere; `all`
 * = enforce everywhere; otherwise a comma-separated list of workspace ids
 * to enforce in. Read per call so a deploy-time env change takes effect
 * without a code path that caches it.
 */
export function lifecycleEnforced(workspaceId: string): boolean {
  const raw = (process.env.APPS_LIFECYCLE_ENFORCE ?? "").trim();
  if (!raw) return false;
  if (raw === "all" || raw === "*") return true;
  return raw
    .split(",")
    .map(s => s.trim())
    .includes(workspaceId);
}

// ---------------------------------------------------------------------------
// Planner — pure
// ---------------------------------------------------------------------------

export interface LifecycleAppInput {
  appId: string;
  path: string;
  title: string;
  /** Earliest creation date Mako knows (index row / project row). */
  createdAt: Date | null;
  lastCommitAt: Date | null;
  lastOpenedAt: Date | null;
  lastNonAuthorOpenedAt: Date | null;
  /** Has scheduled bindings the scheduler would run (a project row exists). */
  scheduled: boolean;
  verified: boolean;
  state: Pick<IAppLifecycleState, "staleSince" | "schedulesPausedAt"> | null;
}

export type LifecycleActionKind =
  | "notify-stale"
  | "archive"
  | "clear-stale"
  | "pause-schedules"
  | "resume-schedules";

export interface LifecyclePlanEntry {
  appId: string;
  path: string;
  title: string;
  actions: LifecycleActionKind[];
  /** Why, in words, one per action (or why nothing happens yet). */
  reasons: string[];
  /** For a noticed or about-to-be-noticed app: when it would be archived. */
  archiveOn?: string;
}

export interface LifecyclePlanContext {
  now: Date;
  /** First day usage was recorded in this workspace; null = never. */
  usageSince: Date | null;
}

const after = (d: Date | null | undefined, ref: Date) =>
  !!d && d.getTime() > ref.getTime();
const daysAgo = (now: Date, days: number) =>
  new Date(now.getTime() - days * DAY_MS);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * What the job should do to each app. Only apps with an action, or a stale
 * notice still counting down, are returned.
 */
export function planAppLifecycle(
  apps: LifecycleAppInput[],
  ctx: LifecyclePlanContext,
): LifecyclePlanEntry[] {
  const { now, usageSince } = ctx;
  const R = LIFECYCLE_RULES;
  // Usage covers the whole window only once tracking is that old.
  const historyCovers = (days: number) =>
    !!usageSince && usageSince.getTime() <= daysAgo(now, days).getTime();
  const out: LifecyclePlanEntry[] = [];

  for (const app of apps) {
    const entry: LifecyclePlanEntry = {
      appId: app.appId,
      path: app.path,
      title: app.title,
      actions: [],
      reasons: [],
    };
    const state = app.state;

    // Resume first: an open since the pause always wins.
    const pausedAt = state?.schedulesPausedAt ?? null;
    const paused = !!pausedAt;
    if (pausedAt && after(app.lastOpenedAt, pausedAt)) {
      entry.actions.push("resume-schedules");
      entry.reasons.push("opened since its schedules were paused");
    }

    const young =
      !!app.createdAt && after(app.createdAt, daysAgo(now, R.minAgeDays));
    const stale =
      !young &&
      !app.verified &&
      historyCovers(R.staleDays) &&
      !after(app.lastNonAuthorOpenedAt, daysAgo(now, R.staleDays)) &&
      !after(app.lastCommitAt, daysAgo(now, R.staleDays));

    const noticedAt = state?.staleSince ?? null;
    if (noticedAt) {
      const reprieved =
        app.verified ||
        after(app.lastOpenedAt, noticedAt) ||
        after(app.lastCommitAt, noticedAt);
      if (reprieved || !stale) {
        entry.actions.push("clear-stale");
        entry.reasons.push(
          app.verified
            ? "verified by an admin since the stale notice"
            : "opened or edited since the stale notice",
        );
      } else {
        const archiveAt = new Date(
          noticedAt.getTime() + R.archiveGraceDays * DAY_MS,
        );
        entry.archiveOn = isoDay(archiveAt);
        if (now.getTime() >= archiveAt.getTime()) {
          entry.actions.push("archive");
          entry.reasons.push(
            `stale notice sent ${isoDay(noticedAt)}; nobody opened or edited it since`,
          );
        } else {
          entry.reasons.push(
            `stale notice sent ${isoDay(noticedAt)}; archived on ${entry.archiveOn} unless used`,
          );
        }
      }
    } else if (stale) {
      entry.actions.push("notify-stale");
      entry.archiveOn = isoDay(
        new Date(now.getTime() + R.archiveGraceDays * DAY_MS),
      );
      entry.reasons.push(
        `no open by anyone but its authors and no commit in ${R.staleDays} days`,
      );
    }

    const unviewed =
      app.scheduled &&
      !young &&
      historyCovers(R.unviewedDays) &&
      !after(app.lastOpenedAt, daysAgo(now, R.unviewedDays));
    if (unviewed && !paused && !entry.actions.includes("archive")) {
      entry.actions.push("pause-schedules");
      entry.reasons.push(
        `scheduled bindings, but nobody opened it in ${R.unviewedDays} days`,
      );
    }

    if (entry.actions.length > 0 || entry.archiveOn) out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * Newest commit touching each app folder, over one `git log` of the app
 * trees — never one rev-list per app (2026-10-19: 573 sequential rev-lists
 * saturated the service). Only commits since `since` are walked.
 *
 * A SWEEPING commit — one touching more than `sweepingApps` apps, like
 * "switch every app to pnpm" or an SDK bump — is nobody editing any one of
 * them, so it does not count: on the RealAdvisor repo two such chores
 * (2026-09-16, 179 folders; 2026-10-02, 88) would otherwise make every app
 * look recently edited for two months after each one. The threshold is the
 * usage service's: a sweep is not authorship there, and not an edit here.
 */
export const SWEEPING_COMMIT_APPS = SWEEP_COMMIT_APP_LIMIT;

export async function lastCommitByAppPath(
  repoDir: string,
  sha: string,
  appPaths: string[],
  since: Date,
  sweepingApps = SWEEPING_COMMIT_APPS,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!sha || appPaths.length === 0) return out;
  const roots = new Set(appPaths);
  const { stdout } = await runGit(
    [
      "-C",
      repoDir,
      "log",
      sha,
      `--since=${since.toISOString()}`,
      "--format=%x1e%ct",
      "--name-only",
      "--",
      APPS_DIR,
      USERS_DIR,
    ],
    { timeoutMs: 60_000 },
  );
  for (const record of stdout.split("\x1e")) {
    const lines = record.split("\n").filter(Boolean);
    if (lines.length < 2) continue;
    const at = new Date(Number(lines[0]) * 1000);
    const touched = new Set<string>();
    for (const file of lines.slice(1)) {
      // Walk up to the app folder holding this file.
      let dir = file;
      for (let slash = dir.lastIndexOf("/"); slash > 0;) {
        dir = dir.slice(0, slash);
        if (roots.has(dir)) {
          touched.add(dir);
          break;
        }
        slash = dir.lastIndexOf("/");
      }
    }
    if (touched.size > sweepingApps) continue;
    // Newest first: the first commit seen for an app is its last.
    for (const dir of touched) if (!out.has(dir)) out.set(dir, at);
  }
  return out;
}

/** The first UTC day usage was recorded in this workspace, or null. */
export async function usageHistorySince(
  workspaceId: string,
): Promise<Date | null> {
  const db = mongoose.connection.db;
  if (!db) return null;
  const ids: unknown[] = [workspaceId];
  if (Types.ObjectId.isValid(workspaceId)) {
    ids.push(new Types.ObjectId(workspaceId));
  }
  const first = await db
    .collection<{ day?: string; firstAt?: Date }>(USAGE_COLLECTION)
    .find({ workspaceId: { $in: ids } })
    .sort({ day: 1 })
    .limit(1)
    .project<{ day?: string; firstAt?: Date }>({ day: 1, firstAt: 1 })
    .toArray();
  const row = first[0];
  if (!row) return null;
  if (row.day) return new Date(`${row.day}T00:00:00.000Z`);
  return row.firstAt ?? null;
}

interface GatheredWorkspace {
  workspaceId: string;
  apps: Array<LifecycleAppInput & { row: AppIndexRow; ownerId?: string }>;
  usageSince: Date | null;
}

const toDate = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

async function gatherWorkspace(
  workspaceId: string,
  now: Date,
): Promise<GatheredWorkspace> {
  const ws = new Types.ObjectId(workspaceId);
  const snapshot = await loadAppsIndex(workspaceId);
  const [entries, projects, states, usage, usageSince] = await Promise.all([
    AppIndexEntry.find({ workspaceId: ws }).select("appId createdAt").lean(),
    AppProject.find({ workspaceId: ws })
      .select("_id owner_id createdBy createdAt")
      .lean(),
    AppLifecycleState.find({ workspaceId: ws }).lean(),
    getAppUsageStats(workspaceId, { days: LIFECYCLE_RULES.staleDays, now }),
    usageHistorySince(workspaceId),
  ]);
  let commits = new Map<string, Date>();
  if (snapshot.sha) {
    const repoDir = await repoForWorkspace(workspaceId);
    commits = await lastCommitByAppPath(
      repoDir,
      snapshot.sha,
      snapshot.apps.map(a => a.path),
      daysAgo(now, LIFECYCLE_RULES.staleDays + 1),
    );
  }
  const entryCreated = new Map(entries.map(e => [e.appId, e.createdAt]));
  const projectById = new Map(projects.map(p => [p._id.toString(), p]));
  const stateById = new Map(states.map(s => [s.appId, s]));

  const apps = snapshot.apps.map(row => {
    const project = projectById.get(row.appId);
    const created = [entryCreated.get(row.appId), project?.createdAt]
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime());
    const stats = usage.get(row.appId);
    const state = stateById.get(row.appId) ?? null;
    const owner =
      project?.owner_id ||
      (project?.createdBy && /^[0-9a-f]{24}$/i.test(project.createdBy)
        ? project.createdBy
        : undefined) ||
      row.ownerId;
    return {
      appId: row.appId,
      path: row.path,
      title: row.title,
      createdAt: created[0] ?? null,
      lastCommitAt: commits.get(row.path) ?? null,
      lastOpenedAt: toDate(stats?.lastOpenedAt),
      lastNonAuthorOpenedAt: toDate(stats?.lastNonAuthorOpenedAt),
      scheduled: row.schedules.length > 0 && !!project,
      verified: !!state?.verifiedAt,
      state,
      row,
      ownerId: owner || undefined,
    };
  });
  return { workspaceId, apps, usageSince };
}

// ---------------------------------------------------------------------------
// Plan (the admin report) and run (the job)
// ---------------------------------------------------------------------------

export interface LifecyclePlan {
  workspaceId: string;
  mode: "dry-run" | "enforce";
  generatedAt: string;
  rules: typeof LIFECYCLE_RULES;
  usageHistorySince: string | null;
  appsConsidered: number;
  counts: Record<LifecycleActionKind, number> & { pendingArchive: number };
  apps: LifecyclePlanEntry[];
}

function summarize(
  workspaceId: string,
  gathered: GatheredWorkspace,
  entries: LifecyclePlanEntry[],
  now: Date,
): LifecyclePlan {
  const counts = {
    "notify-stale": 0,
    archive: 0,
    "clear-stale": 0,
    "pause-schedules": 0,
    "resume-schedules": 0,
    pendingArchive: 0,
  };
  for (const e of entries) {
    for (const a of e.actions) counts[a]++;
    if (e.archiveOn && e.actions.length === 0) counts.pendingArchive++;
  }
  return {
    workspaceId,
    mode: lifecycleEnforced(workspaceId) ? "enforce" : "dry-run",
    generatedAt: now.toISOString(),
    rules: LIFECYCLE_RULES,
    usageHistorySince: gathered.usageSince ? isoDay(gathered.usageSince) : null,
    appsConsidered: gathered.apps.length,
    counts,
    apps: entries,
  };
}

/** The plan for one workspace, computed now, changing nothing. */
export async function getAppLifecyclePlan(
  workspaceId: string,
  now = new Date(),
): Promise<LifecyclePlan> {
  const gathered = await gatherWorkspace(workspaceId, now);
  return summarize(
    workspaceId,
    gathered,
    planAppLifecycle(gathered.apps, { now, usageSince: gathered.usageSince }),
    now,
  );
}

/** Emails of a workspace's owners and admins: who hears about ownerless apps. */
async function adminEmails(workspaceId: string): Promise<string[]> {
  const members = await WorkspaceMember.find({
    workspaceId: new Types.ObjectId(workspaceId),
    role: { $in: ["owner", "admin"] },
  })
    .select("userId")
    .lean();
  const users = await User.find({ _id: { $in: members.map(m => m.userId) } })
    .select("email")
    .lean();
  return users.map(u => u.email).filter(Boolean);
}

function appUrl(appId: string): string | undefined {
  const base =
    process.env.CLIENT_URL?.replace(/\/$/, "") ||
    process.env.PUBLIC_URL?.replace(/\/$/, "");
  return base ? `${base}/apps/${appId}` : undefined;
}

async function upsertState(
  workspaceId: string,
  appId: string,
  update: mongoose.UpdateQuery<IAppLifecycleState>,
): Promise<void> {
  await AppLifecycleState.updateOne(
    { workspaceId: new Types.ObjectId(workspaceId), appId },
    update,
    { upsert: true },
  );
}

/**
 * Plan and — only when the workspace is enforced — apply. Returns the plan
 * either way, with `mode` saying which happened.
 */
export async function runAppLifecycle(
  workspaceId: string,
  now = new Date(),
): Promise<LifecyclePlan> {
  const gathered = await gatherWorkspace(workspaceId, now);
  const entries = planAppLifecycle(gathered.apps, {
    now,
    usageSince: gathered.usageSince,
  });
  const plan = summarize(workspaceId, gathered, entries, now);
  if (plan.mode === "dry-run") {
    for (const e of entries) {
      if (e.actions.length === 0) continue;
      log.info("Apps lifecycle (dry run) would act", {
        workspaceId,
        appId: e.appId,
        path: e.path,
        actions: e.actions,
        reasons: e.reasons,
      });
    }
    log.info("Apps lifecycle dry run", { workspaceId, counts: plan.counts });
    return plan;
  }

  const byId = new Map(gathered.apps.map(a => [a.appId, a]));
  const toNotify: LifecyclePlanEntry[] = [];
  for (const e of entries) {
    for (const action of e.actions) {
      try {
        switch (action) {
          case "resume-schedules":
            await upsertState(workspaceId, e.appId, {
              $unset: { schedulesPausedAt: 1 },
            });
            break;
          case "pause-schedules":
            await upsertState(workspaceId, e.appId, {
              $set: { schedulesPausedAt: now },
            });
            break;
          case "clear-stale":
            await upsertState(workspaceId, e.appId, {
              $unset: { staleSince: 1, staleNotifiedTo: 1 },
            });
            break;
          case "notify-stale":
            toNotify.push(e);
            break;
          case "archive": {
            const moved = await archiveProject(workspaceId, e.path, {
              author: LIFECYCLE_BOT_AUTHOR,
              reason: `Archived by the Mako app lifecycle job: ${e.reasons.join("; ")}. Move the folder back under apps/ (or users/<you>/apps/) to restore it.`,
            });
            await upsertState(workspaceId, e.appId, {
              $set: {
                archivedAt: now,
                archivedFrom: moved.from,
                archivedTo: moved.to,
              },
              $unset: {
                staleSince: 1,
                staleNotifiedTo: 1,
                schedulesPausedAt: 1,
              },
            });
            log.info("Apps lifecycle archived app", {
              workspaceId,
              appId: e.appId,
              ...moved,
            });
            break;
          }
        }
      } catch (error) {
        log.warn("Apps lifecycle action failed", {
          workspaceId,
          appId: e.appId,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (toNotify.length > 0) {
    await notifyStale(workspaceId, toNotify, byId, now);
  }
  log.info("Apps lifecycle run", { workspaceId, counts: plan.counts });
  return plan;
}

/**
 * One digest per recipient. The countdown (`staleSince`) starts only for
 * apps whose notice was actually sent: an app nobody was told about is
 * never archived.
 */
async function notifyStale(
  workspaceId: string,
  entries: LifecyclePlanEntry[],
  byId: Map<string, { ownerId?: string }>,
  now: Date,
): Promise<void> {
  const workspace = await Workspace.findById(workspaceId).select("name").lean();
  const ownerIds = [
    ...new Set(
      entries
        .map(e => byId.get(e.appId)?.ownerId)
        .filter((id): id is string => !!id),
    ),
  ];
  const owners = await User.find({ _id: { $in: ownerIds } })
    .select("email")
    .lean();
  const emailOf = new Map(owners.map(u => [u._id, u.email]));
  let admins: string[] | null = null;

  const digests = new Map<string, LifecyclePlanEntry[]>();
  for (const e of entries) {
    const ownerId = byId.get(e.appId)?.ownerId;
    const ownerEmail = ownerId ? emailOf.get(ownerId) : undefined;
    const recipients = ownerEmail
      ? [ownerEmail]
      : (admins ??= await adminEmails(workspaceId));
    for (const to of recipients) {
      const list = digests.get(to) ?? [];
      list.push(e);
      digests.set(to, list);
    }
  }

  const archiveOn = isoDay(
    new Date(now.getTime() + LIFECYCLE_RULES.archiveGraceDays * DAY_MS),
  );
  const notified = new Map<string, string[]>();
  for (const [to, list] of digests) {
    try {
      const body = await renderEmail(AppStaleNoticeTemplate, {
        workspaceName: workspace?.name ?? "your workspace",
        archiveOn,
        apps: list.map(e => ({
          title: e.title,
          path: e.path,
          url: appUrl(e.appId),
        })),
      });
      await emailService.sendAppLifecycleEmail(to, body);
      for (const e of list) {
        notified.set(e.appId, [...(notified.get(e.appId) ?? []), to]);
      }
    } catch (error) {
      log.warn("Apps lifecycle notice failed", {
        workspaceId,
        to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const [appId, to] of notified) {
    await upsertState(workspaceId, appId, {
      $set: { staleSince: now, staleNotifiedTo: to },
    });
  }
}

// ---------------------------------------------------------------------------
// Hooks other code calls
// ---------------------------------------------------------------------------

/**
 * Called by recordAppUsage on every recorded open (so the in-app beacon and
 * served share/live/embed opens alike); lives in app-lifecycle-state.ts to
 * keep the usage service free of an import cycle.
 */
export { onAppOpened, verifiedAppIds } from "./app-lifecycle-state";

/** App ids whose binding schedules the scheduler must skip. */
export async function pausedScheduleAppIds(): Promise<Set<string>> {
  const ids = await AppLifecycleState.distinct("appId", {
    schedulesPausedAt: { $exists: true },
  });
  return new Set(ids.map(String));
}

/** Mark (or unmark) an app verified. The caller checks the admin role. */
export async function setAppVerified(
  workspaceId: string,
  appId: string,
  verified: boolean,
  userId: string,
): Promise<{ verified: boolean; verifiedAt?: Date; verifiedBy?: string }> {
  if (verified) {
    const at = new Date();
    await upsertState(workspaceId, appId, {
      $set: { verifiedAt: at, verifiedBy: userId },
    });
    return { verified: true, verifiedAt: at, verifiedBy: userId };
  }
  await AppLifecycleState.updateOne(
    { workspaceId: new Types.ObjectId(workspaceId), appId },
    { $unset: { verifiedAt: 1, verifiedBy: 1 } },
  );
  return { verified: false };
}

/** Workspaces the daily job visits: every one with an apps index. */
export async function lifecycleWorkspaceIds(): Promise<string[]> {
  const ids = await AppIndexEntry.distinct("workspaceId");
  return ids.map(id => id.toString());
}
