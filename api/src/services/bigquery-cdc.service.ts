import crypto from "crypto";
import { Types } from "mongoose";
import {
  BigQueryCdcState,
  BigQueryChangeEvent,
  Connector,
  DatabaseConnection,
  Flow,
  IBigQueryChangeEvent,
  IFlow,
  IWebhookEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { createDestinationWriter } from "./destination-writer.service";
import { inngest } from "../inngest/client";
import { getEntityTableName } from "../sync/sync-orchestrator";

const log = loggers.sync("bigquery-cdc");

type SourceKind = "webhook" | "backfill";
type ChangeOp = "upsert" | "delete";

type ChangeInput = {
  entity: string;
  recordId: string;
  op: ChangeOp;
  payload?: Record<string, unknown>;
  sourceTs?: Date;
  idempotencyKey?: string;
  runId?: string;
  sourceKind: SourceKind;
  webhookEventId?: string;
};

function getConfiguredEntities(
  flow: Pick<IFlow, "entityFilter" | "entityLayouts">,
): {
  entities: string[];
  hasExplicitSelection: boolean;
} {
  if (Array.isArray(flow.entityLayouts) && flow.entityLayouts.length > 0) {
    const entities = flow.entityLayouts
      .filter(
        (layout: any) =>
          layout &&
          layout.enabled !== false &&
          typeof layout.entity === "string" &&
          layout.entity.trim().length > 0,
      )
      .map((layout: any) => String(layout.entity).trim());
    return {
      entities: Array.from(new Set(entities)),
      hasExplicitSelection: true,
    };
  }

  if (Array.isArray(flow.entityFilter) && flow.entityFilter.length > 0) {
    const entities = flow.entityFilter
      .filter(
        (entity: string) =>
          typeof entity === "string" && entity.trim().length > 0,
      )
      .map(entity => entity.trim());
    return {
      entities: Array.from(new Set(entities)),
      hasExplicitSelection: true,
    };
  }

  return {
    entities: [],
    hasExplicitSelection: false,
  };
}

export function isBigQueryCdcEnabledForFlow(
  flow: Pick<IFlow, "_id" | "tableDestination">,
  destinationType?: string,
): boolean {
  if (!flow?.tableDestination?.connectionId) return false;
  return destinationType === "bigquery";
}

function normalizePayload(
  payload?: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload || {})) {
    normalized[key.replace(/\./g, "_")] = value;
  }
  return normalized;
}

function resolveSourceTs(
  payload?: Record<string, unknown>,
  fallback?: Date,
): Date {
  const candidates = [
    payload?.date_updated,
    payload?.updated_at,
    payload?.date_created,
    payload?.created_at,
    payload?.timestamp,
    payload?._syncedAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const d = value instanceof Date ? value : new Date(String(value));
    if (!isNaN(d.getTime())) return d;
  }
  return fallback || new Date();
}

function buildIdempotencyKey(input: ChangeInput): string {
  if (input.idempotencyKey) return input.idempotencyKey;
  const payloadHash = crypto
    .createHash("sha1")
    .update(JSON.stringify(input.payload || {}))
    .digest("hex");
  return [
    input.sourceKind,
    input.entity,
    input.recordId,
    input.op,
    input.sourceTs?.toISOString() || "na",
    payloadHash,
  ].join(":");
}

async function reserveIngestSeqRange(
  flowId: Types.ObjectId,
  count: number,
): Promise<number> {
  const counters = Flow.db.collection("bigquery_cdc_counters");
  const result = await counters.findOneAndUpdate(
    { flowId: new Types.ObjectId(flowId) },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: "after" },
  );
  const end = Number(result?.seq || 0);
  return end - count + 1;
}

