/**
 * Lossless mappers and canonicalizers between MongoDB documents, Postgres rows,
 * and store-agnostic `usage_stats` domain records.
 */
import {
  isObjectIdHex,
  isUuidString,
  legacyUserIdToUuidv7,
  objectIdToUuid,
  optionalObjectIdToUuid,
  optionalToWireId,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import type {
  AppFeedSnapshotRow,
  AppUsageDailyRow,
  AppUsageEventRow,
  ConnectionVerificationRow,
  LlmUsageRow,
  QueryExecutionRow,
  SkillUsageDailyRow,
} from "../../database/pg/schema/usage-stats";
import type {
  AppFeedSnapshotRecord,
  AppUsageDailyRecord,
  AppUsageDayRowRecord,
  AppUsageEventRecord,
  AppUsageRollupRecord,
  ConnectionVerificationRecord,
  LlmUsageRecord,
  QueryExecutionRecord,
  SkillUsageDailyRecord,
} from "./types";

export const APP_FEED_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Convert a wire entity ID (24-hex ObjectId or 36-char UUID) to its Postgres UUID.
 */
export function entityIdToPgUuid(id: string): string {
  const parsed = parseEntityId(id);
  if (!parsed) {
    throw new Error(`Invalid entity ID: ${JSON.stringify(id)}`);
  }
  return parsed.uuid;
}

export function optionalEntityIdToPgUuid(
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return entityIdToPgUuid(id);
}

/** True for anonymous viewer prefixes (`anon:<hash>` or PostHog `ph:<hash>`). */
export function isAnonVisitorId(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("anon:") || value.startsWith("ph:"))
  );
}

/**
 * Split a viewer identity into `(pgUserId, pgAnonId, visitorKey)` per #34 §2.2:
 *   - Signed-in user (present in PG `users`): `user_id = uuid`, `anon_id = NULL`, `visitor_key = 'u:' || uuid`
 *   - Deleted/unresolvable user id (non-anon, non-empty): `user_id = NULL`, `anon_id = NULL`,
 *     `visitor_key = 'u:' || deterministic_uuid_or_id` (preserves unique-viewer dedupe without 23503 or 'anon' collision!)
 *   - Identified anon (`anon:<hash>` / `ph:<id>`): `user_id = NULL`, `anon_id = val`, `visitor_key = val`
 *   - Unattributed null viewer: `user_id = NULL`, `anon_id = NULL`, `visitor_key = 'anon'`
 */
export function buildPgDailyViewerColumns(params: {
  rawUserId: string | null | undefined;
  rawAnonId?: string | null | undefined;
  resolvedPgUserUuid: string | null;
}): {
  userId: string | null;
  anonId: string | null;
  visitorKey: string;
} {
  const rawUser = params.rawUserId?.trim() || null;
  const rawAnon = params.rawAnonId?.trim() || null;

  if (rawUser && isAnonVisitorId(rawUser)) {
    return { userId: null, anonId: rawUser, visitorKey: rawUser };
  }

  if (params.resolvedPgUserUuid) {
    const uuid = params.resolvedPgUserUuid.toLowerCase();
    return { userId: uuid, anonId: null, visitorKey: `u:${uuid}` };
  }

  if (rawUser) {
    // Non-anon viewer string whose user row was deleted (or is a synthetic test/legacy id):
    // keep `user_id = NULL` (satisfies FK) while keeping a distinct `u:` visitor_key.
    const stableKey = isUuidString(rawUser)
      ? rawUser.toLowerCase()
      : legacyUserIdToUuidv7(rawUser);
    return { userId: null, anonId: null, visitorKey: `u:${stableKey}` };
  }

  if (rawAnon) {
    return { userId: null, anonId: rawAnon, visitorKey: rawAnon };
  }

  return { userId: null, anonId: null, visitorKey: "anon" };
}

/**
 * Project PG `app_usage_daily.visitor_key` back to Mongo-compatible wire `userId`.
 */
export function visitorKeyToWireUserId(visitorKey: string): string | null {
  if (visitorKey === "anon") return null;
  if (visitorKey.startsWith("u:")) return visitorKey.slice(2);
  return visitorKey;
}

/**
 * Format a numeric USD value into a canonical Postgres `numeric(14, 8)` string.
 */
export function costUsdToPgNumeric(costUsd: number): string {
  if (!Number.isFinite(costUsd)) return "0";
  // Clamp precision to 8 decimal places matching numeric(14, 8).
  return costUsd.toFixed(8);
}

