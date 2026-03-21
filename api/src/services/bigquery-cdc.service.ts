import * as crypto from "crypto";
import { Types } from "mongoose";
import {
  BigQueryCdcState,
  BigQueryChangeEvent,
  Connector,
  DatabaseConnection,
  Flow,
  IBigQueryChangeEvent,
  IFlow,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  sanitizeBackfillPayloadForIdempotency as sanitizeBackfillPayload,
  selectLatestChangePerRecord as selectLatestPerRecord,
  stableStringify,
} from "../sync-cdc/normalization";

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

export function isBigQueryCdcEnabledForFlow(
  flow: Pick<IFlow, "_id" | "tableDestination" | "syncEngine">,
  destinationType?: string,
): boolean {
  if (!flow?.tableDestination?.connectionId) return false;
  if (flow.syncEngine !== "cdc") return false;
  return destinationType === "bigquery";
}

export function sanitizeBackfillPayloadForIdempotency(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeBackfillPayload(payload);
}

function scopeIdempotencyKey(flowId: Types.ObjectId, key: string): string {
  return `flow:${String(flowId)}:${key}`;
}

function buildIdempotencyKey(
  input: ChangeInput,
  flowId: Types.ObjectId,
): string {
  if (input.idempotencyKey) {
    return scopeIdempotencyKey(flowId, input.idempotencyKey);
  }
  const payloadForHash =
    input.sourceKind === "backfill"
      ? sanitizeBackfillPayloadForIdempotency(input.payload || {})
      : input.payload || {};
  const payloadHash = crypto
    .createHash("sha1")
    .update(stableStringify(payloadForHash))
    .digest("hex");
  const rawKey = [
    input.sourceKind,
    input.entity,
    input.recordId,
    input.op,
    input.sourceTs?.toISOString() || "na",
    payloadHash,
  ].join(":");
  return scopeIdempotencyKey(flowId, rawKey);
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
  const flow = await Flow.findById(params.flowId)
    .select({ syncState: 1, syncEngine: 1 })
    .lean();
  if (!flow || flow.syncEngine !== "cdc") return;
  if (flow.syncState === "paused") {
    log.info("Skip CDC materialization enqueue while paused", {
      flowId: String(params.flowId),
      entity: params.entity,
    });
    return;
  }

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

function toWriteErrors(raw: unknown): unknown[] {
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
    const payload = normalizePayloadKeys(change.payload);
    const sourceTs = resolveSourceTimestamp(payload, change.sourceTs);
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
      idempotencyKey: buildIdempotencyKey(
        {
          ...change,
          payload,
          sourceTs,
        },
        params.flowId,
      ),
      payload,
      webhookEventId: change.webhookEventId,
      stageStatus: "pending",
      stageAttemptCount: 0,
      materializationStatus: "pending",
      materializationAttemptCount: 0,
    } as Omit<IBigQueryChangeEvent, "_id">);
  }

  const lastIngestSeqByEntity = new Map<string, number>();
  for (const doc of docs) {
    const current = lastIngestSeqByEntity.get(doc.entity) || 0;
    if (doc.ingestSeq > current) {
      lastIngestSeqByEntity.set(doc.entity, doc.ingestSeq);
    }
  }

  let inserted = 0;
  let deduped = 0;
  try {
    const result = await BigQueryChangeEvent.insertMany(
      docs as unknown as IBigQueryChangeEvent[],
      {
        ordered: false,
      },
    );
    inserted = result.length;
  } catch (error: unknown) {
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
    const lastIngestSeq = lastIngestSeqByEntity.get(entity);
    if (lastIngestSeq === undefined) {
      log.warn("Skipping CDC state update: missing last ingest seq", {
        flowId: String(params.flowId),
        entity,
      });
      continue;
    }
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
  return selectLatestPerRecord(events);
}

export { materializeBigQueryEntity } from "./bigquery-cdc/materialization";

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

