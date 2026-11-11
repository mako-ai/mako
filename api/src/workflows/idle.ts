/**
 * Workers sleep when there is nothing to do (the `gke` provider only).
 *
 * A workspace's worker is a Deployment (kube.ts). It is scaled to 0 pods
 * when it has been idle for IDLE_AFTER_MS, and to 1 again when there is work:
 *
 * - Mako wakes it at once when it starts a run (UI, API, agent, webhook,
 *   retry), when it deploys a new commit, and when a workflow's triggers
 *   change (the worker registers them again).
 * - The sweep (`reconcileIdleWorkers`, every minute) wakes it for what
 *   Hatchet starts by itself: a run queued or running, a schedule or a
 *   scheduled run due within PREWAKE_MS.
 *
 * A run started while the worker sleeps waits QUEUED in Hatchet until the
 * pod is up. worker.mjs gives every task a long default schedule timeout,
 * so a cold start does not cancel it.
 *
 * Idle means all of these, for IDLE_AFTER_MS: no run queued or running, no
 * deploy still building, and nothing due. Any error reading Hatchet leaves
 * the worker as it is: a worker that cannot be checked stays awake.
 */
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { nextCronRunAt } from "../services/cron-due";
import { tenantJson, tenantOfToken, type WorkspaceTenant } from "./hatchet";
import {
  AWAKE_REPLICAS,
  isGkeWorkerConfigured,
  listWorkers,
  setWorkerReplicas,
} from "./kube";

const logger = loggers.api("workflows-idle");

/** How long a worker stays up after it was last needed. */
export const IDLE_AFTER_MS = 10 * 60_000;
/** How long before a schedule fires the worker is woken for it. */
export const PREWAKE_MS = 5 * 60_000;
/** How far back a run still queued or running is looked for. */
const ACTIVE_RUN_LOOKBACK_MS = 30 * 864e5;

type Row = Record<string, unknown>;
type Rows = { rows?: Row[] };

/** What Hatchet holds for a workspace that needs its worker. */
export interface HatchetDemand {
  /** A run of a deployed workflow is queued or running. */
  busy: boolean;
  /** When a schedule of an active workflow, or a scheduled run, fires next. */
  nextTriggerAt?: Date;
}

/**
 * Read what Hatchet will hand the worker. Only the workflows deployed now
 * count, and only active ones' schedules: a workflow gone from main, or
 * switched off, may still be known to Hatchet until the worker registers
 * again, and must not keep the worker awake.
 */
export async function readHatchetDemand(
  tenant: WorkspaceTenant,
  deployed: string[],
  active: string[],
  now = new Date(),
): Promise<HatchetDemand> {
  const names = new Set(deployed);
  const scheduled = new Set(active.filter(name => names.has(name)));
  const base = `/api/v1/tenants/${tenant.tenantId}`;
  const runsQuery = new URLSearchParams({
    since: new Date(now.getTime() - ACTIVE_RUN_LOOKBACK_MS).toISOString(),
    only_tasks: "false",
    limit: "50",
  });
  runsQuery.append("statuses", "QUEUED");
  runsQuery.append("statuses", "RUNNING");
  const scheduledQuery = new URLSearchParams({
    statuses: "SCHEDULED",
    orderByField: "triggerAt",
    orderByDirection: "ASC",
    limit: "50",
  });
  const [runs, crons, oneOffs] = await Promise.all([
    tenantJson<Rows>(
      tenant,
      `/api/v1/stable/tenants/${tenant.tenantId}/workflow-runs`,
      { query: runsQuery },
    ),
    tenantJson<Rows>(tenant, `${base}/workflows/crons`, {
      query: new URLSearchParams({ limit: "200" }),
    }),
    tenantJson<Rows>(tenant, `${base}/workflows/scheduled`, {
      query: scheduledQuery,
    }),
  ]);

  const busy = (runs.rows ?? []).some(run =>
    names.has(String(run.workflowName)),
  );
  const times: number[] = [];
  for (const cron of crons.rows ?? []) {
    if (cron.enabled === false || !scheduled.has(String(cron.workflowName))) {
      continue;
    }
    try {
      times.push(nextCronRunAt(String(cron.cron), { from: now }).getTime());
    } catch {
      // A schedule Hatchet accepted but cron-parser does not read: the
      // worker is not woken ahead of it, and the sweep wakes it once the
      // run is queued.
    }
  }
  for (const run of oneOffs.rows ?? []) {
    const at = Date.parse(String(run.triggerAt));
    if (names.has(String(run.workflowName)) && Number.isFinite(at)) {
      times.push(at);
    }
  }
  const next = times.length ? Math.min(...times) : undefined;
  return { busy, nextTriggerAt: next ? new Date(next) : undefined };
}

