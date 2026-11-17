/**
 * Repartitioning an entity's destination table: pause the stream, rebuild the
 * table under its new layout, re-materialize, resume — plus the recovery of
 * repartitions a crash left half-done.
 */
import { Types } from "mongoose";
import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  IFlow,
} from "../../database/workspace-schema";
import { inngest } from "../../inngest/client";
import { loggers } from "../../logging";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import {
  buildCdcEntityLayout,
  resolveCdcDestinationAdapter,
  resolveEntityClustering,
  resolveEntityPartitioning,
} from "../adapters/registry";
import { getCdcEventStore } from "../event-store";
import { cdcLiveTableName } from "../normalization";

import { startBackfill } from "./lifecycle";
import { deleteDestinationTables } from "./resync";

const log = loggers.sync("cdc.backfill");

/** Resolve the in-place-repartition-capable adapter for a flow (or null). */
export function resolveRepartitionAdapter(
  flow: IFlow,
  destinationType: string,
) {
  const adapter = resolveCdcDestinationAdapter({
    destinationType,
    flowId: String(flow._id),
    destinationDatabaseId: String(flow.destinationDatabaseId),
    destinationDatabaseName: flow.destinationDatabaseName,
    tableDestination: {
      connectionId: String(flow.tableDestination?.connectionId),
      schema: flow.tableDestination?.schema || "public",
      tableName: flow.tableDestination?.tableName || "",
    },
  });
  return adapter.repartitionLiveTable ? adapter : null;
}

export async function setEntityRepartitionStatus(
  workspaceId: Types.ObjectId,
  flowId: Types.ObjectId,
  entity: string,
  repartition: {
    status: "pending" | "running" | "done" | "failed";
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
  },
): Promise<void> {
  await CdcEntityState.updateOne(
    { flowId, entity },
    { $set: { repartition }, $setOnInsert: { workspaceId, mode: "steady" } },
    { upsert: true },
  );
}

/**
 * Pause the flow stream for an in-place repartition. Returns the prior stream
 * state so the resume step can restore it. Tags the pause with a
 * `REPARTITION_PAUSE` marker so a stuck pause can be auto-recovered.
 */
export async function pauseStreamForRepartition(
  workspaceId: string,
  flowId: string,
): Promise<{ previousStreamState: string }> {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
  const previous =
    flow.streamState && flow.streamState !== "paused"
      ? flow.streamState
      : "idle";
  flow.streamState = "paused";
  flow.syncStateMeta = {
    ...(flow.syncStateMeta || {}),
    lastEvent: "REPARTITION_PAUSE",
    lastReason: "Paused for in-place repartition",
  };
  flow.syncStateUpdatedAt = new Date();
  await flow.save();
  log.info("Paused flow stream for repartition", { flowId, previous });
  return { previousStreamState: previous };
}

/** Resume the stream after repartition, restoring the prior state. */
export async function resumeStreamForRepartition(
  workspaceId: string,
  flowId: string,
  previousStreamState: string,
): Promise<void> {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) return;
  // Only resume our own pause — never clobber a pause set elsewhere.
  if (
    flow.streamState === "paused" &&
    flow.syncStateMeta?.lastEvent === "REPARTITION_PAUSE"
  ) {
    flow.streamState = (previousStreamState as IFlow["streamState"]) || "idle";
    flow.syncStateMeta = {
      ...(flow.syncStateMeta || {}),
      lastEvent: "REPARTITION_RESUME",
      lastReason: "Resumed after in-place repartition",
    };
    flow.syncStateUpdatedAt = new Date();
    await flow.save();
    log.info("Resumed flow stream after repartition", {
      flowId,
      restoredStreamState: flow.streamState,
    });
  }
}

/**
 * Repartition a single entity's destination table in place (copy + swap).
 * Updates the entity's `repartition` status. Returns the outcome so the job
 * can decide follow-up: `repartitioned` (done), `missing` (no table → create
 * via backfill), or `failed` (left as-is, surfaced for operator retry).
 */
export async function repartitionEntity(params: {
  workspaceId: string;
  flowId: string;
  entity: string;
}): Promise<{
  outcome: "repartitioned" | "missing" | "failed";
  error?: string;
}> {
  const { workspaceId, flowId, entity } = params;
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");

  if (!flow.tableDestination?.connectionId) {
    return { outcome: "missing" };
  }
  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  ).lean();
  const adapter = destination
    ? resolveRepartitionAdapter(flow, destination.type)
    : null;
  if (!adapter?.repartitionLiveTable) {
    // Unsupported destination (PostgreSQL/Mongo) — fall back to backfill.
    return { outcome: "missing" };
  }

  await setEntityRepartitionStatus(flow.workspaceId, flow._id, entity, {
    status: "running",
    startedAt: new Date(),
  });
  try {
    const layout = await buildEntityLayout(flow, entity);
    const result = await adapter.repartitionLiveTable(layout);
    if (result.repartitioned) {
      await setEntityRepartitionStatus(flow.workspaceId, flow._id, entity, {
        status: "done",
        completedAt: new Date(),
      });
      return { outcome: "repartitioned" };
    }
    // No existing table — clear status; the backfill path will create it.
    await CdcEntityState.updateOne(
      { flowId: flow._id, entity },
      { $unset: { repartition: "" } },
    );
    return { outcome: "missing" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("In-place repartition failed for entity", {
      flowId,
      entity,
      error: message,
    });
    await setEntityRepartitionStatus(flow.workspaceId, flow._id, entity, {
      status: "failed",
      completedAt: new Date(),
      error: message.slice(0, 500),
    });
    return { outcome: "failed", error: message };
  }
}

