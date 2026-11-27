/**
 * Phase 2B (`usage_stats` domain) migration handlers:
 *   - Resumable MongoDB -> Postgres backfill (`usage_stats` + 6 per-table sub-domains)
 *       * `app_feed_snapshots` is intentionally EXCLUDED (24h ephemeral cursor; Stage 4 uses 24h PG->Mongo read-fallback).
 *       * `app_usage_daily` & `skill_usage_daily` scan strictly closed UTC days (`isClosedUtcDay`)
 *         and upsert with `GREATEST(...)` so live `$inc` counters never double-count.
 *   - Single rollover-day reconciliation helper (`reconcileUsageRolloverDay`) for Stage 2 00:05 UTC
 *     cutover and Stage 4->2 rollback.
 *   - Chunked parity verifier + `--repair` healer (`usage_stats` + 6 per-table sub-domains).
 *   - Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`).
 *   - Postgres batched TTL reaper rules:
 *       * `app_feed_snapshots`       (24h on `created_at`)
 *       * `query_executions`         (90d on `executed_at`)
 *       * `connection_verifications` (90d on `verified_at`)
 *       * `app_usage_events`         (400d on `at`)
 *       * `skill_usage_daily`        (400d on `last_at`)
 *       * NEVER registers `llm_usage` or `app_usage_daily`!
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Types } from "mongoose";
import { LlmUsage } from "../../database/schema";
import {
  AppFeedSnapshot,
  AppUsageDaily,
  AppUsageEvent,
  ConnectionVerification,
  QueryExecution,
  SkillUsageDaily,
} from "../../database/workspace-schema";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import { databaseConnections } from "../../database/pg/schema/connections";
import {
  workspaceApiKeys,
  workspaces,
} from "../../database/pg/schema/workspaces";
import {
  appFeedSnapshots,
  appUsageDaily,
  appUsageEvents,
  connectionVerifications,
  llmUsage,
  queryExecutions,
  skillUsageDaily,
} from "../../database/pg/schema/usage-stats";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import {
  MongoUsageStatsRepository,
  PgUsageStatsRepository,
  USAGE_STATS_DOMAIN,
  USAGE_STATS_SHADOW_OPTIONS,
  buildPgDailyViewerColumns,
  canonicalizeAppUsageDailyForCompare,
  canonicalizeSkillUsageDailyForCompare,
  costUsdToPgNumeric,
  entityIdToPgUuid,
  isAnonVisitorId,
  mongoAppFeedSnapshotToRecord,
  mongoAppUsageDailyToRecord,
  mongoAppUsageEventToRecord,
  mongoConnectionVerificationToRecord,
  mongoLlmUsageToRecord,
  mongoQueryExecutionToRecord,
  mongoSkillUsageDailyToRecord,
  optionalEntityIdToPgUuid,
  pgAppFeedSnapshotToRecord,
  pgAppUsageDailyToRecord,
  pgAppUsageEventToRecord,
  pgConnectionVerificationToRecord,
  pgLlmUsageToRecord,
  pgQueryExecutionToRecord,
  pgSkillUsageDailyToRecord,
  type AppUsageDailyRecord,
  type AppUsageEventKind,
  type AppUsageEventRecord,
  type AppUsageEventSource,
  type ConnectionVerificationRecord,
  type LlmUsageRecord,
  type MongoAppFeedSnapshotLike,
  type MongoAppUsageDailyLike,
  type MongoAppUsageEventLike,
  type MongoConnectionVerificationLike,
  type MongoLlmUsageLike,
  type MongoQueryExecutionLike,
  type MongoSkillUsageDailyLike,
  type QueryExecutionRecord,
  type SkillUsageBumpKind,
  type SkillUsageDailyRecord,
  type SkillUsageScopePg,
  type SkillUsageSourcePg,
} from "../../repositories/usage-stats";
import {
  currentUtcDay,
  isClosedUtcDay,
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import {
  chunkRows,
  chunkValues,
  dedupByKey,
  groupContiguous,
  prefetchPgUserUuidMap,
} from "../bulk-helpers";
import { registerTtlRule } from "../ttl-reaper";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

export type UsageStatsBackfilledTable =
  | "app_usage_daily"
  | "app_usage_events"
  | "skill_usage_daily"
  | "llm_usage"
  | "query_executions"
  | "connection_verifications";

interface UsageStageMeta {
  stage: number;
  table: UsageStatsBackfilledTable;
  collection: string;
}

const USAGE_STAGES: readonly UsageStageMeta[] = [
  { stage: 1, table: "app_usage_daily", collection: "app_usage_daily" },
  { stage: 2, table: "app_usage_events", collection: "app_usage_events" },
  { stage: 3, table: "skill_usage_daily", collection: "skill_usage_daily" },
  { stage: 4, table: "llm_usage", collection: "llmusages" },
  { stage: 5, table: "query_executions", collection: "query_executions" },
  {
    stage: 6,
    table: "connection_verifications",
    collection: "connection_verifications",
  },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_TTL_RULES = [
  {
    tableName: "app_feed_snapshots",
    timestampColumn: "created_at",
    olderThanMs: 1 * DAY_MS,
  },
  {
    tableName: "query_executions",
    timestampColumn: "executed_at",
    olderThanMs: 90 * DAY_MS,
  },
  {
    tableName: "connection_verifications",
    timestampColumn: "verified_at",
    olderThanMs: 90 * DAY_MS,
  },
  {
    tableName: "app_usage_events",
    timestampColumn: "at",
    olderThanMs: 400 * DAY_MS,
  },
  {
    tableName: "skill_usage_daily",
    timestampColumn: "last_at",
    olderThanMs: 400 * DAY_MS,
  },
] as const;

type UsageBackfillDoc =
  | {
      table: "app_usage_daily";
      record: AppUsageDailyRecord;
      resolvedUserUuid?: string | null;
    }
  | { table: "app_usage_events"; record: AppUsageEventRecord }
  | { table: "skill_usage_daily"; record: SkillUsageDailyRecord }
  | { table: "llm_usage"; record: LlmUsageRecord }
  | { table: "query_executions"; record: QueryExecutionRecord }
  | { table: "connection_verifications"; record: ConnectionVerificationRecord };

function encodeCursor(
  stage: number,
  table: UsageStatsBackfilledTable,
  mongoId: string,
): string {
  return `${stage}:${table}:${mongoId}`;
}

function decodeCursor(cursor: string | null): {
  stage: number;
  table: UsageStatsBackfilledTable;
  mongoId: string;
} | null {
  if (!cursor) return null;
  const match = /^([1-6]):([a-z_]+):(.*)$/.exec(cursor);
  if (!match) return null;
  return {
    stage: Number(match[1]),
    table: match[2] as UsageStatsBackfilledTable,
    mongoId: match[3],
  };
}

function encodeVerifierKey(
  table: UsageStatsBackfilledTable,
  pgEntityId: string,
): string {
  return `${table}:${pgEntityId}`;
}

function decodeVerifierKey(
  key: string,
): { table: UsageStatsBackfilledTable; pgEntityId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as UsageStatsBackfilledTable,
    pgEntityId: key.slice(idx + 1),
  };
}

function mongoWorkspaceObjectId(
  workspaceId: string | null,
): Types.ObjectId | null {
  if (!workspaceId) return null;
  const parsed = parseEntityId(workspaceId);
  if (!parsed?.oid) {
    throw new Error(
      `Invalid Mongo workspaceId for usage_stats backfill: ${JSON.stringify(workspaceId)}`,
    );
  }
  return new Types.ObjectId(parsed.oid);
}

function buildMongoFilter(
  afterId: string | null,
  workspaceId: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const filter: Record<string, unknown> = { ...extra };
  const wsOid = mongoWorkspaceObjectId(workspaceId);
  if (wsOid) filter.workspaceId = wsOid;
  if (afterId && isObjectIdHex(afterId)) {
    filter._id = { $gt: new Types.ObjectId(afterId) };
  }
  return filter;
}

async function resolvePgWorkspaceSet(
  db: MakoPgDb,
  workspaceWireIds: readonly string[],
): Promise<Set<string>> {
  const uuids = [
    ...new Set(
      workspaceWireIds
        .map(id => parseEntityId(id)?.uuid)
        .filter((u): u is string => Boolean(u)),
    ),
  ];
  const out = new Set<string>();
  if (uuids.length === 0) return out;
  for (const chunk of chunkValues(uuids)) {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.id, chunk));
    for (const r of rows) out.add(r.id.toLowerCase());
  }
  return out;
}

async function resolvePgUserMap(
  db: MakoPgDb,
  rawUserIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(rawUserIds.filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const uuidCandidates = unique.filter(isUuidString).map(u => u.toLowerCase());
  const where =
    uuidCandidates.length > 0
      ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, unique))
      : inArray(users.legacyId, unique);
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(where);
  for (const row of rows) {
    const pgId = row.id.toLowerCase();
    out.set(pgId, pgId);
    if (row.legacyId) out.set(row.legacyId, pgId);
  }
  return out;
}

function toMongoObjectId(id: string): Types.ObjectId {
  const parsed = parseEntityId(id);
  if (parsed?.oid) {
    return new Types.ObjectId(parsed.oid);
  }
  return new Types.ObjectId(id);
}

async function resolvePgApiKeySet(
  db: MakoPgDb,
  apiKeyWireIds: readonly (string | undefined)[],
): Promise<Set<string>> {
  const uuids = [
    ...new Set(
      apiKeyWireIds
        .map(id => (id ? parseEntityId(id)?.uuid : undefined))
        .filter((u): u is string => Boolean(u)),
    ),
  ];
  const out = new Set<string>();
  if (uuids.length === 0) return out;
  for (const chunk of chunkValues(uuids)) {
    const rows = await db
      .select({ id: workspaceApiKeys.id })
      .from(workspaceApiKeys)
      .where(inArray(workspaceApiKeys.id, chunk));
    for (const r of rows) out.add(r.id.toLowerCase());
  }
  return out;
}

async function resolvePgConnectionSet(
  db: MakoPgDb,
  connectionWireIds: readonly (string | undefined)[],
): Promise<Set<string>> {
  const uuids = [
    ...new Set(
      connectionWireIds
        .map(id => (id ? parseEntityId(id)?.uuid : undefined))
        .filter((u): u is string => Boolean(u)),
    ),
  ];
  const out = new Set<string>();
  if (uuids.length === 0) return out;
  for (const chunk of chunkValues(uuids)) {
    const rows = await db
      .select({ id: databaseConnections.id })
      .from(databaseConnections)
      .where(inArray(databaseConnections.id, chunk));
    for (const r of rows) out.add(r.id.toLowerCase());
  }
  return out;
}

async function buildPgUuidToMongoUserIdMap(
  db: MakoPgDb,
  rawIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const uuids = [
    ...new Set(
      rawIds
        .filter((v): v is string => typeof v === "string" && isUuidString(v))
        .map(v => v.toLowerCase()),
    ),
  ];
  const out = new Map<string, string>();
  if (uuids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(inArray(users.id, uuids));
  for (const row of rows) {
    if (row.legacyId) {
      out.set(row.id.toLowerCase(), row.legacyId);
    }
  }
  return out;
}

function toMongoUserId(
  raw: string | null | undefined,
  uuidToLegacy: ReadonlyMap<string, string>,
): string | null {
  if (!raw) return null;
  return uuidToLegacy.get(raw.toLowerCase()) ?? raw;
}

async function workspaceExistsInPg(
  db: MakoPgDb,
  workspaceId: string,
): Promise<boolean> {
  const parsed = parseEntityId(workspaceId);
  if (!parsed) return false;
  const found = await resolvePgWorkspaceSet(db, [parsed.uuid]);
  return found.has(parsed.uuid);
}

async function fetchStageItems(
  meta: UsageStageMeta,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
  composite: boolean,
  now: Date,
): Promise<Array<BackfillItem<UsageBackfillDoc>>> {
  if (limit <= 0) return [];
  const makeCursor = (mongoId: string) =>
    composite ? encodeCursor(meta.stage, meta.table, mongoId) : mongoId;
  const todayUtc = currentUtcDay(now);

  switch (meta.table) {
    case "app_usage_daily": {
      const docs = await AppUsageDaily.find(
        buildMongoFilter(afterId, workspaceId, { day: { $lt: todayUtc } }),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppUsageDailyLike[]>();
      return docs.map(doc => {
        const record = mongoAppUsageDailyToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_usage_daily",
          collectionName: meta.collection,
          doc: { table: "app_usage_daily", record },
        };
      });
    }

    case "app_usage_events": {
      const docs = await AppUsageEvent.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppUsageEventLike[]>();
      return docs.map(doc => {
        const record = mongoAppUsageEventToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_usage_events",
          collectionName: meta.collection,
          doc: { table: "app_usage_events", record },
        };
      });
    }

    case "skill_usage_daily": {
      const docs = await SkillUsageDaily.find(
        buildMongoFilter(afterId, workspaceId, { day: { $lt: todayUtc } }),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoSkillUsageDailyLike[]>();
      return docs.map(doc => {
        const record = mongoSkillUsageDailyToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "skill_usage_daily",
          collectionName: meta.collection,
          doc: { table: "skill_usage_daily", record },
        };
      });
    }

    case "llm_usage": {
      const docs = await LlmUsage.find(buildMongoFilter(afterId, workspaceId))
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoLlmUsageLike[]>();
      return docs.map(doc => {
        const record = mongoLlmUsageToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "llm_usage",
          collectionName: meta.collection,
          doc: { table: "llm_usage", record },
        };
      });
    }

    case "query_executions": {
      const docs = await QueryExecution.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoQueryExecutionLike[]>();
      return docs.map(doc => {
        const record = mongoQueryExecutionToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "query_executions",
          collectionName: meta.collection,
          doc: { table: "query_executions", record },
        };
      });
    }

    case "connection_verifications": {
      const docs = await ConnectionVerification.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoConnectionVerificationLike[]>();
      return docs.map(doc => {
        const record = mongoConnectionVerificationToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId ?? null,
          targetTable: "connection_verifications",
          collectionName: meta.collection,
          doc: { table: "connection_verifications", record },
        };
      });
    }
  }
}

async function validateUsageBackfillItem(
  item: BackfillItem<UsageBackfillDoc>,
  db: MakoPgDb,
  now: Date,
  workspaceCache: Map<string, boolean>,
): Promise<BackfillValidationResult> {
  const { doc } = item;
  if (!parseEntityId(doc.record.id)) {
    return {
      ok: false,
      reason: "invalid_entity_id",
      sanitizedPayload: { table: doc.table, id: doc.record.id },
    };
  }

  const checkWorkspace = async (wsId: string): Promise<boolean> => {
    const parsed = parseEntityId(wsId);
    if (!parsed) return false;
    const cached = workspaceCache.get(parsed.uuid);
    if (cached !== undefined) return cached;
    const found = await resolvePgWorkspaceSet(db, [parsed.uuid]);
    const exists = found.has(parsed.uuid);
    workspaceCache.set(parsed.uuid, exists);
    return exists;
  };

  switch (doc.table) {
    case "app_usage_daily": {
      if (!isClosedUtcDay(doc.record.day, now)) {
        return {
          ok: false,
          reason: "open_utc_day_skipped",
          sanitizedPayload: { table: doc.table, day: doc.record.day },
        };
      }
      if (!parseEntityId(doc.record.appId)) {
        return {
          ok: false,
          reason: "invalid_app_id",
          sanitizedPayload: { table: doc.table, appId: doc.record.appId },
        };
      }
      if (!(await checkWorkspace(doc.record.workspaceId))) {
        return {
          ok: false,
          reason: "orphaned_workspace_missing",
          sanitizedPayload: {
            table: doc.table,
            workspaceId: doc.record.workspaceId,
          },
        };
      }
      return { ok: true };
    }

    case "app_usage_events": {
      if (!parseEntityId(doc.record.appId)) {
        return {
          ok: false,
          reason: "invalid_app_id",
          sanitizedPayload: { table: doc.table, appId: doc.record.appId },
        };
      }
      if (!(await checkWorkspace(doc.record.workspaceId))) {
        return {
          ok: false,
          reason: "orphaned_workspace_missing",
          sanitizedPayload: {
            table: doc.table,
            workspaceId: doc.record.workspaceId,
          },
        };
      }
      return { ok: true };
    }

    case "skill_usage_daily": {
      if (!isClosedUtcDay(doc.record.day, now)) {
        return {
          ok: false,
          reason: "open_utc_day_skipped",
          sanitizedPayload: { table: doc.table, day: doc.record.day },
        };
      }
      if (!(await checkWorkspace(doc.record.workspaceId))) {
        return {
          ok: false,
          reason: "orphaned_workspace_missing",
          sanitizedPayload: {
            table: doc.table,
            workspaceId: doc.record.workspaceId,
          },
        };
      }
      return { ok: true };
    }

    case "llm_usage": {
      if (!parseEntityId(doc.record.workspaceId)) {
        return {
          ok: false,
          reason: "invalid_workspace_id",
          sanitizedPayload: {
            table: doc.table,
            workspaceId: doc.record.workspaceId,
          },
        };
      }
      return { ok: true };
    }

    case "query_executions": {
      if (!parseEntityId(doc.record.connectionId)) {
        return {
          ok: false,
          reason: "invalid_connection_id",
          sanitizedPayload: {
            table: doc.table,
            connectionId: doc.record.connectionId,
          },
        };
      }
      if (!(await checkWorkspace(doc.record.workspaceId))) {
        return {
          ok: false,
          reason: "orphaned_workspace_missing",
          sanitizedPayload: {
            table: doc.table,
            workspaceId: doc.record.workspaceId,
          },
        };
      }
      return { ok: true };
    }

    case "connection_verifications": {
      if (
        doc.record.workspaceId &&
        !(await checkWorkspace(doc.record.workspaceId))
      ) {
        // Nullable workspace_id (ON DELETE SET NULL): preserve telemetry with NULL workspaceId.
        doc.record.workspaceId = undefined;
      }
      return { ok: true };
    }
  }
}

const USAGE_SYSTEM_USER_SENTINELS = new Set([
  "",
  "system",
  "worker",
  "publish",
  "api-key",
  "scheduler",
  "app-chat",
]);

function resolveNullableUserFromMap(
  rawUserId: string | null | undefined,
  userMap: ReadonlyMap<string, string>,
): string | null {
  if (!rawUserId) return null;
  const trimmed = rawUserId.trim();
  const isAnon: boolean = isAnonVisitorId(trimmed);
  if (!trimmed || USAGE_SYSTEM_USER_SENTINELS.has(trimmed) || isAnon) {
    return null;
  }
  return userMap.get(trimmed) ?? userMap.get(trimmed.toLowerCase()) ?? null;
}

async function prepareUsageBatch(
  items: Array<BackfillItem<UsageBackfillDoc>>,
  db: MakoPgDb,
  workspaceCache: Map<string, boolean>,
): Promise<void> {
  const uuidsToCheck = new Set<string>();
  for (const { doc } of items) {
    if (doc.table === "llm_usage") continue;
    const wsId = doc.record.workspaceId;
    if (!wsId) continue;
    const parsed = parseEntityId(wsId);
    if (parsed && !workspaceCache.has(parsed.uuid)) {
      uuidsToCheck.add(parsed.uuid);
    }
  }
  if (uuidsToCheck.size === 0) return;
  const uuidList = [...uuidsToCheck];
  const found = await resolvePgWorkspaceSet(db, uuidList);
  for (const uuid of uuidList) {
    workspaceCache.set(uuid, found.has(uuid));
  }
}

async function upsertUsageBackfillItems(
  items: Array<BackfillItem<UsageBackfillDoc>>,
  db: MakoPgDb,
): Promise<number> {
  if (items.length === 0) return 0;

  const rawUserIds: string[] = [];
  const apiKeyIds: string[] = [];
  const connIds: string[] = [];
  for (const { doc } of items) {
    if ("userId" in doc.record && doc.record.userId) {
      const trimmed = doc.record.userId.trim();
      if (
        trimmed &&
        !USAGE_SYSTEM_USER_SENTINELS.has(trimmed) &&
        !isAnonVisitorId(trimmed)
      ) {
        rawUserIds.push(trimmed);
      }
    }
    if (doc.table === "query_executions" && doc.record.apiKeyId) {
      apiKeyIds.push(doc.record.apiKeyId);
    }
    if (doc.table === "connection_verifications" && doc.record.connectionId) {
      connIds.push(doc.record.connectionId);
    }
  }

  const [userMap, validApiKeyUuids, validConnectionUuids] = await Promise.all([
    prefetchPgUserUuidMap(db, rawUserIds),
    resolvePgApiKeySet(db, apiKeyIds),
    resolvePgConnectionSet(db, connIds),
  ]);

  let upserted = 0;

  for (const group of groupContiguous(items, item => item.doc.table)) {
    switch (group.key) {
      case "app_usage_daily": {
        const rows = dedupByKey(
          group.items.map(item => {
            const rec = (
              item.doc as Extract<
                UsageBackfillDoc,
                { table: "app_usage_daily" }
              >
            ).record;
            const resolvedUserUuid = resolveNullableUserFromMap(
              rec.userId,
              userMap,
            );
            const viewer = buildPgDailyViewerColumns({
              rawUserId: rec.userId,
              resolvedPgUserUuid: resolvedUserUuid,
            });
            return {
              id: entityIdToPgUuid(rec.id),
              workspaceId: entityIdToPgUuid(rec.workspaceId),
              appId: entityIdToPgUuid(rec.appId),
              userId: viewer.userId,
              anonId: viewer.anonId,
              visitorKey: viewer.visitorKey,
              day: rec.day,
              opens: rec.opens,
              activeSeconds: rec.activeSeconds,
              sourcesApp: rec.sources.app ?? 0,
              sourcesShare: rec.sources.share ?? 0,
              sourcesEmbed: rec.sources.embed ?? 0,
              firstAt: rec.firstAt,
              lastAt: rec.lastAt,
            };
          }),
          r => `${r.workspaceId}|${r.appId}|${r.visitorKey}|${r.day}`,
          (existing, incoming) => ({
            ...incoming,
            opens: Math.max(existing.opens, incoming.opens),
            activeSeconds: Math.max(
              existing.activeSeconds,
              incoming.activeSeconds,
            ),
            sourcesApp: Math.max(existing.sourcesApp, incoming.sourcesApp),
            sourcesShare: Math.max(
              existing.sourcesShare,
              incoming.sourcesShare,
            ),
            sourcesEmbed: Math.max(
              existing.sourcesEmbed,
              incoming.sourcesEmbed,
            ),
            firstAt:
              existing.firstAt.getTime() <= incoming.firstAt.getTime()
                ? existing.firstAt
                : incoming.firstAt,
            lastAt:
              existing.lastAt.getTime() >= incoming.lastAt.getTime()
                ? existing.lastAt
                : incoming.lastAt,
          }),
        );
        for (const chunk of chunkRows(rows, 14, 300)) {
          const written = await db
            .insert(appUsageDaily)
            .values(chunk)
            .onConflictDoUpdate({
              target: [
                appUsageDaily.workspaceId,
                appUsageDaily.appId,
                appUsageDaily.visitorKey,
                appUsageDaily.day,
              ],
              set: {
                id: sql`EXCLUDED."id"`,
                opens: sql`GREATEST(${appUsageDaily.opens}, EXCLUDED."opens")`,
                activeSeconds: sql`GREATEST(${appUsageDaily.activeSeconds}, EXCLUDED."active_seconds")`,
                sourcesApp: sql`GREATEST(${appUsageDaily.sourcesApp}, EXCLUDED."sources_app")`,
                sourcesShare: sql`GREATEST(${appUsageDaily.sourcesShare}, EXCLUDED."sources_share")`,
                sourcesEmbed: sql`GREATEST(${appUsageDaily.sourcesEmbed}, EXCLUDED."sources_embed")`,
                firstAt: sql`LEAST(${appUsageDaily.firstAt}, EXCLUDED."first_at")`,
                lastAt: sql`GREATEST(${appUsageDaily.lastAt}, EXCLUDED."last_at")`,
              },
            })
            .returning({ id: appUsageDaily.id });
          upserted += written.length;
        }
        break;
      }

      case "app_usage_events": {
        const rows = dedupByKey(
          group.items.map(item => {
            const rec = (
              item.doc as Extract<
                UsageBackfillDoc,
                { table: "app_usage_events" }
              >
            ).record;
            const resolvedUserUuid = resolveNullableUserFromMap(
              rec.userId,
              userMap,
            );
            const anonId = resolvedUserUuid
              ? null
              : isAnonVisitorId(rec.userId)
                ? rec.userId
                : (rec.anonId ?? null);
            return {
              id: entityIdToPgUuid(rec.id),
              workspaceId: entityIdToPgUuid(rec.workspaceId),
              appId: entityIdToPgUuid(rec.appId),
              at: rec.at,
              kind: rec.kind,
              source: rec.source,
              userId: resolvedUserUuid,
              anonId,
              sessionId: rec.sessionId ?? null,
              referrerKind: rec.referrerKind ?? null,
              uaClass: rec.uaClass,
              throttled: rec.throttled ?? null,
              placement: rec.placement ?? null,
              backfill: rec.backfill ?? null,
            } satisfies typeof appUsageEvents.$inferInsert;
          }),
          r => r.id,
          existing => existing,
        );
        for (const chunk of chunkRows(rows, 14, 350)) {
          await db
            .insert(appUsageEvents)
            .values(chunk)
            .onConflictDoNothing({ target: appUsageEvents.id });
        }
        upserted += group.items.length;
        break;
      }

      case "skill_usage_daily": {
        const rows = dedupByKey(
          group.items.map(item => {
            const rec = (
              item.doc as Extract<
                UsageBackfillDoc,
                { table: "skill_usage_daily" }
              >
            ).record;
            return {
              id: entityIdToPgUuid(rec.id),
              workspaceId: entityIdToPgUuid(rec.workspaceId),
              scope: rec.scope,
              skill: rec.skill,
              source: rec.source,
              day: rec.day,
              loads: rec.loads,
              resourceReads: rec.resourceReads,
              relevantHits: rec.relevantHits,
              firstAt: rec.firstAt,
              lastAt: rec.lastAt,
            };
          }),
          r => `${r.workspaceId}|${r.scope}|${r.skill}|${r.source}|${r.day}`,
          (existing, incoming) => ({
            ...incoming,
            loads: Math.max(existing.loads, incoming.loads),
            resourceReads: Math.max(
              existing.resourceReads,
              incoming.resourceReads,
            ),
            relevantHits: Math.max(
              existing.relevantHits,
              incoming.relevantHits,
            ),
            firstAt:
              existing.firstAt.getTime() <= incoming.firstAt.getTime()
                ? existing.firstAt
                : incoming.firstAt,
            lastAt:
              existing.lastAt.getTime() >= incoming.lastAt.getTime()
                ? existing.lastAt
                : incoming.lastAt,
          }),
        );
        for (const chunk of chunkRows(rows, 11, 350)) {
          const written = await db
            .insert(skillUsageDaily)
            .values(chunk)
            .onConflictDoUpdate({
              target: [
                skillUsageDaily.workspaceId,
                skillUsageDaily.scope,
                skillUsageDaily.skill,
                skillUsageDaily.source,
                skillUsageDaily.day,
              ],
              set: {
                id: sql`EXCLUDED."id"`,
                loads: sql`GREATEST(${skillUsageDaily.loads}, EXCLUDED."loads")`,
                resourceReads: sql`GREATEST(${skillUsageDaily.resourceReads}, EXCLUDED."resource_reads")`,
                relevantHits: sql`GREATEST(${skillUsageDaily.relevantHits}, EXCLUDED."relevant_hits")`,
                firstAt: sql`LEAST(${skillUsageDaily.firstAt}, EXCLUDED."first_at")`,
                lastAt: sql`GREATEST(${skillUsageDaily.lastAt}, EXCLUDED."last_at")`,
              },
            })
            .returning({ id: skillUsageDaily.id });
          upserted += written.length;
        }
        break;
      }

      case "llm_usage": {
        const rows = dedupByKey(
          group.items.map(item => {
            const rec = (
              item.doc as Extract<UsageBackfillDoc, { table: "llm_usage" }>
            ).record;
            return {
              id: entityIdToPgUuid(rec.id),
              workspaceId: entityIdToPgUuid(rec.workspaceId),
              userId: resolveNullableUserFromMap(rec.userId, userMap),
              chatId: optionalEntityIdToPgUuid(rec.chatId),
              invocationType: rec.invocationType,
              modelId: rec.modelId,
              inputTokens: rec.inputTokens,
              outputTokens: rec.outputTokens,
              cacheReadTokens: rec.cacheReadTokens ?? 0,
              cacheWriteTokens: rec.cacheWriteTokens ?? 0,
              reasoningTokens: rec.reasoningTokens ?? 0,
              totalTokens: rec.totalTokens,
              costUsd: costUsdToPgNumeric(rec.costUsd),
              steps: rec.steps ?? null,
              agentId: rec.agentId ?? null,
              tags: rec.tags ?? null,
              durationMs: rec.durationMs ?? null,
              workflowId: rec.workflowRun?.workflowId ?? null,
              workflowRunId: rec.workflowRun?.runId ?? null,
              workflowStep: rec.workflowRun?.step ?? null,
              workflowBackfilled: rec.workflowRun?.backfilled ?? null,
              createdAt: rec.createdAt,
            } satisfies typeof llmUsage.$inferInsert;
          }),
          r => r.id,
          (existing, incoming) => ({
            ...existing,
            workflowId: incoming.workflowId ?? existing.workflowId,
            workflowRunId: incoming.workflowRunId ?? existing.workflowRunId,
            workflowStep: incoming.workflowStep ?? existing.workflowStep,
            workflowBackfilled:
              incoming.workflowBackfilled ?? existing.workflowBackfilled,
          }),
        );
        for (const chunk of chunkRows(rows, 22, 300)) {
          await db
            .insert(llmUsage)
            .values(chunk)
            .onConflictDoUpdate({
              target: llmUsage.id,
              set: {
                workflowId: sql`COALESCE(EXCLUDED."workflow_id", ${llmUsage.workflowId})`,
                workflowRunId: sql`COALESCE(EXCLUDED."workflow_run_id", ${llmUsage.workflowRunId})`,
                workflowStep: sql`COALESCE(EXCLUDED."workflow_step", ${llmUsage.workflowStep})`,
                workflowBackfilled: sql`COALESCE(EXCLUDED."workflow_backfilled", ${llmUsage.workflowBackfilled})`,
              },
            });
        }
        upserted += group.items.length;
        break;
      }

      case "query_executions": {
        const rows = dedupByKey(
          group.items.map(item => {
            const rec = (
              item.doc as Extract<
                UsageBackfillDoc,
                { table: "query_executions" }
              >
            ).record;
            const rawApiKeyUuid = optionalEntityIdToPgUuid(rec.apiKeyId);
            const apiKeyUuid =
              rawApiKeyUuid && validApiKeyUuids.has(rawApiKeyUuid)
                ? rawApiKeyUuid
                : null;
            return {
              id: entityIdToPgUuid(rec.id),
              executedAt: rec.executedAt,
              userId: resolveNullableUserFromMap(rec.userId, userMap),
              apiKeyId: apiKeyUuid,
              workspaceId: entityIdToPgUuid(rec.workspaceId),
              connectionId: entityIdToPgUuid(rec.connectionId),
              databaseName: rec.databaseName ?? null,
              consoleId: optionalEntityIdToPgUuid(rec.consoleId),
              source: rec.source,
              databaseType: rec.databaseType,
              queryLanguage: rec.queryLanguage,
              status: rec.status,
              executionTimeMs: rec.executionTimeMs,
              rowCount: rec.rowCount ?? null,
              errorType: rec.errorType ?? null,
              bytesScanned: rec.bytesScanned ?? null,
            } satisfies typeof queryExecutions.$inferInsert;
          }),
          r => r.id,
          existing => existing,
        );
        for (const chunk of chunkRows(rows, 16, 350)) {
          await db
            .insert(queryExecutions)
            .values(chunk)
            .onConflictDoNothing({ target: queryExecutions.id });
        }
        upserted += group.items.length;
        break;
      }

      case "connection_verifications": {
        const rows = dedupByKey(
          group.items.map(item => {
            const rec = (
              item.doc as Extract<
                UsageBackfillDoc,
                { table: "connection_verifications" }
              >
            ).record;
            const rawConnUuid = optionalEntityIdToPgUuid(rec.connectionId);
            const connUuid =
              rawConnUuid && validConnectionUuids.has(rawConnUuid)
                ? rawConnUuid
                : null;
            return {
              id: entityIdToPgUuid(rec.id),
              verifiedAt: rec.verifiedAt,
              userId: resolveNullableUserFromMap(rec.userId, userMap),
              workspaceId: optionalEntityIdToPgUuid(rec.workspaceId),
              connectionId: connUuid,
              databaseType: rec.databaseType,
              trigger: rec.trigger,
              success: rec.success,
              durationMs: rec.durationMs,
              errorClass: rec.errorClass ?? null,
              errorMessage: rec.errorMessage ?? null,
            } satisfies typeof connectionVerifications.$inferInsert;
          }),
          r => r.id,
          existing => existing,
        );
        for (const chunk of chunkRows(rows, 11, 350)) {
          await db
            .insert(connectionVerifications)
            .values(chunk)
            .onConflictDoNothing({ target: connectionVerifications.id });
        }
        upserted += group.items.length;
        break;
      }
    }
  }

  return upserted;
}

export function createUsageStatsBackfillHandler(
  options: { now?: () => Date } = {},
): BackfillDomainHandler<UsageBackfillDoc> {
  const nowFn = options.now ?? (() => new Date());
  const workspaceCache = new Map<string, boolean>();

  return {
    domain: USAGE_STATS_DOMAIN,
    collectionName: "app_usage_daily",
    targetTable: "app_usage_daily",
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      workspaceCache.clear();
      const parsed = decodeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const now = nowFn();
      const items: Array<BackfillItem<UsageBackfillDoc>> = [];

      for (const meta of USAGE_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageItems(
          meta,
          stageAfter,
          remaining,
          workspaceId,
          true,
          now,
        );
        items.push(...batch);
      }
      return items;
    },
    prepareBatch(items, db) {
      return prepareUsageBatch(items, db, workspaceCache);
    },
    validate(item, db) {
      return validateUsageBackfillItem(item, db, nowFn(), workspaceCache);
    },
    upsertBatch(items, db) {
      return upsertUsageBackfillItems(items, db);
    },
  };
}

export function createUsageStatsTableBackfillHandler(
  meta: UsageStageMeta,
  options: { now?: () => Date } = {},
): BackfillDomainHandler<UsageBackfillDoc> {
  const nowFn = options.now ?? (() => new Date());
  const workspaceCache = new Map<string, boolean>();

  return {
    domain: `${USAGE_STATS_DOMAIN}:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      workspaceCache.clear();
      return fetchStageItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
        nowFn(),
      );
    },
    prepareBatch(items, db) {
      return prepareUsageBatch(items, db, workspaceCache);
    },
    validate(item, db) {
      return validateUsageBackfillItem(item, db, nowFn(), workspaceCache);
    },
    upsertBatch(items, db) {
      return upsertUsageBackfillItems(items, db);
    },
  };
}

// ── Single rollover-day reconciliation helper ────────────────────────────────

export interface ReconcileRolloverDayOptions {
  /** UTC `YYYY-MM-DD` day to reconcile (e.g. yesterday at 00:05 UTC). */
  day: string;
  /** `mongo_to_pg` after enabling Stage 2; `pg_to_mongo` after Stage 4 -> 2 rollback. */
  direction: "mongo_to_pg" | "pg_to_mongo";
  workspaceId?: string | null;
  /** Must be a closed UTC day unless `allowOpenDay` is explicitly passed (tests). */
  allowOpenDay?: boolean;
  now?: Date;
  db?: MakoPgDb;
}