async function upsertStateAfterIngest(params: {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  lastIngestSeq: number;
  sourceKind: SourceKind;
  runId?: string;
}) {
  const mergeIntervalSeconds =
    params.sourceKind === "backfill"
      ? Math.max(
          parseInt(
            process.env.BIGQUERY_CDC_BACKFILL_MERGE_INTERVAL_SECONDS || "900",
            10,
          ) || 900,
          60,
        )
      : Math.max(
          parseInt(
            process.env.BIGQUERY_CDC_STEADY_MERGE_INTERVAL_SECONDS || "60",
            10,
          ) || 60,
          10,
        );
  await BigQueryCdcState.updateOne(
    { flowId: params.flowId, entity: params.entity },
    {
      $set: {
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity: params.entity,
        mode: params.sourceKind === "backfill" ? "backfill" : "steady",
        runId: params.runId,
        mergeIntervalSeconds,
      },
      $max: { lastIngestSeq: params.lastIngestSeq },
    },
    { upsert: true },
  );
}

async function maybeEnqueueMaterialization(params: {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  force?: boolean;
}) {
  const state = await BigQueryCdcState.findOne({
    flowId: params.flowId,
    entity: params.entity,
  }).lean();
  const now = Date.now();
  const lastEnqueuedAt = state?.lastEnqueuedAt
    ? new Date(state.lastEnqueuedAt).getTime()
    : 0;
  const intervalMs = Math.max((state?.mergeIntervalSeconds || 60) * 1000, 1000);
  if (!params.force && now - lastEnqueuedAt < intervalMs) return;

  await BigQueryCdcState.updateOne(
    { flowId: params.flowId, entity: params.entity },
    { $set: { lastEnqueuedAt: new Date() } },
    { upsert: true },
  );

  await inngest.send({
    name: "bigquery/cdc.materialize",
    data: {
      workspaceId: String(params.workspaceId),
      flowId: String(params.flowId),
      entity: params.entity,
      force: Boolean(params.force),
    },
  });
}

function toWriteErrors(raw: unknown): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw instanceof Map) return Array.from(raw.values());
  if (typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>);
  }
  return [];
}

function isDuplicateKeyErrorLike(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    return /E11000 duplicate key/i.test(error);
  }
  if (typeof error !== "object") return false;

  const obj = error as Record<string, unknown>;
  const code = obj.code;
  if (typeof code === "number" && code === 11000) return true;

  const messageCandidates = [
    obj.message,
    obj.errmsg,
    (obj.err as Record<string, unknown> | undefined)?.message,
    (obj.err as Record<string, unknown> | undefined)?.errmsg,
  ].filter((value): value is string => typeof value === "string");

  return messageCandidates.some(message =>
    /E11000 duplicate key/i.test(message),
  );
}

function extractDuplicateErrorInfo(error: unknown): {
  duplicateCount: number;
  writeErrorCount: number;
  duplicateOnly: boolean;
} {
  const err = error as Record<string, unknown> | undefined;
  const writeErrors = toWriteErrors(
    err?.writeErrors ||
      (err?.result as Record<string, unknown> | undefined)?.writeErrors ||
      (
        (err?.result as Record<string, unknown> | undefined)?.result as
          | Record<string, unknown>
          | undefined
      )?.writeErrors ||
      (err?.errorResponse as Record<string, unknown> | undefined)
        ?.writeErrors ||
      (err?.cause as Record<string, unknown> | undefined)?.writeErrors,
  );

  if (writeErrors.length > 0) {
    const duplicateCount = writeErrors.filter(isDuplicateKeyErrorLike).length;
    return {
      duplicateCount,
      writeErrorCount: writeErrors.length,
      duplicateOnly: duplicateCount === writeErrors.length,
    };
  }

  const topLevelDuplicate =
    isDuplicateKeyErrorLike(error) ||
    isDuplicateKeyErrorLike((err?.cause as unknown) || undefined);

  return {
    duplicateCount: topLevelDuplicate ? 1 : 0,
    writeErrorCount: topLevelDuplicate ? 1 : 0,
    duplicateOnly: topLevelDuplicate,
  };
}

