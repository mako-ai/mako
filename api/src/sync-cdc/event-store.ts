import * as crypto from "crypto";
import { Types } from "mongoose";
import {
  CdcChangeEvent,
  Flow,
  ICdcChangeEvent,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  sanitizeBackfillPayloadForIdempotency,
  stableStringify,
} from "./normalization";
import type {
  CdcAppendEntitySummary,
  CdcAppendResult,
  CdcEventInput,
  CdcEventSource,
  CdcEventStore,
  CdcMaterializationStatus,
  CdcStoredEvent,
} from "./events";

const log = loggers.sync("cdc.event-store");

type DuplicateErrorInfo = {
  duplicateCount: number;
  writeErrorCount: number;
  duplicateOnly: boolean;
};

function scopeIdempotencyKey(flowId: Types.ObjectId, key: string): string {
  return `flow:${String(flowId)}:${key}`;
}

function buildIdempotencyKey(
  input: CdcEventInput,
  payload: Record<string, unknown>,
  sourceTs: Date,
  flowId: Types.ObjectId,
): string {
  if (input.idempotencyKey) {
    return scopeIdempotencyKey(flowId, input.idempotencyKey);
  }

  const payloadForHash =
    input.source === "backfill"
      ? sanitizeBackfillPayloadForIdempotency(payload)
      : payload;

  const payloadHash = crypto
    .createHash("sha1")
    .update(stableStringify(payloadForHash))
    .digest("hex");

  const rawKey = [
    input.source,
    input.entity,
    input.recordId,
    input.operation,
    sourceTs.toISOString(),
    payloadHash,
  ].join(":");

  return scopeIdempotencyKey(flowId, rawKey);
}

async function reserveIngestSeqRange(
  flowId: Types.ObjectId,
  count: number,
): Promise<number> {
  const counters = Flow.db.collection("cdc_counters");
  const result = await counters.findOneAndUpdate(
    { flowId: new Types.ObjectId(flowId) },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: "after" },
  );
  const end = Number(result?.seq || 0);
  return end - count + 1;
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

