/**
 * Restore the hot workspaces' local repos before an instance takes traffic.
 *
 * On Cloud Run the bare repos under APPS_GIT_ROOT are a cache: a new
 * instance has none, and its first apps request ran `git clone --mirror`
 * from GitHub (11 to 13.7 s). On 2026-11-16 at 20:26 that clone held all 12
 * repo-work pool slots and 18 more requests got a 503 after 10 s.
 *
 * At boot, this picks the workspaces active in the last 24 h (an apps
 * sandbox used, or an app opened), most recent first. It clones the 5 most
 * recent while `/health/ready` answers 503, and the rest in the background
 * once the instance is ready. The Cloud Run startup probe reads
 * `/health/ready`. The wait is capped at REPO_WARM_MAX_WAIT_MS from the warm's
 * start: past it the instance reports ready and the clones go on in the
 * background, as every clone did before.
 *
 * The cap used to be 25 s from process start. Boot alone takes 18 s or more
 * before the warm starts, and a clone takes 11 to 14 s. On 2026-11-17 at
 * 13:17 an autoscaled instance passed the cap at 25 s, took traffic, and
 * finished its clone at 29.7 s: 7 requests got 503 in between. 90 s from the
 * warm's start plus a 111 s worst boot stays inside the probe's 240 s.
 *
 * Memory: the repos live on tmpfs (the instance's 4 GiB). A repo GitHub
 * sizes over REPO_WARM_MAX_REPO_BYTES is never warmed, and the warm stops
 * adding repos at REPO_WARM_MAX_TOTAL_BYTES. Those clone on first use.
 *
 * Opt-in with APPS_REPO_WARM_ON_BOOT=true (the production deploy sets it).
 * Previews share a prod copy of the database, so they would clone every
 * customer repo the copy names.
 */
import { AppUsageDaily, AppWorktree } from "../../database/workspace-schema";
import { getRepoInfo } from "../../integrations/github/github-api";
import { loggers } from "../../logging";
import {
  ensureLocalRepo,
  resolveReadableMirrorTarget,
  tokenFor,
} from "./target";

const logger = loggers.api("apps");

const MB = 1024 * 1024;

/** Longest the startup check waits, counted from the warm's start. */
export const REPO_WARM_MAX_WAIT_MS = 90_000;
/** Workspaces the startup check waits for; the rest warm after it. */
export const REPO_WARM_GATE_WORKSPACES = 5;
/** A workspace counts as hot when used within this window. */
export const REPO_WARM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Most workspaces warmed at boot (gated and background together). */
export const REPO_WARM_MAX_WORKSPACES = 25;
/** Clones run at once: each is a git subprocess on a small instance. */
export const REPO_WARM_CONCURRENCY = 3;
/** A repo GitHub sizes above this is left to clone on first use. */
export const REPO_WARM_MAX_REPO_BYTES = 300 * MB;
/** Total repo bytes the warm may put on this instance's tmpfs. */
export const REPO_WARM_MAX_TOTAL_BYTES = 1536 * MB;

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

// --- Size budget -------------------------------------------------------------

/** Bytes GitHub reports for the workspace's repo; null when it has none. */
export type RepoSizeOf = (workspaceId: string) => Promise<number | null>;

export const githubRepoSize: RepoSizeOf = async workspaceId => {
  const target = await resolveReadableMirrorTarget(workspaceId);
  if (!target) return null;
  const info = await getRepoInfo(
    target.owner,
    target.repo,
    await tokenFor(target),
  );
  return info.sizeKb * 1024;
};

/**
 * The workspaces to warm, in the order given: those with a repo, each at
 * most `maxRepoBytes`, until `maxTotalBytes`. A size that cannot be read
 * skips the workspace (it clones on first use, as before).
 */
export async function planRepoWarm(
  workspaceIds: string[],
  {
    sizeOf = githubRepoSize,
    maxRepoBytes = REPO_WARM_MAX_REPO_BYTES,
    maxTotalBytes = REPO_WARM_MAX_TOTAL_BYTES,
  }: {
    sizeOf?: RepoSizeOf;
    maxRepoBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<{ ids: string[]; bytes: number; skipped: number }> {
  const sizes = await Promise.all(
    workspaceIds.map(id =>
      sizeOf(id).catch(error => {
        logger.warn("Boot repo warm could not size a repo; skipping it", {
          workspaceId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ),
  );
  const ids: string[] = [];
  let bytes = 0;
  let skipped = 0;
  workspaceIds.forEach((id, i) => {
    const size = sizes[i];
    if (size === null) return;
    if (size > maxRepoBytes || bytes + size > maxTotalBytes) {
      skipped++;
      logger.info("Boot repo warm skips a repo over its size budget", {
        workspaceId: id,
        sizeMb: Math.round(size / MB),
        warmedMb: Math.round(bytes / MB),
      });
      return;
    }
    ids.push(id);
    bytes += size;
  });
  return { ids, bytes, skipped };
}

// --- Readiness ---------------------------------------------------------------

let warm: { done: boolean; deadline: number } | null = null;

/**
 * Whether the instance may take traffic: no warm started, the gated part
 * of the warm finished, or its wait cap passed.
 */
export function repoWarmReady(now = Date.now()): boolean {
  return !warm || warm.done || now >= warm.deadline;
}

/**
 * Start the boot warm, when enabled. Never throws; never blocks the boot.
 * Resolves when every clone, gated or background, has ended.
 */
export function startRepoWarmOnBoot({
  maxWaitMs = REPO_WARM_MAX_WAIT_MS,
  gate = REPO_WARM_GATE_WORKSPACES,
  startedAt = Date.now(),
  listHot = hotWorkspaceIds,
  sizeOf = githubRepoSize,
  ensure = ensureLocalRepo,
}: {
  maxWaitMs?: number;
  gate?: number;
  /** Epoch ms the wait is counted from (the warm's start). */
  startedAt?: number;
  listHot?: () => Promise<string[]>;
  sizeOf?: RepoSizeOf;
  ensure?: (workspaceId: string) => Promise<void>;
} = {}): Promise<void> {
  const state = { done: false, deadline: startedAt + maxWaitMs };
  warm = state;
  return (async () => {
    let rest: string[] = [];
    try {
      const plan = await planRepoWarm(await listHot(), { sizeOf });
      const gated = plan.ids.slice(0, gate);
      rest = plan.ids.slice(gate);
      const result = await warmWorkspaceRepos(gated, { ensure });
      logger.info("Boot repo warm: gated part finished", {
        workspaces: gated.length,
        ...result,
        background: rest.length,
        skippedOverBudget: plan.skipped,
        plannedMb: Math.round(plan.bytes / MB),
        msSinceStart: Date.now() - startedAt,
        pastCap: Date.now() > state.deadline,
      });
    } catch (error) {
      logger.warn("Boot repo warm failed; starting without it", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.done = true;
    }
    if (rest.length > 0) {
      const result = await warmWorkspaceRepos(rest, { ensure });
      logger.info("Boot repo warm: background part finished", {
        workspaces: rest.length,
        ...result,
      });
    }
  })();
}

/** Test seam: forget any boot warm. */
export function resetRepoWarmForTests(): void {
  warm = null;
}