export interface WorkerState {
  replicas: number;
  /** When Mako or the sweep last saw the worker needed. */
  lastNeededAt?: Date;
  /** The commit Mako wants is not yet running or failed. */
  deployPending: boolean;
  /** Null when Hatchet could not be read. */
  demand: HatchetDemand | null;
}

/**
 * What to do with a worker: wake it, put it to sleep, or leave it. A worker
 * that is needed now also counts as needed (`needed`), so its idle time
 * starts again.
 */
export function decide(
  state: WorkerState,
  now = new Date(),
): { action: "wake" | "sleep" | "keep"; needed: boolean } {
  const { demand } = state;
  const needed =
    state.deployPending ||
    Boolean(demand?.busy) ||
    (demand?.nextTriggerAt !== undefined &&
      demand.nextTriggerAt.getTime() - now.getTime() <= PREWAKE_MS);
  const awake = state.replicas > 0;
  if (needed) return { action: awake ? "keep" : "wake", needed };
  // Hatchet unreadable: leave the worker as it is.
  if (!demand) return { action: "keep", needed };
  const recent =
    state.lastNeededAt !== undefined &&
    now.getTime() - state.lastNeededAt.getTime() < IDLE_AFTER_MS;
  return { action: awake && !recent ? "sleep" : "keep", needed };
}

async function markNeeded(workspaceId: string, at = new Date()) {
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    { $set: { "workflows.lastNeededAt": at } },
  );
}

/**
 * Wake the workspace's worker, if it has one and it sleeps. Never throws:
 * what woke it (a run, a deploy) goes ahead either way, and the sweep wakes
 * a worker that a failed wake left asleep once Hatchet holds its run.
 */
export async function wakeWorker(
  workspaceId: string,
  reason: string,
): Promise<void> {
  if (!isGkeWorkerConfigured()) return;
  try {
    await markNeeded(workspaceId);
    if (await setWorkerReplicas(workspaceId, AWAKE_REPLICAS)) {
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

/**
 * Wake the workers Hatchet has work for, and put to sleep the ones idle
 * for IDLE_AFTER_MS. Returns what changed.
 */
export async function reconcileIdleWorkers(
  now = new Date(),
): Promise<{ woke: string[]; slept: string[] }> {
  const result = { woke: [] as string[], slept: [] as string[] };
  if (!isGkeWorkerConfigured()) return result;
  const workers = await listWorkers();
  const ids = workers
    .map(w => w.workspaceId)
    .filter(id => Types.ObjectId.isValid(id));
  const workspaces = await Workspace.find({ _id: { $in: ids } })
    .select("workflows")
    .lean();
  const byId = new Map(workspaces.map(w => [w._id.toString(), w.workflows]));

  for (const { workspaceId, replicas } of workers) {
    const state = byId.get(workspaceId);
    const live = state?.live;
    const tenant = tenantOfToken(state?.hatchetToken);
    // Nothing deployed: nothing for Hatchet to hand this worker.
    const demand: HatchetDemand | null =
      !tenant || !live
        ? { busy: false }
        : await readHatchetDemand(
            tenant,
            live.names ?? [],
            state?.active ?? [],
            now,
          ).catch(error => {
            logger.warn("Could not read Hatchet for an idle check", {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
    const deployPending = Boolean(
      live && live.running?.sha !== live.sha && live.failed?.sha !== live.sha,
    );
    const { action, needed } = decide(
      {
        replicas,
        lastNeededAt: state?.lastNeededAt
          ? new Date(state.lastNeededAt)
          : undefined,
        deployPending,
        demand,
      },
      now,
    );
    try {
      if (needed) await markNeeded(workspaceId, now);
      if (action === "wake") {
        await setWorkerReplicas(workspaceId, AWAKE_REPLICAS);
        result.woke.push(workspaceId);
      } else if (action === "sleep") {
        await setWorkerReplicas(workspaceId, 0);
        result.slept.push(workspaceId);
      }
    } catch (error) {
      logger.warn("Could not scale a workflow worker", {
        workspaceId,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (result.woke.length || result.slept.length) {
    logger.info("Workflow workers scaled", {
      woke: result.woke.length,
      slept: result.slept.length,
    });
  }
  return result;
}