export interface ReconcileRolloverDayResult {
  day: string;
  direction: "mongo_to_pg" | "pg_to_mongo";
  appUsageReconciled: number;
  skillUsageReconciled: number;
}

/**
 * Reconcile the single UTC rollover day whose partial-day `$inc` counters may have
 * differed between MongoDB and Postgres before Stage 2 dual-write was enabled (or
 * after rolling back from Stage 4 to Stage 2).
 */
export async function reconcileUsageRolloverDay(
  options: ReconcileRolloverDayOptions,
): Promise<ReconcileRolloverDayResult> {
  const now = options.now ?? new Date();
  if (!options.allowOpenDay && !isClosedUtcDay(options.day, now)) {
    throw new Error(
      `Refusing to reconcile non-closed UTC day ${JSON.stringify(options.day)} (current UTC day is ${currentUtcDay(now)})`,
    );
  }
  const db = options.db ?? getPgDb();
  const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
  let appUsageReconciled = 0;
  let skillUsageReconciled = 0;

  if (options.direction === "mongo_to_pg") {
    const wsOid = mongoWorkspaceObjectId(options.workspaceId ?? null);
    const filter: Record<string, unknown> = { day: options.day };
    if (wsOid) filter.workspaceId = wsOid;

    const appDocs =
      await AppUsageDaily.find(filter).lean<MongoAppUsageDailyLike[]>();
    for (const doc of appDocs) {
      const record = mongoAppUsageDailyToRecord(doc);
      const resolvedUserUuid = await pgRepo.resolveNullableUserUuid(
        record.userId,
        db,
      );
      await pgRepo.upsertAppUsageDailyClosedDay(record, resolvedUserUuid, {
        overwrite: true,
        db,
      });
      appUsageReconciled += 1;
    }

    const skillDocs =
      await SkillUsageDaily.find(filter).lean<MongoSkillUsageDailyLike[]>();
    for (const doc of skillDocs) {
      const record = mongoSkillUsageDailyToRecord(doc);
      await pgRepo.upsertSkillUsageDailyClosedDay(record, {
        overwrite: true,
        db,
      });
      skillUsageReconciled += 1;
    }
  } else {
    const pgAppRows = await pgRepo.listAppUsageDailyByDay(
      options.day,
      options.workspaceId ?? null,
      db,
    );
    const appUserMap = await buildPgUuidToMongoUserIdMap(
      db,
      pgAppRows.map(r => r.userId),
    );
    for (const row of pgAppRows) {
      const rowOid = toMongoObjectId(row.id);
      const mongoUserId = toMongoUserId(row.userId, appUserMap);
      const byId = await AppUsageDaily.updateOne(
        { _id: rowOid },
        {
          $set: {
            opens: row.opens,
            activeSeconds: row.activeSeconds,
            sources: row.sources,
            firstAt: row.firstAt,
            lastAt: row.lastAt,
          },
        },
      );
      if (byId.matchedCount === 0) {
        await AppUsageDaily.updateOne(
          {
            workspaceId: toMongoObjectId(row.workspaceId),
            appId: row.appId,
            userId: mongoUserId,
            day: row.day,
          },
          {
            $set: {
              opens: row.opens,
              activeSeconds: row.activeSeconds,
              sources: row.sources,
              firstAt: row.firstAt,
              lastAt: row.lastAt,
            },
            $setOnInsert: {
              _id: rowOid,
            },
          },
          { upsert: true },
        );
      }
      appUsageReconciled += 1;
    }

    const pgSkillRows = await pgRepo.listSkillUsageDailyByDay(
      options.day,
      options.workspaceId ?? null,
      db,
    );
    for (const row of pgSkillRows) {
      const rowOid = toMongoObjectId(row.id);
      const byId = await SkillUsageDaily.updateOne(
        { _id: rowOid },
        {
          $set: {
            loads: row.loads,
            resourceReads: row.resourceReads,
            relevantHits: row.relevantHits,
            firstAt: row.firstAt,
            lastAt: row.lastAt,
          },
        },
      );
      if (byId.matchedCount === 0) {
        await SkillUsageDaily.updateOne(
          {
            workspaceId: toMongoObjectId(row.workspaceId),
            scope: row.scope,
            skill: row.skill,
            source: row.source,
            day: row.day,
          },
          {
            $set: {
              loads: row.loads,
              resourceReads: row.resourceReads,
              relevantHits: row.relevantHits,
              firstAt: row.firstAt,
              lastAt: row.lastAt,
            },
            $setOnInsert: {
              _id: rowOid,
            },
          },
          { upsert: true },
        );
      }
      skillUsageReconciled += 1;
    }
  }

  return {
    day: options.day,
    direction: options.direction,
    appUsageReconciled,
    skillUsageReconciled,
  };
}

