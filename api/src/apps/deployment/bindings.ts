/**
 * A release's data bindings: whether each artifact is ready and current,
 * the deployment's binding index, and rebuilding what is missing or stale.
 */
import {
  getArtifactStore,
  type ArtifactStore,
} from "../../services/artifact-store.service";
import {
  bindingArtifactKey,
  materializeAppBinding,
  readBindingsTolerant,
  type AppBinding,
} from "../bindings.service";
import { isCronDue, nextCronRunAt } from "../../services/cron-due";
import { type IAppProject } from "../../database/workspace-schema";
import { markBindingProgress, markDeployStage } from "../deploy-progress";
import { loggers } from "../../logging";
import { PUBLISH_ACTOR } from "../worktree.service";
import {
  deploymentKey,
  artifactStoreForRead,
  existingDeploymentAsset,
} from "./store";

const logger = loggers.api("apps-deployment");

export interface DeploymentBindingReadiness {
  /** Parquet bindings that a published deployment must be able to serve. */
  required: string[];
  /** Bindings whose existing artifact is current for their schedule. */
  reused: string[];
  /** Bindings with no artifact, built by this readiness check. */
  materialized: string[];
  /**
   * Scheduled bindings whose artifact predates the schedule's latest
   * occurrence. The release goes live on these artifacts; each one is queued
   * for a rebuild behind it.
   */
  refreshing: string[];
  /**
   * Files under bindings/ that are not servable (bad filename, no
   * connection). They do not block the release — their data URL 404s
   * exactly as it did before publish read bindings at all — but they are
   * reported so the log names the file to fix.
   */
  skipped: Array<{ path: string; error: string }>;
}

/**
 * Whether an artifact that already exists for `binding` is current for its
 * schedule. A stale one still serves; the release queues its rebuild.
 *
 * Content addressing answers "same query?", not "current data?". Scheduler
 * state is per binding NAME, so when a merge reverts a query to an earlier
 * text, the old text's artifact is still in the store (built before the
 * edit) while the scheduler believes it ran the binding this morning — it
 * did, for the other text. Reusing that artifact served day-old numbers for
 * a whole day (#992). A scheduled binding's artifact therefore counts only
 * if it is at least as fresh as the schedule's latest occurrence, judged by
 * the store's own write time: no state read, no warehouse query, and the
 * common case (built by this morning's sweep) still reuses. An unknown
 * write time is treated as stale — one extra warehouse query is the cheap
 * side of that mistake.
 *
 * The write time is the artifact's own, which is why it has the same scope
 * as the content-addressed key (another app, a branch build or the sweep may
 * all have written it). Two known limits: a binding on a sub-tick cron (every
 * 15 minutes) is almost always overdue at publish time, so a code-only
 * publish of such an app pays one warehouse query per such binding; and
 * adoptBindingArtifact (v1 → v2 migration) COPIES an old artifact, so its
 * write time is the adoption time until the scheduler's next tick rebuilds
 * it from the run it recorded at `builtAt`.
 */
