/**
 * Backfill completion: mark it complete, purge soft deletes after a hard-delete
 * backfill, and force-drain the flow's pending CDC events.
 */
import { inWorkspace } from "../../utils/workspace-scope";
import { Types } from "mongoose";
import { DatabaseConnection, Flow } from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import { inngest } from "../../inngest/client";
import { loggers } from "../../logging";
import { resolveConfiguredEntities } from "../entity-selection";
import { getCdcEventStore } from "../event-store";
import { cdcLiveTableName } from "../normalization";

const log = loggers.sync("cdc.backfill");

export async function markCdcBackfillCompletedForFlow(params: {
  workspaceId: string;
  flowId: string;
}) {
  await Flow.updateOne(
    {
      _id: new Types.ObjectId(params.flowId),
      workspaceId: new Types.ObjectId(params.workspaceId),
    },
    {
      $set: {
        "backfillState.status": "completed",
        "backfillState.completedAt": new Date(),
      },
      $unset: {
        "backfillState.runId": "",
      },
    },
  );
  // The COMPLETE transition that follows finds the status already completed
  // and changes nothing, so it never replaces an old failure's meta: a flow
  // whose backfill failed once kept that error for months of clean runs.
  // A live stream error keeps its meta (the consumer's self-heal reads it).
  await Flow.updateOne(
    {
      _id: new Types.ObjectId(params.flowId),
      workspaceId: new Types.ObjectId(params.workspaceId),
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
      await driver.executeQuery(destination, query);
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
      },
    });
  }
}
