/**
 * The Apps home's shared base — one memoized read per workspace behind
 * /discovery, /feed, /usage, /recent and /search.
 *
 * The home fires those calls in parallel on every load, and each used to
 * redo the same work: a mirror fetch from GitHub, several `git rev-parse`
 * spawns, the index, the people directory, the bindings' state, a year of
 * `git log` whenever main moved (200+ times a day in a busy workspace), and
 * the usage rollup. Measured on prod, 4–7 s per endpoint on a cold load.
 *
 * Here that work happens once per workspace and is shared:
 *
 * - **Single-flight.** Concurrent requests wait on the same computation.
 * - **Fresh for FRESH_MS**, then served stale while ONE background
 *   revalidation (mirror fetch included) runs, up to MAX_STALE_MS; past
 *   that, or on a new UTC day (the usage windows move), a request waits.
 * - **Keyed by main.** When this instance's index moves to another commit
 *   (a push landed here, the explorer's list fetched one), the next request
 *   rebuilds — no git call needed to notice (peekAppsIndexSha).
 * - **Never the visibility.** Who may see which app is judged per request
 *   on a fresh read of the state rows (loadAppStates), so an app made
 *   private disappears from the next response, memo or not. Admin marks
 *   invalidate the memo directly (invalidateAppsHomeBase).
 *
 * Commit authorship is memoized by the app trees it depends on
 * (app-usage.service appTreesKey), so main moving for anything other than
 * an app costs no `git log`. GitHub login lookups never block a request.
 */
import { Types } from "mongoose";
import { AppUsageDaily } from "../database/workspace-schema";
import { loggers } from "../logging";
import { noteTiming, timed } from "../middleware/server-timing";
import {
  discoveryAppsFrom,
  loadAppStates,
  loadDiscoveryBase,
  type AppStateRow,
  type DiscoveryApp,
  type DiscoveryBase,
} from "./app-discovery.service";
import { coUsageScores, type FeedSignals, type FeedViewer } from "./app-feed";
import { canSeeIndexedApp } from "./app-authorization";
import { peekAppsIndexSha } from "./app-index.service";
import {
  appAuthorsFrom,
  computeAppUsageStats,
  DEFAULT_USAGE_WINDOW_DAYS,
  emptyAppUsageStats,
  getAppUsageStats,
  utcDay,
  type AppUsageRollup,
  type AppUsageStats,
} from "./app-usage.service";

const logger = loggers.api("apps-home-base");

const DAY_MS = 24 * 60 * 60 * 1000;
/** Served without any I/O for this long. */
export const FRESH_MS = 10_000;
/** Served stale (revalidating in the background) up to this age. */
export const MAX_STALE_MS = 5 * 60_000;
/** The longest usage window the base holds: the feed's affinity window. */
export const BASE_USAGE_WINDOW_DAYS = 90;
/** Workspaces memoized at once; the least recently built goes first. */
const MAX_WORKSPACES = 200;

export interface HomeBase extends DiscoveryBase {
  workspaceId: string;
  /** The UTC day the usage windows were cut on. */
  day: string;
  /** The daily rollup rows of the last BASE_USAGE_WINDOW_DAYS days. */
  dailyRows: UsageDayRow[];
  /** Each app's authors (getAppAuthors), for the popularity score. */
  authors: Map<string, Set<string>>;
  builtAt: number;
  /** peekAppsIndexSha when built: a different one means main moved here. */
  indexSha: string | undefined;
  /** Rollups and stats per window length, computed on first ask. */
  rollupsByDays: Map<number, AppUsageRollup[]>;
  statsByDays: Map<number, Map<string, AppUsageStats>>;
}

/** One `app_usage_daily` row, as much of it as the stats read. */
export interface UsageDayRow {
  appId: string;
  userId: string | null;
  day: string;
  opens: number;
  activeSeconds: number;
  lastAt: Date;
}

/** The daily rows since `since` (inclusive), indexed by workspace + day. */
function loadUsageDays(
  workspaceId: string,
  since: string,
): Promise<UsageDayRow[]> {
  return AppUsageDaily.find({
    workspaceId: new Types.ObjectId(workspaceId),
    day: { $gte: since },
  })
    .select({
      _id: 0,
      appId: 1,
      userId: 1,
      day: 1,
      opens: 1,
      activeSeconds: 1,
      lastAt: 1,
    })
    .lean<UsageDayRow[]>();
}

/**
 * Per (app, viewer) rollups of the rows on or after `since` — what
 * loadUsageRollups' aggregation returns, grouped here so every window
 * comes from one read.
 */