export async function appendBigQueryChangeEvents(params: {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  changes: ChangeInput[];
  enqueue?: boolean;
}): Promise<{ inserted: number; deduped: number }> {
  if (params.changes.length === 0) return { inserted: 0, deduped: 0 };

  const byEntity = new Map<string, ChangeInput[]>();
  for (const change of params.changes) {
    if (!byEntity.has(change.entity)) byEntity.set(change.entity, []);
    byEntity.get(change.entity)!.push(change);
  }

  const seqStart = await reserveIngestSeqRange(
    params.flowId,
    params.changes.length,
  );
  let nextSeq = seqStart;
  const now = new Date();

  const docs: Omit<IBigQueryChangeEvent, "_id">[] = [];
  for (const change of params.changes) {
    const payload = normalizePayload(change.payload);
    const sourceTs = resolveSourceTs(payload, change.sourceTs);
    docs.push({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      runId: change.runId,
      sourceKind: change.sourceKind,
      entity: change.entity,
      recordId: change.recordId,
      op: change.op,
      sourceTs,
      ingestTs: now,
      ingestSeq: nextSeq++,
      idempotencyKey: buildIdempotencyKey({
        ...change,
        payload,
        sourceTs,
      }),
      payload,
      webhookEventId: change.webhookEventId,
      stageStatus: "pending",
      stageAttemptCount: 0,
      materializationStatus: "pending",
      materializationAttemptCount: 0,
    } as Omit<IBigQueryChangeEvent, "_id">);
  }

  let inserted = 0;
  let deduped = 0;
  try {
    const result = await BigQueryChangeEvent.insertMany(docs as any, {
      ordered: false,
    });
    inserted = result.length;
  } catch (error: any) {
    const duplicateInfo = extractDuplicateErrorInfo(error);
    deduped = duplicateInfo.duplicateCount;
    inserted = Math.max(docs.length - deduped, 0);

    if (!duplicateInfo.duplicateOnly) {
      throw error;
    }

    if (deduped > 0) {
      log.warn("Deduped CDC change events due to duplicate idempotency keys", {
        flowId: String(params.flowId),
        workspaceId: String(params.workspaceId),
        deduped,
        attempted: docs.length,
      });
    }
  }

  for (const [entity, changes] of byEntity.entries()) {
    const lastIngestSeq = seqStart + changes.length - 1;
    const sourceKind = changes.some(c => c.sourceKind === "backfill")
      ? "backfill"
      : "webhook";
    const runId = changes.find(c => c.runId)?.runId;
    await upsertStateAfterIngest({
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity,
      lastIngestSeq,
      sourceKind,
      runId,
    });

    if (params.enqueue !== false) {
      await maybeEnqueueMaterialization({
        workspaceId: params.workspaceId,
        flowId: params.flowId,
        entity,
      });
    }
  }

  return { inserted, deduped };
}

type ComparableChange = {
  recordId: string;
  sourceTs: Date | string;
  ingestSeq: number;
};

export function selectLatestChangePerRecord<T extends ComparableChange>(
  events: T[],
): T[] {
  const latestByRecord = new Map<string, any>();
  for (const event of events) {
    const current = latestByRecord.get(event.recordId);
    if (!current) {
      latestByRecord.set(event.recordId, event);
      continue;
    }
    const currentTs = new Date(current.sourceTs).getTime();
    const nextTs = new Date(event.sourceTs).getTime();
    if (nextTs > currentTs) {
      latestByRecord.set(event.recordId, event);
      continue;
    }
    if (
      nextTs === currentTs &&
      Number(event.ingestSeq) > Number(current.ingestSeq)
    ) {
      latestByRecord.set(event.recordId, event);
    }
  }
  return Array.from(latestByRecord.values()) as T[];
}

