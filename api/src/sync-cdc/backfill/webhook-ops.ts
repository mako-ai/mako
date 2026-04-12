/**
 * Webhook event operations for CDC backfill recovery.
 *
 * Handles draining stuck webhook events, resetting failed events,
 * reconciling apply status between WebhookEvent and CdcChangeEvent,
 * and resolving orphaned webhook apply statuses.
 */
import { Types } from "mongoose";
import { inngest } from "../../inngest/client";
import { resolveWebhookEventName } from "../../inngest/webhook-process-enqueue";
import {
  CdcChangeEvent,
  DatabaseConnection,
  Flow,
  WebhookEvent,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  CDC_WEBHOOK_DRAIN_CHUNK,
  CDC_WEBHOOK_DRAIN_LIMIT,
  CDC_WEBHOOK_MAX_RETRY_ATTEMPTS,
} from "../constants";

const log = loggers.sync("cdc.backfill");

export async function resetFailedWebhookEvents(
  workspaceId: string,
  flowId: string,
): Promise<number> {
  try {
    const result = await WebhookEvent.updateMany(
      {
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [{ status: "failed" }, { applyStatus: "failed" }],
        attempts: { $lt: CDC_WEBHOOK_MAX_RETRY_ATTEMPTS },
      },
      {
        $set: { status: "pending", applyStatus: "pending" },
        $unset: { applyError: "", error: "", processedAt: "" },
      },
    );
    if (result.modifiedCount > 0) {
      log.info("Reset failed webhook events during recover", {
        flowId,
        count: result.modifiedCount,
      });
    }
    return result.modifiedCount || 0;
  } catch (error) {
    log.warn("Failed to reset failed webhook events", {
      flowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export async function reconcileWebhookApplyStatus(
  workspaceId: string,
  flowId: string,
): Promise<number> {
  try {
    const flowOid = new Types.ObjectId(flowId);
    const wsOid = new Types.ObjectId(workspaceId);

    const appliedCdcWebhookIds: string[] = await CdcChangeEvent.distinct(
      "webhookEventId",
      {
        flowId: flowOid,
        materializationStatus: "applied",
        webhookEventId: { $type: "string" },
      },
    );
    if (appliedCdcWebhookIds.length === 0) return 0;

    const oids = appliedCdcWebhookIds
      .filter(id => Types.ObjectId.isValid(id))
      .map(id => new Types.ObjectId(id));

    const result = await WebhookEvent.updateMany(
      {
        _id: { $in: oids },
        flowId: flowOid,
        workspaceId: wsOid,
        applyStatus: { $ne: "applied" },
      },
      {
        $set: { applyStatus: "applied", status: "completed" },
        $unset: { applyError: "" },
      },
    );

    if (result.modifiedCount > 0) {
      log.info("Reconciled webhook applyStatus from CDC state", {
        flowId,
        reconciled: result.modifiedCount,
      });
    }
    return result.modifiedCount || 0;
  } catch (error) {
    log.warn("Failed to reconcile webhook apply status", {
      flowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export async function resolveOrphanedWebhookApplyStatus(
  workspaceId: string,
  flowId: string,
): Promise<number> {
  try {
    const flowOid = new Types.ObjectId(flowId);
    const wsOid = new Types.ObjectId(workspaceId);

    const stuckWebhookEvents = await WebhookEvent.find({
      flowId: flowOid,
      workspaceId: wsOid,
      status: "completed",
      applyStatus: "pending",
    })
      .select({ _id: 1 })
      .limit(1000)
      .lean();

    if (stuckWebhookEvents.length === 0) return 0;

    const stuckIds = stuckWebhookEvents.map(e => String(e._id));

    const withPendingCdc: string[] = await CdcChangeEvent.distinct(
      "webhookEventId",
      {
        flowId: flowOid,
        webhookEventId: { $in: stuckIds },
        materializationStatus: "pending",
      },
    );
    const pendingSet = new Set(withPendingCdc);

    const orphanedIds = stuckIds.filter(id => !pendingSet.has(id));
    if (orphanedIds.length === 0) return 0;

    const orphanedOids = orphanedIds.map(id => new Types.ObjectId(id));

    const result = await WebhookEvent.updateMany(
      { _id: { $in: orphanedOids } },
      {
        $set: { applyStatus: "applied" },
        $unset: { applyError: "" },
      },
    );

    if (result.modifiedCount > 0) {
      log.info("Resolved orphaned webhook applyStatus", {
        flowId,
        total: stuckWebhookEvents.length,
        withPendingCdc: withPendingCdc.length,
        resolved: result.modifiedCount,
      });
    }

    return result.modifiedCount || 0;
  } catch (error) {
    log.warn("Failed to resolve orphaned webhook apply status", {
      flowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

export async function drainPendingWebhookEvents(
  workspaceId: string,
  flowId: string,
  trigger: string,
): Promise<number> {
  try {
    const stuckWebhookEvents = await WebhookEvent.find({
      flowId: new Types.ObjectId(flowId),
      status: "pending",
      attempts: { $lt: CDC_WEBHOOK_MAX_RETRY_ATTEMPTS },
    })
      .sort({ receivedAt: 1 })
      .limit(CDC_WEBHOOK_DRAIN_LIMIT)
      .select({ eventId: 1 })
      .lean<Array<{ _id: Types.ObjectId; eventId?: string }>>();

    if (stuckWebhookEvents.length === 0) return 0;

    const flow = await Flow.findById(flowId)
      .select("syncEngine destinationDatabaseId tableDestination")
      .lean();
    const destConn = flow?.destinationDatabaseId
      ? await DatabaseConnection.findById(flow.destinationDatabaseId)
          .select("type")
          .lean()
      : null;

    const eventName = resolveWebhookEventName(
      flow
        ? {
            syncEngine: flow.syncEngine,
            tableDestination: flow.tableDestination,
          }
        : undefined,
      destConn?.type,
    );

    for (
      let i = 0;
      i < stuckWebhookEvents.length;
      i += CDC_WEBHOOK_DRAIN_CHUNK
    ) {
      const batch = stuckWebhookEvents.slice(i, i + CDC_WEBHOOK_DRAIN_CHUNK);
      await inngest.send(
        batch.map(evt => ({
          name: eventName,
          data: {
            flowId,
            workspaceId,
            eventId: evt.eventId,
            isReplay: true,
          },
        })),
      );
    }

    log.info("Drained pending WebhookEvents", {
      flowId,
      workspaceId,
      trigger,
      count: stuckWebhookEvents.length,
    });

    return stuckWebhookEvents.length;
  } catch (error) {
    log.warn("Failed to drain pending WebhookEvents", {
      flowId,
      workspaceId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
