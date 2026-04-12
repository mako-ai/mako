/**
 * Destination table operations for CDC backfill lifecycle.
 *
 * Handles dropping destination tables during resync and cleaning up
 * orphan staging tables during recovery.
 */
import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  DatabaseConnection,
  Flow,
  type IFlow,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { databaseRegistry } from "../../databases/registry";
import { resolveConfiguredEntities } from "../entity-selection";
import { hasCdcDestinationAdapter } from "../adapters/registry";
import { BIGQUERY_WORKING_DATASET } from "../../utils/bigquery-working-dataset";
import { cdcLiveTableName, cdcStageTableName } from "../normalization";
import { inngest } from "../../inngest/client";
import { getCdcEventStore } from "../event-store";

const log = loggers.sync("cdc.backfill");

export async function deleteDestinationTables(
  flow: Pick<
    IFlow,
    "_id" | "tableDestination" | "destinationDatabaseId" | "entityLayouts"
  >,
) {
  if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
    return;
  }

  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  );
  if (!destination) return;

  const driver = databaseRegistry.getDriver(destination.type);
  if (!driver?.dropTable) return;

  const enabledEntities = resolveConfiguredEntities(flow).entities;
  const tablePrefix = flow.tableDestination.tableName || "";
  const schema = flow.tableDestination.schema;
  const stageSchema =
    destination.type === "bigquery" ? BIGQUERY_WORKING_DATASET : schema;
  const flowId = flow._id.toString();

  const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  for (const entity of enabledEntities) {
    const liveTable = cdcLiveTableName(tablePrefix, entity);
    const oldStageTables = [
      cdcStageTableName(tablePrefix, entity, flowId),
      `${liveTable}__stage_changes`,
    ];
    const bulkStagingTable = `${liveTable}__${flowToken}__staging`;
    const backfillStagingTable = `${liveTable}__${flowToken}__backfill_staging`;

    await driver.dropTable(destination, liveTable, { schema });
    for (const stageTable of oldStageTables) {
      await driver.dropTable(destination, stageTable, {
        schema: stageSchema,
      });
    }
    await driver.dropTable(destination, bulkStagingTable, { schema });
    await driver.dropTable(destination, backfillStagingTable, { schema });
  }

  const db = Flow.db;
  for (const entity of enabledEntities) {
    const collName = `backfill_tmp_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
    await db
      .collection(collName)
      .drop()
      .catch(() => undefined);
  }

  log.info("CDC destination tables dropped during resync", {
    flowId: flow._id.toString(),
    entityCount: enabledEntities.length,
  });
}

export async function cleanupOrphanStagingTables(
  flow: Pick<
    IFlow,
    "_id" | "tableDestination" | "destinationDatabaseId" | "entityLayouts"
  >,
): Promise<number> {
  try {
    if (
      !flow.tableDestination?.connectionId ||
      !flow.tableDestination?.schema
    ) {
      return 0;
    }
    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    );
    if (!destination || !hasCdcDestinationAdapter(destination.type)) return 0;

    const driver = databaseRegistry.getDriver(destination.type);
    if (!driver?.dropTable) return 0;

    const flowId = String(flow._id);
    const { entities: enabledEntities } = resolveConfiguredEntities(flow);
    const tablePrefix = flow.tableDestination.tableName || "";
    const schema = flow.tableDestination.schema;
    const stageSchema =
      destination.type === "bigquery" ? BIGQUERY_WORKING_DATASET : schema;
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    let dropped = 0;

    for (const entity of enabledEntities) {
      const liveTable = cdcLiveTableName(tablePrefix, entity);
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

  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  );
  if (!destination) return;

  const driver = databaseRegistry.getDriver(destination.type);
  if (!driver?.executeQuery) return;

  const enabledEntities = resolveConfiguredEntities(flow).entities;
  const tablePrefix = flow.tableDestination.tableName || "sync";
  const schema = flow.tableDestination.schema;

  for (const entity of enabledEntities) {
    const tableName = cdcLiveTableName(tablePrefix, entity);
    const fullTable =
      destination.type === "bigquery"
        ? `\`${schema}\`.${tableName}`
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

    const minPending = await CdcChangeEvent.findOne({
      flowId: new Types.ObjectId(params.flowId),
      entity: item.entity,
      materializationStatus: "pending",
    })
      .sort({ ingestSeq: 1 })
      .select({ ingestSeq: 1 })
      .lean();

    if (minPending) {
      const targetSeq = Math.max(
        0,
        (parseInt(String(minPending.ingestSeq), 10) || 0) - 1,
      );
      await CdcEntityState.updateOne(
        {
          flowId: new Types.ObjectId(params.flowId),
          entity: item.entity,
          lastMaterializedSeq: { $gt: targetSeq },
        },
        { $set: { lastMaterializedSeq: targetSeq } },
      );
    }

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