export function pgNumericToNumber(
  value: string | number | null | undefined,
): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toWireStringId(value: { toString(): string } | string): string {
  return typeof value === "string" ? value : value.toString();
}

// ── Mongo -> Record mappers ──────────────────────────────────────────────────

export interface MongoAppUsageDailyLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  appId: string;
  userId?: string | null;
  day: string;
  opens?: number;
  activeSeconds?: number;
  sources?: { app?: number; share?: number; embed?: number };
  firstAt: Date | string;
  lastAt: Date | string;
}

export function mongoAppUsageDailyToRecord(
  doc: MongoAppUsageDailyLike,
): AppUsageDailyRecord {
  const sources: { app?: number; share?: number; embed?: number } = {};
  if (doc.sources?.app) sources.app = doc.sources.app;
  if (doc.sources?.share) sources.share = doc.sources.share;
  if (doc.sources?.embed) sources.embed = doc.sources.embed;
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    appId: doc.appId,
    userId: doc.userId ?? null,
    day: doc.day,
    opens: doc.opens ?? 0,
    activeSeconds: doc.activeSeconds ?? 0,
    sources,
    firstAt: toDate(doc.firstAt),
    lastAt: toDate(doc.lastAt),
  };
}

export interface MongoAppUsageEventLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  appId: string;
  at: Date | string;
  kind: AppUsageEventRecord["kind"];
  source: AppUsageEventRecord["source"];
  userId?: string | null;
  anonId?: string | null;
  sessionId?: string | null;
  referrerKind?: AppUsageEventRecord["referrerKind"];
  uaClass: AppUsageEventRecord["uaClass"];
  throttled?: boolean;
  placement?: AppUsageEventRecord["placement"];
  backfill?: AppUsageEventRecord["backfill"];
}

export function mongoAppUsageEventToRecord(
  doc: MongoAppUsageEventLike,
): AppUsageEventRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    appId: doc.appId,
    at: toDate(doc.at),
    kind: doc.kind,
    source: doc.source,
    userId: doc.userId ?? null,
    anonId: doc.anonId ?? null,
    sessionId: doc.sessionId ?? null,
    ...(doc.referrerKind ? { referrerKind: doc.referrerKind } : {}),
    uaClass: doc.uaClass,
    ...(doc.throttled !== undefined ? { throttled: doc.throttled } : {}),
    ...(doc.placement ? { placement: doc.placement } : {}),
    ...(doc.backfill ? { backfill: doc.backfill } : {}),
  };
}

export interface MongoAppFeedSnapshotLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  userId?: string | null;
  popular?: string[];
  fresh?: string[];
  recommended?: string[];
  createdAt: Date | string;
}

export function mongoAppFeedSnapshotToRecord(
  doc: MongoAppFeedSnapshotLike,
): AppFeedSnapshotRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    userId: doc.userId ?? null,
    popular: doc.popular ?? [],
    fresh: doc.fresh ?? [],
    recommended: doc.recommended ?? [],
    createdAt: toDate(doc.createdAt),
  };
}

export interface MongoSkillUsageDailyLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  scope: SkillUsageDailyRecord["scope"];
  skill: string;
  source: SkillUsageDailyRecord["source"];
  day: string;
  loads?: number;
  resourceReads?: number;
  relevantHits?: number;
  firstAt: Date | string;
  lastAt: Date | string;
}

export function mongoSkillUsageDailyToRecord(
  doc: MongoSkillUsageDailyLike,
): SkillUsageDailyRecord {
  return {
    id: toWireStringId(doc._id),
    workspaceId: toWireStringId(doc.workspaceId),
    scope: doc.scope,
    skill: doc.skill,
    source: doc.source,
    day: doc.day,
    loads: doc.loads ?? 0,
    resourceReads: doc.resourceReads ?? 0,
    relevantHits: doc.relevantHits ?? 0,
    firstAt: toDate(doc.firstAt),
    lastAt: toDate(doc.lastAt),
  };
}

export interface MongoLlmUsageLike {
  _id: { toString(): string } | string;
  workspaceId: { toString(): string } | string;
  userId?: string | null;
  chatId?: { toString(): string } | string | null;
  invocationType: LlmUsageRecord["invocationType"];
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  steps?: LlmUsageRecord["steps"];
  agentId?: string;
  tags?: string[];
  durationMs?: number;
  workflowRun?: {
    workflowId: string;
    runId: string;
    step?: string;
    backfilled?: boolean;
  };
  createdAt: Date | string;
}