export async function mapBackfillRecordsToChanges(params: {
  flowId?: string;
  entity: string;
  records: Array<Record<string, unknown>>;
  runId?: string;
}): Promise<ChangeInput[]> {
  // Backward-compatible mapper kept for tests and legacy callers.
  // Runtime CDC ingestion should use cdcIngestService + source adapters.
  return params.records.map(record => {
    const payload = normalizePayloadKeys(record);
    const payloadForId = sanitizeBackfillPayloadForIdempotency(payload);
    const stableRecordHash = crypto
      .createHash("sha1")
      .update(stableStringify(payloadForId))
      .digest("hex");
    const recordId = String(
      payload.id ||
        payload._id ||
        `missing-id:${stableRecordHash.slice(0, 24)}`,
    );
    const sourceTs = resolveSourceTimestamp(payloadForId, new Date(0));
    const hash = crypto
      .createHash("sha1")
      .update(stableStringify(payloadForId))
      .digest("hex");
    return {
      entity: params.entity,
      recordId,
      op: "upsert",
      payload,
      sourceTs,
      sourceKind: "backfill",
      runId: params.runId,
      idempotencyKey: `backfill:${params.flowId ? `${params.flowId}:` : ""}${params.entity}:${recordId}:${sourceTs.toISOString()}:${hash}`,
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

  // Pull candidates that haven't been enqueued recently.
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
    .select({ _id: 1, syncEngine: 1, syncState: 1, tableDestination: 1 })
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
    if (!flow || flow.syncEngine !== "cdc") continue;
    if (flow.syncState === "paused") continue;
    if (!flow.tableDestination?.connectionId) continue;

    const pendingCount = await BigQueryChangeEvent.countDocuments({
      flowId: state.flowId,
      entity: state.entity,
      materializationStatus: "pending",
    });

    // Keep state backlog in sync even when no requeue is needed.
    if (state.backlogCount !== pendingCount) {
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

export async function retryFailedMaterializationForFlow(params: {
  workspaceId: string;
  flowId: string;
  entity?: string;
}) {
  const workspaceObjectId = new Types.ObjectId(params.workspaceId);
  const flowObjectId = new Types.ObjectId(params.flowId);
  const match: Record<string, unknown> = {
    workspaceId: workspaceObjectId,
    flowId: flowObjectId,
    materializationStatus: "failed",
  };
  if (params.entity) {
    match.entity = params.entity;
  }

  const failedDocs = await BigQueryChangeEvent.find(match)
    .select({ entity: 1, webhookEventId: 1 })
    .lean();
  if (failedDocs.length === 0) {
    return { resetCount: 0, entities: [] as string[] };
  }

  const entities = Array.from(new Set(failedDocs.map(doc => doc.entity)));
  const webhookEventIds = Array.from(
    new Set(
      failedDocs
        .map(doc => doc.webhookEventId)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const resetResult = await BigQueryChangeEvent.updateMany(match, {
    $set: {
      materializationStatus: "pending",
      stageStatus: "pending",
    },
    $unset: {
      materializationError: "",
      stageError: "",
      appliedAt: "",
      stagedAt: "",
    },
  });

  if (webhookEventIds.length > 0) {
    await (
      await import("../database/workspace-schema")
    ).WebhookEvent.updateMany(
      {
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
        eventId: { $in: webhookEventIds },
      },
      {
        $set: { applyStatus: "pending", status: "pending" },
        $unset: { applyError: "", error: "", processedAt: "" },
      },
    );
  }

  for (const entity of entities) {
    await maybeEnqueueMaterialization({
      workspaceId: workspaceObjectId,
      flowId: flowObjectId,
      entity,
      force: true,
    });
  }

  log.info("Retried failed CDC materialization rows", {
    flowId: params.flowId,
    entity: params.entity || null,
    resetCount: resetResult.modifiedCount,
    entityCount: entities.length,
  });

  return {
    resetCount: resetResult.modifiedCount || 0,
    entities,
  };
}

export async function recordMaterializationFailure(params: {
  flowId: string;
  entity: string;
  errorCode?: string;
  error: string;
}) {
  log.error("BigQuery CDC materialization failed", {
    flowId: params.flowId,
    entity: params.entity,
    errorCode: params.errorCode || "MATERIALIZATION_FAILED",
    error: params.error,
  });
}
