/**
 * Resync a CDC flow from scratch (optionally dropping its destination tables),
 * or only a subset of its entities.
 */
import {
  bulkBufferName,
  bulkStagingSuffix,
} from "../../sync/sync-orchestrator";
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
import { openFlowDataDiff } from "../data-diff";
import { cdcLiveTableName, cdcStageTableName } from "../normalization";
import { assertRetainedWritesDrainedForResync } from "../bigquery-staged-intent";
import { withCdcResyncFence, type CdcResyncScope } from "../cdc-resync-fence";

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

  await withCdcEventReset(flow, { deleteDestination }, async drop => {
    await getCdcEventStore().deleteFlowEvents({ workspaceId, flowId });
    const eventScope = { workspaceId: workspaceObjectId, flowId: flowObjectId };
    await CdcEntityState.deleteMany(eventScope);
    await CdcStateTransition.deleteMany(eventScope);

    if (clearWebhookEvents) {
      await WebhookEvent.deleteMany({
        ...eventScope,
        // Mongo's null match includes inbox rows created before status was stored.
        status: { $in: ["pending", "processing", "completed", "failed", null] },
      });
    }

    await drop();
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
  });

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

export async function withCdcEventReset(
  flow: IFlow,
  options: { entities?: string[]; deleteDestination?: boolean },
  reset: (drop: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const plan = options.deleteDestination
    ? await prepareDestinationReset(flow, options.entities)
    : undefined;
  const scope = {
    workspaceId: String(flow.workspaceId),
    flowId: String(flow._id),
    entities: options.entities,
    tables: plan?.tables ?? [],
  };
  await withCdcResyncFence(
    scope,
    session => assertRetainedWritesDrainedForResync(scope, session),
    () =>
      reset(async () => {
        await plan?.drop();
      }),
  );
}

async function prepareDestinationReset(flow: IFlow, onlyEntities?: string[]) {
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
  const resetTables = enabledEntities.flatMap(entity => {
    const liveTable = cdcLiveTableName(tablePrefix, entity, flowId);
    const oldStageTables = [
      cdcStageTableName(tablePrefix, entity, flowId),
      `${liveTable}__stage_changes`,
    ];
    const bulkStagingTable = `${liveTable}__${flowToken}__staging`;
    const laneStagingTables = [true, false].map(
      fullRead => `${liveTable}__${flowToken}__${bulkStagingSuffix(fullRead)}`,
    );

    return [
      { dataset: schema, table: liveTable },
      ...oldStageTables.map(table => ({ dataset: stageSchema, table })),
      { dataset: schema, table: bulkStagingTable },
      ...laneStagingTables.map(table => ({ dataset: schema, table })),
    ];
  });
  const bigQuery = destination.type === "bigquery";
  const tables: CdcResyncScope["tables"] = [];
  if (bigQuery) {
    const connection = destination.connection as { project_id?: unknown };
    const project = connection?.project_id;
    if (typeof project !== "string" || !project.trim()) {
      throw new Error("BigQuery resync requires a destination project");
    }
    tables.push(...resetTables.map(table => ({ project, ...table })));
  }
  const dropTable = driver.dropTable.bind(driver);

  return {
    tables,
    drop: async () => {
      // Count what the tables hold before the refilling backfill.
      await openFlowDataDiff({
        flow,
        entities: enabledEntities,
        reasons: ["resync"],
      });
      for (const { dataset, table } of resetTables) {
        const result = await dropTable(destination, table, { schema: dataset });
        if (bigQuery && !result.success) {
          throw new Error("BigQuery resync could not verify a table drop");
        }
      }

      const db = Flow.db;
      for (const entity of enabledEntities) {
        for (const fullRead of [true, false]) {
          await db
            .collection(bulkBufferName(flowId, entity, fullRead))
            .drop()
            .catch(() => undefined);
        }
      }
      log.info("CDC destination tables dropped during resync", {
        flowId,
        entityCount: enabledEntities.length,
      });
    },
  };
}