export function mongoLlmUsageToRecord(doc: MongoLlmUsageLike): LlmUsageRecord {
  const id = toWireStringId(doc._id);
  const chatId = doc.chatId ? toWireStringId(doc.chatId) : null;
  return {
    id,
    _id: id,
    workspaceId: toWireStringId(doc.workspaceId),
    userId: doc.userId ?? null,
    ...(chatId ? { chatId } : { chatId: null }),
    invocationType: doc.invocationType,
    modelId: doc.modelId,
    inputTokens: doc.inputTokens ?? 0,
    outputTokens: doc.outputTokens ?? 0,
    cacheReadTokens: doc.cacheReadTokens ?? 0,
    cacheWriteTokens: doc.cacheWriteTokens ?? 0,
    reasoningTokens: doc.reasoningTokens ?? 0,
    totalTokens: doc.totalTokens ?? 0,
    costUsd: doc.costUsd ?? 0,
    ...(doc.steps !== undefined ? { steps: doc.steps } : {}),
    ...(doc.agentId !== undefined ? { agentId: doc.agentId } : {}),
    ...(doc.tags !== undefined ? { tags: doc.tags } : {}),
    ...(doc.durationMs !== undefined ? { durationMs: doc.durationMs } : {}),
    ...(doc.workflowRun
      ? {
          workflowRun: {
            workflowId: doc.workflowRun.workflowId,
            runId: doc.workflowRun.runId,
            ...(doc.workflowRun.step !== undefined
              ? { step: doc.workflowRun.step }
              : {}),
            ...(doc.workflowRun.backfilled !== undefined
              ? { backfilled: doc.workflowRun.backfilled }
              : {}),
          },
        }
      : {}),
    createdAt: toDate(doc.createdAt),
  };
}

export interface MongoQueryExecutionLike {
  _id: { toString(): string } | string;
  executedAt: Date | string;
  userId?: string | null;
  apiKeyId?: { toString(): string } | string | null;
  workspaceId: { toString(): string } | string;
  connectionId: { toString(): string } | string;
  databaseName?: string;
  consoleId?: { toString(): string } | string | null;
  source: QueryExecutionRecord["source"];
  databaseType: string;
  queryLanguage: QueryExecutionRecord["queryLanguage"];
  status: QueryExecutionRecord["status"];
  executionTimeMs: number;
  rowCount?: number;
  errorType?: string;
  bytesScanned?: number;
}

export function mongoQueryExecutionToRecord(
  doc: MongoQueryExecutionLike,
): QueryExecutionRecord {
  const id = toWireStringId(doc._id);
  return {
    id,
    _id: id,
    executedAt: toDate(doc.executedAt),
    userId: doc.userId ?? null,
    ...(doc.apiKeyId ? { apiKeyId: toWireStringId(doc.apiKeyId) } : {}),
    workspaceId: toWireStringId(doc.workspaceId),
    connectionId: toWireStringId(doc.connectionId),
    ...(doc.databaseName !== undefined
      ? { databaseName: doc.databaseName }
      : {}),
    ...(doc.consoleId ? { consoleId: toWireStringId(doc.consoleId) } : {}),
    source: doc.source,
    databaseType: doc.databaseType,
    queryLanguage: doc.queryLanguage,
    status: doc.status,
    executionTimeMs: doc.executionTimeMs,
    ...(doc.rowCount !== undefined ? { rowCount: doc.rowCount } : {}),
    ...(doc.errorType !== undefined ? { errorType: doc.errorType } : {}),
    ...(doc.bytesScanned !== undefined
      ? { bytesScanned: doc.bytesScanned }
      : {}),
  };
}

export interface MongoConnectionVerificationLike {
  _id: { toString(): string } | string;
  verifiedAt: Date | string;
  userId?: string | null;
  workspaceId?: { toString(): string } | string | null;
  connectionId?: { toString(): string } | string | null;
  databaseType: string;
  trigger: ConnectionVerificationRecord["trigger"];
  success: boolean;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
}