// ── Parity Verifier (+ --repair) ─────────────────────────────────────────────

async function fetchPgRecordsForTable(
  table: UsageStatsBackfilledTable,
  uuids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const valid = uuids.filter(isUuidString).map(u => u.toLowerCase());
  if (valid.length === 0) return out;

  switch (table) {
    case "app_usage_daily": {
      const rows = await db
        .select()
        .from(appUsageDaily)
        .where(inArray(appUsageDaily.id, valid));
      for (const row of rows) {
        out.set(
          row.id.toLowerCase(),
          canonicalizeAppUsageDailyForCompare(pgAppUsageDailyToRecord(row)),
        );
      }
      return out;
    }
    case "app_usage_events": {
      const rows = await db
        .select()
        .from(appUsageEvents)
        .where(inArray(appUsageEvents.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppUsageEventToRecord(row));
      }
      return out;
    }
    case "skill_usage_daily": {
      const rows = await db
        .select()
        .from(skillUsageDaily)
        .where(inArray(skillUsageDaily.id, valid));
      for (const row of rows) {
        out.set(
          row.id.toLowerCase(),
          canonicalizeSkillUsageDailyForCompare(pgSkillUsageDailyToRecord(row)),
        );
      }
      return out;
    }
    case "llm_usage": {
      const rows = await db
        .select()
        .from(llmUsage)
        .where(inArray(llmUsage.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgLlmUsageToRecord(row));
      }
      return out;
    }
    case "query_executions": {
      const rows = await db
        .select()
        .from(queryExecutions)
        .where(inArray(queryExecutions.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgQueryExecutionToRecord(row));
      }
      return out;
    }
    case "connection_verifications": {
      const rows = await db
        .select()
        .from(connectionVerifications)
        .where(inArray(connectionVerifications.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgConnectionVerificationToRecord(row));
      }
      return out;
    }
  }
}

