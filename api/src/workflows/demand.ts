/**
 * How many steps a workspace's worker has to run now: what the autoscaler
 * sizes the worker by (kube.ts `autoscalerBodies`). Steps queued or running
 * in Hatchet, and one more while the worker has something to build or
 * register: a commit it has not reported on yet, which is also how a change
 * of triggers shows (webhook.ts `setTriggers` forgets the last report).
 * A worker at zero pods wakes for either.
 */
import { Workspace } from "../database/workspace-schema";
import { tenantJson, tenantOfToken, type WorkspaceTenant } from "./hatchet";

/** Hatchet's `task-stats`: the engine's own queue, by task name. */
type TaskStats = Record<
  string,
  { queued?: { total?: number }; running?: { total?: number } }
>;

export interface WorkerDemand {
  /** What the autoscaler reads: `queued + running`, at least 1 while `building`. */
  steps: number;
  queued: number;
  running: number;
  building: boolean;
}

// The autoscaler asks every few seconds, per workspace, on every instance.
const FRESH_FOR_MS = 10_000;
const stats = new Map<
  string,
  { at: number; queued: number; running: number }
>();

async function readQueue(tenant: WorkspaceTenant, now: number) {
  const known = stats.get(tenant.tenantId);
  if (known && now - known.at < FRESH_FOR_MS) return known;
  const byTask = await tenantJson<TaskStats>(
    tenant,
    `/api/v1/tenants/${tenant.tenantId}/task-stats`,
  );
  const read = { at: now, queued: 0, running: 0 };
  for (const task of Object.values(byTask ?? {})) {
    read.queued += task.queued?.total ?? 0;
    read.running += task.running?.total ?? 0;
  }
  stats.set(tenant.tenantId, read);
  return read;
}

/** Forget what was read (tests). */
export function forgetDemandForTests() {
  stats.clear();
}

type Slot = {
  sha?: string;
  running?: { sha?: string };
  failed?: { sha?: string };
};

/**
 * The demand for a slot and a queue reading. A commit that failed to build
 * is not work: the pod that failed tries it again by itself while it is up,
 * and more pods would only fail the same way.
 */
export function demandOf(
  live: Slot | undefined,
  queue: { queued: number; running: number },
): WorkerDemand {
  const building = Boolean(
    live?.sha &&
    live.running?.sha !== live.sha &&
    live.failed?.sha !== live.sha,
  );
  return {
    steps: Math.max(queue.queued + queue.running, building ? 1 : 0),
    queued: queue.queued,
    running: queue.running,
    building,
  };
}

/**
 * The workspace's demand. Throws when Hatchet does not answer: the caller
 * says so, and the autoscaler keeps the pods it has rather than read "none".
 */
export async function workerDemand(
  workspaceId: string,
  now = Date.now(),
): Promise<WorkerDemand> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows.live workflows.hatchetToken")
    .lean();
  const tenant = tenantOfToken(workspace?.workflows?.hatchetToken);
  const { queued, running } = tenant
    ? await readQueue(tenant, now)
    : { queued: 0, running: 0 };
  return demandOf(workspace?.workflows?.live, { queued, running });
}