export function mongoConnectionVerificationToRecord(
  doc: MongoConnectionVerificationLike,
): ConnectionVerificationRecord {
  return {
    id: toWireStringId(doc._id),
    verifiedAt: toDate(doc.verifiedAt),
    ...(doc.userId ? { userId: doc.userId } : {}),
    ...(doc.workspaceId
      ? { workspaceId: toWireStringId(doc.workspaceId) }
      : {}),
    ...(doc.connectionId
      ? { connectionId: toWireStringId(doc.connectionId) }
      : {}),
    databaseType: doc.databaseType,
    trigger: doc.trigger,
    success: doc.success,
    durationMs: doc.durationMs,
    ...(doc.errorClass !== undefined ? { errorClass: doc.errorClass } : {}),
    ...(doc.errorMessage !== undefined
      ? { errorMessage: doc.errorMessage }
      : {}),
  };
}

// ── PG Row -> Record mappers ─────────────────────────────────────────────────

export function pgAppUsageDailyToRecord(
  row: AppUsageDailyRow,
): AppUsageDailyRecord {
  const sources: { app?: number; share?: number; embed?: number } = {};
  if (row.sourcesApp) sources.app = row.sourcesApp;
  if (row.sourcesShare) sources.share = row.sourcesShare;
  if (row.sourcesEmbed) sources.embed = row.sourcesEmbed;
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    appId: toWireId(row.appId),
    userId: visitorKeyToWireUserId(row.visitorKey),
    day: row.day,
    opens: row.opens,
    activeSeconds: row.activeSeconds,
    sources,
    firstAt: toDate(row.firstAt),
    lastAt: toDate(row.lastAt),
  };
}

export function pgAppUsageDailyToDayRow(
  row: Pick<
    AppUsageDailyRow,
    "appId" | "visitorKey" | "day" | "opens" | "activeSeconds" | "lastAt"
  >,
): AppUsageDayRowRecord {
  return {
    appId: toWireId(row.appId),
    userId: visitorKeyToWireUserId(row.visitorKey),
    day: row.day,
    opens: row.opens,
    activeSeconds: row.activeSeconds,
    lastAt: toDate(row.lastAt),
  };
}

export function pgAppUsageEventToRecord(
  row: AppUsageEventRow,
): AppUsageEventRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    appId: toWireId(row.appId),
    at: toDate(row.at),
    kind: row.kind,
    source: row.source,
    userId: row.userId ? row.userId.toLowerCase() : null,
    anonId: row.anonId ?? null,
    sessionId: row.sessionId ?? null,
    ...(row.referrerKind ? { referrerKind: row.referrerKind } : {}),
    uaClass: row.uaClass,
    ...(row.throttled != null ? { throttled: row.throttled } : {}),
    ...(row.placement != null ? { placement: row.placement } : {}),
    ...(row.backfill != null ? { backfill: row.backfill } : {}),
  };
}

export function pgAppFeedSnapshotToRecord(
  row: AppFeedSnapshotRow,
): AppFeedSnapshotRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    userId: row.userId ? row.userId.toLowerCase() : null,
    popular: row.popular ?? [],
    fresh: row.fresh ?? [],
    recommended: row.recommended ?? [],
    createdAt: toDate(row.createdAt),
  };
}

export function pgSkillUsageDailyToRecord(
  row: SkillUsageDailyRow,
): SkillUsageDailyRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    scope: row.scope,
    skill: row.skill,
    source: row.source,
    day: row.day,
    loads: row.loads,
    resourceReads: row.resourceReads,
    relevantHits: row.relevantHits,
    firstAt: toDate(row.firstAt),
    lastAt: toDate(row.lastAt),
  };
}

export function pgLlmUsageToRecord(row: LlmUsageRow): LlmUsageRecord {
  const id = toWireId(row.id);
  const chatId = optionalToWireId(row.chatId);
  const hasWorkflow = row.workflowId != null && row.workflowRunId != null;
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    userId: row.userId ? row.userId.toLowerCase() : null,
    chatId,
    invocationType: row.invocationType,
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    costUsd: pgNumericToNumber(row.costUsd),
    ...(row.steps != null ? { steps: row.steps } : {}),
    ...(row.agentId != null ? { agentId: row.agentId } : {}),
    ...(row.tags != null ? { tags: row.tags } : {}),
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    ...(hasWorkflow
      ? {
          workflowRun: {
            workflowId: row.workflowId as string,
            runId: row.workflowRunId as string,
            ...(row.workflowStep != null ? { step: row.workflowStep } : {}),
            ...(row.workflowBackfilled != null
              ? { backfilled: row.workflowBackfilled }
              : {}),
          },
        }
      : {}),
    createdAt: toDate(row.createdAt),
  };
}