function extractDuplicateErrorInfo(error: unknown): DuplicateErrorInfo {
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

function normalizeSource(input: CdcEventInput): CdcEventSource {
  return input.source;
}

function normalizeIds(eventIds: string[]): Types.ObjectId[] {
  return eventIds
    .filter(id => Types.ObjectId.isValid(id))
    .map(id => new Types.ObjectId(id));
}

function toStoredEvent(
  doc: Pick<
    ICdcChangeEvent,
    | "workspaceId"
    | "flowId"
    | "runId"
    | "sourceKind"
    | "entity"
    | "recordId"
    | "op"
    | "sourceTs"
    | "ingestTs"
    | "ingestSeq"
    | "idempotencyKey"
    | "payload"
    | "webhookEventId"
    | "materializationStatus"
  > & {
    _id: Types.ObjectId;
  },
): CdcStoredEvent {
  return {
    id: String(doc._id),
    workspaceId: String(doc.workspaceId),
    flowId: String(doc.flowId),
    runId: doc.runId,
    source: doc.sourceKind,
    entity: doc.entity,
    recordId: doc.recordId,
    operation: doc.op,
    sourceTs: new Date(doc.sourceTs),
    ingestTs: new Date(doc.ingestTs),
    ingestSeq: Number(doc.ingestSeq),
    idempotencyKey: doc.idempotencyKey,
    payload: (doc.payload || undefined) as Record<string, unknown> | undefined,
    webhookEventId: doc.webhookEventId,
    materializationStatus: doc.materializationStatus,
  };
}

class MongoCdcEventStore implements CdcEventStore {
  async appendEvents(params: {
    workspaceId: string;
    flowId: string;
    events: CdcEventInput[];
  }): Promise<CdcAppendResult> {
    if (params.events.length === 0) {
      return { inserted: 0, deduped: 0, attempted: 0, entities: [] };
    }

    const workspaceObjectId = new Types.ObjectId(params.workspaceId);
    const flowObjectId = new Types.ObjectId(params.flowId);
    const seqStart = await reserveIngestSeqRange(
      flowObjectId,
      params.events.length,
    );
    let nextSeq = seqStart;
    const now = new Date();

    const docs: Omit<ICdcChangeEvent, "_id">[] = [];
    const byEntity = new Map<string, CdcAppendEntitySummary>();
    for (const event of params.events) {
      const payload = normalizePayloadKeys(event.payload);
      const sourceTs = resolveSourceTimestamp(payload, event.sourceTs);
      const ingestSeq = nextSeq++;
      docs.push({
        workspaceId: workspaceObjectId,
        flowId: flowObjectId,
        runId: event.runId,
        sourceKind: normalizeSource(event),
        entity: event.entity,
        recordId: event.recordId,
        op: event.operation,
        sourceTs,
        ingestTs: now,
        ingestSeq,
        idempotencyKey: buildIdempotencyKey(
          event,
          payload,
          sourceTs,
          flowObjectId,
        ),
        payload,
        webhookEventId: event.webhookEventId,
        stageStatus: "pending",
        stageAttemptCount: 0,
        materializationStatus: "pending",
        materializationAttemptCount: 0,
      } as Omit<ICdcChangeEvent, "_id">);

      const previous = byEntity.get(event.entity);
      byEntity.set(event.entity, {
        entity: event.entity,
        source:
          previous?.source === "backfill" || event.source === "backfill"
            ? "backfill"
            : "webhook",
        runId: event.runId ?? previous?.runId,
        lastIngestSeq: ingestSeq,
      });
    }

    let inserted = 0;
    let deduped = 0;
    try {
      const result = await CdcChangeEvent.insertMany(
        docs as unknown as ICdcChangeEvent[],
        { ordered: false },
      );
      inserted = result.length;
    } catch (error: unknown) {
      const duplicateInfo = extractDuplicateErrorInfo(error);
      deduped = duplicateInfo.duplicateCount;
      inserted = Math.max(docs.length - deduped, 0);
      if (!duplicateInfo.duplicateOnly) {
        throw error;
      }
    }

    return {
      inserted,
      deduped,
      attempted: docs.length,
      entities: Array.from(byEntity.values()),
    };
  }

  async readAfter(params: {
    flowId: string;
    entity: string;
    afterIngestSeq: number;
    limit: number;
  }): Promise<CdcStoredEvent[]> {
    const rows = await CdcChangeEvent.find({
      flowId: new Types.ObjectId(params.flowId),
      entity: params.entity,
      materializationStatus: "pending",
      ingestSeq: { $gt: Math.max(params.afterIngestSeq, 0) },
    })
      .sort({ ingestSeq: 1 })
      .limit(Math.max(params.limit, 1))
      .lean();

    return rows.map(row =>
      toStoredEvent(
        row as Pick<
          ICdcChangeEvent,
          | "workspaceId"
          | "flowId"
          | "runId"
          | "sourceKind"
          | "entity"
          | "recordId"
          | "op"
          | "sourceTs"
          | "ingestTs"
          | "ingestSeq"
          | "idempotencyKey"
          | "payload"
          | "webhookEventId"
          | "materializationStatus"
        > & {
          _id: Types.ObjectId;
        },
      ),
    );
  }

  async markEventsApplied(eventIds: string[]): Promise<void> {
    const ids = normalizeIds(eventIds);
    if (ids.length === 0) return;
    await CdcChangeEvent.updateMany(
      { _id: { $in: ids } },
      {
        $set: { materializationStatus: "applied", appliedAt: new Date() },
        $inc: { materializationAttemptCount: 1 },
        $unset: { materializationError: "" },
      },
    );
  }

  async markEventsFailed(params: {
    eventIds: string[];
    errorCode?: string;
    errorMessage: string;
  }): Promise<void> {
    const ids = normalizeIds(params.eventIds);
    if (ids.length === 0) return;
    await CdcChangeEvent.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          materializationStatus: "failed",
          materializationError: {
            message: params.errorMessage,
            code: params.errorCode || "MATERIALIZATION_FAILED",
          },
        },
        $inc: { materializationAttemptCount: 1 },
      },
    );
  }

  async markEventsDropped(params: {
    eventIds: string[];
    errorCode?: string;
    errorMessage: string;
  }): Promise<void> {
    const ids = normalizeIds(params.eventIds);
    if (ids.length === 0) return;
    await CdcChangeEvent.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          materializationStatus: "dropped",
          appliedAt: new Date(),
          materializationError: {
            message: params.errorMessage,
            code: params.errorCode || "DROPPED",
          },
        },
        $inc: { materializationAttemptCount: 1 },
      },
    );
  }

  async countEvents(params: {
    flowId: string;
    workspaceId?: string;
    entity?: string;
    source?: CdcEventSource;
    materializationStatus?: CdcMaterializationStatus;
  }): Promise<number> {
    const query: Record<string, unknown> = {
      flowId: new Types.ObjectId(params.flowId),
    };
    if (params.workspaceId) {
      query.workspaceId = new Types.ObjectId(params.workspaceId);
    }
    if (params.entity) {
      query.entity = params.entity;
    }
    if (params.source) {
      query.sourceKind = params.source;
    }
    if (params.materializationStatus) {
      query.materializationStatus = params.materializationStatus;
    }
    return CdcChangeEvent.countDocuments(query);
  }

  async countEventsByEntity(params: {
    flowId: string;
    workspaceId?: string;
    materializationStatus: CdcMaterializationStatus;
  }): Promise<Array<{ entity: string; count: number }>> {
    const query: Record<string, unknown> = {
      flowId: new Types.ObjectId(params.flowId),
      materializationStatus: params.materializationStatus,
    };
    if (params.workspaceId) {
      query.workspaceId = new Types.ObjectId(params.workspaceId);
    }

    const rows = await CdcChangeEvent.aggregate([
      { $match: query },
      { $group: { _id: "$entity", count: { $sum: 1 } } },
    ]);

    return rows.map(row => ({
      entity: String(row._id),
      count: Number(row.count || 0),
    }));
  }

  async findLatestEvent(params: {
    flowId: string;
    workspaceId?: string;
    source?: CdcEventSource;
  }): Promise<CdcStoredEvent | null> {
    const query: Record<string, unknown> = {
      flowId: new Types.ObjectId(params.flowId),
    };
    if (params.workspaceId) {
      query.workspaceId = new Types.ObjectId(params.workspaceId);
    }
    if (params.source) {
      query.sourceKind = params.source;
    }

    const row = await CdcChangeEvent.findOne(query)
      .sort({ ingestTs: -1 })
      .lean();
    if (!row) return null;
    return toStoredEvent(
      row as Pick<
        ICdcChangeEvent,
        | "workspaceId"
        | "flowId"
        | "runId"
        | "sourceKind"
        | "entity"
        | "recordId"
        | "op"
        | "sourceTs"
        | "ingestTs"
        | "ingestSeq"
        | "idempotencyKey"
        | "payload"
        | "webhookEventId"
        | "materializationStatus"
      > & {
        _id: Types.ObjectId;
      },
    );
  }

  async listRecentEvents(params: {
    flowId: string;
    workspaceId: string;
    limit: number;
  }): Promise<CdcStoredEvent[]> {
    const rows = await CdcChangeEvent.find({
      flowId: new Types.ObjectId(params.flowId),
      workspaceId: new Types.ObjectId(params.workspaceId),
    })
      .sort({ ingestSeq: -1 })
      .limit(Math.max(params.limit, 1))
      .lean();

    return rows.map(row =>
      toStoredEvent(
        row as Pick<
          ICdcChangeEvent,
          | "workspaceId"
          | "flowId"
          | "runId"
          | "sourceKind"
          | "entity"
          | "recordId"
          | "op"
          | "sourceTs"
          | "ingestTs"
          | "ingestSeq"
          | "idempotencyKey"
          | "payload"
          | "webhookEventId"
          | "materializationStatus"
        > & {
          _id: Types.ObjectId;
        },
      ),
    );
  }

  async resetFailedEvents(params: {
    workspaceId: string;
    flowId: string;
    entity?: string;
  }): Promise<{
    resetCount: number;
    entities: string[];
    webhookEventIds: string[];
  }> {
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
      materializationStatus: "failed",
    };
    if (params.entity) {
      query.entity = params.entity;
    }

    const failedDocs = await CdcChangeEvent.find(query)
      .select({ entity: 1, webhookEventId: 1 })
      .lean();
    if (failedDocs.length === 0) {
      return { resetCount: 0, entities: [], webhookEventIds: [] };
    }

    const entities = Array.from(
      new Set(failedDocs.map(doc => String(doc.entity))),
    );
    const webhookEventIds = Array.from(
      new Set(
        failedDocs
          .map(doc => doc.webhookEventId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const result = await CdcChangeEvent.updateMany(query, {
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

    return {
      resetCount: result.modifiedCount || 0,
      entities,
      webhookEventIds,
    };
  }

  async deleteFlowEvents(params: {
    workspaceId: string;
    flowId: string;
  }): Promise<number> {
    const result = await CdcChangeEvent.deleteMany({
      workspaceId: new Types.ObjectId(params.workspaceId),
      flowId: new Types.ObjectId(params.flowId),
    });
    return result.deletedCount || 0;
  }
}

let cachedStore: CdcEventStore | null = null;

export function getCdcEventStoreConfig(): { primary: "mongo" } {
  return { primary: "mongo" };
}

export function getCdcEventStore(): CdcEventStore {
  if (!cachedStore) {
    cachedStore = new MongoCdcEventStore();
    log.info("CDC event store initialized", {
      primary: "mongo",
    });
  }
  return cachedStore;
}
