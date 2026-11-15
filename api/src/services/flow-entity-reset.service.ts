/**
 * Per-entity destination resets for CDC flows: drop an entity's tables and
 * state and re-backfill it, or NULL one destination column (optionally
 * forcing a replay) and re-backfill that entity.
 *
 * Refusals are {@link FlowRequestError}s; the routes answer them as-is.
 */
import { Types } from "mongoose";
import { asSystem } from "../access/connection-writes";
import {
  CdcChangeEvent,
  CdcEntityState,
  DatabaseConnection,
  Flow,
  type IFlow,
} from "../database/workspace-schema";
import { databaseRegistry } from "../databases/registry";
import { cdcBackfillService } from "../sync-cdc/backfill";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import { cdcLiveTableName, cdcStageTableName } from "../sync-cdc/normalization";
import { buildColumnResetQuery } from "./flow-column-reset-sql";
import { invalidateDestinationCounts } from "./flow-destination-counts.service";
import { FlowRequestError } from "./flow-request-error";

/** The refusal message when a backfill cannot start, as a 400. */
async function assertCanStartBackfill(
  workspaceId: string,
  flowId: string,
): Promise<void> {
  try {
    await cdcBackfillService.assertCanStartBackfill(workspaceId, flowId);
  } catch (error) {
    throw new FlowRequestError(
      400,
      error instanceof Error ? error.message : "Execution still running",
    );
  }
}

/**
 * Drop the entity's destination tables (live, both staging shapes), clear its
 * CDC state and events, and start a backfill of just that entity.
 */
export async function resetFlowEntity(params: {
  workspaceId: string;
  flowId: string;
  flow: Pick<IFlow, "syncEngine" | "tableDestination">;
  entity: string;
}): Promise<{ runId: string }> {
  const { workspaceId, flowId, flow, entity } = params;
  if (flow.syncEngine !== "cdc") {
    throw new FlowRequestError(400, "Entity reset requires syncEngine=cdc");
  }
  await assertCanStartBackfill(workspaceId, flowId);

  if (flow.tableDestination?.connectionId && flow.tableDestination?.schema) {
    const destination = await DatabaseConnection.findById(
      flow.tableDestination.connectionId,
    );
    if (destination) {
      const driver = databaseRegistry.getDriver(destination.type);
      if (driver?.dropTable) {
        const schema = flow.tableDestination.schema;
        const stageSchema = driver.getStagingSchema?.(schema) ?? schema;
        const liveTable = cdcLiveTableName(
          flow.tableDestination.tableName,
          entity,
          flowId,
        );
        const oldStageTable = cdcStageTableName(
          flow.tableDestination.tableName,
          entity,
          flowId,
        );
        const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
        const bulkStagingTable = `${liveTable}__${flowToken}__staging`;

        // The flow's own tables: dropped as Mako, like its syncs.
        const dropTable = driver.dropTable.bind(driver);
        await asSystem(async () => {
          await dropTable(destination, liveTable, { schema });
          await dropTable(destination, oldStageTable, {
            schema: stageSchema,
          });
          await dropTable(destination, `${liveTable}__stage_changes`, {
            schema: stageSchema,
          });
          await dropTable(destination, bulkStagingTable, { schema });
        });
      }
    }
  }

  const scope = {
    workspaceId: new Types.ObjectId(workspaceId),
    flowId: new Types.ObjectId(flowId),
    entity,
  };
  await CdcEntityState.deleteMany(scope);
  await CdcChangeEvent.deleteMany(scope);

  const tempCollectionName = `backfill_tmp_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
  await Flow.db
    .collection(tempCollectionName)
    .drop()
    .catch(() => undefined);

  invalidateDestinationCounts(workspaceId, flowId);

  const backfill = await cdcBackfillService.startBackfill(workspaceId, flowId, {
    entities: [entity],
  });
  return { runId: backfill.runId };
}

/**
 * NULL one destination column of an entity's live table and, unless told
 * not to, re-backfill the entity so the column is repopulated.
 */
export async function resetFlowColumn(params: {
  workspaceId: string;
  flowId: string;
  flow: Pick<IFlow, "_id" | "syncEngine" | "tableDestination"> &
    Parameters<typeof resolveConfiguredEntities>[0];
  entity: string;
  column: string;
  forceReplay: boolean;
  startBackfill: boolean;
}) {
  const { workspaceId, flowId, flow, entity, column } = params;
  const { forceReplay, startBackfill } = params;
  if (flow.syncEngine !== "cdc") {
    throw new FlowRequestError(400, "Column reset requires syncEngine=cdc");
  }
  if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
    throw new FlowRequestError(
      400,
      "Flow has no destination table configuration",
    );
  }

  const { entities: configuredEntities } = resolveConfiguredEntities(flow);
  if (configuredEntities.length > 0 && !configuredEntities.includes(entity)) {
    throw new FlowRequestError(
      400,
      `Entity '${entity}' is not enabled for this flow`,
    );
  }

  if (startBackfill) await assertCanStartBackfill(workspaceId, flowId);

  const destinationRaw = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  );
  if (!destinationRaw) {
    throw new FlowRequestError(404, "Destination connection not found");
  }
  const destinationDoc = destinationRaw.toObject();

  const destinationType = String(destinationDoc.type || "").toLowerCase();
  const projectId = (
    destinationDoc as { connection?: { project_id?: unknown } }
  ).connection?.project_id;
  const resetQuery = buildColumnResetQuery({
    destinationType,
    projectId: typeof projectId === "string" ? projectId.trim() : "",
    schema: flow.tableDestination.schema,
    tableName: cdcLiveTableName(
      flow.tableDestination.tableName,
      entity,
      String(flow._id),
    ),
    column,
    forceReplay,
  });

  if (!resetQuery) {
    throw new FlowRequestError(
      400,
      `Column reset is not supported for destination type '${destinationDoc.type}'`,
    );
  }

  const driver = databaseRegistry.getDriver(destinationType);
  if (!driver?.executeQuery) {
    throw new FlowRequestError(
      400,
      `No query driver available for destination type '${destinationDoc.type}'`,
    );
  }

  // The flow's own table: reset as Mako, like its syncs.
  const resetResult = await asSystem(() =>
    driver.executeQuery(destinationDoc, resetQuery),
  );
  if (!resetResult.success) {
    throw new FlowRequestError(
      400,
      typeof resetResult.error === "string"
        ? resetResult.error
        : "Failed to reset destination column",
    );
  }

  let backfillRunId: string | null = null;
  let reusedRunId = false;
  if (startBackfill) {
    try {
      const backfill = await cdcBackfillService.startBackfill(
        workspaceId,
        flowId,
        { entities: [entity] },
      );
      backfillRunId = backfill.runId;
      reusedRunId = backfill.reusedRunId;
    } catch (error) {
      throw new FlowRequestError(
        400,
        `Column reset applied but failed to start backfill: ${error instanceof Error ? error.message : String(error)}`,
        { data: { resetApplied: true, entity, column } },
      );
    }
  }

  return {
    resetApplied: true,
    entity,
    column,
    forceReplay,
    backfillStarted: startBackfill,
    runId: backfillRunId,
    reusedRunId,
  };
}