async function isBindingArtifactCurrent(
  store: ArtifactStore,
  key: string,
  binding: AppBinding,
  context: { projectId: string; sha: string; now: Date },
): Promise<boolean> {
  if (!binding.schedule) return true;
  const { projectId, sha, now } = context;
  // Validate the cron before paying the metadata round trip. The scheduler
  // skips a binding whose cron it cannot parse; publish treats it the same
  // way (effectively unscheduled) rather than failing the release.
  try {
    nextCronRunAt(binding.schedule, { timezone: binding.timezone, from: now });
  } catch (error) {
    logger.warn("Invalid binding schedule", {
      projectId,
      sha,
      binding: binding.name,
      schedule: binding.schedule,
      timezone: binding.timezone ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  const builtAt = await store.getLastModified(key);
  if (
    builtAt &&
    !isCronDue({
      cron: binding.schedule,
      timezone: binding.timezone,
      lastRunAt: builtAt,
      now,
    })
  ) {
    return true;
  }
  logger.info("Apps deployment found stale binding artifact", {
    projectId,
    sha,
    binding: binding.name,
    key,
    storeType: store.type,
    schedule: binding.schedule,
    timezone: binding.timezone ?? null,
    builtAt: builtAt?.toISOString() ?? null,
    reason: builtAt ? "overdue" : "unknown-build-time",
  });
  return false;
}

/**
 * A deployment's binding index: every binding's artifact key by name, as of
 * the deployment commit. Written once when the deployment's bindings are made
 * ready, next to its build.
 *
 * Serving reads it instead of the repository. Without it, each
 * `__data/<name>.parquet` request resolves the key by reading
 * `bindings/<name>.sql` at the deployed sha, and on an instance that has
 * never seen that commit this means first cloning or fetching the workspace
 * repository: tens of seconds before the first table of a freshly published
 * app, or one opened on a new instance, even starts to download. The keys of
 * a deployment never change (it is immutable, its artifacts are
 * content-addressed), so the index is also cached for the life of the process.
 */
export const DEPLOYMENT_BINDING_INDEX = "__data/bindings.json";

async function writeDeploymentBindingIndex(
  projectId: string,
  sha: string,
  bindings: AppBinding[],
): Promise<void> {
  const keys = Object.fromEntries(
    bindings.map(binding => [binding.name, bindingArtifactKey(binding)]),
  );
  try {
    await getArtifactStore().putBuffer(
      Buffer.from(JSON.stringify(keys)),
      deploymentKey(projectId, sha, DEPLOYMENT_BINDING_INDEX),
      "application/json",
    );
    bindingIndexCache.set(`${projectId}:${sha}`, keys);
  } catch (error) {
    // Serving falls back to reading the bindings from the repository.
    logger.warn("Apps deployment binding index not written", {
      projectId,
      sha,
      error,
    });
  }
}

/** Positive results only: an index written later (a rollback) must be seen. */
const bindingIndexCache = new Map<string, Record<string, string>>();
const BINDING_INDEX_CACHE_SIZE = 500;

/** The deployment's binding keys by name, or null when it predates the index. */
export async function deploymentBindingIndex(
  projectId: string,
  sha: string,
): Promise<Record<string, string> | null> {
  const cacheKey = `${projectId}:${sha}`;
  const cached = bindingIndexCache.get(cacheKey);
  if (cached) return cached;
  const asset = await existingDeploymentAsset(
    projectId,
    sha,
    DEPLOYMENT_BINDING_INDEX,
  );
  const stream = asset ? await asset.store.openReadStream(asset.key) : null;
  if (!stream) return null;
  let keys: Record<string, string>;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    keys = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    logger.warn("Apps deployment binding index unreadable", {
      projectId,
      sha,
      error,
    });
    return null;
  }
  if (bindingIndexCache.size >= BINDING_INDEX_CACHE_SIZE) {
    const oldest = bindingIndexCache.keys().next().value;
    if (oldest !== undefined) bindingIndexCache.delete(oldest);
  }
  bindingIndexCache.set(cacheKey, keys);
  return keys;
}

/** Metadata reads per release: one or two store round trips per binding. */
const BINDING_CHECK_CONCURRENCY = 16;

/**
 * Binding builds a deploy may run in this process, across all its walks. These
 * run outside Inngest's workspace budget, on an instance with 4 GiB and an
 * in-memory /tmp: 4 builds of 300k rows reached 4.04 GiB in review.
 */
export const APPS_DEPLOY_INLINE_BUILD_LIMIT = 2;

let inlineBuildsRunning = 0;
const inlineBuildWaiters: Array<() => void> = [];

/**
 * How long an inline build may hold its slot. The slowest build on 2026-11-03
 * took 731 s. A hung socket would otherwise hold a slot for the life of the
 * instance, and two would stop every publish on it. The timeout fails the
 * release and frees the slot. The build itself has no cancel signal, so a slow
 * one finishes in the background outside the limit.
 */
function inlineBuildTimeoutMs(): number {
  const configured = Number(process.env.APPS_DEPLOY_INLINE_BUILD_TIMEOUT_MS);
  return configured > 0 ? configured : 30 * 60_000;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Build timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withInlineBuildSlot<T>(build: () => Promise<T>): Promise<T> {
  if (inlineBuildsRunning >= APPS_DEPLOY_INLINE_BUILD_LIMIT) {
    await new Promise<void>(resolve => inlineBuildWaiters.push(resolve));
  } else {
    inlineBuildsRunning += 1;
  }
  try {
    return await withTimeout(build(), inlineBuildTimeoutMs());
  } finally {
    // A waiter inherits this slot, so the count stays right.
    const next = inlineBuildWaiters.shift();
    if (next) next();
    else inlineBuildsRunning -= 1;
  }
}

/**
 * Run `work` over `items`, at most `limit` at a time, in input order. After a
 * failure no new item starts; items in flight finish, then the first error
 * is thrown.
 */
async function forEachBounded<T>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await work(items[index], index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failed) throw firstError;
}

/**
 * Is the artifact of `binding` present and current for its schedule? The
 * after-publish refresh asks this right before it builds, so a binding that
 * another build already refreshed is not built twice.
 */
export async function isBindingArtifactReady(
  binding: AppBinding,
  context: { projectId: string; sha: string; now?: Date },
): Promise<boolean> {
  const key = bindingArtifactKey(binding);
  const store = await artifactStoreForRead(key);
  if (!store) return false;
  return isBindingArtifactCurrent(store, key, binding, {
    ...context,
    now: context.now ?? new Date(),
  });
}

/** Queue rebuilds for a release's stale artifacts. A failed send only logs. */
export async function queueBindingRefreshes(
  project: IAppProject,
  sha: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  try {
    const { requestBindingRefreshes } =
      await import("../../inngest/functions/apps-binding-refresh");
    await requestBindingRefreshes(project, sha, names);
  } catch (error) {
    // The binding's own schedule still rebuilds it at its next due tick.
    logger.warn("Apps deployment could not queue binding refreshes", {
      projectId: project._id.toString(),
      sha,
      bindings: names.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Make the data contract of a deployment ready before it becomes live.
 *
 * Binding definitions are read at the exact deployment commit, never from a
 * mutable worktree. Each binding is judged once, against the moment this
 * release started:
 *
 * - No artifact: built now, at most APPS_DEPLOY_INLINE_BUILD_LIMIT at a time
 *   in this process. Only this blocks the release: a page cannot read a table
 *   that does not exist. A failure propagates to the durable deploy job and
 *   the caller has not moved `publishedSha` yet.
 * - Artifact predates the schedule's latest occurrence: the release goes live
 *   on it, and the caller passes `refreshing` to setPublishedSha, which queues
 *   the rebuilds. They keep #992 fixed: scheduler state is per binding name
 *   and may believe a reverted query ran today, so the refresh judges the
 *   artifact's own write time.
 * - Otherwise: reused.
 *
 * This walk used to rebuild every stale artifact in sequence and judge each
 * binding at its own turn. On 2026-11-03 a 134-binding app on an hourly cron
 * walked for 124 minutes: 77 builds, 10 of them stale only because the walk
 * itself crossed the :55. It outlived Cloud Run's 3,600 s request limit and
 * the live frontend waited for all of it.
 */
export async function ensureDeploymentBindings(
  project: IAppProject,
  sha: string,
  options: {
    /** The moment freshness is judged against; injectable for tests. */
    now?: Date;
  } = {},
): Promise<DeploymentBindingReadiness> {
  const projectId = project._id.toString();
  const { bindings, skipped } = await readBindingsTolerant(
    project,
    PUBLISH_ACTOR,
    sha,
  );
  if (skipped.length > 0) {
    logger.warn("Apps deployment skips malformed bindings", {
      projectId,
      sha,
      skipped,
    });
  }
  const live = bindings.filter(binding => binding.materialization === "live");
  if (live.length > 0) {
    throw new Error(
      `Cannot publish live binding${live.length === 1 ? "" : "s"} ${live
        .map(binding => `"${binding.name}"`)
        .join(", ")}. Published apps require parquet materialization.`,
    );
  }

  // One moment for the whole release: a schedule coming due during
  // preparation must not change what this release considers ready.
  const judgedAt = options.now ?? new Date();
  await markDeployStage(project, sha, "bindings");
  await markBindingProgress(project, sha, {
    total: bindings.length,
    prepared: 0,
  });

  const verdicts = new Array<"absent" | "stale" | "current">(bindings.length);
  await forEachBounded(
    bindings,
    BINDING_CHECK_CONCURRENCY,
    async (binding, index) => {
      const key = bindingArtifactKey(binding);
      const store = await artifactStoreForRead(key);
      if (!store) {
        verdicts[index] = "absent";
        return;
      }
      verdicts[index] = (await isBindingArtifactCurrent(store, key, binding, {
        projectId,
        sha,
        now: judgedAt,
      }))
        ? "current"
        : "stale";
    },
  );
  const namesWith = (verdict: (typeof verdicts)[number]) =>
    bindings.filter((_, i) => verdicts[i] === verdict).map(b => b.name);

  const absent = bindings.filter((_, i) => verdicts[i] === "absent");
  let prepared = bindings.length - absent.length;
  const building = new Set<string>();
  const reportProgress = () =>
    markBindingProgress(project, sha, {
      total: bindings.length,
      prepared,
      ...(building.size > 0 ? { current: [...building].join(", ") } : {}),
    });
  await reportProgress();
  await forEachBounded(
    absent,
    APPS_DEPLOY_INLINE_BUILD_LIMIT,
    async binding => {
      await withInlineBuildSlot(async () => {
        building.add(binding.name);
        await reportProgress();
        try {
          await materializeAppBinding(project, binding.name, PUBLISH_ACTOR, {
            at: sha,
            binding,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`Binding "${binding.name}": ${message}`, {
            cause: error,
          });
        } finally {
          building.delete(binding.name);
        }
      });
      prepared += 1;
      await reportProgress();
    },
  );

  const readiness: DeploymentBindingReadiness = {
    required: bindings.map(binding => binding.name),
    reused: namesWith("current"),
    materialized: namesWith("absent"),
    refreshing: namesWith("stale"),
    skipped,
  };

  await writeDeploymentBindingIndex(projectId, sha, bindings);

  logger.info("Apps deployment bindings ready", {
    projectId,
    sha,
    required: readiness.required.length,
    reused: readiness.reused.length,
    materialized: readiness.materialized.length,
    refreshing: readiness.refreshing.length,
    skipped: readiness.skipped.length,
  });
  return readiness;
}