export function rollUpUsageDays(
  rows: ReadonlyArray<UsageDayRow>,
  since: string,
): AppUsageRollup[] {
  const out = new Map<string, AppUsageRollup & { daySet: Set<string> }>();
  for (const row of rows) {
    if (row.day < since) continue;
    const userId = row.userId ?? null;
    const key = `${row.appId}\u0000${userId ?? ""}`;
    let r = out.get(key);
    if (!r) {
      r = {
        appId: row.appId,
        userId,
        days: [],
        daySet: new Set(),
        opens: 0,
        activeSeconds: 0,
        lastAt: new Date(row.lastAt),
      };
      out.set(key, r);
    }
    r.daySet.add(row.day);
    r.opens += row.opens ?? 0;
    r.activeSeconds += row.activeSeconds ?? 0;
    const at = new Date(row.lastAt);
    if (at > r.lastAt) r.lastAt = at;
  }
  return [...out.values()].map(({ daySet, ...r }) => ({
    ...r,
    days: [...daySet],
  }));
}

interface Entry {
  base: HomeBase;
  generation: number;
}

const memo = new Map<string, Entry>();
const inFlight = new Map<
  string,
  { generation: number; run: Promise<HomeBase> }
>();
/** Bumped by invalidation, so a computation that started before it is not kept. */
const generations = new Map<string, number>();

const generationOf = (workspaceId: string) => generations.get(workspaceId) ?? 0;

/** Drop the memo: the next request rebuilds (an admin mark changed, tests). */
export function invalidateAppsHomeBase(workspaceId?: string): void {
  const ids = workspaceId ? [workspaceId] : [...memo.keys()];
  for (const id of ids) {
    generations.set(id, generationOf(id) + 1);
    memo.delete(id);
  }
  if (!workspaceId) inFlight.clear();
}

async function buildHomeBase(
  workspaceId: string,
  now: Date,
  options: { freshen: boolean },
): Promise<HomeBase> {
  const day = utcDay(now);
  const since = utcDay(
    new Date(now.getTime() - (BASE_USAGE_WINDOW_DAYS - 1) * DAY_MS),
  );
  const states = await loadAppStates(workspaceId);
  const [discovery, dailyRows] = await Promise.all([
    loadDiscoveryBase(workspaceId, {
      freshen: options.freshen,
      states,
      waitForGitHub: false,
    }),
    timed("base.usage", () => loadUsageDays(workspaceId, since)),
  ]);
  const authors = await timed("base.authors", () =>
    // Stale authorship while a new `git log` runs: it only nudges scores.
    appAuthorsFrom(workspaceId, discovery.snapshot.apps, states, {
      allowStale: true,
    }),
  );
  return {
    ...discovery,
    workspaceId,
    day,
    dailyRows,
    authors,
    builtAt: Date.now(),
    indexSha: peekAppsIndexSha(workspaceId),
    rollupsByDays: new Map(),
    statsByDays: new Map(),
  };
}

function compute(
  workspaceId: string,
  now: Date,
  options: { freshen: boolean },
): Promise<HomeBase> {
  const generation = generationOf(workspaceId);
  const pending = inFlight.get(workspaceId);
  if (pending && pending.generation === generation) return pending.run;
  const run = buildHomeBase(workspaceId, now, options)
    .then(base => {
      if (generationOf(workspaceId) === generation) {
        memo.delete(workspaceId);
        memo.set(workspaceId, { base, generation });
        while (memo.size > MAX_WORKSPACES) {
          const oldest = memo.keys().next().value;
          if (oldest === undefined) break;
          memo.delete(oldest);
        }
      }
      return base;
    })
    .finally(() => {
      if (inFlight.get(workspaceId)?.run === run) inFlight.delete(workspaceId);
    });
  inFlight.set(workspaceId, { generation, run });
  return run;
}

/**
 * The workspace's home base: memoized, single-flight, stale-while-
 * revalidate (see the file comment). `now` is for tests.
 */