/** Fan out materialization for entities that were repartitioned in place. */
export async function triggerEntityMaterialization(
  workspaceId: string,
  flowId: string,
  entities: string[],
): Promise<void> {
  for (const entity of entities) {
    await inngest.send({
      name: "cdc/materialize",
      data: { workspaceId, flowId, entity, force: true },
    });
  }
}

/**
 * Safety net: clear any repartition pause / running state for a flow (used by
 * the job's onFailure handler and the stale-pause sweeper). Marks still-running
 * entities as failed and resumes the stream.
 */
export async function recoverRepartition(
  workspaceId: string,
  flowId: string,
): Promise<void> {
  await CdcEntityState.updateMany(
    {
      flowId: new Types.ObjectId(flowId),
      "repartition.status": { $in: ["pending", "running"] },
    },
    {
      $set: {
        "repartition.status": "failed",
        "repartition.completedAt": new Date(),
        "repartition.error": "Repartition job did not complete",
      },
    },
  );
  await resumeStreamForRepartition(workspaceId, flowId, "idle");
}

/**
 * Resume flows stuck in a repartition pause for longer than the threshold
 * (e.g. the job's process died before its resume step ran). Called from the
 * CDC materialize scheduler.
 */
export async function recoverStaleRepartitionPauses(
  olderThanMs = 30 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stuck = await Flow.find({
    streamState: "paused",
    "syncStateMeta.lastEvent": "REPARTITION_PAUSE",
    syncStateUpdatedAt: { $lt: cutoff },
  })
    .select({ _id: 1, workspaceId: 1 })
    .lean();
  for (const flow of stuck) {
    await recoverRepartition(String(flow.workspaceId), String(flow._id));
  }
  if (stuck.length > 0) {
    log.warn("Recovered stale repartition pauses", { count: stuck.length });
  }
  return stuck.length;
}

/** Public entry: load the flow and backfill entities lacking a live table. */
export async function backfillMissingEntities(
  workspaceId: string,
  flowId: string,
  entities: string[],
  deleteDestination?: boolean,
): Promise<void> {
  if (entities.length === 0) return;
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!flow) throw new Error("Flow not found");
  await backfillEntitiesFallback(
    flow,
    workspaceId,
    flowId,
    entities,
    deleteDestination,
  );
}

/** Drop + clear + subset backfill for entities that can't be repartitioned. */
export async function backfillEntitiesFallback(
  flow: IFlow,
  workspaceId: string,
  flowId: string,
  entities: string[],
  deleteDestination?: boolean,
): Promise<void> {
  await getCdcEventStore().deleteFlowEvents({
    workspaceId,
    flowId,
    entities,
  });
  await CdcEntityState.deleteMany({
    workspaceId: new Types.ObjectId(workspaceId),
    flowId: new Types.ObjectId(flowId),
    entity: { $in: entities },
  });

  if (deleteDestination) {
    await deleteDestinationTables(flow, entities);
  }

  await startBackfill(workspaceId, flowId, {
    entities,
    reason: `Layout-change resync (backfill) for entities: ${entities.join(", ")}`,
  });
}

/** Resolve the CDC layout (table name, key columns, new partitioning). */
export async function buildEntityLayout(flow: IFlow, entity: string) {
  const entityLayout = (flow.entityLayouts || []).find(
    layout =>
      layout.entity === entity || layout.entity === entity.split(":")[0],
  );
  const tableName = cdcLiveTableName(
    flow.tableDestination?.tableName,
    entity,
    String(flow._id),
  );

  let keyColumns: string[] | undefined;
  if (flow.dataSourceId) {
    try {
      const ds = await sourceConnectionManager.getSourceConnection(
        String(flow.dataSourceId),
        String(flow.workspaceId),
      );
      const conn = ds ? await syncConnectorRegistry.getConnectorFor(ds) : null;
      const schema = conn ? await conn.resolveSchema(entity) : null;
      keyColumns = schema?.keyColumns;
    } catch {
      log.warn("Schema resolution failed for repartition key columns", {
        entity,
        flowId: String(flow._id),
      });
    }
  }

  return buildCdcEntityLayout({
    entity,
    tableName,
    keyColumns,
    deleteMode: flow.deleteMode,
    partitioning: resolveEntityPartitioning(
      entityLayout,
      flow.tableDestination?.partitioning,
    ),
    clustering: resolveEntityClustering(
      entityLayout,
      flow.tableDestination?.clustering,
    ),
  });
}