interface UsageVerifierLookupContext {
  userMap: Map<string, string>;
  validApiKeyUuids: Set<string>;
  validWorkspaceUuids: Set<string>;
  validConnectionUuids: Set<string>;
}

async function buildUsageVerifierLookupContext(
  db: MakoPgDb,
  items: ReadonlyArray<BackfillItem<UsageBackfillDoc>>,
): Promise<UsageVerifierLookupContext> {
  const rawUserIds: string[] = [];
  const apiKeyIds: string[] = [];
  const connVerifWorkspaceIds: string[] = [];
  const connVerifConnectionIds: string[] = [];

  for (const item of items) {
    const { doc } = item;
    if ("userId" in doc.record && doc.record.userId) {
      rawUserIds.push(doc.record.userId);
    }
    if (doc.table === "query_executions" && doc.record.apiKeyId) {
      apiKeyIds.push(doc.record.apiKeyId);
    }
    if (doc.table === "connection_verifications") {
      if (doc.record.workspaceId) {
        connVerifWorkspaceIds.push(doc.record.workspaceId);
      }
      if (doc.record.connectionId) {
        connVerifConnectionIds.push(doc.record.connectionId);
      }
    }
  }

  const [userMap, validApiKeyUuids, validWorkspaceUuids, validConnectionUuids] =
    await Promise.all([
      resolvePgUserMap(db, rawUserIds),
      resolvePgApiKeySet(db, apiKeyIds),
      resolvePgWorkspaceSet(db, connVerifWorkspaceIds),
      resolvePgConnectionSet(db, connVerifConnectionIds),
    ]);
  return {
    userMap,
    validApiKeyUuids,
    validWorkspaceUuids,
    validConnectionUuids,
  };
}

