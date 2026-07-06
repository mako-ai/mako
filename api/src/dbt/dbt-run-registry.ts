/**
 * In-process registry of dbt runs that are actively executing on THIS node.
 *
 * The Inngest `cancelOn: "dbt/run.cancel"` only stops the executor function
 * from scheduling further steps — it cannot interrupt the dbt subprocess that
 * is already running inside a `step.run` on the worker. Without a way to reach
 * that child process, cancelling a stuck build (e.g. a model running >18 min)
 * would still leave it consuming warehouse compute until it finished on its
 * own. This registry bridges that gap: the executor registers a control handle
 * keyed by runId while a command is in flight, and {@link cancelLocalRun}
 * (called from the cancel API path, which runs in the same process as the
 * Inngest worker) aborts the subprocess and best-effort-cancels any BigQuery
 * jobs the run has spawned.
 *
 * It is intentionally process-local: in a multi-instance deployment the cancel
 * may land on a different instance than the one running the subprocess, in
 * which case the `dbt/run.cancel` event still frees the Inngest concurrency
 * slot and finalizes the run. The registry is the fast path that also reclaims
 * warehouse compute when the cancel and the worker share a process (the common
 * single-instance / dev case).
 */

import { loggers } from "../logging";

const logger = loggers.app();

export interface ActiveRunControl {
  /** Abort the in-flight dbt subprocess (SIGTERM, then SIGKILL after grace). */
  abort: (reason: string) => void;
  /** Best-effort cancel of any BigQuery jobs discovered for this run. */
  cancelWarehouseJobs: () => Promise<void>;
}

const activeRuns = new Map<string, ActiveRunControl>();

/** Register the control handle for a run that is starting execution here. */
export function registerActiveRun(
  runId: string,
  control: ActiveRunControl,
): void {
  activeRuns.set(runId, control);
}

/**
 * Remove a run's control handle. Pass the same `control` reference registered
 * earlier so a stale teardown (from a re-invoked executor) never clobbers a
 * newer registration for the same runId.
 */
export function unregisterActiveRun(
  runId: string,
  control?: ActiveRunControl,
): void {
  if (control && activeRuns.get(runId) !== control) return;
  activeRuns.delete(runId);
}

/** True when this process is currently executing the given run. */
export function isRunActiveLocally(runId: string): boolean {
  return activeRuns.has(runId);
}

/**
 * Abort a run executing on this process: SIGTERM/SIGKILL the dbt subprocess and
 * fire-and-forget a BigQuery job cancel. Returns whether a local handle existed
 * (false means the run is running elsewhere or already finished here).
 */
export function cancelLocalRun(runId: string, reason: string): boolean {
  const control = activeRuns.get(runId);
  if (!control) return false;
  try {
    control.abort(reason);
  } catch (error) {
    logger.warn("dbt local run abort failed", { error, runId });
  }
  void control.cancelWarehouseJobs().catch(error => {
    logger.warn("dbt warehouse job cancel failed", { error, runId });
  });
  return true;
}
