/**
 * Restore the hot workspaces' local repos before an instance takes traffic.
 *
 * On Cloud Run the bare repos under APPS_GIT_ROOT are a cache: a new
 * instance has none, and its first apps request ran `git clone --mirror`
 * from GitHub (11 to 13.7 s). On 2026-11-16 at 20:26 that clone held all 12
 * repo-work pool slots and 18 more requests got a 503 after 10 s.
 *
 * At boot, this clones the repos of the workspaces active in the last 24 h
 * (an apps sandbox used, or an app opened), and `/health/ready` answers 503
 * until it finishes. The Cloud Run startup probe reads `/health/ready`, so
 * the instance takes no traffic while it clones. The wait is capped
 * (REPO_WARM_MAX_WAIT_MS): past it the instance reports ready and the
 * remaining clones go on in the background, as every clone did before.
 *
 * Opt-in with APPS_REPO_WARM_ON_BOOT=true (the production deploy sets it).
 * Previews share a prod copy of the database, so they would clone every
 * customer repo the copy names.
 */
import { AppUsageDaily, AppWorktree } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { ensureLocalRepo } from "./target";

const logger = loggers.api("apps");

/** Longest the startup check waits for the clones. */
export const REPO_WARM_MAX_WAIT_MS = 60_000;
/** A workspace counts as hot when used within this window. */
export const REPO_WARM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Most workspaces warmed at boot; the busiest instance needs a handful. */
export const REPO_WARM_MAX_WORKSPACES = 25;
/** Clones run at once: each is a git subprocess on a small instance. */
export const REPO_WARM_CONCURRENCY = 3;

export function repoWarmEnabled(): boolean {
  return process.env.APPS_REPO_WARM_ON_BOOT === "true";
}

/**
 * Workspaces used in the last `windowMs`, most recent first. Two signals:
 * an apps sandbox touched (app_worktrees.updatedAt) and an app opened
 * (app_usage_daily.lastAt). Both collections hold a row per person, not per
 * event, so the scan is small.
 */
export async function hotWorkspaceIds(
  now = Date.now(),
  windowMs = REPO_WARM_WINDOW_MS,
  limit = REPO_WARM_MAX_WORKSPACES,
): Promise<string[]> {
  const since = new Date(now - windowMs);
  const [worktrees, usage] = await Promise.all([
    AppWorktree.aggregate<{ _id: unknown; at: Date }>([
      { $match: { updatedAt: { $gte: since } } },
      { $group: { _id: "$workspaceId", at: { $max: "$updatedAt" } } },
    ]),
    AppUsageDaily.aggregate<{ _id: unknown; at: Date }>([
      { $match: { lastAt: { $gte: since } } },
      { $group: { _id: "$workspaceId", at: { $max: "$lastAt" } } },
    ]),
  ]);
  const latest = new Map<string, number>();
  for (const row of [...worktrees, ...usage]) {
    const id = String(row._id);
    const at = new Date(row.at).getTime();
    if ((latest.get(id) ?? 0) < at) latest.set(id, at);
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/** Clone each workspace's repo (a no-op when present or unbound). */
export async function warmWorkspaceRepos(
  workspaceIds: string[],
  {
    concurrency = REPO_WARM_CONCURRENCY,
    ensure = ensureLocalRepo,
  }: {
    concurrency?: number;
    ensure?: (workspaceId: string) => Promise<void>;
  } = {},
): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;
  const queue = [...workspaceIds];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        await ensure(id);
        warmed++;
      } catch (error) {
        // One broken repo must not stop the others.
        failed++;
        logger.warn("Boot repo warm failed for a workspace", {
          workspaceId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return { warmed, failed };
}

// --- Readiness ---------------------------------------------------------------

let warm: { done: boolean; deadline: number } | null = null;

/**
 * Whether the instance may take traffic: no warm started, the warm
 * finished, or its wait cap passed.
 */
export function repoWarmReady(now = Date.now()): boolean {
  return !warm || warm.done || now >= warm.deadline;
}

/** Start the boot warm, when enabled. Never throws; never blocks the boot. */
export function startRepoWarmOnBoot({
  maxWaitMs = REPO_WARM_MAX_WAIT_MS,
  listHot = hotWorkspaceIds,
  ensure = ensureLocalRepo,
}: {
  maxWaitMs?: number;
  listHot?: () => Promise<string[]>;
  ensure?: (workspaceId: string) => Promise<void>;
} = {}): Promise<void> {
  const started = Date.now();
  const state = { done: false, deadline: started + maxWaitMs };
  warm = state;
  return (async () => {
    try {
      const ids = await listHot();
      const result = await warmWorkspaceRepos(ids, { ensure });
      logger.info("Boot repo warm finished", {
        workspaces: ids.length,
        ...result,
        ms: Date.now() - started,
        pastCap: Date.now() > state.deadline,
      });
    } catch (error) {
      logger.warn("Boot repo warm failed; starting without it", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.done = true;
    }
  })();
}

/** Test seam: forget any boot warm. */
export function resetRepoWarmForTests(): void {
  warm = null;
}