function buildVerifierRecord(
  item: BackfillItem<UsageBackfillDoc>,
  ctx: UsageVerifierLookupContext,
  composite: boolean,
): VerifierMongoRecord {
  const { doc } = item;
  const {
    userMap,
    validApiKeyUuids,
    validWorkspaceUuids,
    validConnectionUuids,
  } = ctx;
  const pgUuid = item.entityId.toLowerCase();
  let comparable: unknown;

  switch (doc.table) {
    case "app_usage_daily": {
      const resolved = doc.record.userId
        ? (userMap.get(doc.record.userId) ?? null)
        : null;
      const viewer = buildPgDailyViewerColumns({
        rawUserId: doc.record.userId,
        resolvedPgUserUuid: resolved,
      });
      const projectedUserId =
        viewer.visitorKey === "anon"
          ? null
          : viewer.visitorKey.startsWith("u:")
            ? viewer.visitorKey.slice(2)
            : viewer.visitorKey;
      comparable = canonicalizeAppUsageDailyForCompare({
        ...doc.record,
        userId: projectedUserId,
      });
      break;
    }
    case "app_usage_events": {
      const resolved = doc.record.userId
        ? (userMap.get(doc.record.userId) ?? null)
        : null;
      comparable = { ...doc.record, userId: resolved };
      break;
    }
    case "skill_usage_daily":
      comparable = canonicalizeSkillUsageDailyForCompare(doc.record);
      break;
    case "llm_usage": {
      const resolved = doc.record.userId
        ? (userMap.get(doc.record.userId) ?? null)
        : null;
      comparable = { ...doc.record, userId: resolved };
      break;
    }
    case "query_executions": {
      const resolved = doc.record.userId
        ? (userMap.get(doc.record.userId) ?? null)
        : null;
      const apiKeyUuid = doc.record.apiKeyId
        ? parseEntityId(doc.record.apiKeyId)?.uuid
        : undefined;
      const next: QueryExecutionRecord = { ...doc.record, userId: resolved };
      if (!apiKeyUuid || !validApiKeyUuids.has(apiKeyUuid)) {
        delete next.apiKeyId;
      }
      comparable = next;
      break;
    }
    case "connection_verifications": {
      const resolved = doc.record.userId
        ? (userMap.get(doc.record.userId) ?? undefined)
        : undefined;
      const wsUuid = doc.record.workspaceId
        ? parseEntityId(doc.record.workspaceId)?.uuid
        : undefined;
      const connUuid = doc.record.connectionId
        ? parseEntityId(doc.record.connectionId)?.uuid
        : undefined;
      const next: ConnectionVerificationRecord = { ...doc.record };
      if (resolved) {
        next.userId = resolved;
      } else {
        delete next.userId;
      }
      if (!wsUuid || !validWorkspaceUuids.has(wsUuid)) {
        delete next.workspaceId;
      }
      if (!connUuid || !validConnectionUuids.has(connUuid)) {
        delete next.connectionId;
      }
      comparable = next;
      break;
    }
  }

  return {
    cursor: item.cursor,
    entityId: composite ? encodeVerifierKey(doc.table, pgUuid) : pgUuid,
    targetTable: doc.table,
    tombstoneId: pgUuid,
    record: comparable,
  };
}