async function stageChangeEventsToBigQuery(params: {
  flow: any;
  destinationDatabaseId: Types.ObjectId;
  destinationDatabaseName?: string;
  tableDestination: any;
  entity: string;
  events: any[];
}): Promise<void> {
  const entityTableName = getEntityTableName(
    params.tableDestination.tableName,
    params.entity,
  );
  const stageTableName = `${entityTableName}__stage_changes`;

  const writer = await createDestinationWriter(
    {
      destinationDatabaseId: params.destinationDatabaseId,
      destinationDatabaseName: params.destinationDatabaseName,
      tableDestination: {
        ...params.tableDestination,
        tableName: stageTableName,
      },
    },
    "bigquery-cdc",
  );

  const rows = params.events.map(event => ({
    ...(event.payload || {}),
    _mako_record_id: event.recordId,
    _mako_op: event.op,
    _mako_source_ts: event.sourceTs,
    _mako_ingest_seq: event.ingestSeq,
    _mako_ingest_ts: event.ingestTs,
    _mako_source_kind: event.sourceKind,
    _mako_run_id: event.runId || null,
    _mako_entity: event.entity,
    _mako_webhook_event_id: event.webhookEventId || null,
  }));

  const result = await writer.writeBatch(rows);
  if (!result.success) {
    throw new Error(result.error || "Failed to stage BigQuery CDC events");
  }
}

