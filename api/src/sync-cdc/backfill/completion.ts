/**
 * Backfill completion: mark it complete, purge soft deletes after a hard-delete
 * backfill, and force-drain the flow's pending CDC events.
 */
import { syncWritePriority } from "../../services/bigquery-job-priority";
import { inWorkspace } from "../../utils/workspace-scope";
import { Types } from "mongoose";
import { DatabaseConnection, Flow } from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import { inngest } from "../../inngest/client";
import { loggers } from "../../logging";
import { resolveConfiguredEntities } from "../entity-selection";
import { getCdcEventStore } from "../event-store";
import { cdcLiveTableName } from "../normalization";
import { backfillAttemptFilter, type BackfillAttempt } from "./attempt";

const log = loggers.sync("cdc.backfill");

export async function markCdcBackfillCompletedForFlow(params: {
  workspaceId: string;
  flowId: string;
  expectedAttempt?: BackfillAttempt;
}): Promise<boolean> {
  const scope = {
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  };
  const expected = params.expectedAttempt;
  const terminalOwner = expected
    ? {
        "backfillState.attemptId": expected.attemptId ?? null,
        "backfillState.status": "completed" as const,
        "backfillState.runId": null,
      }
    : {};
  const update = await Flow.updateOne(
    {
      ...scope,
      ...(expected
        ? {
            ...backfillAttemptFilter(expected),
            "backfillState.status": "running" as const,
          }
        : {}),
    },
    {
      $set: {
        "backfillState.status": "completed",
        "backfillState.completedAt": new Date(),
      },
      $unset: {
        "backfillState.runId": "",
        "backfillState.dispatchPendingAt": "",
      },
    },
  );
  // A retry of the same step may reach this write after it already set
  // completed. Only the original dispatch may continue the epilogue.
  if (
    !update.matchedCount &&
    (!expected || !(await Flow.exists({ ...scope, ...terminalOwner })))
  ) {
    return false;
  }
  // The COMPLETE transition that follows finds the status already completed
  // and changes nothing, so it never replaces an old failure's meta: a flow
  // whose backfill failed once kept that error for months of clean runs.
  // A live stream error keeps its meta (the consumer's self-heal reads it).
  await Flow.updateOne(
    {
      ...scope,
      ...terminalOwner,
      streamState: { $ne: "error" },
      "syncStateMeta.lastErrorCode": { $exists: true, $ne: null },
    },
    {
      $set: {
        syncStateMeta: {
          lastEvent: "backfill:COMPLETE",
          lastReason: "Backfill completed",
        },
        syncStateUpdatedAt: new Date(),
      },
    },
  );
  return true;
}

export async function purgeSoftDeletesAfterBackfill(params: {
  workspaceId: string;
  flowId: string;
}) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(params.flowId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  }).lean();
  if (!flow || flow.deleteMode !== "hard") return;
  if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
    return;
  }

  const destination = await DatabaseConnection.findOne(
    inWorkspace(flow.tableDestination.connectionId, flow.workspaceId),
  );
  if (!destination) return;

  const driver = databaseRegistry.getDriver(destination.type);
  if (!driver?.executeQuery) return;

  const enabledEntities = resolveConfiguredEntities(flow).entities;
  const tablePrefix = flow.tableDestination.tableName || "sync";
  const schema = flow.tableDestination.schema;

  for (const entity of enabledEntities) {
    const tableName = cdcLiveTableName(tablePrefix, entity);
    const fullTable = driver.formatTableRef
      ? driver.formatTableRef(schema, tableName)
      : `"${schema}"."${tableName}"`;
    const query = `DELETE FROM ${fullTable} WHERE is_deleted = true`;
    try {
      await driver.executeQuery(destination, query, {
        priority: syncWritePriority(),
      });
      log.info("Purged soft-deleted rows after backfill", {
        flowId: params.flowId,
        entity,
        table: tableName,
      });
    } catch (err) {
      log.warn("Failed to purge soft-deleted rows", {
        flowId: params.flowId,
        entity,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function forceDrainCdcFlow(params: {
  workspaceId: string;
  flowId: string;
  completedAttemptId?: string;
}) {
  const byEntity = await getCdcEventStore().countEventsByEntity({
    workspaceId: params.workspaceId,
    flowId: params.flowId,
    materializationStatus: "pending",
  });

  for (const item of byEntity) {
    if (item.count <= 0) continue;

    // Force materialize without rewinding the consumer cursor (see
    // reprocessStaleEvents / retryFailedMaterialization).
    await inngest.send({
      name: "cdc/materialize",
      data: {
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: item.entity,
        force: true,
        ...(params.completedAttemptId
          ? { completedAttemptId: params.completedAttemptId }
          : {}),
      },
    });
  }
}