export async function loadHomeBase(
  workspaceId: string,
  options: { now?: Date } = {},
): Promise<HomeBase> {
  const now = options.now ?? new Date();
  const entry = memo.get(workspaceId);
  if (
    entry &&
    entry.generation === generationOf(workspaceId) &&
    entry.base.day === utcDay(now) &&
    entry.base.indexSha === peekAppsIndexSha(workspaceId)
  ) {
    const age = Date.now() - entry.base.builtAt;
    if (age < FRESH_MS) {
      noteTiming("base", "fresh");
      return entry.base;
    }
    if (age < MAX_STALE_MS) {
      noteTiming("base", "stale");
      // The revalidation fetches the mirror: main may have moved elsewhere.
      compute(workspaceId, now, { freshen: true }).catch(error => {
        logger.warn("Apps home revalidation failed; serving the last one", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return entry.base;
    }
  }
  noteTiming("base", inFlight.has(workspaceId) ? "joined" : "miss");
  // A miss does not wait for the mirror fetch: the local clone is at most
  // a freshen interval behind on a busy instance (the explorer's list
  // fetches), and was cloned seconds ago on a new one. The next request
  // after FRESH_MS revalidates with a fetch.
  return timed("base.build", () =>
    compute(workspaceId, now, { freshen: false }),
  );
}

// ---------------------------------------------------------------------------
// Reads over the base (the routes)
// ---------------------------------------------------------------------------

/** The discovery cards this person can see, from the memo. */
export async function listHomeDiscoveryApps(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<DiscoveryApp[]> {
  const [base, states] = await Promise.all([
    loadHomeBase(workspaceId),
    loadAppStates(workspaceId),
  ]);
  return discoveryAppsFrom(base, states, userId, role);
}

/** The ids of the indexed apps this person can see (the list's rule). */
export async function visibleHomeAppIds(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<Set<string>> {
  const [base, states] = await Promise.all([
    loadHomeBase(workspaceId),
    loadAppStates(workspaceId),
  ]);
  return visibleIdsFrom(base, states, userId, role);
}

export function visibleIdsFrom(
  base: Pick<HomeBase, "snapshot">,
  states: AppStateRow[],
  userId: string | undefined,
  role: string | undefined,
): Set<string> {
  const stateById = new Map(states.map(s => [s._id.toString(), s]));
  return new Set(
    base.snapshot.apps
      .filter(app =>
        canSeeIndexedApp(app, stateById.get(app.appId), userId, role),
      )
      .map(app => app.appId),
  );
}

/**
 * Usage stats over the last `days` (getAppUsageStats' contract), from the
 * memo's rollups when the window fits in them.
 */
export async function homeUsageStats(
  workspaceId: string,
  options: { days?: number; base?: HomeBase } = {},
): Promise<Map<string, AppUsageStats>> {
  const days = Math.max(
    1,
    Math.min(options.days ?? DEFAULT_USAGE_WINDOW_DAYS, 400),
  );
  if (days > BASE_USAGE_WINDOW_DAYS) {
    return getAppUsageStats(workspaceId, { days });
  }
  const base = options.base ?? (await loadHomeBase(workspaceId));
  return usageStatsFrom(base, days);
}

/** The base's per-viewer rollups over the last `days`, memoized. */
export function rollupsFrom(base: HomeBase, days: number): AppUsageRollup[] {
  const hit = base.rollupsByDays.get(days);
  if (hit) return hit;
  const since = utcDay(new Date(dayNoon(base).getTime() - (days - 1) * DAY_MS));
  const rollups = rollUpUsageDays(base.dailyRows, since);
  base.rollupsByDays.set(days, rollups);
  return rollups;
}

const dayNoon = (base: HomeBase) => new Date(`${base.day}T12:00:00Z`);

/** The base's stats for a window (getAppUsageStats' shape), memoized. */
export function usageStatsFrom(
  base: HomeBase,
  days: number,
): Map<string, AppUsageStats> {
  const hit = base.statsByDays.get(days);
  if (hit) return hit;
  const stats = computeAppUsageStats(
    rollupsFrom(base, days),
    base.authors,
    dayNoon(base),
  );
  for (const app of base.snapshot.apps) {
    if (!stats.has(app.appId)) {
      stats.set(app.appId, emptyAppUsageStats(app.appId));
    }
  }
  base.statsByDays.set(days, stats);
  return stats;
}

/**
 * The feed's usage signals for one viewer (loadFeedSignals' contract),
 * from the memo: popularity over the Popular shelf's 28 days, the viewer's
 * own reads and co-usage over the 90-day affinity window.
 */
export function feedSignalsFrom(
  base: HomeBase,
  viewer: FeedViewer,
): FeedSignals {
  const affinity = rollupsFrom(base, BASE_USAGE_WINDOW_DAYS);
  const popular = computeAppUsageStats(
    rollupsFrom(base, DEFAULT_USAGE_WINDOW_DAYS),
    base.authors,
    dayNoon(base),
  );
  const mine = new Map<string, { days: number; lastAt: string }>();
  if (viewer.id) {
    for (const r of affinity) {
      if (r.userId !== viewer.id) continue;
      mine.set(r.appId, {
        days: new Set(r.days).size,
        lastAt: new Date(r.lastAt).toISOString(),
      });
    }
  }
  return {
    popularity: new Map([...popular].map(([id, s]) => [id, s.score])),
    mine,
    coUsage: coUsageScores(affinity, viewer.id),
  };
}