export function pgQueryExecutionToRecord(
  row: QueryExecutionRow,
): QueryExecutionRecord {
  const id = toWireId(row.id);
  const apiKeyId = optionalToWireId(row.apiKeyId);
  const consoleId = optionalToWireId(row.consoleId);
  return {
    id,
    _id: id,
    executedAt: toDate(row.executedAt),
    userId: row.userId ? row.userId.toLowerCase() : null,
    ...(apiKeyId ? { apiKeyId } : {}),
    workspaceId: toWireId(row.workspaceId),
    connectionId: toWireId(row.connectionId),
    ...(row.databaseName != null ? { databaseName: row.databaseName } : {}),
    ...(consoleId ? { consoleId } : {}),
    source: row.source,
    databaseType: row.databaseType,
    queryLanguage: row.queryLanguage,
    status: row.status,
    executionTimeMs: row.executionTimeMs,
    ...(row.rowCount != null ? { rowCount: row.rowCount } : {}),
    ...(row.errorType != null ? { errorType: row.errorType } : {}),
    ...(row.bytesScanned != null ? { bytesScanned: row.bytesScanned } : {}),
  };
}

export function pgConnectionVerificationToRecord(
  row: ConnectionVerificationRow,
): ConnectionVerificationRecord {
  const workspaceId = optionalToWireId(row.workspaceId);
  const connectionId = optionalToWireId(row.connectionId);
  return {
    id: toWireId(row.id),
    verifiedAt: toDate(row.verifiedAt),
    ...(row.userId ? { userId: row.userId.toLowerCase() } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(connectionId ? { connectionId } : {}),
    databaseType: row.databaseType,
    trigger: row.trigger,
    success: row.success,
    durationMs: row.durationMs,
    ...(row.errorClass != null ? { errorClass: row.errorClass } : {}),
    ...(row.errorMessage != null ? { errorMessage: row.errorMessage } : {}),
  };
}

// ── Canonicalizers for shadow-compare & verifier ─────────────────────────────

export function canonicalizeRollups(
  rollups: readonly AppUsageRollupRecord[],
): AppUsageRollupRecord[] {
  return [...rollups]
    .map(r => ({ ...r, days: [...r.days].sort() }))
    .sort((a, b) => {
      const appCmp = a.appId.localeCompare(b.appId);
      if (appCmp !== 0) return appCmp;
      return (a.userId ?? "").localeCompare(b.userId ?? "");
    });
}

export function canonicalizeDayRows(
  rows: readonly AppUsageDayRowRecord[],
): AppUsageDayRowRecord[] {
  return [...rows].sort((a, b) => {
    const dayCmp = a.day.localeCompare(b.day);
    if (dayCmp !== 0) return dayCmp;
    const appCmp = a.appId.localeCompare(b.appId);
    if (appCmp !== 0) return appCmp;
    return (a.userId ?? "").localeCompare(b.userId ?? "");
  });
}

export function canonicalizeAppUsageDailyForCompare(
  record: AppUsageDailyRecord,
): Record<string, unknown> {
  return {
    workspaceId: record.workspaceId,
    appId: record.appId,
    userId: record.userId,
    day: record.day,
    opens: record.opens,
    activeSeconds: record.activeSeconds,
    sourcesApp: record.sources.app ?? 0,
    sourcesShare: record.sources.share ?? 0,
    sourcesEmbed: record.sources.embed ?? 0,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
  };
}

export function canonicalizeSkillUsageDailyForCompare(
  record: SkillUsageDailyRecord,
): Record<string, unknown> {
  return {
    workspaceId: record.workspaceId,
    scope: record.scope,
    skill: record.skill,
    source: record.source,
    day: record.day,
    loads: record.loads,
    resourceReads: record.resourceReads,
    relevantHits: record.relevantHits,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
  };
}

export function wireOrObjectIdToPgUuid(id: string): string {
  return isObjectIdHex(id) ? objectIdToUuid(id) : entityIdToPgUuid(id);
}

export function optionalWireOrObjectIdToPgUuid(
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return isObjectIdHex(id)
    ? optionalObjectIdToUuid(id)
    : optionalEntityIdToPgUuid(id);
}
