/**
 * App usage — who opens which app, and which apps people actually use.
 *
 * Every view of a PUBLISHED app reports itself: an `open` when it starts, a
 * `heartbeat` every 60 s while the page is visible. Both land in one row per
 * (workspace, app, viewer, UTC day) in `app_usage_daily`, bumped with `$inc`
 * upserts — the collection grows with distinct viewer-days, never with
 * traffic. The in-editor dev preview never reports: that is the author
 * building, not someone using the app.
 *
 * Popularity excludes the app's AUTHORS (see getAppAuthors): the owner on
 * the app's row, the owner of the personal tree it lives in, and whoever
 * committed to its folder on main — minus sweeping commits that touch many
 * apps at once, which are maintenance, not authorship. Commits are the only
 * reliable signal: an app pushed from a laptop has no row at all, and a row
 * is claimed by whoever first published or shared it.
 *
 * Score = Σ over signed-in non-author viewers of their distinct active days
 * in the window, each day weighted 0.5^(age_days / 14). Daily use by many
 * beats daily use by one, which beats one look by many.
 */
import { Types } from "mongoose";
import { AppProject, AppUsageDaily } from "../database/workspace-schema";
import { User } from "../database/schema";
import { loggers } from "../logging";
import { loadAppsIndex } from "./app-index.service";
import { runGit } from "./git";
import { DEFAULT_BRANCH, resolveCommit } from "./repository.service";
import { boundRepoDirIfExists } from "./workspace-repo-required";

const logger = loggers.api("apps-usage");

export type AppUsageSource = "app" | "share" | "embed";
export const APP_USAGE_SOURCES: readonly AppUsageSource[] = [
  "app",
  "share",
  "embed",
];

/** What one heartbeat is worth; the client beats on the same period. */
export const HEARTBEAT_SECONDS = 60;
/** Popularity halves every this many days of age. */
export const SCORE_HALF_LIFE_DAYS = 14;
export const DEFAULT_USAGE_WINDOW_DAYS = 28;
/** "Recently viewed" looks this far back. */
const RECENT_LOOKBACK_DAYS = 90;
/** A commit touching more apps than this is a sweep, not authorship. */
export const SWEEP_COMMIT_APP_LIMIT = 3;
/** How far back commit authorship is read. */
const AUTHOR_HISTORY_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of the UTC day `at` falls on. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Whole days between two `YYYY-MM-DD` days (b - a). */
function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}