export async function materializeBigQueryEntity(params: {
  workspaceId: string;
  flowId: string;
  entity: string;
  maxEvents?: number;
}): Promise<{
  staged: number;
  applied: number;
  lastMaterializedSeq: number;
}> {
  const maxEvents = Math.max(params.maxEvents || 5000, 100);
  const flow = await Flow.findById(params.flowId).lean();
  if (!flow?.tableDestination?.connectionId) {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }
  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  ).lean();
  if (!destination || destination.type !== "bigquery") {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }

  const { entities: configuredEntities, hasExplicitSelection } =
    getConfiguredEntities(flow);
  const isEntityEnabled =
    !hasExplicitSelection || configuredEntities.includes(params.entity);

  const pending = await BigQueryChangeEvent.find({
    flowId: new Types.ObjectId(params.flowId),
    entity: params.entity,
    materializationStatus: "pending",
  })
    .sort({ ingestSeq: 1 })
    .limit(maxEvents)
    .lean();

  if (pending.length === 0) {
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
  }

  if (!isEntityEnabled) {
    await BigQueryChangeEvent.updateMany(
      { _id: { $in: pending.map(event => event._id) } },
      {
        $set: {
          materializationStatus: "applied",
          appliedAt: new Date(),
        },
        $inc: { materializationAttemptCount: 1 },
        $unset: { materializationError: "" },
      },
    );

    const webhookEventIds = pending
      .map(event => event.webhookEventId)
      .filter((id): id is string => Boolean(id));
    if (webhookEventIds.length > 0) {
      await (
        await import("../database/workspace-schema")
      ).WebhookEvent.updateMany(
        {
          flowId: new Types.ObjectId(params.flowId),
          eventId: { $in: webhookEventIds },
        },
        {
          $set: {
            applyStatus: "applied",
            appliedAt: new Date(),
            status: "completed",
            applyError: {
              code: "ENTITY_DISABLED",
              message: `Entity ${params.entity} is disabled or not selected in flow configuration`,
            },
          },
        },
      );
    }

    const lastMaterializedSeq = Number(
      pending[pending.length - 1]?.ingestSeq || 0,
    );
    const backlogCount = await BigQueryChangeEvent.countDocuments({
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
      materializationStatus: "pending",
    });
    await BigQueryCdcState.updateOne(
      { flowId: new Types.ObjectId(params.flowId), entity: params.entity },
      {
        $set: {
          workspaceId: new Types.ObjectId(params.workspaceId),
          flowId: new Types.ObjectId(params.flowId),
          entity: params.entity,
          lastMaterializedSeq,
          lastMaterializedAt: new Date(),
          backlogCount,
        },
      },
      { upsert: true },
    );

    log.warn("Discarded CDC events for disabled/unselected entity", {
      flowId: params.flowId,
      entity: params.entity,
      discarded: pending.length,
      backlogCount,
    });

    return {
      staged: pending.length,
      applied: pending.length,
      lastMaterializedSeq,
    };
  }

  await stageChangeEventsToBigQuery({
    flow,
    destinationDatabaseId: new Types.ObjectId(
      String(flow.destinationDatabaseId),
    ),
    destinationDatabaseName: flow.destinationDatabaseName,
    tableDestination: flow.tableDestination,
    entity: params.entity,
    events: pending,
  });

  await BigQueryChangeEvent.updateMany(
    { _id: { $in: pending.map(e => e._id) } },
    {
      $set: { stageStatus: "staged", stagedAt: new Date() },
      $inc: { stageAttemptCount: 1 },
      $unset: { stageError: "" },
    },
  );

  const latest = selectLatestChangePerRecord(pending);
  const entityTableName = getEntityTableName(
    flow.tableDestination.tableName,
    params.entity,
  );
  const writer = await createDestinationWriter(
    {
      destinationDatabaseId: new Types.ObjectId(
        String(flow.destinationDatabaseId),
      ),
      destinationDatabaseName: flow.destinationDatabaseName,
      tableDestination: {
        ...flow.tableDestination,
        tableName: entityTableName,
      },
    },
    "bigquery-cdc",
  );
  (writer as any).config.deleteMode = "soft";

  const rows = latest.map(event => {
    const payload = normalizePayload(event.payload || {});
    const sourceTs = resolveSourceTs(payload, new Date(event.sourceTs));
    return {
      ...payload,
      id: event.recordId,
      _mako_source_ts: sourceTs,
      _mako_ingest_seq: Number(event.ingestSeq),
      _mako_deleted_at: event.op === "delete" ? new Date() : null,
      is_deleted: event.op === "delete",
      deleted_at: event.op === "delete" ? new Date() : null,
    };
  });

  const write = await writer.writeBatch(rows, {
    keyColumns: ["id", "_dataSourceId"],
    conflictStrategy: "update",
  });
  if (!write.success) {
    await BigQueryChangeEvent.updateMany(
      { _id: { $in: pending.map(e => e._id) } },
      {
        $set: {
          materializationStatus: "failed",
          materializationError: {
            message: write.error || "Materialization write failed",
            code: "WRITE_FAILED",
          },
        },
        $inc: { materializationAttemptCount: 1 },
      },
    );
    throw new Error(write.error || "Failed to materialize BigQuery CDC batch");
  }

  await BigQueryChangeEvent.updateMany(
    { _id: { $in: pending.map(e => e._id) } },
    {
      $set: {
        materializationStatus: "applied",
        appliedAt: new Date(),
      },
      $inc: { materializationAttemptCount: 1 },
      $unset: { materializationError: "" },
    },
  );

  const webhookEventIds = pending
    .map(event => event.webhookEventId)
    .filter((id): id is string => Boolean(id));
  if (webhookEventIds.length > 0) {
    await (
      await import("../database/workspace-schema")
    ).WebhookEvent.updateMany(
      {
        flowId: new Types.ObjectId(params.flowId),
        eventId: { $in: webhookEventIds },
      },
      {
        $set: {
          applyStatus: "applied",
          appliedAt: new Date(),
          status: "completed",
        },
        $unset: { applyError: "" },
      },
    );
  }

  const lastMaterializedSeq = Number(
    pending[pending.length - 1]?.ingestSeq || 0,
  );
  const backlogCount = await BigQueryChangeEvent.countDocuments({
    flowId: new Types.ObjectId(params.flowId),
    entity: params.entity,
    materializationStatus: "pending",
  });

  await BigQueryCdcState.updateOne(
    { flowId: new Types.ObjectId(params.flowId), entity: params.entity },
    {
      $set: {
        workspaceId: new Types.ObjectId(params.workspaceId),
        flowId: new Types.ObjectId(params.flowId),
        entity: params.entity,
        lastMaterializedSeq,
        lastMaterializedAt: new Date(),
        backlogCount,
      },
    },
    { upsert: true },
  );

  return {
    staged: pending.length,
    applied: latest.length,
    lastMaterializedSeq,
  };
}

