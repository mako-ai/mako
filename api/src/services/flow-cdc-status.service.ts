/**
 * Read models for a CDC flow's observability endpoints: the unified status
 * (backlog, lag, failures, transitions per entity) and schema health (live
 * destination column types against the connector schema).
 */
import { inWorkspace } from "../utils/workspace-scope";
import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  DatabaseConnection,
  Flow,
  WebhookEvent,
} from "../database/workspace-schema";
import { mapLogicalTypeToBigQuery } from "../sync-cdc/adapters/bigquery";
import {
  computeEntityPendingBacklog,
  computeEntitySeqGap,
  computePendingLagSeconds,
} from "../sync-cdc/backlog";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import { cdcLiveTableName } from "../sync-cdc/normalization";
import { syncMachineService } from "../sync-cdc/sync-state";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { databaseConnectionService } from "./database-connection.service";
import { FlowRequestError } from "./flow-request-error";

/**
 * Unified CDC observability — one round of parallel queries (flow, entity
 * states, recent transitions, failure/pending/source aggregates). Replaces
 * the old /summary (11 queries) and /diagnostics (500-event scan).
 */
export async function getFlowCdcStatus(workspaceId: string, flowId: string) {
  const workspaceObjectId = new Types.ObjectId(workspaceId);
  const flowObjectId = new Types.ObjectId(flowId);

  const failedQuery = {
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
    materializationStatus: "failed" as const,
  };
  const [
    flow,
    states,
    transitions,
    failedRows,
    failedTotal,
    pendingByEntity,
    failedWebhookCount,
    webhookApplyPendingCount,
    cdcByStatus,
    cdcBySource,
  ] = await Promise.all([
    Flow.findOne({
      _id: flowObjectId,
      workspaceId: workspaceObjectId,
    }).lean(),
    CdcEntityState.find({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    })
      .sort({ entity: 1 })
      .lean(),
    CdcStateTransition.find({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
    })
      .sort({ at: -1 })
      .limit(20)
      .lean(),
    CdcChangeEvent.find(failedQuery)
      .sort({ ingestTs: -1 })
      .select({ entity: 1, materializationError: 1, ingestTs: 1 })
      .limit(200)
      .lean(),
    CdcChangeEvent.countDocuments(failedQuery),
    CdcChangeEvent.aggregate<{
      _id: string;
      count: number;
      oldestIngestTs: Date | null;
    }>([
      {
        $match: {
          flowId: flowObjectId,
          materializationStatus: "pending",
        },
      },
      {
        $group: {
          _id: "$entity",
          count: { $sum: 1 },
          oldestIngestTs: { $min: "$ingestTs" },
        },
      },
    ]),
    WebhookEvent.countDocuments({
      flowId: flowObjectId,
      workspaceId: workspaceObjectId,
      status: "failed",
    }),
    WebhookEvent.countDocuments({
      flowId: flowObjectId,
      workspaceId: workspaceObjectId,
      applyStatus: "pending",
    }),
    CdcChangeEvent.aggregate<{ _id: string; count: number }>([
      { $match: { flowId: flowObjectId } },
      { $group: { _id: "$materializationStatus", count: { $sum: 1 } } },
    ]),
    CdcChangeEvent.aggregate<{ _id: string; count: number }>([
      { $match: { flowId: flowObjectId } },
      { $group: { _id: "$sourceKind", count: { $sum: 1 } } },
    ]),
  ]);

  if (!flow) {
    throw new Error("Flow not found");
  }
  const { entities: configuredEntities } = resolveConfiguredEntities(
    flow as any,
  );
  const stateByEntity = new Map(
    states
      .filter(
        state => typeof state.entity === "string" && state.entity.length > 0,
      )
      .map(state => [state.entity, state] as const),
  );
  const uniqueEntities = Array.from(
    new Set([
      ...configuredEntities,
      ...states
        .map(state => (typeof state.entity === "string" ? state.entity : ""))
        .filter(Boolean),
    ]),
  );
  const failedByEntity = new Map<
    string,
    { count: number; latestAt: Date | null; latestError: any | null }
  >();
  for (const row of failedRows) {
    const entity =
      typeof (row as any).entity === "string" ? (row as any).entity : "";
    if (!entity) continue;
    const existing = failedByEntity.get(entity) || {
      count: 0,
      latestAt: null,
      latestError: null,
    };
    existing.count += 1;
    if (!existing.latestAt) {
      existing.latestAt = (row as any).ingestTs
        ? new Date((row as any).ingestTs)
        : null;
      existing.latestError = (row as any).materializationError || null;
    }
    failedByEntity.set(entity, existing);
  }

  const pendingCountMap = new Map(pendingByEntity.map(r => [r._id, r.count]));
  const pendingOldestTsMap = new Map(
    pendingByEntity.flatMap(r =>
      r.oldestIngestTs ? [[r._id, new Date(r.oldestIngestTs)] as const] : [],
    ),
  );

  const entities = uniqueEntities.map(entity => {
    const state = stateByEntity.get(entity);
    const lastMaterializedAt = state?.lastMaterializedAt
      ? new Date(state.lastMaterializedAt)
      : null;
    const lifetimeEventsProcessed =
      typeof (state as any)?.lifetimeEventsProcessed === "number"
        ? (state as any).lifetimeEventsProcessed
        : 0;
    const lifetimeRowsApplied =
      typeof (state as any)?.lifetimeRowsApplied === "number"
        ? (state as any).lifetimeRowsApplied
        : 0;
    const backfillDone =
      state?.backfillCompletedAt != null ||
      (state?.backfillCursor as any)?.hasMore === false;
    const ingestSeq = state?.lastIngestSeq || 0;
    const materializedSeq = state?.lastMaterializedSeq || 0;
    // Real pending rows only — never inflate with ingest/materialized seq
    // gap (Recover/Reprocess used to rewind the cursor and make the gap
    // look like hundreds of thousands of "pending" events).
    const backlogCount = computeEntityPendingBacklog(
      pendingCountMap.get(entity) || 0,
    );
    const seqGap = computeEntitySeqGap(ingestSeq, materializedSeq);
    const oldestPendingTs = pendingOldestTsMap.get(entity) ?? null;
    return {
      entity,
      lastIngestSeq: ingestSeq,
      lastMaterializedSeq: materializedSeq,
      backlogCount,
      seqGap,
      lagSeconds: computePendingLagSeconds({
        pendingCount: backlogCount,
        oldestPendingTs,
      }),
      lastMaterializedAt,
      destinationRowCount: (state as any)?.destinationRowCount ?? null,
      lifetimeEventsProcessed,
      lifetimeRowsApplied,
      backfillDone,
      failedCount: failedByEntity.get(entity)?.count || 0,
      lastFailedAt: failedByEntity.get(entity)?.latestAt || null,
      lastFailedError: failedByEntity.get(entity)?.latestError || null,
      repartition: (state as any)?.repartition?.status
        ? {
            status: (state as any).repartition.status as
              "pending" | "running" | "done" | "failed",
            error: (state as any).repartition.error ?? null,
          }
        : null,
    };
  });

  const totalBacklog = entities.reduce((sum, e) => sum + e.backlogCount, 0);
  const materializedDates = entities
    .map(e => e.lastMaterializedAt)
    .filter((d): d is Date => d instanceof Date);
  const oldestPendingTs = Array.from(pendingOldestTsMap.values()).sort(
    (a, b) => a.getTime() - b.getTime(),
  )[0];
  const lagSeconds = computePendingLagSeconds({
    pendingCount: totalBacklog,
    oldestPendingTs,
  });

  let backfillStatus = flow.backfillState?.status || "idle";
  if (
    backfillStatus === "paused" &&
    entities.length > 0 &&
    entities.every(e => e.backfillDone)
  ) {
    try {
      await syncMachineService.applyBackfillTransition({
        workspaceId,
        flowId,
        event: {
          type: "COMPLETE",
          reason: "All entities completed (auto-healed from paused)",
        },
        context: { backfillCursorExhausted: true },
      });
      backfillStatus = "completed";
    } catch {
      /* ignore guard failures */
    }
  }

  const lastError =
    flow.syncStateMeta?.lastErrorMessage || flow.syncStateMeta?.lastErrorCode
      ? {
          message: flow.syncStateMeta.lastErrorMessage || null,
          code: flow.syncStateMeta.lastErrorCode || null,
          reason: flow.syncStateMeta.lastReason || null,
          event: flow.syncStateMeta.lastEvent || null,
        }
      : null;

  const statusMap = new Map(cdcByStatus.map(r => [r._id, r.count]));
  const sourceMap = new Map(cdcBySource.map(r => [r._id, r.count]));

  return {
    syncState: flow.syncState ?? flow.streamState ?? "idle",
    streamState: flow.streamState || "idle",
    backfillStatus,
    consecutiveFailures: flow.backfillState?.consecutiveFailures ?? 0,
    lastError,
    backlogCount: totalBacklog,
    // The UI "pending" counter must reflect real pending CdcChangeEvents
    // only — not cursor seq gaps (Recover rewind used to inflate those
    // into hundreds of thousands of fake "pending" events) and not the
    // raw WebhookEvent.applyStatus count (orphaned/deduped rows).
    webhookPendingCount: totalBacklog,
    // Raw applyStatus=pending count kept for diagnostics only.
    webhookApplyPendingCount,
    lagSeconds,
    lastMaterializedAt:
      materializedDates.sort((a, b) => b.getTime() - a.getTime())[0] || null,
    entities,
    failedMaterialization: {
      total: failedTotal,
      latest:
        failedRows.length > 0
          ? {
              entity: (failedRows[0] as any).entity || null,
              at: (failedRows[0] as any).ingestTs || null,
              error: (failedRows[0] as any).materializationError || null,
            }
          : null,
    },
    failedWebhookCount,
    pipeline: {
      cdcEventsByStatus: {
        pending: statusMap.get("pending") || 0,
        applied: statusMap.get("applied") || 0,
        failed: statusMap.get("failed") || 0,
        dropped: statusMap.get("dropped") || 0,
      },
      cdcEventsBySource: {
        webhook: sourceMap.get("webhook") || 0,
        backfill: sourceMap.get("backfill") || 0,
      },
      materializationBacklog: totalBacklog,
      lagSeconds,
    },
    transitions: transitions.map(t => ({
      machine: t.machine,
      fromState: t.fromState,
      event: t.event,
      toState: t.toState,
      at: t.at,
      reason: t.reason,
    })),
  };
}

