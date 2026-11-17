/**
 * Resync a CDC flow from scratch (optionally dropping its destination tables),
 * or only a subset of its entities.
 */
import { inWorkspace } from "../../utils/workspace-scope";
import { Types } from "mongoose";
import {
  CdcEntityState,
  CdcStateTransition,
  DatabaseConnection,
  Flow,
  IFlow,
  WebhookEvent,
} from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import { inngest } from "../../inngest/client";
import { loggers } from "../../logging";
import {
  normalizeEntityList,
  resolveConfiguredEntities,
} from "../entity-selection";
import { getCdcEventStore } from "../event-store";
import { cdcLiveTableName, cdcStageTableName } from "../normalization";

import { assertCanStartBackfill } from "./execution-guard";
import { startBackfill } from "./lifecycle";
import { drainPendingWebhookEvents } from "./webhook-maintenance";

const log = loggers.sync("cdc.backfill");

export async function resyncFlow(params: {
  workspaceId: string;
  flowId: string;
  deleteDestination?: boolean;
  clearWebhookEvents?: boolean;
}) {
  const { workspaceId, flowId, deleteDestination, clearWebhookEvents } = params;
  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const flowObjectId = new Types.ObjectId(flowId);

  const flow = await Flow.findOne({
    _id: flowObjectId,
    workspaceId: workspaceObjectId,
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Resync requires syncEngine=cdc");
  }

  await assertCanStartBackfill(workspaceId, flowId);

  await getCdcEventStore().deleteFlowEvents({ workspaceId, flowId });
  await CdcEntityState.deleteMany({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
  });
  await CdcStateTransition.deleteMany({
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
  });

  if (clearWebhookEvents) {
    await WebhookEvent.deleteMany({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    });
  }

  if (deleteDestination) {
    await deleteDestinationTables(flow);
  }

  flow.streamState = "idle";
  flow.syncStateUpdatedAt = new Date();
  flow.syncStateMeta = {
    lastEvent: "RESYNC",
    lastReason: "Operator initiated resync",
  };
  flow.backfillState = {
    status: "idle",
    runId: undefined,
    startedAt: undefined,
    completedAt: undefined,
  };
  await flow.save();

  await startBackfill(workspaceId, flowId);

  if (!clearWebhookEvents) {
    await drainPendingWebhookEvents(workspaceId, flowId, "resync");
  }
}

/**
 * Resync only a subset of a flow's entities. Used when a partition/cluster
 * layout change requires recreating just the affected destination tables —
 * unchanged entities keep their data and are not re-backfilled. Drops the
 * targeted tables, clears those entities' stored CDC events + per-entity
 * state, then triggers a subset backfill (`backfillEntities`).
 */
export async function resyncEntities(params: {
  workspaceId: string;
  flowId: string;
  entities: string[];
  deleteDestination?: boolean;
}): Promise<{ queued: string[] }> {
  const { workspaceId, flowId, deleteDestination } = params;
  const entities = normalizeEntityList(params.entities);
  if (entities.length === 0) {
    throw new Error("resyncEntities requires at least one entity");
  }

  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) {
    throw new Error("Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new Error("Resync requires syncEngine=cdc");
  }

  await assertCanStartBackfill(workspaceId, flowId);

  // Mark the target entities pending so the UI shows progress immediately,
  // then hand off to the background `cdc/repartition` job. The job rewrites
  // the partitioning/clustering in place (copy + swap, no source re-fetch)
  // per entity as durable steps — so a long copy on a large table can't time
  // out the request or leave the others unprocessed.
  await CdcEntityState.updateMany(
    { flowId: flow._id, entity: { $in: entities } },
    {
      $set: {
        "repartition.status": "pending",
        "repartition.startedAt": new Date(),
      },
      $unset: { "repartition.completedAt": "", "repartition.error": "" },
    },
  );

  await inngest.send({
    name: "cdc/repartition",
    data: {
      workspaceId,
      flowId,
      entities,
      deleteDestination: Boolean(deleteDestination),
    },
  });

  log.info("Enqueued cdc/repartition job", { flowId, entities });
  return { queued: entities };
}

export async function deleteDestinationTables(
  flow: Pick<
    IFlow,
    | "_id"
    | "workspaceId"
    | "tableDestination"
    | "destinationDatabaseId"
    | "entityLayouts"
  >,
  /** Restrict to these entities (omit to drop all configured entities). */
  onlyEntities?: string[],
) {
  if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
    return;
  }

  const destination = await DatabaseConnection.findOne(
    inWorkspace(flow.tableDestination.connectionId, flow.workspaceId),
  );
  if (!destination) {
    return;
  }

  const driver = databaseRegistry.getDriver(destination.type);
  if (!driver?.dropTable) {
    return;
  }

  const configuredEntities = resolveConfiguredEntities(flow).entities;
  const scopeSet =
    onlyEntities && onlyEntities.length > 0 ? new Set(onlyEntities) : null;
  const enabledEntities = scopeSet
    ? configuredEntities.filter(e => scopeSet.has(e))
    : configuredEntities;
  const tablePrefix = flow.tableDestination.tableName || "";
  const schema = flow.tableDestination.schema;
  const stageSchema = driver.getStagingSchema?.(schema) ?? schema;
  const flowId = flow._id.toString();

  const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  for (const entity of enabledEntities) {
    const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
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