export async function markBackfillCompletedForFlow(params: {
  flowId: string;
  workspaceId: string;
}) {
  await BigQueryCdcState.updateMany(
    { flowId: new Types.ObjectId(params.flowId) },
    {
      $set: {
        mode: "steady",
        backfillCompletedAt: new Date(),
        mergeIntervalSeconds: Math.max(
          parseInt(
            process.env.BIGQUERY_CDC_STEADY_MERGE_INTERVAL_SECONDS || "60",
            10,
          ) || 60,
          10,
        ),
      },
      $unset: { runId: "" },
    },
  );

  const states = await BigQueryCdcState.find({
    flowId: new Types.ObjectId(params.flowId),
  })
    .select({ entity: 1 })
    .lean();
  for (const state of states) {
    await maybeEnqueueMaterialization({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      entity: state.entity,
      force: true,
    });
  }
}

export async function getBigQueryCdcFlowStats(params: {
  flowId: string;
}): Promise<{
  enabled: boolean;
  mode: "steady" | "backfill";
  entities: number;
  backlogCount: number;
  lagSeconds: number | null;
}> {
  const states = await BigQueryCdcState.find({
    flowId: new Types.ObjectId(params.flowId),
  }).lean();
  if (states.length === 0) {
    return {
      enabled: false,
      mode: "steady",
      entities: 0,
      backlogCount: 0,
      lagSeconds: null,
    };
  }
  const backlogCount = states.reduce(
    (sum, s) => sum + (s.backlogCount || 0),
    0,
  );
  const mode = states.some(s => s.mode === "backfill") ? "backfill" : "steady";
  const latestMaterializedAt = states
    .map(s => s.lastMaterializedAt)
    .filter(Boolean)
    .map(d => new Date(d as Date).getTime())
    .sort((a, b) => b - a)[0];
  const lagSeconds = latestMaterializedAt
    ? Math.max(Math.floor((Date.now() - latestMaterializedAt) / 1000), 0)
    : null;
  return {
    enabled: true,
    mode,
    entities: states.length,
    backlogCount,
    lagSeconds,
  };
}

export async function mapWebhookEventToChangeInput(params: {
  entity: string;
  operation: ChangeOp;
  recordId: string;
  payload: Record<string, unknown>;
  webhookEvent: Pick<IWebhookEvent, "eventId" | "receivedAt">;
}): Promise<ChangeInput> {
  const sourceTs = resolveSourceTs(
    params.payload,
    params.webhookEvent.receivedAt,
  );
  return {
    entity: params.entity,
    op: params.operation,
    recordId: params.recordId,
    payload: params.payload,
    sourceTs,
    sourceKind: "webhook",
    webhookEventId: params.webhookEvent.eventId,
    idempotencyKey: `webhook:${params.webhookEvent.eventId}:${params.entity}:${params.recordId}:${params.operation}`,
  };
}

export async function mapBackfillRecordsToChanges(params: {
  entity: string;
  records: Array<Record<string, unknown>>;
  runId?: string;
}): Promise<ChangeInput[]> {
  return params.records.map(record => {
    const payload = normalizePayload(record);
    const recordId = String(payload.id || payload._id || crypto.randomUUID());
    const sourceTs = resolveSourceTs(payload, new Date());
    const hash = crypto
      .createHash("sha1")
      .update(JSON.stringify(payload))
      .digest("hex");
    return {
      entity: params.entity,
      recordId,
      op: "upsert",
      payload,
      sourceTs,
      sourceKind: "backfill",
      runId: params.runId,
      idempotencyKey: `backfill:${params.entity}:${recordId}:${sourceTs.toISOString()}:${hash}`,
    };
  });
}

