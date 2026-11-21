/**
 * Webhook-event and staging housekeeping the recovery paths share: reset
 * failed events, reconcile apply status, drop orphaned staging tables, and
 * drain pending events into the CDC store.
 */
import { inWorkspace } from "../../utils/workspace-scope";
import { Types } from "mongoose";
import {
  CdcChangeEvent,
  DatabaseConnection,
  IFlow,
  WebhookEvent,
} from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import { loggers } from "../../logging";
import { hasCdcDestinationAdapter } from "../adapters/registry";
import { resolveOrphanedWebhookApplyStatusForFlow } from "../cdc-orphan-applystatus";
import { resolveConfiguredEntities } from "../entity-selection";
import { cdcLiveTableName, cdcStageTableName } from "../normalization";
import { webhookReceiptIdsReadyToApply } from "../webhook-apply-status";

const log = loggers.sync("cdc.backfill");

export async function resetFailedWebhookEvents(
  workspaceId: string,
  flowId: string,
): Promise<number> {
  try {
    // Includes ENQUEUE_FAILED (status + applyStatus both "failed") and materialization failures.
    const result = await WebhookEvent.updateMany(
      {
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [{ status: "failed" }, { applyStatus: "failed" }],
        attempts: { $lt: 5 },
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
        workspaceId: wsOid,
        materializationStatus: "applied",
        webhookEventId: { $type: "string" },
      },
    );
    if (appliedCdcWebhookIds.length === 0) return 0;

    const oids = appliedCdcWebhookIds
      .filter(id => Types.ObjectId.isValid(id))
      .map(id => new Types.ObjectId(id));
    const readyIds = await webhookReceiptIdsReadyToApply(
      { flowId: flowOid, workspaceId: wsOid },
      oids,
    );
    if (readyIds.length === 0) return 0;

    const result = await WebhookEvent.updateMany(
      {
        _id: { $in: readyIds },
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

/**
 * Finds WebhookEvents stuck at applyStatus:"pending" whose CDC events have
 * all been materialized (applied/dropped) or were never created, and resolves
 * their applyStatus accordingly.
 */
export async function resolveOrphanedWebhookApplyStatus(
  workspaceId: string,
  flowId: string,
): Promise<number> {
  // Delegates to the shared, cursor-paginated resolver so a single
  // "Reprocess pending events" click drains the ENTIRE orphaned backlog. The
  // old inline version capped at 1000 per call, which is why the button
  // appeared to do nothing against a 50k+ backlog.
  return resolveOrphanedWebhookApplyStatusForFlow({ workspaceId, flowId });
}

export async function cleanupOrphanStagingTables(
  flow: Pick<
    IFlow,
    | "_id"
    | "workspaceId"
    | "tableDestination"
    | "destinationDatabaseId"
    | "entityLayouts"
  >,
): Promise<number> {
  try {
    if (
      !flow.tableDestination?.connectionId ||
      !flow.tableDestination?.schema
    ) {
      return 0;
    }
    const destination = await DatabaseConnection.findOne(
      inWorkspace(flow.tableDestination.connectionId, flow.workspaceId),
    );
    if (!destination || !hasCdcDestinationAdapter(destination.type)) return 0;

    const driver = databaseRegistry.getDriver(destination.type);
    if (!driver?.dropTable) return 0;

    const flowId = String(flow._id);
    const { entities: enabledEntities } = resolveConfiguredEntities(
      flow as any,
    );
    const tablePrefix = flow.tableDestination.tableName || "";
    const schema = flow.tableDestination.schema;
    const stageSchema = driver.getStagingSchema?.(schema) ?? schema;
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    let dropped = 0;

    for (const entity of enabledEntities) {
      const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
      // Only drop backfill staging and legacy tables. The stream staging
      // table (`…__staging`) is ephemeral — created and dropped within
      // writeViaParquet's try/finally. Dropping it here races with
      // in-flight cdc-materialize jobs and causes "Table not found" errors.
      const backfillBulkStaging = `${liveTable}__${flowToken}__backfill_staging`;
      const legacyStagingTables = [
        cdcStageTableName(tablePrefix, entity, flowId),
        `${liveTable}__stage_changes`,
      ];
      try {
        await driver.dropTable(destination, backfillBulkStaging, { schema });
        dropped++;
      } catch {
        /* may not exist */
      }
      for (const table of legacyStagingTables) {
        try {
          await driver.dropTable(destination, table, { schema: stageSchema });
          dropped++;
        } catch {
          /* may not exist */
        }
      }
    }

    if (dropped > 0) {
      log.info("Cleaned up orphan staging tables during recover", {
        flowId,
        dropped,
      });
    }
    return dropped;
  } catch (error) {
    log.warn("Failed to cleanup orphan staging tables", {
      flowId: String(flow._id),
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
    // Legacy per-event enqueue (`webhook/event.process`) was decommissioned.
    // For CDC flows, pending WebhookEvents are picked up by the CDC scheduler
    // cron (`cdcMaterializeSchedulerFunction`) on its next cycle, so there is
    // nothing to enqueue here. Re-arm any stuck non-pending events back to
    // "pending" so the cron re-ingests them, and report the backlog size.
    await WebhookEvent.updateMany(
      {
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        status: "processing",
        attempts: { $lt: 5 },
      },
      { $set: { status: "pending" } },
    );

    const pendingCount = await WebhookEvent.countDocuments({
      flowId: new Types.ObjectId(flowId),
      status: "pending",
      attempts: { $lt: 5 },
    });

    if (pendingCount > 0) {
      log.info("Pending WebhookEvents awaiting CDC cron ingest", {
        flowId,
        workspaceId,
        trigger,
        count: pendingCount,
      });
    }

    return pendingCount;
  } catch (error) {
    log.warn("Failed to inspect pending WebhookEvents", {
      flowId,
      workspaceId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
