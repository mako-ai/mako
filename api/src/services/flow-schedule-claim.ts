/**
 * Due-check + atomic claim for the poll-trigger flow scheduler
 * (`flowSchedulerFunction`), in one call meant to be ONE `step.run`.
 *
 * Before, the scheduler took one step per enabled flow (plus a sleep and a
 * send per due one), so it hard-failed at a few hundred flows against
 * Inngest's per-run step limit, and returned full flow documents as step
 * output. It also had no claim: it skipped a flow only while an execution
 * was `running`, so a dispatched `flow.execute` still QUEUED behind the
 * flow function's `concurrency: 1` (it has not stamped `lastRunAt` yet) was
 * dispatched again on the next tick.
 *
 * Now a dispatch stamps `lastScheduledDispatchAt` with compare-and-swap on
 * the value the scan read, and due-ness counts from the later of that and
 * `lastRunAt`. Two overlapping scans cannot both claim one flow, and a
 * queued dispatch is not repeated until the schedule's next occurrence.
 */
import { Types } from "mongoose";

import { Flow, FlowExecution } from "../database/workspace-schema";
import { loggers } from "../logging";
import { isCronDue } from "./cron-due";
import { buildScheduledFlowSelection } from "./flow-triggers.service";
import { flowDisplayName } from "./flow-identity.service";

const log = loggers.inngest("flow-scheduler");

/** A flow this scan claimed for dispatch; small and JSON-safe. */
export interface ClaimedScheduledFlow {
  flowId: string;
  workspaceId: string;
  displayName: string;
  /** ISO time of the claim; the dispatch's identity. */
  dispatchedAt: string;
}

/** The fields the due check and the display name need, nothing more. */
const SCHEDULER_PROJECTION =
  "_id workspaceId name sourceType databaseSource dataSourceId " +
  "tableDestination destinationDatabaseId schedule lastRunAt lastScheduledDispatchAt";

function laterOf(a?: Date | null, b?: Date | null): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export async function claimDueScheduledFlows(
  now: Date,
): Promise<{ checked: number; claimed: ClaimedScheduledFlow[] }> {
  const flows = await Flow.find(buildScheduledFlowSelection())
    .select(SCHEDULER_PROJECTION)
    .lean();

  const due = flows.filter(flow => {
    const cron = flow.schedule?.cron;
    if (!cron) return false;
    try {
      return isCronDue({
        cron,
        timezone: flow.schedule?.timezone || "UTC",
        lastRunAt: laterOf(flow.lastRunAt, flow.lastScheduledDispatchAt),
        now,
      });
    } catch (error) {
      log.error("Invalid cron on scheduled flow; skipping", {
        flowId: String(flow._id),
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  });
  if (due.length === 0) return { checked: flows.length, claimed: [] };

  // Skip flows with a run still going (one query, not one per flow) —
  // prevents pile-up when a run outlasts its cron interval.
  const running = new Set(
    (
      (await FlowExecution.collection.distinct("flowId", {
        flowId: { $in: due.map(flow => flow._id) },
        status: "running",
      })) as unknown[]
    ).map(id => String(id)),
  );

  const claimed: ClaimedScheduledFlow[] = [];
  for (const flow of due) {
    const flowId = String(flow._id);
    if (running.has(flowId)) {
      log.info("Skipping dispatch: flow already has active execution", {
        flowId,
      });
      continue;
    }
    const result = await Flow.updateOne(
      {
        _id: new Types.ObjectId(flowId),
        workspaceId: flow.workspaceId,
        // `null` also matches a flow that was never dispatched.
        lastScheduledDispatchAt: flow.lastScheduledDispatchAt ?? null,
      },
      { $set: { lastScheduledDispatchAt: now } },
    );
    if (result.modifiedCount === 0) continue;
    claimed.push({
      flowId,
      workspaceId: String(flow.workspaceId),
      displayName: await flowDisplayName(flow),
      dispatchedAt: now.toISOString(),
    });
  }

  return { checked: flows.length, claimed };
}

/** Deterministic `flow.execute` event id for one claimed dispatch. */
export function scheduledFlowEventId(claimed: ClaimedScheduledFlow): string {
  return `flow-schedule:${claimed.flowId}:${claimed.dispatchedAt}`;
}