async function repairUsageEntityInPg(
  table: UsageStatsBackfilledTable,
  pgUuid: string,
  db: MakoPgDb,
  pgRepo: PgUsageStatsRepository,
): Promise<boolean> {
  const parsed = parseEntityId(pgUuid);
  if (!parsed?.oid) return false;
  const oid = new Types.ObjectId(parsed.oid);
  switch (table) {
    case "app_usage_daily": {
      const doc = await AppUsageDaily.findById(
        oid,
      ).lean<MongoAppUsageDailyLike | null>();
      if (!doc) return false;
      const rec = mongoAppUsageDailyToRecord(doc);
      if (
        !parseEntityId(rec.appId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      const userUuid = await pgRepo.resolveNullableUserUuid(rec.userId, db);
      await pgRepo.upsertAppUsageDailyClosedDay(rec, userUuid, {
        overwrite: true,
        db,
      });
      return true;
    }
    case "app_usage_events": {
      const doc = await AppUsageEvent.findById(
        oid,
      ).lean<MongoAppUsageEventLike | null>();
      if (!doc) return false;
      const rec = mongoAppUsageEventToRecord(doc);
      if (
        !parseEntityId(rec.appId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await pgRepo.createAppUsageEvent(rec, db, {
        overwrite: true,
      });
      return true;
    }
    case "skill_usage_daily": {
      const doc = await SkillUsageDaily.findById(
        oid,
      ).lean<MongoSkillUsageDailyLike | null>();
      if (!doc) return false;
      const rec = mongoSkillUsageDailyToRecord(doc);
      if (!(await workspaceExistsInPg(db, rec.workspaceId))) return false;
      await pgRepo.upsertSkillUsageDailyClosedDay(rec, { overwrite: true, db });
      return true;
    }
    case "llm_usage": {
      const doc = await LlmUsage.findById(oid).lean<MongoLlmUsageLike | null>();
      if (!doc) return false;
      const rec = mongoLlmUsageToRecord(doc);
      if (!parseEntityId(rec.workspaceId)) return false;
      await pgRepo.createLlmUsage(rec, db, {
        overwrite: true,
      });
      return true;
    }
    case "query_executions": {
      const doc = await QueryExecution.findById(
        oid,
      ).lean<MongoQueryExecutionLike | null>();
      if (!doc) return false;
      const rec = mongoQueryExecutionToRecord(doc);
      if (
        !parseEntityId(rec.connectionId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await pgRepo.createQueryExecution(rec, db, {
        overwrite: true,
      });
      return true;
    }
    case "connection_verifications": {
      const doc = await ConnectionVerification.findById(
        oid,
      ).lean<MongoConnectionVerificationLike | null>();
      if (!doc) return false;
      const rec = mongoConnectionVerificationToRecord(doc);
      if (
        rec.workspaceId &&
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        rec.workspaceId = undefined;
      }
      await pgRepo.createConnectionVerification(rec, db, { overwrite: true });
      return true;
    }
  }
}

export function createUsageStatsVerifierHandler(
  options: { now?: () => Date } = {},
): VerifierDomainHandler {
  const pgRepo = new PgUsageStatsRepository();
  const nowFn = options.now ?? (() => new Date());

  return {
    domain: USAGE_STATS_DOMAIN,
    targetTable: "app_usage_daily",
    compareOptions: USAGE_STATS_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const parsed = decodeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<UsageBackfillDoc>> = [];
      const now = nowFn();

      for (const meta of USAGE_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        items.push(
          ...(await fetchStageItems(
            meta,
            stageAfter,
            remaining,
            workspaceId,
            true,
            now,
          )),
        );
      }

      const ctx = await buildUsageVerifierLookupContext(db, items);
      return items.map(item => buildVerifierRecord(item, ctx, true));
    },
    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<UsageStatsBackfilledTable, string[]>();
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        const list = byTable.get(decoded.table);
        if (list) list.push(decoded.pgEntityId);
        else byTable.set(decoded.table, [decoded.pgEntityId]);
      }
      const out = new Map<string, unknown>();
      for (const [table, ids] of byTable) {
        const rows = await fetchPgRecordsForTable(table, ids, db);
        for (const [id, rec] of rows) {
          out.set(encodeVerifierKey(table, id), rec);
        }
      }
      return out;
    },
    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        if (
          await repairUsageEntityInPg(
            decoded.table,
            decoded.pgEntityId,
            db,
            pgRepo,
          )
        ) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

export function createUsageStatsTableVerifierHandler(
  meta: UsageStageMeta,
  options: { now?: () => Date } = {},
): VerifierDomainHandler {
  const pgRepo = new PgUsageStatsRepository();
  const nowFn = options.now ?? (() => new Date());

  return {
    domain: `${USAGE_STATS_DOMAIN}:${meta.table}`,
    targetTable: meta.table,
    compareOptions: USAGE_STATS_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const items = await fetchStageItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
        nowFn(),
      );
      const ctx = await buildUsageVerifierLookupContext(db, items);
      return items.map(item => buildVerifierRecord(item, ctx, false));
    },
    fetchPgByIds(entityIds, db) {
      return fetchPgRecordsForTable(meta.table, entityIds, db);
    },
    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const id of entityIds) {
        if (await repairUsageEntityInPg(meta.table, id, db, pgRepo)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

// ── Dead-letter sync-retry replay handlers ───────────────────────────────────

export async function replayUsageStatsWriteToPg(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
  now: Date = new Date(),
): Promise<void> {
  const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
  const table = String(data.payload?.table ?? "");

  if (table === "app_feed_snapshots") {
    const parsed = parseEntityId(String(data.payload?.id ?? data.entityId));
    if (!parsed?.oid) return;
    const doc = await AppFeedSnapshot.findById(
      new Types.ObjectId(parsed.oid),
    ).lean<MongoAppFeedSnapshotLike | null>();
    if (!doc) return;
    await pgRepo.createFeedSnapshot(mongoAppFeedSnapshotToRecord(doc), db);
    return;
  }

  if (table === "app_usage_daily") {
    const wsId = String(data.payload?.workspaceId ?? data.workspaceId ?? "");
    const rawAppId = String(data.payload?.appId ?? "");
    const day = String(data.payload?.day ?? "");
    const rawUserId =
      (data.payload?.userId as string | null | undefined) ?? null;
    const rawAnonId =
      (data.payload?.anonId as string | null | undefined) ?? null;
    const parsedWs = parseEntityId(wsId);
    const parsedApp = parseEntityId(rawAppId);
    if (!parsedWs?.oid || !parsedApp?.oid || !day) return;

    const closed = isClosedUtcDay(day, now);
    const kind = data.payload?.kind as AppUsageEventKind | undefined;
    const source = data.payload?.source as AppUsageEventSource | undefined;
    const rawAt = data.payload?.at as string | Date | undefined;
    const at = rawAt ? new Date(rawAt) : null;
    if (
      !closed &&
      (kind === "open" || kind === "heartbeat") &&
      (source === "app" || source === "share" || source === "embed") &&
      at &&
      Number.isFinite(at.getTime())
    ) {
      const heartbeatSeconds =
        typeof data.payload?.heartbeatSeconds === "number"
          ? data.payload.heartbeatSeconds
          : undefined;
      await pgRepo.bumpAppUsageDaily(
        {
          id:
            typeof data.payload?.id === "string" ? data.payload.id : undefined,
          workspaceId: wsId,
          appId: rawAppId,
          userId: rawUserId,
          anonId: rawAnonId,
          day,
          kind,
          source,
          ...(heartbeatSeconds !== undefined ? { heartbeatSeconds } : {}),
          at,
        },
        db,
      );
      return;
    }

    const mongoViewerId = rawUserId ?? rawAnonId;
    let doc = await AppUsageDaily.findOne({
      workspaceId: new Types.ObjectId(parsedWs.oid),
      appId: parsedApp.oid,
      userId: mongoViewerId,
      day,
    }).lean<MongoAppUsageDailyLike | null>();
    if (!doc && mongoViewerId && isUuidString(mongoViewerId)) {
      const legacyMap = await buildPgUuidToMongoUserIdMap(db, [mongoViewerId]);
      const legacyId = legacyMap.get(mongoViewerId.toLowerCase());
      if (legacyId) {
        doc = await AppUsageDaily.findOne({
          workspaceId: new Types.ObjectId(parsedWs.oid),
          appId: parsedApp.oid,
          userId: legacyId,
          day,
        }).lean<MongoAppUsageDailyLike | null>();
      }
    }
    if (!doc) return;
    const rec = mongoAppUsageDailyToRecord(doc);
    const resolvedUserUuid = await pgRepo.resolveNullableUserUuid(
      rec.userId,
      db,
    );
    await pgRepo.upsertAppUsageDailyClosedDay(rec, resolvedUserUuid, {
      // Only overwrite PG counters once the UTC day is closed; for open-day legacy
      // payloads without delta fields, use GREATEST(...) so live increments survive.
      overwrite: closed,
      db,
    });
    return;
  }

  if (table === "skill_usage_daily") {
    const wsId = String(data.payload?.workspaceId ?? data.workspaceId ?? "");
    const day = String(data.payload?.day ?? "");
    const source = data.payload?.source as SkillUsageSourcePg | undefined;
    const targets = data.payload?.targets as
      Array<{ scope: SkillUsageScopePg; skill: string }> | undefined;
    const parsedWs = parseEntityId(wsId);
    if (!parsedWs?.oid || !day || !source || !targets?.length) return;

    const closed = isClosedUtcDay(day, now);
    const kind = data.payload?.kind as SkillUsageBumpKind | undefined;
    const rawAt = data.payload?.at as string | Date | undefined;
    const at = rawAt ? new Date(rawAt) : null;
    if (
      !closed &&
      (kind === "load" || kind === "resource" || kind === "relevant") &&
      (source === "agent" || source === "mcp") &&
      at &&
      Number.isFinite(at.getTime())
    ) {
      const ids = Array.isArray(data.payload?.ids)
        ? (data.payload.ids as string[])
        : undefined;
      await pgRepo.bumpSkillUsageDaily(
        wsId,
        targets,
        kind,
        source,
        at,
        ids,
        db,
      );
      return;
    }

    for (const target of targets) {
      const doc = await SkillUsageDaily.findOne({
        workspaceId: new Types.ObjectId(parsedWs.oid),
        scope: target.scope,
        skill: target.skill,
        source,
        day,
      }).lean<MongoSkillUsageDailyLike | null>();
      if (!doc) continue;
      await pgRepo.upsertSkillUsageDailyClosedDay(
        mongoSkillUsageDailyToRecord(doc),
        { overwrite: closed, db },
      );
    }
    return;
  }

  if (
    table === "app_usage_events" ||
    table === "llm_usage" ||
    table === "query_executions" ||
    table === "connection_verifications"
  ) {
    const ids = Array.isArray(data.payload?.ids)
      ? (data.payload.ids as string[])
      : [String(data.payload?.id ?? data.entityId)];
    for (const rawId of ids) {
      const parsed = parseEntityId(rawId);
      if (!parsed) continue;
      await repairUsageEntityInPg(table, parsed.uuid, db, pgRepo);
    }
  }
}

export async function replayUsageStatsWriteToMongo(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
  now: Date = new Date(),
): Promise<void> {
  const mongoRepo = new MongoUsageStatsRepository();
  const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
  const table = String(data.payload?.table ?? "");

  if (table === "app_feed_snapshots") {
    const parsed = parseEntityId(String(data.payload?.id ?? data.entityId));
    if (!parsed) return;
    const rows = await db
      .select()
      .from(appFeedSnapshots)
      .where(eq(appFeedSnapshots.id, parsed.uuid))
      .limit(1);
    if (!rows[0]) return;
    const rec = pgAppFeedSnapshotToRecord(rows[0]);
    const userMap = await buildPgUuidToMongoUserIdMap(db, [rec.userId]);
    const mongoUserId = toMongoUserId(rec.userId, userMap) ?? rec.userId;
    await AppFeedSnapshot.updateOne(
      { _id: toMongoObjectId(rec.id) },
      {
        $set: {
          workspaceId: toMongoObjectId(rec.workspaceId),
          userId: mongoUserId,
          popular: rec.popular,
          fresh: rec.fresh,
          recommended: rec.recommended,
          createdAt: rec.createdAt,
        },
      },
      { upsert: true },
    );
    return;
  }

  if (table === "app_usage_daily") {
    const day = String(data.payload?.day ?? "");
    const wsId = String(data.payload?.workspaceId ?? data.workspaceId ?? "");
    const appId = String(data.payload?.appId ?? "");
    const rawUserId =
      (data.payload?.userId as string | null | undefined) ?? null;
    const rawAnonId =
      (data.payload?.anonId as string | null | undefined) ?? null;
    const parsedWs = parseEntityId(wsId);
    const parsedApp = parseEntityId(appId);
    if (!day || !parsedWs || !parsedApp) return;

    const closed = isClosedUtcDay(day, now);
    const kind = data.payload?.kind as AppUsageEventKind | undefined;
    const source = data.payload?.source as AppUsageEventSource | undefined;
    const rawAt = data.payload?.at as string | Date | undefined;
    const at = rawAt ? new Date(rawAt) : null;
    if (
      !closed &&
      (kind === "open" || kind === "heartbeat") &&
      (source === "app" || source === "share" || source === "embed") &&
      at &&
      Number.isFinite(at.getTime())
    ) {
      const userMap = await buildPgUuidToMongoUserIdMap(db, [rawUserId]);
      const mongoUserId = toMongoUserId(rawUserId, userMap);
      const heartbeatSeconds =
        typeof data.payload?.heartbeatSeconds === "number"
          ? data.payload.heartbeatSeconds
          : undefined;
      await mongoRepo.bumpAppUsageDaily({
        id: typeof data.payload?.id === "string" ? data.payload.id : undefined,
        workspaceId: wsId,
        appId,
        userId: mongoUserId,
        anonId: rawAnonId,
        day,
        kind,
        source,
        ...(heartbeatSeconds !== undefined ? { heartbeatSeconds } : {}),
        at,
      });
      return;
    }

    const resolvedUserUuid = await pgRepo.resolveNullableUserUuid(
      rawUserId,
      db,
    );
    const viewer = buildPgDailyViewerColumns({
      rawUserId,
      rawAnonId,
      resolvedPgUserUuid: resolvedUserUuid,
    });
    const rows = await db
      .select()
      .from(appUsageDaily)
      .where(
        and(
          eq(appUsageDaily.workspaceId, parsedWs.uuid),
          eq(appUsageDaily.appId, parsedApp.uuid),
          eq(appUsageDaily.visitorKey, viewer.visitorKey),
          eq(appUsageDaily.day, day),
        ),
      )
      .limit(1);
    if (!rows[0]) return;

    const row = pgAppUsageDailyToRecord(rows[0]);
    const userMap = await buildPgUuidToMongoUserIdMap(db, [row.userId]);
    const mongoUserId = toMongoUserId(row.userId, userMap);
    const rowOid = toMongoObjectId(row.id);

    const buildOpenDayUpdate = () => {
      const $max: Record<string, unknown> = {
        opens: row.opens,
        activeSeconds: row.activeSeconds,
        lastAt: row.lastAt,
      };
      if (row.sources.app !== undefined) $max["sources.app"] = row.sources.app;
      if (row.sources.share !== undefined) {
        $max["sources.share"] = row.sources.share;
      }
      if (row.sources.embed !== undefined) {
        $max["sources.embed"] = row.sources.embed;
      }
      return {
        $max,
        $min: { firstAt: row.firstAt },
      };
    };

    const updateDoc = closed
      ? {
          $set: {
            opens: row.opens,
            activeSeconds: row.activeSeconds,
            sources: row.sources,
            firstAt: row.firstAt,
            lastAt: row.lastAt,
          },
        }
      : buildOpenDayUpdate();

    const byId = await AppUsageDaily.updateOne({ _id: rowOid }, updateDoc);
    if (byId.matchedCount === 0) {
      await AppUsageDaily.updateOne(
        {
          workspaceId: toMongoObjectId(row.workspaceId),
          appId: row.appId,
          userId: mongoUserId,
          day: row.day,
        },
        {
          ...updateDoc,
          $setOnInsert: {
            _id: rowOid,
          },
        },
        { upsert: true },
      );
    }
    return;
  }

  if (table === "skill_usage_daily") {
    const day = String(data.payload?.day ?? "");
    const wsId = String(data.payload?.workspaceId ?? data.workspaceId ?? "");
    const source = data.payload?.source as SkillUsageSourcePg | undefined;
    const targets = data.payload?.targets as
      Array<{ scope: SkillUsageScopePg; skill: string }> | undefined;
    const parsedWs = parseEntityId(wsId);
    if (!day || !parsedWs || !source || !targets?.length) return;

    const closed = isClosedUtcDay(day, now);
    const kind = data.payload?.kind as SkillUsageBumpKind | undefined;
    const rawAt = data.payload?.at as string | Date | undefined;
    const at = rawAt ? new Date(rawAt) : null;
    if (
      !closed &&
      (kind === "load" || kind === "resource" || kind === "relevant") &&
      (source === "agent" || source === "mcp") &&
      at &&
      Number.isFinite(at.getTime())
    ) {
      const ids = Array.isArray(data.payload?.ids)
        ? (data.payload.ids as string[])
        : undefined;
      await mongoRepo.bumpSkillUsageDaily(wsId, targets, kind, source, at, ids);
      return;
    }

    for (const target of targets) {
      const rows = await db
        .select()
        .from(skillUsageDaily)
        .where(
          and(
            eq(skillUsageDaily.workspaceId, parsedWs.uuid),
            eq(skillUsageDaily.scope, target.scope),
            eq(skillUsageDaily.skill, target.skill),
            eq(skillUsageDaily.source, source),
            eq(skillUsageDaily.day, day),
          ),
        )
        .limit(1);
      if (!rows[0]) continue;
      const row = pgSkillUsageDailyToRecord(rows[0]);
      const rowOid = toMongoObjectId(row.id);
      const updateDoc = closed
        ? {
            $set: {
              loads: row.loads,
              resourceReads: row.resourceReads,
              relevantHits: row.relevantHits,
              firstAt: row.firstAt,
              lastAt: row.lastAt,
            },
          }
        : {
            $max: {
              loads: row.loads,
              resourceReads: row.resourceReads,
              relevantHits: row.relevantHits,
              lastAt: row.lastAt,
            },
            $min: { firstAt: row.firstAt },
          };
      const byId = await SkillUsageDaily.updateOne({ _id: rowOid }, updateDoc);
      if (byId.matchedCount === 0) {
        await SkillUsageDaily.updateOne(
          {
            workspaceId: toMongoObjectId(row.workspaceId),
            scope: row.scope,
            skill: row.skill,
            source: row.source,
            day: row.day,
          },
          {
            ...updateDoc,
            $setOnInsert: {
              _id: rowOid,
            },
          },
          { upsert: true },
        );
      }
    }
    return;
  }

  if (table === "app_usage_events") {
    const parsed = parseEntityId(String(data.payload?.id ?? data.entityId));
    if (!parsed) return;
    const rows = await db
      .select()
      .from(appUsageEvents)
      .where(eq(appUsageEvents.id, parsed.uuid))
      .limit(1);
    if (!rows[0]) return;
    const rec = pgAppUsageEventToRecord(rows[0]);
    const userMap = await buildPgUuidToMongoUserIdMap(db, [rec.userId]);
    const mongoUserId = toMongoUserId(rec.userId, userMap);
    await AppUsageEvent.updateOne(
      { _id: toMongoObjectId(rec.id) },
      {
        $setOnInsert: {
          _id: toMongoObjectId(rec.id),
          workspaceId: toMongoObjectId(rec.workspaceId),
          appId: rec.appId,
          at: rec.at,
          kind: rec.kind,
          source: rec.source,
          userId: mongoUserId,
          anonId: mongoUserId ? null : (rec.anonId ?? null),
          sessionId: rec.sessionId ?? null,
          ...(rec.referrerKind ? { referrerKind: rec.referrerKind } : {}),
          uaClass: rec.uaClass,
          ...(rec.throttled !== undefined ? { throttled: rec.throttled } : {}),
          ...(rec.placement ? { placement: rec.placement } : {}),
          ...(rec.backfill ? { backfill: rec.backfill } : {}),
        },
      },
      { upsert: true },
    );
    return;
  }

  if (table === "llm_usage") {
    const ids = Array.isArray(data.payload?.ids)
      ? (data.payload.ids as string[])
      : [String(data.payload?.id ?? data.entityId)];
    for (const rawId of ids) {
      const parsed = parseEntityId(rawId);
      if (!parsed) continue;
      const rows = await db
        .select()
        .from(llmUsage)
        .where(eq(llmUsage.id, parsed.uuid))
        .limit(1);
      if (!rows[0]) continue;
      const rec = pgLlmUsageToRecord(rows[0]);
      const userMap = await buildPgUuidToMongoUserIdMap(db, [rec.userId]);
      const mongoUserId = toMongoUserId(rec.userId, userMap) ?? "system";
      await LlmUsage.updateOne(
        { _id: toMongoObjectId(rec.id) },
        {
          $set: {
            workspaceId: toMongoObjectId(rec.workspaceId),
            userId: mongoUserId,
            ...(rec.chatId ? { chatId: toMongoObjectId(rec.chatId) } : {}),
            invocationType: rec.invocationType,
            modelId: rec.modelId,
            inputTokens: rec.inputTokens,
            outputTokens: rec.outputTokens,
            cacheReadTokens: rec.cacheReadTokens,
            cacheWriteTokens: rec.cacheWriteTokens,
            reasoningTokens: rec.reasoningTokens,
            totalTokens: rec.totalTokens,
            costUsd: rec.costUsd,
            ...(rec.steps ? { steps: rec.steps } : {}),
            ...(rec.agentId ? { agentId: rec.agentId } : {}),
            ...(rec.tags ? { tags: rec.tags } : {}),
            ...(rec.durationMs !== undefined
              ? { durationMs: rec.durationMs }
              : {}),
            ...(rec.workflowRun ? { workflowRun: rec.workflowRun } : {}),
            createdAt: rec.createdAt,
          },
        },
        { upsert: true },
      );
    }
    return;
  }

  if (table === "query_executions") {
    const parsed = parseEntityId(String(data.payload?.id ?? data.entityId));
    if (!parsed) return;
    const rows = await db
      .select()
      .from(queryExecutions)
      .where(eq(queryExecutions.id, parsed.uuid))
      .limit(1);
    if (!rows[0]) return;
    const rec = pgQueryExecutionToRecord(rows[0]);
    const existing = await QueryExecution.exists({
      _id: toMongoObjectId(rec.id),
    });
    if (!existing) {
      const userMap = await buildPgUuidToMongoUserIdMap(db, [rec.userId]);
      const mongoUserId = toMongoUserId(rec.userId, userMap);
      await mongoRepo.createQueryExecution({
        ...rec,
        userId: mongoUserId,
      });
    }
    return;
  }

  if (table === "connection_verifications") {
    const parsed = parseEntityId(String(data.payload?.id ?? data.entityId));
    if (!parsed) return;
    const rows = await db
      .select()
      .from(connectionVerifications)
      .where(eq(connectionVerifications.id, parsed.uuid))
      .limit(1);
    if (!rows[0]) return;
    const rec = pgConnectionVerificationToRecord(rows[0]);
    const existing = await ConnectionVerification.exists({
      _id: toMongoObjectId(rec.id),
    });
    if (!existing) {
      const userMap = await buildPgUuidToMongoUserIdMap(db, [rec.userId]);
      const mongoUserId = toMongoUserId(rec.userId, userMap) ?? undefined;
      await mongoRepo.createConnectionVerification({
        ...rec,
        userId: mongoUserId,
      });
    }
  }
}

/**
 * Register all `usage_stats` backfill handlers, parity verifiers, sync-retry handlers,
 * and Postgres TTL reaper rules.
 */
export function registerUsageStatsMigrationDomain(): void {
  registerBackfillDomain(createUsageStatsBackfillHandler());
  registerVerifierDomain(createUsageStatsVerifierHandler());

  for (const meta of USAGE_STAGES) {
    registerBackfillDomain(createUsageStatsTableBackfillHandler(meta));
    registerVerifierDomain(createUsageStatsTableVerifierHandler(meta));
  }

  registerSyncRetryHandler("pg", USAGE_STATS_DOMAIN, data =>
    replayUsageStatsWriteToPg(data),
  );
  registerSyncRetryHandler("mongo", USAGE_STATS_DOMAIN, data =>
    replayUsageStatsWriteToMongo(data),
  );

  // Register TTL reaper rules ONLY for expiring telemetry & snapshot tables.
  // NEVER register `llm_usage` (permanent billing ledger) or `app_usage_daily`!
  for (const rule of USAGE_TTL_RULES) {
    registerTtlRule(rule);
  }
}

export { entityIdToPgUuid };