/** The weight of one active day `day`, seen from `today`. */
export function recencyWeight(day: string, today: string): number {
  const age = Math.max(0, dayDiff(day, today));
  return 0.5 ** (age / SCORE_HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export async function recordAppUsage(input: {
  workspaceId: string;
  appId: string;
  userId: string | null;
  kind: "open" | "heartbeat";
  source: AppUsageSource;
  at?: Date;
}): Promise<void> {
  const at = input.at ?? new Date();
  const inc: Record<string, number> =
    input.kind === "open"
      ? { opens: 1, [`sources.${input.source}`]: 1 }
      : { activeSeconds: HEARTBEAT_SECONDS };
  await AppUsageDaily.updateOne(
    {
      workspaceId: new Types.ObjectId(input.workspaceId),
      appId: input.appId,
      userId: input.userId,
      day: utcDay(at),
    },
    {
      $inc: inc,
      $min: { firstAt: at },
      $max: { lastAt: at },
    },
    { upsert: true },
  );
}

/**
 * Light per-instance throttle: one open per viewer+app every
 * OPEN_MIN_INTERVAL_MS, one heartbeat every HEARTBEAT_MIN_INTERVAL_MS. A
 * double-mounted effect, a reload loop or a scripted client cannot inflate
 * the numbers; a real viewer never hits it. Per instance on purpose — this is
 * hygiene, not security, and costs no round trip.
 */
const OPEN_MIN_INTERVAL_MS = 10_000;
const HEARTBEAT_MIN_INTERVAL_MS = (HEARTBEAT_SECONDS * 1000) / 2;
const lastBeatAt = new Map<string, number>();

export function acceptUsageBeat(
  key: string,
  kind: "open" | "heartbeat",
  now: number = Date.now(),
): boolean {
  const slot = `${kind}:${key}`;
  const min =
    kind === "open" ? OPEN_MIN_INTERVAL_MS : HEARTBEAT_MIN_INTERVAL_MS;
  const last = lastBeatAt.get(slot);
  if (last !== undefined && now - last < min) return false;
  lastBeatAt.set(slot, now);
  if (lastBeatAt.size > 50_000) {
    for (const [k, t] of lastBeatAt) {
      if (now - t > HEARTBEAT_SECONDS * 2000) lastBeatAt.delete(k);
    }
  }
  return true;
}

/**
 * Opens the SERVER sees: a page load of a published app that never passes
 * through Mako's React shell — a share link (the share page hands the
 * browser straight to the app's entry), a raw `/live/` link, or either one
 * framed on another site. Counted when the HTML entry is served as a page
 * (`Sec-Fetch-Dest: document`) or a frame (`iframe` → `embed`); the bundle's
 * own requests are never HTML documents, so they never count. These views
 * have no heartbeat — the page is the app's, not ours.
 */
export function servedOpenSource(
  fetchDest: string | undefined,
  contentType: string | null | undefined,
  pageSource: "app" | "share",
): AppUsageSource | null {
  if (!contentType?.toLowerCase().startsWith("text/html")) return null;
  if (fetchDest === "document") return pageSource;
  if (fetchDest === "iframe" || fetchDest === "frame") return "embed";
  return null;
}

/** Record a served open without holding up the response, or failing it. */
export function recordServedOpen(input: {
  workspaceId: string;
  appId: string;
  userId: string | null;
  /** Who to throttle by: the user, or the client IP for anonymous views. */
  viewerKey: string;
  fetchDest: string | undefined;
  contentType: string | null | undefined;
  pageSource: "app" | "share";
}): void {
  const source = servedOpenSource(
    input.fetchDest,
    input.contentType,
    input.pageSource,
  );
  if (!source) return;
  if (!acceptUsageBeat(`${input.viewerKey}:${input.appId}`, "open")) return;
  recordAppUsage({
    workspaceId: input.workspaceId,
    appId: input.appId,
    userId: input.userId,
    kind: "open",
    source,
  }).catch(error => {
    logger.warn("Could not record an app open", {
      appId: input.appId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Forget the throttle (tests). */
export function resetUsageThrottle(): void {
  lastBeatAt.clear();
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

/**
 * Commit author emails per app, from `git log --format=%x00%ae --name-only`
 * output: each commit is a NUL line with the email, then the paths it
 * touched. A path belongs to the app whose folder contains it (the deepest
 * one, though app folders never nest). Commits touching more than
 * SWEEP_COMMIT_APP_LIMIT apps are skipped. Pure, so it is unit-tested.
 */
export function parseCommitAuthors(
  log: string,
  apps: ReadonlyArray<{ appId: string; path: string }>,
): Map<string, Set<string>> {
  const roots = [...apps].sort((a, b) => b.path.length - a.path.length);
  const appOf = (file: string): string | null => {
    for (const app of roots) {
      if (file.startsWith(`${app.path}/`)) return app.appId;
    }
    return null;
  };
  const out = new Map<string, Set<string>>();
  for (const chunk of log.split("\0")) {
    const lines = chunk.split("\n").map(l => l.trim());
    const email = lines[0]?.toLowerCase();
    if (!email) continue;
    const touched = new Set<string>();
    for (const file of lines.slice(1)) {
      if (!file) continue;
      const appId = appOf(file);
      if (appId) touched.add(appId);
    }
    if (touched.size === 0 || touched.size > SWEEP_COMMIT_APP_LIMIT) continue;
    for (const appId of touched) {
      let set = out.get(appId);
      if (!set) out.set(appId, (set = new Set()));
      set.add(email);
    }
  }
  return out;
}

const commitAuthorCache = new Map<
  string,
  { sha: string; byApp: Map<string, Set<string>> }
>();

async function commitAuthorUserIds(
  workspaceId: string,
  apps: ReadonlyArray<{ appId: string; path: string }>,
): Promise<Map<string, Set<string>>> {
  try {
    // A READ: no bound repo means no history to attribute, not a skipped
    // write (no-silent-repo-skip guards writes).
    const repoDir = await boundRepoDirIfExists(workspaceId);
    if (repoDir === null) return new Map();
    const ref = `refs/heads/${DEFAULT_BRANCH}`;
    const sha = await resolveCommit(repoDir, ref);
    if (!sha) return new Map();
    const cached = commitAuthorCache.get(workspaceId);
    if (cached?.sha === sha) return cached.byApp;
    const { stdout } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        ref,
        "--no-merges",
        `--since=${AUTHOR_HISTORY_DAYS}.days`,
        "--format=%x00%ae",
        "--name-only",
        "--",
        "apps",
        "users",
      ],
      { timeoutMs: 15_000, maxBufferBytes: 64 * 1024 * 1024 },
    );
    const emailsByApp = parseCommitAuthors(stdout, apps);
    const emails = [...new Set([...emailsByApp.values()].flatMap(s => [...s]))];
    const users = emails.length
      ? await User.find({ email: { $in: emails } })
          .select("_id email")
          .lean()
      : [];
    const idByEmail = new Map(
      users.map(u => [u.email.toLowerCase(), String(u._id)]),
    );
    const byApp = new Map<string, Set<string>>();
    for (const [appId, set] of emailsByApp) {
      const ids = new Set(
        [...set].map(e => idByEmail.get(e)).filter((id): id is string => !!id),
      );
      if (ids.size) byApp.set(appId, ids);
    }
    commitAuthorCache.set(workspaceId, { sha, byApp });
    return byApp;
  } catch (error) {
    // Authorship from history is a refinement; the row owners still apply.
    logger.warn("Could not read app commit authors", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/**
 * Each app's authors (user ids): the row's owner and creator, the owner of
 * the personal tree it lives in, and its committers on main.
 */
export async function getAppAuthors(
  workspaceId: string,
): Promise<Map<string, Set<string>>> {
  const [snapshot, rows] = await Promise.all([
    loadAppsIndex(workspaceId, { freshen: false }),
    AppProject.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .select("_id owner_id createdBy")
      .lean(),
  ]);
  const authors = await commitAuthorUserIds(workspaceId, snapshot.apps);
  const add = (appId: string, userId: string | null | undefined) => {
    if (!userId) return;
    let set = authors.get(appId);
    if (!set) authors.set(appId, (set = new Set()));
    set.add(userId);
  };
  for (const app of snapshot.apps) add(app.appId, app.ownerId);
  for (const row of rows) {
    add(row._id.toString(), row.owner_id);
    add(row._id.toString(), row.createdBy);
  }
  return authors;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface AppUsageStats {
  appId: string;
  /** Distinct signed-in viewers in the window (authors included). */
  viewers: number;
  /** Distinct signed-in viewers who are not the app's authors. */
  nonAuthorViewers: number;
  /** Σ over non-author viewers of their distinct active days. */
  viewerDays: number;
  /** All opens in the window, anyone's (authors and share links included). */
  opens: number;
  activeSeconds: number;
  /** Last activity, anyone's (ISO). */
  lastOpenedAt: string | null;
  /** Last activity by anyone but an author — anonymous share viewers count. */
  lastNonAuthorOpenedAt: string | null;
  score: number;
}

/** One viewer's usage of one app over the window. */
export interface AppUsageRollup {
  appId: string;
  userId: string | null;
  days: string[];
  opens: number;
  activeSeconds: number;
  lastAt: Date;
}

export function emptyAppUsageStats(appId: string): AppUsageStats {
  return {
    appId,
    viewers: 0,
    nonAuthorViewers: 0,
    viewerDays: 0,
    opens: 0,
    activeSeconds: 0,
    lastOpenedAt: null,
    lastNonAuthorOpenedAt: null,
    score: 0,
  };
}

/** The stats math, over per-viewer rollups. Pure, so it is unit-tested. */
export function computeAppUsageStats(
  rollups: ReadonlyArray<AppUsageRollup>,
  authorsByApp: ReadonlyMap<string, ReadonlySet<string>>,
  now: Date = new Date(),
): Map<string, AppUsageStats> {
  const today = utcDay(now);
  const out = new Map<string, AppUsageStats>();
  const latest = (a: string | null, b: Date) =>
    !a || b.toISOString() > a ? b.toISOString() : a;
  for (const r of rollups) {
    let s = out.get(r.appId);
    if (!s) out.set(r.appId, (s = emptyAppUsageStats(r.appId)));
    s.opens += r.opens;
    s.activeSeconds += r.activeSeconds;
    s.lastOpenedAt = latest(s.lastOpenedAt, r.lastAt);
    const isAuthor = !!r.userId && !!authorsByApp.get(r.appId)?.has(r.userId);
    if (!isAuthor) {
      s.lastNonAuthorOpenedAt = latest(s.lastNonAuthorOpenedAt, r.lastAt);
    }
    // Anonymous share viewers are one collapsed row per day: activity, but
    // no viewer to count.
    if (!r.userId) continue;
    s.viewers += 1;
    if (isAuthor) continue;
    const days = new Set(r.days);
    s.nonAuthorViewers += 1;
    s.viewerDays += days.size;
    for (const day of days) s.score += recencyWeight(day, today);
  }
  for (const s of out.values()) s.score = Math.round(s.score * 1000) / 1000;
  return out;
}

/**
 * Usage of every app in the workspace over the last `days` (default 28)
 * UTC days, today included. Every indexed app is present (zeros when
 * unviewed); apps with usage but no folder any more are kept too.
 */
export async function getAppUsageStats(
  workspaceId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<Map<string, AppUsageStats>> {
  const now = opts.now ?? new Date();
  const days = Math.max(
    1,
    Math.min(opts.days ?? DEFAULT_USAGE_WINDOW_DAYS, 400),
  );
  const since = utcDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  const [rollups, authors, snapshot] = await Promise.all([
    AppUsageDaily.aggregate<AppUsageRollup>([
      {
        $match: {
          workspaceId: new Types.ObjectId(workspaceId),
          day: { $gte: since },
        },
      },
      {
        $group: {
          _id: { appId: "$appId", userId: "$userId" },
          days: { $addToSet: "$day" },
          opens: { $sum: "$opens" },
          activeSeconds: { $sum: "$activeSeconds" },
          lastAt: { $max: "$lastAt" },
        },
      },
      {
        $project: {
          _id: 0,
          appId: "$_id.appId",
          userId: "$_id.userId",
          days: 1,
          opens: 1,
          activeSeconds: 1,
          lastAt: 1,
        },
      },
    ]),
    getAppAuthors(workspaceId),
    loadAppsIndex(workspaceId, { freshen: false }),
  ]);
  const stats = computeAppUsageStats(rollups, authors, now);
  for (const app of snapshot.apps) {
    if (!stats.has(app.appId)) {
      stats.set(app.appId, emptyAppUsageStats(app.appId));
    }
  }
  return stats;
}

/** The apps `userId` opened most recently, newest first. */
export async function getRecentlyViewedApps(
  workspaceId: string,
  userId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<Array<{ appId: string; lastOpenedAt: string }>> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const rows = await AppUsageDaily.aggregate<{ _id: string; lastAt: Date }>([
    {
      $match: {
        workspaceId: new Types.ObjectId(workspaceId),
        userId,
        lastAt: {
          $gte: new Date(now.getTime() - RECENT_LOOKBACK_DAYS * DAY_MS),
        },
      },
    },
    { $group: { _id: "$appId", lastAt: { $max: "$lastAt" } } },
    { $sort: { lastAt: -1 } },
    { $limit: limit },
  ]);
  return rows.map(r => ({
    appId: r._id,
    lastOpenedAt: r.lastAt.toISOString(),
  }));
}