export async function resolveDestinationTypeForFlow(
  flow: Pick<IFlow, "tableDestination">,
): Promise<string | undefined> {
  if (!flow.tableDestination?.connectionId) return undefined;
  const destination = await DatabaseConnection.findById(
    flow.tableDestination.connectionId,
  )
    .select({ type: 1 })
    .lean();
  return destination?.type;
}

export async function resolveDataSourceForFlow(
  flow: Pick<IFlow, "dataSourceId">,
) {
  if (!flow.dataSourceId) return undefined;
  return Connector.findById(flow.dataSourceId)
    .select({ _id: 1, name: 1 })
    .lean();
}

export async function forceDrainBigQueryCdcFlow(params: {
  workspaceId: string;
  flowId: string;
}) {
  const states = await BigQueryCdcState.find({
    flowId: new Types.ObjectId(params.flowId),
  }).lean();
  for (const state of states) {
    await maybeEnqueueMaterialization({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      entity: state.entity,
      force: true,
    });
  }
}

export async function sweepStaleBigQueryCdcPending(params?: {
  staleSeconds?: number;
  maxEntities?: number;
}) {
  const staleSeconds = Math.max(params?.staleSeconds || 180, 30);
  const maxEntities = Math.max(params?.maxEntities || 25, 1);
  const staleThreshold = new Date(Date.now() - staleSeconds * 1000);

  const candidates = await BigQueryCdcState.find({
    $or: [
      { lastEnqueuedAt: { $exists: false } },
      { lastEnqueuedAt: null },
      { lastEnqueuedAt: { $lt: staleThreshold } },
    ],
  })
    .sort({ lastEnqueuedAt: 1 })
    .limit(maxEntities * 5)
    .lean();

  if (candidates.length === 0) {
    return {
      staleSeconds,
      scannedEntities: 0,
      reenqueuedEntities: 0,
      details: [] as Array<{
        flowId: string;
        entity: string;
        pendingCount: number;
      }>,
    };
  }

  const flowIds = Array.from(
    new Set(candidates.map(state => String(state.flowId))),
  ).map(id => new Types.ObjectId(id));

  const flows = await Flow.find({ _id: { $in: flowIds } })
    .select({ _id: 1, syncEngine: 1, tableDestination: 1 })
    .lean();
  const flowMap = new Map(flows.map(flow => [String(flow._id), flow]));

  let scannedEntities = 0;
  let reenqueuedEntities = 0;
  const details: Array<{
    flowId: string;
    entity: string;
    pendingCount: number;
  }> = [];

  for (const state of candidates) {
    if (reenqueuedEntities >= maxEntities) break;
    scannedEntities += 1;

    const flowId = String(state.flowId);
    const flow = flowMap.get(flowId);
    if (!flow || (flow as any).syncEngine !== "cdc") continue;
    if (!flow.tableDestination?.connectionId) continue;

    const pendingCount = await BigQueryChangeEvent.countDocuments({
      flowId: state.flowId,
      entity: state.entity,
      materializationStatus: "pending",
    });

    if ((state as any).backlogCount !== pendingCount) {
      await BigQueryCdcState.updateOne(
        { _id: state._id },
        { $set: { backlogCount: pendingCount } },
      );
    }

    if (pendingCount === 0) continue;

    await maybeEnqueueMaterialization({
      workspaceId: state.workspaceId,
      flowId: state.flowId,
      entity: state.entity,
      force: true,
    });
    reenqueuedEntities += 1;
    details.push({
      flowId,
      entity: state.entity,
      pendingCount,
    });
  }

  if (reenqueuedEntities > 0) {
    log.warn("Auto-reenqueued stale BigQuery CDC entities", {
      staleSeconds,
      scannedEntities,
      reenqueuedEntities,
      details,
    });
  }

  return {
    staleSeconds,
    scannedEntities,
    reenqueuedEntities,
    details,
  };
}

export async function recordMaterializationFailure(params: {
  flowId: string;
  entity: string;
  error: string;
}) {
  log.error("BigQuery CDC materialization failed", {
    flowId: params.flowId,
    entity: params.entity,
    error: params.error,
  });
}
