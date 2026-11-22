import { Types } from "mongoose";
import { WebhookEvent } from "../database/workspace-schema";
import { loggers } from "../logging";
import { webhookReceiptIdsReadyToApply } from "./webhook-apply-status";

const log = loggers.sync("cdc.orphan-applystatus");

const BATCH = 1000;
// Safety cap so a runaway query can never loop unbounded (BATCH * MAX = 10M rows).
const MAX_ITERATIONS = 10_000;

/**
 * Resolves WebhookEvents stuck at applyStatus:"pending" whose CDC events were
 * applied or were never created (e.g. deduped at ingest). No pending CDC event
 * references those receipts, so the consumer never updates them and the
 * flow's "pending" count grows forever.
 *
 * Cursor-paginates by _id so EVERY stuck row is inspected exactly once (the old
 * single-shot .limit(1000) only ever cleared 1000 per call, which is why the
 * "Reprocess pending events" button appeared to do nothing against a 50k+
 * backlog). A pending, failed or dropped CDC sibling blocks an applied outcome.
 */
export async function resolveOrphanedWebhookApplyStatusForFlow(params: {
  flowId: string;
  workspaceId?: string;
}): Promise<number> {
  const flowOid = new Types.ObjectId(params.flowId);
  const scope = {
    flowId: flowOid,
    ...(params.workspaceId && {
      workspaceId: new Types.ObjectId(params.workspaceId),
    }),
  };
  const baseQuery = {
    ...scope,
    status: "completed",
    applyStatus: "pending",
  } as const;

  let totalResolved = 0;
  let cursor: Types.ObjectId | null = null;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const query = cursor ? { ...baseQuery, _id: { $gt: cursor } } : baseQuery;
      const stuck = await WebhookEvent.find(query)
        .sort({ _id: 1 })
        .select({ _id: 1 })
        .limit(BATCH)
        .lean();

      if (stuck.length === 0) break;
      cursor = stuck[stuck.length - 1]._id as Types.ObjectId;

      const orphanedOids = await webhookReceiptIdsReadyToApply(
        scope,
        stuck.map(e => e._id as Types.ObjectId),
      );

      if (orphanedOids.length > 0) {
        const result = await WebhookEvent.updateMany(
          { ...baseQuery, _id: { $in: orphanedOids } },
          { $set: { applyStatus: "applied" }, $unset: { applyError: "" } },
        );
        totalResolved += result.modifiedCount || 0;
      }

      if (stuck.length < BATCH) break;
    }

    if (totalResolved > 0) {
      log.info("Resolved orphaned webhook applyStatus", {
        flowId: params.flowId,
        resolved: totalResolved,
      });
    }
    return totalResolved;
  } catch (error) {
    log.warn("Failed to resolve orphaned webhook apply status", {
      flowId: params.flowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return totalResolved;
  }
}

/**
 * Scheduler entry point: finds every flow that currently has webhooks stuck at
 * applyStatus:"pending" and reconciles each. Keeps the flow "pending" counter
 * honest without requiring a manual reprocess click.
 */
export async function reconcileOrphanedWebhookApplyStatus(): Promise<{
  flowsScanned: number;
  resolved: number;
}> {
  const flowIds: Types.ObjectId[] = await WebhookEvent.distinct("flowId", {
    status: "completed",
    applyStatus: "pending",
  });

  let resolved = 0;
  for (const flowId of flowIds) {
    resolved += await resolveOrphanedWebhookApplyStatusForFlow({
      flowId: String(flowId),
    });
  }

  return { flowsScanned: flowIds.length, resolved };
}
