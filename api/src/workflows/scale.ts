/**
 * A workspace's worker follows its work (the `gke` provider, with
 * WORKFLOWS_AUTOSCALE=on): as many pods as its steps need, none when there
 * is nothing to do.
 *
 * - Every minute the sweep (`reconcileWorkers`) reads what each workspace
 *   has to run (demand.ts: steps queued or running in Hatchet's own queue,
 *   and a commit not built yet) and sets the pods: one per `workerSteps()`
 *   steps, at most WORKER_MAX_REPLICAS.
 * - It grows at once and shrinks one pod a minute. The last pod stops only
 *   after IDLE_AFTER_MS without work, so a schedule that fires every few
 *   minutes keeps its worker.
 * - Mako does not wait for the sweep when it knows work is coming: starting
 *   a run, deploying a commit and switching a workflow's triggers wake a
 *   sleeping worker at once (`wakeWorker`).
 *
 * A run started while no pod is up waits QUEUED in Hatchet, about a minute;
 * worker.mjs lets a step wait a day before Hatchet cancels it. A schedule
 * Hatchet fires by itself is picked up by the next sweep.
 *
 * When Hatchet cannot be read the worker is left as it is: no answer is
 * not "no work".
 */
import { Types } from "mongoose";

import { loggers } from "../logging";
import { workspaceRepo } from "../repositories/workspaces";
import { demandOf, readQueue, type WorkerDemand } from "./demand";
import { tenantOfToken } from "./hatchet";
import {
  WORKER_MAX_REPLICAS,
  isGkeWorkerConfigured,
  listWorkers,
  setWorkerReplicas,
  workerSteps,
} from "./kube";

const logger = loggers.api("workflows-scale");

/** How long the last pod stays after the worker was last needed. */
export const IDLE_AFTER_MS = 10 * 60_000;

/** True when Mako sets the workers' pod count (WORKFLOWS_AUTOSCALE=on). */
export function isAutoscaled(): boolean {
  return process.env.WORKFLOWS_AUTOSCALE === "on" && isGkeWorkerConfigured();
}

export interface WorkerState {
  replicas: number;
  /** When the worker was last seen needed. */
  lastNeededAt?: Date;
  /** Null when Hatchet could not be read. */
  demand: WorkerDemand | null;
}

/**
 * The pods a worker should have now, and whether it is needed (its idle
 * time then starts again).
 */
export function decide(
  state: WorkerState,
  now = new Date(),
  slots = workerSteps(),
  most = WORKER_MAX_REPLICAS,
): { replicas: number; needed: boolean } {
  const { demand, replicas } = state;
  if (!demand) return { replicas, needed: false };
  const needed = demand.steps > 0;
  const wanted = Math.min(most, Math.ceil(demand.steps / slots));
  // Grow at once.
  if (wanted >= replicas) return { replicas: wanted, needed };
  // Shrink one pod at a time, down to one.
  if (replicas - 1 >= Math.max(wanted, 1)) {
    return { replicas: replicas - 1, needed };
  }
  // The last pod: only after a while without work.
  const recent =
    state.lastNeededAt !== undefined &&
    now.getTime() - state.lastNeededAt.getTime() < IDLE_AFTER_MS;
  return { replicas: needed || recent ? replicas : 0, needed };
}

async function markNeeded(workspaceId: string, at = new Date()) {
  await workspaceRepo.touchWorkflowLastNeededAt(workspaceId, at);
}

/**
 * Wake the workspace's worker if it sleeps. Never throws: what woke it (a
 * run, a deploy) goes ahead either way, and the sweep wakes a worker that a
 * failed wake left asleep once Hatchet holds its run.
 */
export async function wakeWorker(
  workspaceId: string,
  reason: string,
): Promise<void> {
  if (!isAutoscaled()) return;
  try {
    await markNeeded(workspaceId);
    const changed = await setWorkerReplicas(workspaceId, current =>
      Math.max(current, 1),
    );
    if (changed && changed.to !== changed.from) {
      logger.info("Woke workflow worker", { workspaceId, reason });
    }
  } catch (error) {
    logger.warn("Could not wake workflow worker", {
      workspaceId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Set every worker's pods to what its work needs. Returns what changed. */
export async function reconcileWorkers(
  now = new Date(),
): Promise<Array<{ workspaceId: string; from: number; to: number }>> {
  const changes: Array<{ workspaceId: string; from: number; to: number }> = [];
  if (!isAutoscaled()) return changes;
  const workers = await listWorkers();
  const ids = workers
    .map(worker => worker.workspaceId)
    .filter(id => Types.ObjectId.isValid(id));
  const workspaces = await workspaceRepo.findByIds(ids);
  const byId = new Map(workspaces.map(w => [w.id, w.workflows]));

  for (const { workspaceId, replicas } of workers) {
    const state = byId.get(workspaceId);
    // Reading the token is inside the chain: a token that cannot be read
    // (a database restored under another key) leaves its own worker as it
    // is, and the sweep goes on to the next.
    const demand = await Promise.resolve()
      .then(() => tenantOfToken(state?.hatchetToken))
      .then(tenant =>
        tenant ? readQueue(tenant, now.getTime()) : { queued: 0, running: 0 },
      )
      .then(queue => demandOf(state?.live, queue))
      .catch(error => {
        logger.warn("Could not read Hatchet to size a workflow worker", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    const wanted = decide(
      {
        replicas,
        lastNeededAt: state?.lastNeededAt
          ? new Date(state.lastNeededAt)
          : undefined,
        demand,
      },
      now,
    );
    try {
      if (wanted.needed) await markNeeded(workspaceId, now);
      if (wanted.replicas === replicas) continue;
      // From the count it has now: a wake since the list was read stays.
      const changed = await setWorkerReplicas(workspaceId, current =>
        wanted.replicas === 0 && current !== replicas
          ? current
          : wanted.replicas,
      );
      if (changed && changed.to !== changed.from) {
        changes.push({ workspaceId, ...changed });
      }
    } catch (error) {
      logger.warn("Could not scale a workflow worker", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (changes.length) logger.info("Workflow workers scaled", { changes });
  return changes;
}