/** Compare live destination column types against the connector schema. */
export async function getFlowSchemaHealth(
  workspaceId: string,
  flowId: string,
  entityFilter: string | undefined,
) {
  const flow = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean();
  if (!flow) {
    throw new FlowRequestError(404, "Flow not found");
  }
  if (flow.syncEngine !== "cdc") {
    throw new FlowRequestError(400, "Schema health requires syncEngine=cdc");
  }
  if (!flow.tableDestination?.connectionId || !flow.tableDestination?.schema) {
    throw new FlowRequestError(
      400,
      "Flow has no destination table configuration",
    );
  }

  const destination = await DatabaseConnection.findOne(
    inWorkspace(flow.tableDestination.connectionId, flow.workspaceId),
  );
  if (!destination) {
    throw new FlowRequestError(404, "Destination connection not found");
  }

  if (destination.type !== "bigquery") {
    throw new FlowRequestError(
      400,
      "Schema health is currently only supported for BigQuery destinations",
    );
  }

  const { entities: configuredEntities } = resolveConfiguredEntities(
    flow as any,
  );
  const targetEntities = entityFilter
    ? configuredEntities.filter(e => e === entityFilter)
    : configuredEntities;

  if (targetEntities.length === 0) {
    return { entities: [], hasDrift: false };
  }

  const connectorSchema: Map<
    string,
    Record<string, { type: string }>
  > = new Map();
  if (flow.dataSourceId) {
    try {
      const ds = await sourceConnectionManager.getSourceConnection(
        String(flow.dataSourceId),
        String(flow.workspaceId),
      );
      if (ds) {
        const connector = await syncConnectorRegistry.getConnectorFor(ds);
        if (connector?.resolveSchema) {
          for (const entity of targetEntities) {
            try {
              const schema = await connector.resolveSchema(entity);
              if (schema?.fields) {
                connectorSchema.set(entity, schema.fields as any);
              }
            } catch {
              // skip entities where schema resolution fails
            }
          }
        }
      }
    } catch {
      // connector resolution failed — return empty schema health
    }
  }

  const schema = flow.tableDestination.schema;
  const conn = (destination as any).connection || {};
  const connLocation: string | undefined = conn.location;
  const results: Array<{
    entity: string;
    columns: Array<{
      column: string;
      liveType: string;
      expectedType: string;
      status: "match" | "drift";
    }>;
    hasDrift: boolean;
  }> = [];
  let globalHasDrift = false;

  for (const entity of targetEntities) {
    const fields = connectorSchema.get(entity);
    if (!fields) {
      results.push({ entity, columns: [], hasDrift: false });
      continue;
    }

    const liveTable = cdcLiveTableName(
      flow.tableDestination.tableName,
      entity,
      flowId,
    );

    const infoQuery = `SELECT column_name, data_type FROM \`${schema}\`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${liveTable.replace(/'/g, "''")}'`;

    const infoResult = await databaseConnectionService.executeQuery(
      destination,
      infoQuery,
      { location: connLocation },
    );

    if (!infoResult.success || !Array.isArray(infoResult.data)) {
      results.push({ entity, columns: [], hasDrift: false });
      continue;
    }

    const liveTypes = new Map<string, string>();
    for (const row of infoResult.data as any[]) {
      liveTypes.set(row.column_name, row.data_type);
    }

    const columns: Array<{
      column: string;
      liveType: string;
      expectedType: string;
      status: "match" | "drift";
    }> = [];
    let entityHasDrift = false;

    for (const [col, fieldDef] of Object.entries(fields)) {
      const liveType = liveTypes.get(col);
      if (!liveType) continue;
      const expectedType = mapLogicalTypeToBigQuery((fieldDef as any).type);
      const status =
        liveType.toUpperCase() === expectedType.toUpperCase()
          ? ("match" as const)
          : ("drift" as const);
      if (status === "drift") entityHasDrift = true;
      columns.push({ column: col, liveType, expectedType, status });
    }

    if (entityHasDrift) globalHasDrift = true;
    results.push({ entity, columns, hasDrift: entityHasDrift });
  }

  return { entities: results, hasDrift: globalHasDrift };
}
