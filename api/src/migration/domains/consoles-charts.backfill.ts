/**
 * Phase 2A-2 (`consoles_charts` domain) migration handlers:
 *   - 10-stage FK + 2-pass self-FK resumable MongoDB -> Postgres backfill
 *     (`consoles_charts` + 7 per-table sub-domains)
 *   - Chunked parity verifier + `--repair` healer (`consoles_charts` + 7 sub-domains)
 *   - Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`)
 *   - Postgres batched TTL reaper rule (`scheduled_query_runs`, 90d sparse on `completed_at`)
 *
 * 10-stage backfill order:
 *   1. `console_folders`          (Pass 1: insert with `parent_id = NULL`)
 *   2. `console_folders_parents`  (Pass 2: wire `parent_id` where parent exists in PG)
 *   3. `saved_consoles`           (FK -> workspaces, console_folders; rewrites user UUIDs + JSONB)
 *   4. `entity_versions`          (skips/quarantines legacy `entityType !== 'console'` rows)
 *   5. `notebook_folders`         (Pass 1: insert with `parent_id = NULL`)
 *   6. `notebook_folders_parents` (Pass 2: wire `parent_id`)
 *   7. `notebook_indexes`         (FK -> workspaces, notebook_folders; rewrites user UUIDs + JSONB)
 *   8. `favourites`               (Pass 1: skips/quarantines legacy `kind = 'dashboard'` + orphan userId; `parent_id = NULL`)
 *   9. `favourites_parents`       (Pass 2: wire `parent_id`)
 *  10. `scheduled_query_runs`     (FK -> workspaces; soft ref on `console_id` to preserve run history across repo disconnect/reconnect)
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Types } from "mongoose";
import {
  ConsoleFolder,
  EntityVersion,
  Favourite,
  NotebookFolder,
  NotebookIndex,
  SavedConsole,
  ScheduledQueryRun,
} from "../../database/workspace-schema";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import { databaseConnections } from "../../database/pg/schema/connections";
import { migrationTombstones } from "../../database/pg/schema/control-plane";
import {
  consoleFolders,
  entityVersions,
  favourites,
  notebookFolders,
  notebookIndexes,
  savedConsoles,
  scheduledQueryRuns,
} from "../../database/pg/schema/consoles-charts";
import { workspaces } from "../../database/pg/schema/workspaces";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import { hasConsolesConnectionFk } from "../../repositories/consoles-charts/pg.repo";
import {
  CONSOLES_CHARTS_DOMAIN,
  CONSOLES_CHARTS_SHADOW_OPTIONS,
  MongoConsolesChartsRepository,
  PgConsolesChartsRepository,
  isNonUserSentinel,
  isValidFavouriteKind,
  mongoConsoleFolderToRecord,
  mongoEntityVersionToRecord,
  mongoFavouriteToRecord,
  mongoNotebookFolderToRecord,
  mongoNotebookIndexToRecord,
  mongoSavedConsoleToRecord,
  mongoScheduledQueryRunToRecord,
  optionalPgUuid,
  pgConsoleFolderToRecord,
  pgEntityVersionToRecord,
  pgFavouriteToRecord,
  pgNotebookFolderToRecord,
  pgNotebookIndexToRecord,
  pgSavedConsoleToRecord,
  pgScheduledQueryRunToRecord,
  toPgUuid,
  type ConsoleFolderRecord,
  type EntityVersionRecord,
  type FavouriteRecord,
  type MongoConsoleFolderLike,
  type MongoEntityVersionLike,
  type MongoFavouriteLike,
  type MongoNotebookFolderLike,
  type MongoNotebookIndexLike,
  type MongoSavedConsoleLike,
  type MongoScheduledQueryRunLike,
  type NotebookFolderRecord,
  type NotebookIndexRecord,
  type ReorderFavouriteUpdate,
  type SavedConsoleRecord,
  type ScheduledQueryRunRecord,
  type UserUuidResolver,
} from "../../repositories/consoles-charts";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import { recordMigrationTombstone } from "../router";
import { registerTtlRule } from "../ttl-reaper";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

export const SCHEDULED_QUERY_RUNS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type ConsolesChartsTableName =
  | "console_folders"
  | "saved_consoles"
  | "entity_versions"
  | "notebook_folders"
  | "notebook_indexes"
  | "favourites"
  | "scheduled_query_runs";

type BackfillStageName =
  | "console_folders"
  | "console_folders_parents"
  | "saved_consoles"
  | "entity_versions"
  | "notebook_folders"
  | "notebook_folders_parents"
  | "notebook_indexes"
  | "favourites"
  | "favourites_parents"
  | "scheduled_query_runs";

interface StageMeta {
  stage: number;
  name: BackfillStageName;
  table: ConsolesChartsTableName;
  collection: string;
}

const BACKFILL_STAGES: readonly StageMeta[] = [
  {
    stage: 1,
    name: "console_folders",
    table: "console_folders",
    collection: "consolefolders",
  },
  {
    stage: 2,
    name: "console_folders_parents",
    table: "console_folders",
    collection: "consolefolders",
  },
  {
    stage: 3,
    name: "saved_consoles",
    table: "saved_consoles",
    collection: "savedconsoles",
  },
  {
    stage: 4,
    name: "entity_versions",
    table: "entity_versions",
    collection: "entity_versions",
  },
  {
    stage: 5,
    name: "notebook_folders",
    table: "notebook_folders",
    collection: "notebookfolders",
  },
  {
    stage: 6,
    name: "notebook_folders_parents",
    table: "notebook_folders",
    collection: "notebookfolders",
  },
  {
    stage: 7,
    name: "notebook_indexes",
    table: "notebook_indexes",
    collection: "notebookindexes",
  },
  {
    stage: 8,
    name: "favourites",
    table: "favourites",
    collection: "favourites",
  },
  {
    stage: 9,
    name: "favourites_parents",
    table: "favourites",
    collection: "favourites",
  },
  {
    stage: 10,
    name: "scheduled_query_runs",
    table: "scheduled_query_runs",
    collection: "scheduled_query_runs",
  },
] as const;

const VERIFIER_TABLES: readonly {
  stage: number;
  table: ConsolesChartsTableName;
  collection: string;
}[] = [
  { stage: 1, table: "console_folders", collection: "consolefolders" },
  { stage: 2, table: "saved_consoles", collection: "savedconsoles" },
  { stage: 3, table: "entity_versions", collection: "entity_versions" },
  { stage: 4, table: "notebook_folders", collection: "notebookfolders" },
  { stage: 5, table: "notebook_indexes", collection: "notebookindexes" },
  { stage: 6, table: "favourites", collection: "favourites" },
  {
    stage: 7,
    table: "scheduled_query_runs",
    collection: "scheduled_query_runs",
  },
] as const;

type CompositeBackfillDoc =
  | { stage: "console_folders"; record: ConsoleFolderRecord }
  | {
      stage: "console_folders_parents";
      id: string;
      workspaceId: string;
      parentId: string;
    }
  | { stage: "saved_consoles"; record: SavedConsoleRecord }
  | {
      stage: "entity_versions";
      rawEntityType: string;
      record: EntityVersionRecord | null;
      workspaceId: string;
    }
  | { stage: "notebook_folders"; record: NotebookFolderRecord }
  | {
      stage: "notebook_folders_parents";
      id: string;
      workspaceId: string;
      parentId: string;
    }
  | { stage: "notebook_indexes"; record: NotebookIndexRecord }
  | {
      stage: "favourites";
      rawKind?: string | null;
      rawType: string;
      record: FavouriteRecord | null;
      workspaceId: string;
      rawUserId: string;
    }
  | {
      stage: "favourites_parents";
      id: string;
      workspaceId: string;
      parentId: string;
      updatedAt: Date;
    }
  | { stage: "scheduled_query_runs"; record: ScheduledQueryRunRecord };

function encodeCursor(stage: number, mongoId: string): string {
  return `${String(stage).padStart(2, "0")}:${mongoId}`;
}

function decodeCursor(
  cursor: string | null,
): { stage: number; mongoId: string } | null {
  if (!cursor) return null;
  const match = /^(\d{2}):(.*)$/.exec(cursor);
  if (!match) return null;
  return { stage: Number(match[1]), mongoId: match[2] };
}

function encodeVerifierKey(
  table: ConsolesChartsTableName,
  pgUuid: string,
): string {
  return `${table}:${pgUuid.toLowerCase()}`;
}

function decodeVerifierKey(
  key: string,
): { table: ConsolesChartsTableName; pgUuid: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as ConsolesChartsTableName,
    pgUuid: key.slice(idx + 1).toLowerCase(),
  };
}

function workspaceMongoFilter(
  workspaceId: string | null,
): Record<string, unknown> {
  if (!workspaceId) return {};
  const oid = parseEntityId(workspaceId)?.oid;
  return oid ? { workspaceId: new Types.ObjectId(oid) } : { _id: { $in: [] } };
}

function isValidEmbedding(embedding: unknown): boolean {
  if (embedding === undefined || embedding === null) return true;
  return (
    Array.isArray(embedding) &&
    embedding.length === 1536 &&
    embedding.every(v => typeof v === "number" && Number.isFinite(v))
  );
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

function makeDbUserResolver(db: MakoPgDb): UserUuidResolver {
  return async raw => {
    if (!raw || isNonUserSentinel(raw)) return null;
    const map = await resolvePgUserUuidsBatch(db, [raw]);
    return map.get(raw) ?? map.get(raw.toLowerCase()) ?? null;
  };
}

function workspacePgUuid(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  return optionalPgUuid(workspaceId);
}

function oidCursorFilter(afterId: string | null): Record<string, unknown> {
  if (!afterId || !isObjectIdHex(afterId)) return {};
  return { _id: { $gt: new Types.ObjectId(afterId) } };
}

async function resolvePgUserUuidsBatch(
  db: MakoPgDb,
  rawIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      rawIds.filter(
        (id): id is string => typeof id === "string" && !isNonUserSentinel(id),
      ),
    ),
  ];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const uuidCandidates = unique.filter(isUuidString).map(s => s.toLowerCase());
  const whereClause =
    uuidCandidates.length > 0
      ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, unique))
      : inArray(users.legacyId, unique);
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(whereClause);
  for (const row of rows) {
    const pgId = row.id.toLowerCase();
    out.set(pgId, pgId);
    if (row.legacyId) {
      out.set(row.legacyId, pgId);
      if (isUuidString(row.legacyId)) {
        out.set(row.legacyId.toLowerCase(), pgId);
      }
    }
  }
  return out;
}

function makeBatchResolver(map: ReadonlyMap<string, string>): UserUuidResolver {
  return raw => {
    if (!raw || isNonUserSentinel(raw)) return null;
    return map.get(raw) ?? map.get(raw.toLowerCase()) ?? null;
  };
}

async function pgWorkspaceExists(db: MakoPgDb, wsId: string): Promise<boolean> {
  const wsUuid = optionalPgUuid(wsId);
  if (!wsUuid) return false;
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, wsUuid))
    .limit(1);
  return rows.length > 0;
}

async function fetchStageBatch(
  meta: StageMeta,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
): Promise<Array<BackfillItem<CompositeBackfillDoc>>> {
  const baseFilter = {
    ...workspaceMongoFilter(workspaceId),
    ...oidCursorFilter(afterId),
  };

  switch (meta.name) {
    case "console_folders": {
      const docs = await ConsoleFolder.find(baseFilter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoConsoleFolderLike[]>();
      return docs.map(doc => {
        const record = mongoConsoleFolderToRecord(doc);
        return {
          cursor: encodeCursor(meta.stage, record.id),
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "console_folders",
          collectionName: "consolefolders",
          doc: { stage: "console_folders", record },
        };
      });
    }

    case "console_folders_parents": {
      const wsFilter = workspaceMongoFilter(workspaceId);
      const out: Array<BackfillItem<CompositeBackfillDoc>> = [];
      let cursor = afterId;
      while (out.length < limit) {
        const batchLimit = limit - out.length;
        const docs = await ConsoleFolder.find({
          ...wsFilter,
          ...oidCursorFilter(cursor),
          parentId: { $exists: true, $ne: null },
        })
          .select("_id workspaceId parentId")
          .sort({ _id: 1 })
          .limit(batchLimit)
          .lean<
            Array<{
              _id: Types.ObjectId;
              workspaceId: Types.ObjectId;
              parentId?: Types.ObjectId | null;
            }>
          >();
        if (docs.length === 0) break;
        cursor = docs[docs.length - 1]._id.toString();
        for (const d of docs) {
          if (!d.parentId) continue;
          const id = d._id.toString();
          const wsId = d.workspaceId.toString();
          out.push({
            cursor: encodeCursor(meta.stage, id),
            entityId: toPgUuid(id),
            workspaceId: wsId,
            targetTable: "console_folders",
            collectionName: "consolefolders",
            doc: {
              stage: "console_folders_parents" as const,
              id,
              workspaceId: wsId,
              parentId: d.parentId.toString(),
            },
          });
        }
        if (docs.length < batchLimit) break;
      }
      return out;
    }

    case "saved_consoles": {
      const docs = await SavedConsole.find(baseFilter)
        .select("+descriptionEmbedding")
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoSavedConsoleLike[]>();
      return docs.map(doc => {
        const record = mongoSavedConsoleToRecord(doc);
        return {
          cursor: encodeCursor(meta.stage, record.id),
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "saved_consoles",
          collectionName: "savedconsoles",
          doc: { stage: "saved_consoles", record },
        };
      });
    }

    case "entity_versions": {
      // Use raw collection so historical legacy `entityType: "dashboard"` rows
      // are seen, validated, and counted in `rowsQuarantined` without Mongoose enum rejection.
      const docs = (await EntityVersion.collection
        .find(baseFilter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoEntityVersionLike[];
      return docs.map(doc => {
        const id = doc._id.toString();
        const wsId = doc.workspaceId.toString();
        const rawEntityType = String(doc.entityType ?? "");
        return {
          cursor: encodeCursor(meta.stage, id),
          entityId: toPgUuid(id),
          workspaceId: wsId,
          targetTable: "entity_versions",
          collectionName: "entity_versions",
          doc: {
            stage: "entity_versions",
            rawEntityType,
            workspaceId: wsId,
            record:
              rawEntityType === "console"
                ? mongoEntityVersionToRecord(doc)
                : null,
          },
        };
      });
    }

    case "notebook_folders": {
      const docs = await NotebookFolder.find(baseFilter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoNotebookFolderLike[]>();
      return docs.map(doc => {
        const record = mongoNotebookFolderToRecord(doc);
        return {
          cursor: encodeCursor(meta.stage, record.id),
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "notebook_folders",
          collectionName: "notebookfolders",
          doc: { stage: "notebook_folders", record },
        };
      });
    }

    case "notebook_folders_parents": {
      const wsFilter = workspaceMongoFilter(workspaceId);
      const out: Array<BackfillItem<CompositeBackfillDoc>> = [];
      let cursor = afterId;
      while (out.length < limit) {
        const batchLimit = limit - out.length;
        const docs = await NotebookFolder.find({
          ...wsFilter,
          ...oidCursorFilter(cursor),
          parentId: { $exists: true, $ne: null },
        })
          .select("_id workspaceId parentId")
          .sort({ _id: 1 })
          .limit(batchLimit)
          .lean<
            Array<{
              _id: Types.ObjectId;
              workspaceId: Types.ObjectId;
              parentId?: Types.ObjectId | null;
            }>
          >();
        if (docs.length === 0) break;
        cursor = docs[docs.length - 1]._id.toString();
        for (const d of docs) {
          if (!d.parentId) continue;
          const id = d._id.toString();
          const wsId = d.workspaceId.toString();
          out.push({
            cursor: encodeCursor(meta.stage, id),
            entityId: toPgUuid(id),
            workspaceId: wsId,
            targetTable: "notebook_folders",
            collectionName: "notebookfolders",
            doc: {
              stage: "notebook_folders_parents" as const,
              id,
              workspaceId: wsId,
              parentId: d.parentId.toString(),
            },
          });
        }
        if (docs.length < batchLimit) break;
      }
      return out;
    }

    case "notebook_indexes": {
      const docs = await NotebookIndex.find(baseFilter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoNotebookIndexLike[]>();
      return docs.map(doc => {
        const record = mongoNotebookIndexToRecord(doc);
        return {
          cursor: encodeCursor(meta.stage, record.id),
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "notebook_indexes",
          collectionName: "notebookindexes",
          doc: { stage: "notebook_indexes", record },
        };
      });
    }

    case "favourites": {
      // Raw collection so legacy `kind: "dashboard"` rows are skipped & recorded cleanly.
      const docs = (await Favourite.collection
        .find(baseFilter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoFavouriteLike[];
      return docs.map(doc => {
        const id = doc._id.toString();
        const wsId = doc.workspaceId.toString();
        const rawType = String(doc.type ?? "");
        const rawKind = doc.kind ?? null;
        const valid =
          rawType === "folder" ||
          (rawType === "item" &&
            isValidFavouriteKind(rawKind) &&
            Boolean(doc.refId));
        return {
          cursor: encodeCursor(meta.stage, id),
          entityId: toPgUuid(id),
          workspaceId: wsId,
          targetTable: "favourites",
          collectionName: "favourites",
          doc: {
            stage: "favourites",
            rawType,
            rawKind,
            workspaceId: wsId,
            rawUserId: String(doc.userId ?? ""),
            record: valid ? mongoFavouriteToRecord(doc) : null,
          },
        };
      });
    }

    case "favourites_parents": {
      const wsFilter = workspaceMongoFilter(workspaceId);
      const out: Array<BackfillItem<CompositeBackfillDoc>> = [];
      let cursor = afterId;
      while (out.length < limit) {
        const batchLimit = limit - out.length;
        const docs = (await Favourite.collection
          .find({
            ...wsFilter,
            ...oidCursorFilter(cursor),
            parentId: { $exists: true, $nin: [null, ""] },
          })
          .project({
            _id: 1,
            workspaceId: 1,
            parentId: 1,
            updatedAt: 1,
            createdAt: 1,
          })
          .sort({ _id: 1 })
          .limit(batchLimit)
          .toArray()) as unknown as Array<{
          _id: Types.ObjectId;
          workspaceId: Types.ObjectId;
          parentId?: string | Types.ObjectId | null;
          updatedAt?: Date | string | null;
          createdAt?: Date | string | null;
        }>;
        if (docs.length === 0) break;
        cursor = docs[docs.length - 1]._id.toString();
        for (const d of docs) {
          if (d.parentId == null || String(d.parentId).length === 0) continue;
          const id = d._id.toString();
          const wsId = d.workspaceId.toString();
          const updatedAt = d.updatedAt
            ? new Date(d.updatedAt)
            : d.createdAt
              ? new Date(d.createdAt)
              : new Date(0);
          out.push({
            cursor: encodeCursor(meta.stage, id),
            entityId: toPgUuid(id),
            workspaceId: wsId,
            targetTable: "favourites",
            collectionName: "favourites",
            doc: {
              stage: "favourites_parents",
              id,
              workspaceId: wsId,
              parentId: String(d.parentId),
              updatedAt,
            },
          });
        }
        if (docs.length < batchLimit) break;
      }
      return out;
    }

    case "scheduled_query_runs": {
      const docs = await ScheduledQueryRun.find(baseFilter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoScheduledQueryRunLike[]>();
      return docs.map(doc => {
        const record = mongoScheduledQueryRunToRecord(doc);
        return {
          cursor: encodeCursor(meta.stage, record.id),
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          targetTable: "scheduled_query_runs",
          collectionName: "scheduled_query_runs",
          doc: { stage: "scheduled_query_runs", record },
        };
      });
    }
  }
}

interface BatchValidationContext {
  consoleFolderIds: Set<string>;
  savedConsoleIds: Set<string>;
  notebookFolderIds: Set<string>;
  favouriteIds: Set<string>;
}

function createBatchValidationContext(): BatchValidationContext {
  return {
    consoleFolderIds: new Set<string>(),
    savedConsoleIds: new Set<string>(),
    notebookFolderIds: new Set<string>(),
    favouriteIds: new Set<string>(),
  };
}

function clearBatchValidationContext(ctx: BatchValidationContext): void {
  ctx.consoleFolderIds.clear();
  ctx.savedConsoleIds.clear();
  ctx.notebookFolderIds.clear();
  ctx.favouriteIds.clear();
}

async function validateCompositeItem(
  item: BackfillItem<CompositeBackfillDoc>,
  db: MakoPgDb,
  batchCtx: BatchValidationContext,
): Promise<BackfillValidationResult> {
  const payload = item.doc;

  switch (payload.stage) {
    case "entity_versions": {
      if (payload.rawEntityType !== "console" || !payload.record) {
        return {
          ok: false,
          reason:
            payload.rawEntityType === "dashboard"
              ? "legacy_dashboard_entity_version"
              : `legacy_entity_type_${payload.rawEntityType || "unknown"}`,
        };
      }
      if (!(await pgWorkspaceExists(db, payload.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      return { ok: true };
    }

    case "favourites": {
      if (payload.rawType === "item" && payload.rawKind === "dashboard") {
        return { ok: false, reason: "legacy_dashboard_favourite" };
      }
      if (!payload.record) {
        return {
          ok: false,
          reason: `invalid_favourite_${payload.rawType}_${payload.rawKind ?? "null"}`,
        };
      }
      if (!(await pgWorkspaceExists(db, payload.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      const userMap = await resolvePgUserUuidsBatch(db, [payload.rawUserId]);
      if (!makeBatchResolver(userMap)(payload.rawUserId)) {
        return { ok: false, reason: "orphan_user_id" };
      }
      batchCtx.favouriteIds.add(toPgUuid(payload.record.id).toLowerCase());
      return { ok: true };
    }

    case "scheduled_query_runs": {
      if (!(await pgWorkspaceExists(db, payload.record.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      const consoleUuid = optionalPgUuid(payload.record.consoleId);
      if (!consoleUuid) {
        return { ok: false, reason: "invalid_console_id" };
      }
      return { ok: true };
    }

    case "console_folders_parents": {
      const parentUuid = optionalPgUuid(payload.parentId);
      if (!parentUuid) return { ok: false, reason: "invalid_parent_id" };
      if (batchCtx.consoleFolderIds.has(parentUuid.toLowerCase())) {
        return { ok: true };
      }
      const exists = await db
        .select({ id: consoleFolders.id })
        .from(consoleFolders)
        .where(eq(consoleFolders.id, parentUuid))
        .limit(1);
      if (exists.length === 0) {
        return { ok: false, reason: "orphan_parent_folder" };
      }
      return { ok: true };
    }

    case "notebook_folders_parents": {
      const parentUuid = optionalPgUuid(payload.parentId);
      if (!parentUuid) return { ok: false, reason: "invalid_parent_id" };
      if (batchCtx.notebookFolderIds.has(parentUuid.toLowerCase())) {
        return { ok: true };
      }
      const exists = await db
        .select({ id: notebookFolders.id })
        .from(notebookFolders)
        .where(eq(notebookFolders.id, parentUuid))
        .limit(1);
      if (exists.length === 0) {
        return { ok: false, reason: "orphan_parent_folder" };
      }
      return { ok: true };
    }

    case "favourites_parents": {
      const parentUuid = optionalPgUuid(payload.parentId);
      if (!parentUuid) return { ok: false, reason: "invalid_parent_id" };
      if (batchCtx.favouriteIds.has(parentUuid.toLowerCase())) {
        return { ok: true };
      }
      const exists = await db
        .select({ id: favourites.id })
        .from(favourites)
        .where(eq(favourites.id, parentUuid))
        .limit(1);
      if (exists.length === 0) {
        return { ok: false, reason: "orphan_parent_favourite" };
      }
      return { ok: true };
    }

    case "console_folders": {
      if (!(await pgWorkspaceExists(db, payload.record.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      batchCtx.consoleFolderIds.add(toPgUuid(payload.record.id).toLowerCase());
      return { ok: true };
    }

    case "saved_consoles": {
      if (!(await pgWorkspaceExists(db, payload.record.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      if (!isValidEmbedding(payload.record.descriptionEmbedding)) {
        return { ok: false, reason: "invalid_embedding_dimensions" };
      }
      batchCtx.savedConsoleIds.add(toPgUuid(payload.record.id).toLowerCase());
      return { ok: true };
    }

    case "notebook_folders": {
      if (!(await pgWorkspaceExists(db, payload.record.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      batchCtx.notebookFolderIds.add(toPgUuid(payload.record.id).toLowerCase());
      return { ok: true };
    }

    case "notebook_indexes": {
      if (!(await pgWorkspaceExists(db, payload.record.workspaceId))) {
        return { ok: false, reason: "orphan_workspace_id" };
      }
      return { ok: true };
    }
  }
}

async function upsertCompositeBatch(
  items: Array<BackfillItem<CompositeBackfillDoc>>,
  db: MakoPgDb,
  options: { ignoreUpdatedAtGuard?: boolean } = {},
): Promise<number> {
  if (items.length === 0) return 0;

  // Collect all user IDs in this batch for a single PG lookup.
  const rawUserIds: Array<string | null | undefined> = [];
  for (const item of items) {
    const d = item.doc;
    if (d.stage === "console_folders") rawUserIds.push(d.record.ownerId);
    else if (d.stage === "saved_consoles") {
      rawUserIds.push(
        d.record.createdBy,
        d.record.owner_id,
        d.record.lastRun?.runBy,
      );
      for (const s of d.record.sharedWith) {
        rawUserIds.push(s.userId, s.addedBy);
      }
    } else if (d.stage === "entity_versions" && d.record) {
      rawUserIds.push(d.record.savedBy);
    } else if (d.stage === "notebook_folders") {
      rawUserIds.push(d.record.ownerId);
    } else if (d.stage === "notebook_indexes") {
      rawUserIds.push(d.record.ownerId);
      for (const s of d.record.sharedWith) {
        rawUserIds.push(s.userId, s.addedBy);
      }
    } else if (d.stage === "favourites" && d.record) {
      rawUserIds.push(d.record.userId);
    } else if (d.stage === "scheduled_query_runs") {
      rawUserIds.push(d.record.triggeredBy);
    }
  }

  const userMap = await resolvePgUserUuidsBatch(db, rawUserIds);
  const pgRepo = new PgConsolesChartsRepository({
    getDb: () => db,
    resolveUserUuid: makeBatchResolver(userMap),
  });

  // Pre-fetch existing folder IDs (and database_connections IDs once 0005a FK is
  // attached) for saved_consoles / notebook_indexes so dangling deleted references
  // null out cleanly instead of failing FK 23503.
  const consoleFolderIds = new Set<string>();
  const consoleConnectionIds = new Set<string>();
  const notebookFolderIds = new Set<string>();
  for (const item of items) {
    if (item.doc.stage === "saved_consoles") {
      if (item.doc.record.folderId) {
        const fUuid = optionalPgUuid(item.doc.record.folderId);
        if (fUuid) consoleFolderIds.add(fUuid);
      }
      if (item.doc.record.connectionId) {
        const cUuid = optionalPgUuid(item.doc.record.connectionId);
        if (cUuid) consoleConnectionIds.add(cUuid);
      }
    }
    if (item.doc.stage === "notebook_indexes" && item.doc.record.folderId) {
      const fUuid = optionalPgUuid(item.doc.record.folderId);
      if (fUuid) notebookFolderIds.add(fUuid);
    }
  }
  const existingConsoleFolders = new Set<string>();
  if (consoleFolderIds.size > 0) {
    const rows = await db
      .select({ id: consoleFolders.id })
      .from(consoleFolders)
      .where(inArray(consoleFolders.id, [...consoleFolderIds]));
    for (const r of rows) existingConsoleFolders.add(r.id.toLowerCase());
  }
  const existingConnections = new Set<string>();
  const validateConnections =
    consoleConnectionIds.size > 0 && (await hasConsolesConnectionFk(db));
  if (validateConnections) {
    const rows = await db
      .select({ id: databaseConnections.id })
      .from(databaseConnections)
      .where(inArray(databaseConnections.id, [...consoleConnectionIds]));
    for (const r of rows) existingConnections.add(r.id.toLowerCase());
  }
  const existingNotebookFolders = new Set<string>();
  if (notebookFolderIds.size > 0) {
    const rows = await db
      .select({ id: notebookFolders.id })
      .from(notebookFolders)
      .where(inArray(notebookFolders.id, [...notebookFolderIds]));
    for (const r of rows) existingNotebookFolders.add(r.id.toLowerCase());
  }

  let upserted = 0;
  for (const item of items) {
    const d = item.doc;
    switch (d.stage) {
      case "console_folders": {
        // Pass 1: insert with parentId cleared so child-before-parent never fails FK.
        // Without `ignoreUpdatedAtGuard`, `onConflictDoNothing` preserves live Stage 2 rows.
        await pgRepo.upsertConsoleFolder(
          { ...d.record, parentId: undefined },
          { db, ignoreUpdatedAtGuard: options.ignoreUpdatedAtGuard },
        );
        upserted += 1;
        break;
      }
      case "console_folders_parents": {
        const whereCond = options.ignoreUpdatedAtGuard
          ? eq(consoleFolders.id, toPgUuid(d.id))
          : and(
              eq(consoleFolders.id, toPgUuid(d.id)),
              isNull(consoleFolders.parentId),
            );
        await db
          .update(consoleFolders)
          .set({ parentId: toPgUuid(d.parentId) })
          .where(whereCond);
        upserted += 1;
        break;
      }
      case "saved_consoles": {
        const folderUuid = optionalPgUuid(d.record.folderId);
        const safeFolderId =
          folderUuid && existingConsoleFolders.has(folderUuid)
            ? d.record.folderId
            : undefined;
        let safeConnectionId = d.record.connectionId;
        if (validateConnections && safeConnectionId) {
          const connUuid = optionalPgUuid(safeConnectionId);
          if (!connUuid || !existingConnections.has(connUuid)) {
            safeConnectionId = undefined;
          }
        }
        await pgRepo.upsertConsole(
          {
            ...d.record,
            folderId: safeFolderId,
            connectionId: safeConnectionId,
          },
          {
            db,
            ignoreUpdatedAtGuard: options.ignoreUpdatedAtGuard,
            connectionValidated: true,
          },
        );
        upserted += 1;
        break;
      }
      case "entity_versions": {
        if (!d.record) break;
        await pgRepo.upsertEntityVersion(d.record, db);
        upserted += 1;
        break;
      }
      case "notebook_folders": {
        // Pass 1: parentId cleared; `onConflictDoNothing` preserves live Stage 2 rows.
        await pgRepo.upsertNotebookFolder(
          { ...d.record, parentId: undefined },
          { db, ignoreUpdatedAtGuard: options.ignoreUpdatedAtGuard },
        );
        upserted += 1;
        break;
      }
      case "notebook_folders_parents": {
        const whereCond = options.ignoreUpdatedAtGuard
          ? eq(notebookFolders.id, toPgUuid(d.id))
          : and(
              eq(notebookFolders.id, toPgUuid(d.id)),
              isNull(notebookFolders.parentId),
            );
        await db
          .update(notebookFolders)
          .set({ parentId: toPgUuid(d.parentId) })
          .where(whereCond);
        upserted += 1;
        break;
      }
      case "notebook_indexes": {
        const folderUuid = optionalPgUuid(d.record.folderId);
        const safeFolderId =
          folderUuid && existingNotebookFolders.has(folderUuid)
            ? d.record.folderId
            : undefined;
        await pgRepo.upsertNotebookIndex(
          { ...d.record, folderId: safeFolderId },
          { db, ignoreUpdatedAtGuard: options.ignoreUpdatedAtGuard },
        );
        upserted += 1;
        break;
      }
      case "favourites": {
        if (!d.record) break;
        // Pass 1: insert with parentId = null; preserve existing parentId on conflict.
        await pgRepo.upsertFavourite(
          { ...d.record, parentId: null },
          {
            db,
            ignoreUpdatedAtGuard: options.ignoreUpdatedAtGuard,
            preserveParentOnConflict: !options.ignoreUpdatedAtGuard,
          },
        );
        upserted += 1;
        break;
      }
      case "favourites_parents": {
        const whereCond = options.ignoreUpdatedAtGuard
          ? eq(favourites.id, toPgUuid(d.id))
          : and(
              eq(favourites.id, toPgUuid(d.id)),
              or(
                isNull(favourites.updatedAt),
                lte(favourites.updatedAt, d.updatedAt),
              ),
            );
        await db
          .update(favourites)
          .set({ parentId: toPgUuid(d.parentId) })
          .where(whereCond);
        upserted += 1;
        break;
      }
      case "scheduled_query_runs": {
        await pgRepo.upsertScheduledQueryRun(d.record, {
          db,
          ignoreUpdatedAtGuard: options.ignoreUpdatedAtGuard,
        });
        upserted += 1;
        break;
      }
    }
  }
  return upserted;
}

export function createConsolesChartsBackfillHandler(): BackfillDomainHandler<CompositeBackfillDoc> {
  const batchCtx = createBatchValidationContext();
  return {
    domain: CONSOLES_CHARTS_DOMAIN,
    collectionName: "consoles_charts",
    targetTable: "saved_consoles",
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      clearBatchValidationContext(batchCtx);
      const decoded = decodeCursor(afterCursor);
      const startStage = decoded?.stage ?? 1;
      const items: Array<BackfillItem<CompositeBackfillDoc>> = [];

      for (const meta of BACKFILL_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        const stageAfter =
          decoded && decoded.stage === meta.stage ? decoded.mongoId : null;
        const batch = await fetchStageBatch(
          meta,
          stageAfter,
          remaining,
          workspaceId,
        );
        items.push(...batch);
      }
      return items;
    },
    validate: (item, db) => validateCompositeItem(item, db, batchCtx),
    upsertBatch: (items, db) => upsertCompositeBatch(items, db),
  };
}

function createSingleTableBackfillHandler(
  table: ConsolesChartsTableName,
): BackfillDomainHandler<CompositeBackfillDoc> {
  const stages = BACKFILL_STAGES.filter(s => s.table === table);
  const batchCtx = createBatchValidationContext();
  return {
    domain: `${CONSOLES_CHARTS_DOMAIN}:${table}`,
    collectionName: stages[0].collection,
    targetTable: table,
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      clearBatchValidationContext(batchCtx);
      const decoded = decodeCursor(afterCursor);
      let startIdx = decoded
        ? stages.findIndex(s => s.stage === decoded.stage)
        : 0;
      if (startIdx < 0) startIdx = 0;
      const items: Array<BackfillItem<CompositeBackfillDoc>> = [];

      for (let idx = startIdx; idx < stages.length; idx++) {
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        const meta = stages[idx];
        const stageAfter =
          decoded && decoded.stage === meta.stage ? decoded.mongoId : null;
        const batch = await fetchStageBatch(
          meta,
          stageAfter,
          remaining,
          workspaceId,
        );
        items.push(...batch);
      }
      return items;
    },
    validate: (item, db) => validateCompositeItem(item, db, batchCtx),
    upsertBatch: (items, db) => upsertCompositeBatch(items, db),
  };
}

// ── Parity Verifier & --repair ──────────────────────────────────────────────

function normalizeRecordUserIdsForCompare(
  table: ConsolesChartsTableName,
  record: unknown,
  resolve: UserUuidResolver,
): unknown {
  const normOpt = (v: string | undefined): string | undefined => {
    if (!v || isNonUserSentinel(v)) return undefined;
    const resolved = resolve(v);
    return typeof resolved === "string" ? resolved : undefined;
  };
  const normShares = (
    entries: Array<{
      userId: string;
      role: string;
      addedAt: Date;
      addedBy?: string;
    }>,
  ) =>
    entries.map(e => ({
      userId: normOpt(e.userId) ?? e.userId,
      role: e.role,
      addedAt: e.addedAt,
      ...(e.addedBy ? { addedBy: normOpt(e.addedBy) ?? e.addedBy } : {}),
    }));

  switch (table) {
    case "console_folders": {
      const r = record as ConsoleFolderRecord;
      return { ...r, ownerId: normOpt(r.ownerId) };
    }
    case "saved_consoles": {
      const r = record as SavedConsoleRecord;
      return {
        ...r,
        createdBy: normOpt(r.createdBy) ?? "",
        owner_id: normOpt(r.owner_id),
        sharedWith: normShares(r.sharedWith),
        ...(r.lastRun
          ? {
              lastRun: {
                ...r.lastRun,
                runBy: normOpt(r.lastRun.runBy) ?? r.lastRun.runBy,
              },
            }
          : {}),
        // Embeddings are compared by existence/length rather than float32 rounding noise.
        descriptionEmbedding: r.descriptionEmbedding
          ? r.descriptionEmbedding.length
          : undefined,
      };
    }
    case "entity_versions": {
      const r = record as EntityVersionRecord;
      return { ...r, savedBy: normOpt(r.savedBy) ?? "" };
    }
    case "notebook_folders": {
      const r = record as NotebookFolderRecord;
      return { ...r, ownerId: normOpt(r.ownerId) };
    }
    case "notebook_indexes": {
      const r = record as NotebookIndexRecord;
      return {
        ...r,
        ownerId: normOpt(r.ownerId) ?? "system",
        sharedWith: normShares(r.sharedWith),
      };
    }
    case "favourites": {
      const r = record as FavouriteRecord;
      return { ...r, userId: normOpt(r.userId) ?? r.userId };
    }
    case "scheduled_query_runs": {
      const r = record as ScheduledQueryRunRecord;
      return { ...r, triggeredBy: normOpt(r.triggeredBy) };
    }
  }
}

async function fetchExistingPgIds(
  db: MakoPgDb,
  tableRef:
    | typeof consoleFolders
    | typeof databaseConnections
    | typeof notebookFolders
    | typeof favourites
    | typeof savedConsoles,
  rawIds: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const uuids = [
    ...new Set(
      rawIds.map(v => optionalPgUuid(v)).filter((u): u is string => u !== null),
    ),
  ];
  const existing = new Set<string>();
  if (uuids.length === 0) return existing;
  const rows = await db
    .select({ id: tableRef.id })
    .from(tableRef)
    .where(inArray(tableRef.id, uuids));
  for (const r of rows) existing.add(r.id.toLowerCase());
  return existing;
}

async function fetchMongoTableVerifierBatch(
  table: ConsolesChartsTableName,
  stage: number,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
  db: MakoPgDb,
  compositeKey: boolean,
): Promise<VerifierMongoRecord[]> {
  const wsFilter = workspaceMongoFilter(workspaceId);
  const out: VerifierMongoRecord[] = [];
  let cursor = afterId;

  while (out.length < limit) {
    const remaining = limit - out.length;
    const baseFilter = {
      ...wsFilter,
      ...oidCursorFilter(cursor),
    };

    let rawRecords: Array<{
      id: string;
      workspaceId: string;
      record: unknown;
      userIds: Array<string | undefined>;
    }> = [];

    switch (table) {
      case "console_folders": {
        const docs = await ConsoleFolder.find(baseFilter)
          .sort({ _id: 1 })
          .limit(remaining)
          .lean<MongoConsoleFolderLike[]>();
        rawRecords = docs.map(d => {
          const rec = mongoConsoleFolderToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [rec.ownerId],
          };
        });
        break;
      }
      case "saved_consoles": {
        const docs = await SavedConsole.find(baseFilter)
          .select("+descriptionEmbedding")
          .sort({ _id: 1 })
          .limit(remaining)
          .lean<MongoSavedConsoleLike[]>();
        rawRecords = docs.map(d => {
          const rec = mongoSavedConsoleToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [
              rec.createdBy,
              rec.owner_id,
              rec.lastRun?.runBy,
              ...rec.sharedWith.flatMap(s => [s.userId, s.addedBy]),
            ],
          };
        });
        break;
      }
      case "entity_versions": {
        const docs = (await EntityVersion.collection
          .find({ ...baseFilter, entityType: "console" })
          .sort({ _id: 1 })
          .limit(remaining)
          .toArray()) as unknown as MongoEntityVersionLike[];
        rawRecords = docs.map(d => {
          const rec = mongoEntityVersionToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [rec.savedBy],
          };
        });
        break;
      }
      case "notebook_folders": {
        const docs = await NotebookFolder.find(baseFilter)
          .sort({ _id: 1 })
          .limit(remaining)
          .lean<MongoNotebookFolderLike[]>();
        rawRecords = docs.map(d => {
          const rec = mongoNotebookFolderToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [rec.ownerId],
          };
        });
        break;
      }
      case "notebook_indexes": {
        const docs = await NotebookIndex.find(baseFilter)
          .sort({ _id: 1 })
          .limit(remaining)
          .lean<MongoNotebookIndexLike[]>();
        rawRecords = docs.map(d => {
          const rec = mongoNotebookIndexToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [
              rec.ownerId,
              ...rec.sharedWith.flatMap(s => [s.userId, s.addedBy]),
            ],
          };
        });
        break;
      }
      case "favourites": {
        const docs = (await Favourite.collection
          .find({
            ...baseFilter,
            $or: [
              { type: "folder" },
              { type: "item", kind: { $in: ["app", "console", "notebook"] } },
            ],
          })
          .sort({ _id: 1 })
          .limit(remaining)
          .toArray()) as unknown as MongoFavouriteLike[];
        rawRecords = docs.map(d => {
          const rec = mongoFavouriteToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [rec.userId],
          };
        });
        break;
      }
      case "scheduled_query_runs": {
        const docs = await ScheduledQueryRun.find(baseFilter)
          .sort({ _id: 1 })
          .limit(remaining)
          .lean<MongoScheduledQueryRunLike[]>();
        rawRecords = docs.map(d => {
          const rec = mongoScheduledQueryRunToRecord(d);
          return {
            id: rec.id,
            workspaceId: rec.workspaceId,
            record: rec,
            userIds: [rec.triggeredBy],
          };
        });
        break;
      }
    }

    if (rawRecords.length === 0) break;
    cursor = rawRecords[rawRecords.length - 1].id;

    // Skip rows from orphan/deleted workspaces (quarantined by backfill & skipped by --repair).
    const validWorkspaces = await filterExistingPgWorkspaces(
      db,
      rawRecords.map(r => r.workspaceId),
    );
    const wsScoped = rawRecords.filter(r => {
      const wsUuid = optionalPgUuid(r.workspaceId);
      return wsUuid !== null && validWorkspaces.has(wsUuid);
    });
    if (wsScoped.length === 0) {
      if (rawRecords.length < remaining) break;
      continue;
    }

    const userMap = await resolvePgUserUuidsBatch(
      db,
      wsScoped.flatMap(r => r.userIds),
    );
    const resolver = makeBatchResolver(userMap);

    // Pre-fetch PG FK targets so dangling folderId/parentId/connectionId normalize
    // identically to backfill & --repair. (`scheduled_query_runs.console_id` is a
    // soft ref so run history survives workspace repo disconnect/reconnect.)
    let validParentOrFolderUuids: Set<string> | null = null;
    let validConnectionUuids: Set<string> | null = null;
    if (table === "console_folders") {
      validParentOrFolderUuids = await fetchExistingPgIds(
        db,
        consoleFolders,
        wsScoped.map(r => (r.record as ConsoleFolderRecord).parentId),
      );
    } else if (table === "saved_consoles") {
      validParentOrFolderUuids = await fetchExistingPgIds(
        db,
        consoleFolders,
        wsScoped.map(r => (r.record as SavedConsoleRecord).folderId),
      );
      if (await hasConsolesConnectionFk(db)) {
        validConnectionUuids = await fetchExistingPgIds(
          db,
          databaseConnections,
          wsScoped.map(r => (r.record as SavedConsoleRecord).connectionId),
        );
      }
    } else if (table === "notebook_folders") {
      validParentOrFolderUuids = await fetchExistingPgIds(
        db,
        notebookFolders,
        wsScoped.map(r => (r.record as NotebookFolderRecord).parentId),
      );
    } else if (table === "notebook_indexes") {
      validParentOrFolderUuids = await fetchExistingPgIds(
        db,
        notebookFolders,
        wsScoped.map(r => (r.record as NotebookIndexRecord).folderId),
      );
    } else if (table === "favourites") {
      validParentOrFolderUuids = await fetchExistingPgIds(
        db,
        favourites,
        wsScoped.map(r => (r.record as FavouriteRecord).parentId),
      );
    }

    for (const r of wsScoped) {
      let record = r.record;
      if (table === "saved_consoles") {
        let rec = record as SavedConsoleRecord;
        if (!isValidEmbedding(rec.descriptionEmbedding)) continue;
        if (rec.folderId && validParentOrFolderUuids) {
          const fUuid = optionalPgUuid(rec.folderId);
          if (!fUuid || !validParentOrFolderUuids.has(fUuid)) {
            const copy = { ...rec };
            delete copy.folderId;
            rec = copy;
          }
        }
        if (rec.connectionId && validConnectionUuids) {
          const cUuid = optionalPgUuid(rec.connectionId);
          if (!cUuid || !validConnectionUuids.has(cUuid)) {
            const copy = { ...rec };
            delete copy.connectionId;
            rec = copy;
          }
        }
        record = rec;
      } else if (table === "console_folders") {
        const rec = record as ConsoleFolderRecord;
        if (rec.parentId && validParentOrFolderUuids) {
          const pUuid = optionalPgUuid(rec.parentId);
          if (!pUuid || !validParentOrFolderUuids.has(pUuid)) {
            const copy = { ...rec };
            delete copy.parentId;
            record = copy;
          }
        }
      } else if (table === "notebook_folders") {
        const rec = record as NotebookFolderRecord;
        if (rec.parentId && validParentOrFolderUuids) {
          const pUuid = optionalPgUuid(rec.parentId);
          if (!pUuid || !validParentOrFolderUuids.has(pUuid)) {
            const copy = { ...rec };
            delete copy.parentId;
            record = copy;
          }
        }
      } else if (table === "notebook_indexes") {
        const rec = record as NotebookIndexRecord;
        if (rec.folderId && validParentOrFolderUuids) {
          const fUuid = optionalPgUuid(rec.folderId);
          if (!fUuid || !validParentOrFolderUuids.has(fUuid)) {
            const copy = { ...rec };
            delete copy.folderId;
            record = copy;
          }
        }
      } else if (table === "favourites") {
        const rec = record as FavouriteRecord;
        if (!resolver(rec.userId)) continue;
        if (rec.parentId && validParentOrFolderUuids) {
          const pUuid = optionalPgUuid(rec.parentId);
          if (!pUuid || !validParentOrFolderUuids.has(pUuid)) {
            record = { ...rec, parentId: null };
          }
        }
      } else if (table === "scheduled_query_runs") {
        if (!optionalPgUuid((record as ScheduledQueryRunRecord).consoleId)) {
          continue;
        }
      }

      const pgUuid = toPgUuid(r.id);
      out.push({
        cursor: compositeKey ? encodeCursor(stage, r.id) : r.id,
        entityId: compositeKey ? encodeVerifierKey(table, pgUuid) : pgUuid,
        targetTable: table,
        tombstoneId: pgUuid,
        record: normalizeRecordUserIdsForCompare(table, record, resolver),
      });
    }

    if (rawRecords.length < remaining) break;
  }

  return out;
}

async function fetchPgTableRecordsByUuids(
  table: ConsolesChartsTableName,
  uuids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (uuids.length === 0) return out;
  const identityResolver: UserUuidResolver = id =>
    isUuidString(id) ? id.toLowerCase() : null;

  switch (table) {
    case "console_folders": {
      const rows = await db
        .select()
        .from(consoleFolders)
        .where(inArray(consoleFolders.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgConsoleFolderToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
    case "saved_consoles": {
      const rows = await db
        .select({
          id: savedConsoles.id,
          workspaceId: savedConsoles.workspaceId,
          folderId: savedConsoles.folderId,
          connectionId: savedConsoles.connectionId,
          databaseName: savedConsoles.databaseName,
          databaseId: savedConsoles.databaseId,
          name: savedConsoles.name,
          description: savedConsoles.description,
          descriptionEmbedding: savedConsoles.descriptionEmbedding,
          embeddingModel: savedConsoles.embeddingModel,
          descriptionGeneratedAt: savedConsoles.descriptionGeneratedAt,
          path: savedConsoles.path,
          sourceBlobSha: savedConsoles.sourceBlobSha,
          descriptionSourceSha: savedConsoles.descriptionSourceSha,
          descriptionSource: savedConsoles.descriptionSource,
          code: savedConsoles.code,
          language: savedConsoles.language,
          chartSpec: savedConsoles.chartSpec,
          resultsViewMode: savedConsoles.resultsViewMode,
          mongoOptions: savedConsoles.mongoOptions,
          createdBy: savedConsoles.createdBy,
          ownerId: savedConsoles.ownerId,
          isPrivate: savedConsoles.isPrivate,
          isSaved: savedConsoles.isSaved,
          access: savedConsoles.access,
          workspaceRole: savedConsoles.workspaceRole,
          sharedWith: savedConsoles.sharedWith,
          scheduleCron: savedConsoles.scheduleCron,
          scheduleTimezone: savedConsoles.scheduleTimezone,
          scheduledRunNextAt: savedConsoles.scheduledRunNextAt,
          scheduledRunLastAt: savedConsoles.scheduledRunLastAt,
          scheduledRunLastStatus: savedConsoles.scheduledRunLastStatus,
          scheduledRunLastError: savedConsoles.scheduledRunLastError,
          scheduledRunLastDurationMs: savedConsoles.scheduledRunLastDurationMs,
          scheduledRunLastRowsAffected:
            savedConsoles.scheduledRunLastRowsAffected,
          scheduledRunLastRowCount: savedConsoles.scheduledRunLastRowCount,
          scheduledRunCount: savedConsoles.scheduledRunCount,
          scheduledRunConsecutiveFailures:
            savedConsoles.scheduledRunConsecutiveFailures,
          scheduledRunPermanentFailures:
            savedConsoles.scheduledRunPermanentFailures,
          scheduledRunPausedAt: savedConsoles.scheduledRunPausedAt,
          scheduledRunPausedReason: savedConsoles.scheduledRunPausedReason,
          version: savedConsoles.version,
          draftRevision: savedConsoles.draftRevision,
          lastDraftOrigin: savedConsoles.lastDraftOrigin,
          lastRun: savedConsoles.lastRun,
          lastExecutedAt: savedConsoles.lastExecutedAt,
          executionCount: savedConsoles.executionCount,
          lastExternalUsedAt: savedConsoles.lastExternalUsedAt,
          externalUseCount: savedConsoles.externalUseCount,
          lastExternalSource: savedConsoles.lastExternalSource,
          isDeleted: savedConsoles.isDeleted,
          deletedAt: savedConsoles.deletedAt,
          createdAt: savedConsoles.createdAt,
          updatedAt: savedConsoles.updatedAt,
        })
        .from(savedConsoles)
        .where(inArray(savedConsoles.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgSavedConsoleToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
    case "entity_versions": {
      const rows = await db
        .select()
        .from(entityVersions)
        .where(inArray(entityVersions.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgEntityVersionToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
    case "notebook_folders": {
      const rows = await db
        .select()
        .from(notebookFolders)
        .where(inArray(notebookFolders.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgNotebookFolderToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
    case "notebook_indexes": {
      const rows = await db
        .select()
        .from(notebookIndexes)
        .where(inArray(notebookIndexes.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgNotebookIndexToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
    case "favourites": {
      const rows = await db
        .select()
        .from(favourites)
        .where(inArray(favourites.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgFavouriteToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
    case "scheduled_query_runs": {
      const rows = await db
        .select()
        .from(scheduledQueryRuns)
        .where(inArray(scheduledQueryRuns.id, uuids));
      for (const r of rows) {
        out.set(
          r.id.toLowerCase(),
          normalizeRecordUserIdsForCompare(
            table,
            pgScheduledQueryRunToRecord(r),
            identityResolver,
          ),
        );
      }
      break;
    }
  }
  return out;
}

async function filterExistingPgWorkspaces(
  db: MakoPgDb,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  const uuids = [
    ...new Set(
      workspaceIds
        .map(ws => optionalPgUuid(ws))
        .filter((u): u is string => u !== null),
    ),
  ];
  const existing = new Set<string>();
  if (uuids.length === 0) return existing;
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.id, uuids));
  for (const r of rows) existing.add(r.id.toLowerCase());
  return existing;
}

async function repairTableEntities(
  table: ConsolesChartsTableName,
  pgUuids: string[],
  db: MakoPgDb,
): Promise<number> {
  if (pgUuids.length === 0) return 0;
  const oids = pgUuids
    .map(u => parseEntityId(u)?.oid)
    .filter((h): h is string => Boolean(h))
    .map(h => new Types.ObjectId(h));
  if (oids.length === 0) return 0;

  let repaired = 0;
  switch (table) {
    case "console_folders": {
      const docs = await ConsoleFolder.find({ _id: { $in: oids } }).lean<
        MongoConsoleFolderLike[]
      >();
      const records = docs.map(mongoConsoleFolderToRecord);
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const validRecords = records.filter(r => {
        const wsUuid = optionalPgUuid(r.workspaceId);
        return wsUuid !== null && validWs.has(wsUuid);
      });
      if (validRecords.length === 0) break;
      const userMap = await resolvePgUserUuidsBatch(
        db,
        validRecords.map(r => r.ownerId),
      );
      await db.transaction(async tx => {
        const txDb = tx as unknown as MakoPgDb;
        const pgRepo = new PgConsolesChartsRepository({
          getDb: () => txDb,
          resolveUserUuid: makeBatchResolver(userMap),
        });
        for (const rec of validRecords) {
          await pgRepo.upsertConsoleFolder(
            { ...rec, parentId: undefined },
            { db: txDb, ignoreUpdatedAtGuard: true },
          );
        }
        for (const rec of validRecords) {
          if (rec.parentId) {
            const pUuid = optionalPgUuid(rec.parentId);
            if (pUuid) {
              const exists = await tx
                .select({ id: consoleFolders.id })
                .from(consoleFolders)
                .where(eq(consoleFolders.id, pUuid))
                .limit(1);
              if (exists.length > 0) {
                await tx
                  .update(consoleFolders)
                  .set({ parentId: pUuid })
                  .where(eq(consoleFolders.id, toPgUuid(rec.id)));
              }
            }
          }
        }
      });
      repaired += validRecords.length;
      break;
    }
    case "saved_consoles": {
      const docs = await SavedConsole.find({ _id: { $in: oids } })
        .select("+descriptionEmbedding")
        .lean<MongoSavedConsoleLike[]>();
      const records = docs
        .map(mongoSavedConsoleToRecord)
        .filter(rec => isValidEmbedding(rec.descriptionEmbedding));
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const items: Array<BackfillItem<CompositeBackfillDoc>> = records
        .filter(rec => {
          const wsUuid = optionalPgUuid(rec.workspaceId);
          return wsUuid !== null && validWs.has(wsUuid);
        })
        .map(record => ({
          cursor: record.id,
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          doc: { stage: "saved_consoles", record },
        }));
      // Preserve stale-overwrite protection (`EXCLUDED.updated_at >= saved_consoles.updated_at`).
      repaired = await upsertCompositeBatch(items, db);
      break;
    }
    case "entity_versions": {
      const docs = (await EntityVersion.collection
        .find({ _id: { $in: oids }, entityType: "console" })
        .toArray()) as unknown as MongoEntityVersionLike[];
      const records = docs.map(mongoEntityVersionToRecord);
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const items: Array<BackfillItem<CompositeBackfillDoc>> = records
        .filter(rec => {
          const wsUuid = optionalPgUuid(rec.workspaceId);
          return wsUuid !== null && validWs.has(wsUuid);
        })
        .map(record => ({
          cursor: record.id,
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          doc: {
            stage: "entity_versions",
            rawEntityType: "console",
            workspaceId: record.workspaceId,
            record,
          },
        }));
      repaired = await upsertCompositeBatch(items, db);
      break;
    }
    case "notebook_folders": {
      const docs = await NotebookFolder.find({ _id: { $in: oids } }).lean<
        MongoNotebookFolderLike[]
      >();
      const records = docs.map(mongoNotebookFolderToRecord);
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const validRecords = records.filter(r => {
        const wsUuid = optionalPgUuid(r.workspaceId);
        return wsUuid !== null && validWs.has(wsUuid);
      });
      if (validRecords.length === 0) break;
      const userMap = await resolvePgUserUuidsBatch(
        db,
        validRecords.map(r => r.ownerId),
      );
      await db.transaction(async tx => {
        const txDb = tx as unknown as MakoPgDb;
        const pgRepo = new PgConsolesChartsRepository({
          getDb: () => txDb,
          resolveUserUuid: makeBatchResolver(userMap),
        });
        for (const rec of validRecords) {
          await pgRepo.upsertNotebookFolder(
            { ...rec, parentId: undefined },
            { db: txDb, ignoreUpdatedAtGuard: true },
          );
        }
        for (const rec of validRecords) {
          if (rec.parentId) {
            const pUuid = optionalPgUuid(rec.parentId);
            if (pUuid) {
              const exists = await tx
                .select({ id: notebookFolders.id })
                .from(notebookFolders)
                .where(eq(notebookFolders.id, pUuid))
                .limit(1);
              if (exists.length > 0) {
                await tx
                  .update(notebookFolders)
                  .set({ parentId: pUuid })
                  .where(eq(notebookFolders.id, toPgUuid(rec.id)));
              }
            }
          }
        }
      });
      repaired += validRecords.length;
      break;
    }
    case "notebook_indexes": {
      const docs = await NotebookIndex.find({ _id: { $in: oids } }).lean<
        MongoNotebookIndexLike[]
      >();
      const records = docs.map(mongoNotebookIndexToRecord);
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const items: Array<BackfillItem<CompositeBackfillDoc>> = records
        .filter(rec => {
          const wsUuid = optionalPgUuid(rec.workspaceId);
          return wsUuid !== null && validWs.has(wsUuid);
        })
        .map(record => ({
          cursor: record.id,
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          doc: { stage: "notebook_indexes", record },
        }));
      // Preserve stale-overwrite protection (`EXCLUDED.updated_at >= notebook_indexes.updated_at`).
      repaired = await upsertCompositeBatch(items, db);
      break;
    }
    case "favourites": {
      const docs = (await Favourite.collection
        .find({
          _id: { $in: oids },
          $or: [
            { type: "folder" },
            { type: "item", kind: { $in: ["app", "console", "notebook"] } },
          ],
        })
        .toArray()) as unknown as MongoFavouriteLike[];
      const records = docs.map(mongoFavouriteToRecord);
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const userMap = await resolvePgUserUuidsBatch(
        db,
        records.map(r => r.userId),
      );
      const resolver = makeBatchResolver(userMap);
      const validRecords = records.filter(rec => {
        const wsUuid = optionalPgUuid(rec.workspaceId);
        return (
          wsUuid !== null &&
          validWs.has(wsUuid) &&
          Boolean(resolver(rec.userId))
        );
      });
      if (validRecords.length === 0) break;
      await db.transaction(async tx => {
        const txDb = tx as unknown as MakoPgDb;
        const pgRepo = new PgConsolesChartsRepository({
          getDb: () => txDb,
          resolveUserUuid: resolver,
        });
        // Pass 1: honor `updated_at` guard so strictly newer live PG rows are never clobbered,
        // while allowing equal/newer updates (including moves back to root `parentId: null`) to heal.
        for (const rec of validRecords) {
          await pgRepo.upsertFavourite(
            { ...rec, parentId: null },
            {
              db: txDb,
              ignoreUpdatedAtGuard: false,
              preserveParentOnConflict: false,
            },
          );
        }
        // Pass 2: wire non-null `parent_id` with the same `updated_at` guard atomically.
        for (const rec of validRecords) {
          if (rec.parentId) {
            const pUuid = optionalPgUuid(rec.parentId);
            if (pUuid) {
              const exists = await tx
                .select({ id: favourites.id })
                .from(favourites)
                .where(eq(favourites.id, pUuid))
                .limit(1);
              if (exists.length > 0) {
                await tx
                  .update(favourites)
                  .set({ parentId: pUuid })
                  .where(
                    and(
                      eq(favourites.id, toPgUuid(rec.id)),
                      or(
                        isNull(favourites.updatedAt),
                        lte(favourites.updatedAt, rec.updatedAt),
                      ),
                    ),
                  );
              }
            }
          }
        }
      });
      repaired += validRecords.length;
      break;
    }
    case "scheduled_query_runs": {
      const docs = await ScheduledQueryRun.find({ _id: { $in: oids } }).lean<
        MongoScheduledQueryRunLike[]
      >();
      const records = docs.map(mongoScheduledQueryRunToRecord);
      const validWs = await filterExistingPgWorkspaces(
        db,
        records.map(r => r.workspaceId),
      );
      const items: Array<BackfillItem<CompositeBackfillDoc>> = records
        .filter(rec => {
          const wsUuid = optionalPgUuid(rec.workspaceId);
          const cUuid = optionalPgUuid(rec.consoleId);
          return wsUuid !== null && validWs.has(wsUuid) && cUuid !== null;
        })
        .map(record => ({
          cursor: record.id,
          entityId: toPgUuid(record.id),
          workspaceId: record.workspaceId,
          doc: { stage: "scheduled_query_runs", record },
        }));
      // Preserve monotonic status / completed_at stale-overwrite guard.
      repaired = await upsertCompositeBatch(items, db);
      break;
    }
  }
  return repaired;
}

async function listAllPgIdsForTable(
  table: ConsolesChartsTableName,
  workspaceId: string | null,
  db: MakoPgDb,
): Promise<string[]> {
  const wsUuid = workspacePgUuid(workspaceId);
  if (workspaceId !== null && !wsUuid) return [];
  const tableRef = {
    console_folders: consoleFolders,
    saved_consoles: savedConsoles,
    entity_versions: entityVersions,
    notebook_folders: notebookFolders,
    notebook_indexes: notebookIndexes,
    favourites: favourites,
    scheduled_query_runs: scheduledQueryRuns,
  }[table];
  const rows = wsUuid
    ? await db
        .select({ id: tableRef.id })
        .from(tableRef)
        .where(eq(tableRef.workspaceId, wsUuid))
    : await db.select({ id: tableRef.id }).from(tableRef);
  return rows.map(r => r.id.toLowerCase());
}

export function createConsolesChartsVerifierHandler(): VerifierDomainHandler {
  return {
    domain: CONSOLES_CHARTS_DOMAIN,
    targetTable: "saved_consoles",
    compareOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const decoded = decodeCursor(afterCursor);
      const startStage = decoded?.stage ?? 1;
      const items: VerifierMongoRecord[] = [];

      for (const meta of VERIFIER_TABLES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        const stageAfter =
          decoded && decoded.stage === meta.stage ? decoded.mongoId : null;
        const batch = await fetchMongoTableVerifierBatch(
          meta.table,
          meta.stage,
          stageAfter,
          remaining,
          workspaceId,
          db,
          true,
        );
        items.push(...batch);
      }
      return items;
    },
    async fetchPgByIds(entityIds, db) {
      const grouped = new Map<ConsolesChartsTableName, string[]>();
      for (const key of entityIds) {
        const parsed = decodeVerifierKey(key);
        if (!parsed) continue;
        const list = grouped.get(parsed.table) ?? [];
        list.push(parsed.pgUuid);
        grouped.set(parsed.table, list);
      }
      const out = new Map<string, unknown>();
      for (const [table, uuids] of grouped) {
        const map = await fetchPgTableRecordsByUuids(table, uuids, db);
        for (const [uuid, rec] of map) {
          out.set(encodeVerifierKey(table, uuid), rec);
        }
      }
      return out;
    },
    async findExtraPgIds({ workspaceId, seenEntityIds, db }) {
      const extras: string[] = [];
      for (const meta of VERIFIER_TABLES) {
        const pgIds = await listAllPgIdsForTable(meta.table, workspaceId, db);
        for (const pgId of pgIds) {
          const key = encodeVerifierKey(meta.table, pgId);
          if (!seenEntityIds.has(key)) extras.push(key);
        }
      }
      return extras;
    },
    async repair({ entityIds, db }) {
      const grouped = new Map<ConsolesChartsTableName, string[]>();
      for (const key of entityIds) {
        const parsed = decodeVerifierKey(key);
        if (!parsed) continue;
        const list = grouped.get(parsed.table) ?? [];
        list.push(parsed.pgUuid);
        grouped.set(parsed.table, list);
      }
      let total = 0;
      for (const [table, uuids] of grouped) {
        total += await repairTableEntities(table, uuids, db);
      }
      return total;
    },
  };
}

function createSingleTableVerifierHandler(
  table: ConsolesChartsTableName,
): VerifierDomainHandler {
  return {
    domain: `${CONSOLES_CHARTS_DOMAIN}:${table}`,
    targetTable: table,
    compareOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      return fetchMongoTableVerifierBatch(
        table,
        1,
        afterCursor,
        limit,
        workspaceId,
        db,
        false,
      );
    },
    fetchPgByIds: (entityIds, db) =>
      fetchPgTableRecordsByUuids(table, entityIds, db),
    async findExtraPgIds({ workspaceId, seenEntityIds, db }) {
      const pgIds = await listAllPgIdsForTable(table, workspaceId, db);
      return pgIds.filter(id => !seenEntityIds.has(id));
    },
    repair: ({ entityIds, db }) => repairTableEntities(table, entityIds, db),
  };
}

// ── Inngest Sync-Retry Handlers ─────────────────────────────────────────────

/**
 * Record tombstones for IDs deleted from PG, plus any candidate IDs from the retry
 * payload that are confirmed absent from MongoDB (never tombstoning live docs on
 * unauthorized/no-op replays).
 */
async function tombstoneDeletedIds(
  table: ConsolesChartsTableName,
  pgDeletedIds: Iterable<string>,
  candidateIds: Iterable<string>,
  existsInMongo: (oidHex: string) => Promise<boolean>,
  db: MakoPgDb,
): Promise<void> {
  const recorded = new Set<string>();
  for (const rawId of pgDeletedIds) {
    const pgUuid = optionalPgUuid(rawId);
    if (pgUuid && !recorded.has(pgUuid)) {
      await recordMigrationTombstone(table, pgUuid, db);
      recorded.add(pgUuid);
    }
  }
  for (const rawId of candidateIds) {
    const parsed = parseEntityId(rawId);
    if (!parsed?.oid || recorded.has(parsed.uuid)) continue;
    if (!(await existsInMongo(parsed.oid))) {
      await recordMigrationTombstone(table, parsed.uuid, db);
      recorded.add(parsed.uuid);
    }
  }
}

async function replaySyncToPg(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const payload = data.payload ?? {};
  const table = payload.table as ConsolesChartsTableName | undefined;
  const action = String(payload.action ?? "upsert");
  const wsId = String(payload.workspaceId ?? data.workspaceId ?? "");
  const id = String(payload.id ?? data.entityId ?? "");
  const pgRepo = new PgConsolesChartsRepository({
    getDb: () => db,
    resolveUserUuid: makeDbUserResolver(db),
  });

  if (!table) return;

  if (action === "delete") {
    if (table === "console_folders" && wsId && id) {
      const deletedIds = await pgRepo.deleteConsoleFolderReturningIds(wsId, id);
      await tombstoneDeletedIds(
        "console_folders",
        deletedIds,
        [...extractStringArray(payload.deletedIds), id],
        async oid =>
          Boolean(await ConsoleFolder.exists({ _id: new Types.ObjectId(oid) })),
        db,
      );
    } else if (table === "notebook_indexes" && payload.notebookId && wsId) {
      const deletedId = await pgRepo.deleteNotebookIndexReturningId(
        wsId,
        String(payload.notebookId),
      );
      await tombstoneDeletedIds(
        "notebook_indexes",
        deletedId ? [deletedId] : [],
        extractStringArray(payload.deletedIds),
        async oid =>
          Boolean(await NotebookIndex.exists({ _id: new Types.ObjectId(oid) })),
        db,
      );
    }
    return;
  }

  if (
    action === "delete_subtree" &&
    table === "notebook_folders" &&
    wsId &&
    id
  ) {
    const deletedIds = await pgRepo.deleteNotebookFolderSubtreeReturningIds(
      wsId,
      id,
    );
    await tombstoneDeletedIds(
      "notebook_folders",
      deletedIds,
      [...extractStringArray(payload.deletedIds), id],
      async oid =>
        Boolean(await NotebookFolder.exists({ _id: new Types.ObjectId(oid) })),
      db,
    );
    return;
  }
  if (
    action === "delete_subtree" &&
    table === "favourites" &&
    wsId &&
    payload.userId &&
    id
  ) {
    const deletedIds = await pgRepo.deleteFavouriteSubtreeReturningIds(
      wsId,
      String(payload.userId),
      id,
    );
    await tombstoneDeletedIds(
      "favourites",
      deletedIds,
      [...extractStringArray(payload.deletedIds), id],
      async oid =>
        Boolean(await Favourite.exists({ _id: new Types.ObjectId(oid) })),
      db,
    );
    return;
  }
  if (
    action === "delete_by_ref" &&
    table === "favourites" &&
    wsId &&
    payload.userId &&
    payload.kind &&
    payload.refId
  ) {
    const deletedId = await pgRepo.deleteFavouriteByRefReturningId(
      wsId,
      String(payload.userId),
      payload.kind as FavouriteRecord["kind"] & string,
      String(payload.refId),
    );
    await tombstoneDeletedIds(
      "favourites",
      deletedId ? [deletedId] : [],
      extractStringArray(payload.deletedIds),
      async oid =>
        Boolean(await Favourite.exists({ _id: new Types.ObjectId(oid) })),
      db,
    );
    return;
  }
  if (action === "purge_workspace_index" && wsId) {
    const hinted =
      payload.deletedByTable && typeof payload.deletedByTable === "object"
        ? (payload.deletedByTable as Record<string, unknown>)
        : null;
    if (!hinted) {
      // Never wipe whole-workspace PG content on a delayed retry without the
      // captured deleted IDs — doing so would erase content re-created after
      // a workspace repo reconnect.
      return;
    }

    const filterAbsentFromMongo = async (
      rawIds: string[],
      existsInMongo: (oidHex: string) => Promise<boolean>,
    ): Promise<string[]> => {
      const absent: string[] = [];
      const seen = new Set<string>();
      for (const rawId of rawIds) {
        const parsed = parseEntityId(rawId);
        if (!parsed?.oid || seen.has(parsed.oid)) continue;
        seen.add(parsed.oid);
        if (!(await existsInMongo(parsed.oid))) {
          absent.push(parsed.oid);
        }
      }
      return absent;
    };

    const [
      absentConsoles,
      absentFolders,
      absentVersions,
      absentNotebooks,
      absentNbFolders,
    ] = await Promise.all([
      filterAbsentFromMongo(
        extractStringArray(hinted.saved_consoles),
        async oid =>
          Boolean(await SavedConsole.exists({ _id: new Types.ObjectId(oid) })),
      ),
      filterAbsentFromMongo(
        extractStringArray(hinted.console_folders),
        async oid =>
          Boolean(await ConsoleFolder.exists({ _id: new Types.ObjectId(oid) })),
      ),
      filterAbsentFromMongo(
        extractStringArray(hinted.entity_versions),
        async oid =>
          Boolean(await EntityVersion.exists({ _id: new Types.ObjectId(oid) })),
      ),
      filterAbsentFromMongo(
        extractStringArray(hinted.notebook_indexes),
        async oid =>
          Boolean(await NotebookIndex.exists({ _id: new Types.ObjectId(oid) })),
      ),
      filterAbsentFromMongo(
        extractStringArray(hinted.notebook_folders),
        async oid =>
          Boolean(
            await NotebookFolder.exists({ _id: new Types.ObjectId(oid) }),
          ),
      ),
    ]);

    await pgRepo.deleteWorkspaceContentIndexByIds(wsId, {
      saved_consoles: absentConsoles,
      console_folders: absentFolders,
      entity_versions: absentVersions,
      notebook_indexes: absentNotebooks,
      notebook_folders: absentNbFolders,
    });

    const recordAbsentTombstones = async (
      t: ConsolesChartsTableName,
      oids: readonly string[],
    ) => {
      for (const oid of oids) {
        const pgUuid = optionalPgUuid(oid);
        if (pgUuid) {
          await recordMigrationTombstone(t, pgUuid, db);
        }
      }
    };
    await recordAbsentTombstones("saved_consoles", absentConsoles);
    await recordAbsentTombstones("console_folders", absentFolders);
    await recordAbsentTombstones("entity_versions", absentVersions);
    await recordAbsentTombstones("notebook_indexes", absentNotebooks);
    await recordAbsentTombstones("notebook_folders", absentNbFolders);
    return;
  }
  if (
    action === "delete_in_folder" &&
    table === "saved_consoles" &&
    wsId &&
    payload.folderId
  ) {
    const deletedIds = await pgRepo.deleteConsolesInFolderReturningIds(
      wsId,
      String(payload.folderId),
    );
    await tombstoneDeletedIds(
      "saved_consoles",
      deletedIds,
      extractStringArray(payload.deletedIds),
      async oid =>
        Boolean(await SavedConsole.exists({ _id: new Types.ObjectId(oid) })),
      db,
    );
    return;
  }
  if (
    action === "update_folder_access" &&
    table === "saved_consoles" &&
    wsId &&
    payload.folderId
  ) {
    const wsOid = parseEntityId(wsId)?.oid;
    const folderOid = parseEntityId(String(payload.folderId))?.oid;
    if (wsOid && folderOid) {
      const docs = await SavedConsole.find({
        workspaceId: new Types.ObjectId(wsOid),
        folderId: new Types.ObjectId(folderOid),
      })
        .select("_id")
        .lean<Array<{ _id: Types.ObjectId }>>();
      const uuids = docs.map(d => toPgUuid(d._id));
      if (uuids.length > 0) {
        await repairTableEntities("saved_consoles", uuids, db);
      }
    }
    return;
  }
  if (
    action === "reorder" &&
    table === "favourites" &&
    wsId &&
    payload.userId
  ) {
    const rawIds = Array.isArray(payload.ids)
      ? extractStringArray(payload.ids)
      : Array.isArray(payload.updates)
        ? (payload.updates as ReorderFavouriteUpdate[]).map(u => u.id)
        : [];
    const uuids = rawIds
      .map(raw => optionalPgUuid(raw))
      .filter((u): u is string => u !== null);
    if (uuids.length > 0) {
      await repairTableEntities("favourites", uuids, db);
    }
    return;
  }

  const clearReplayedTombstone = async (
    targetTable: ConsolesChartsTableName,
    pgUuid: string,
  ) => {
    await db
      .delete(migrationTombstones)
      .where(
        and(
          eq(migrationTombstones.tableName, targetTable),
          eq(migrationTombstones.entityId, pgUuid.toLowerCase()),
        ),
      );
  };

  const entityPgUuid = optionalPgUuid(id);
  if (entityPgUuid) {
    const repaired = await repairTableEntities(table, [entityPgUuid], db);
    if (repaired > 0) {
      await clearReplayedTombstone(table, entityPgUuid);
    }
  } else if (table === "notebook_indexes" && wsId && payload.notebookId) {
    const wsOid = parseEntityId(wsId)?.oid;
    if (wsOid) {
      const doc = await NotebookIndex.findOne({
        workspaceId: new Types.ObjectId(wsOid),
        notebookId: String(payload.notebookId),
      }).lean<MongoNotebookIndexLike | null>();
      if (doc) {
        const docPgUuid = toPgUuid(doc._id);
        const repaired = await repairTableEntities(table, [docPgUuid], db);
        if (repaired > 0) {
          await clearReplayedTombstone(table, docPgUuid);
        }
      }
    }
  }
}

/**
 * Batch-resolve PG UUIDv7 `users.id` values back to Mongo `_id` (`legacy_id ?? id`)
 * for Stage 4 PG -> Mongo reverse-sync replays.
 */
async function resolveLegacyUserIdsForMongo(
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
  const map = new Map<string, string>();
  if (uuids.length === 0) return map;
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(inArray(users.id, uuids));
  for (const r of rows) {
    map.set(r.id.toLowerCase(), r.legacyId ?? r.id);
  }
  return map;
}

function mapToMongoUserId(
  raw: string | undefined,
  legacyMap: ReadonlyMap<string, string>,
): string | undefined {
  if (!raw) return raw;
  return legacyMap.get(raw.toLowerCase()) ?? raw;
}

async function upsertPgConsolesToMongo(
  db: MakoPgDb,
  mongoRepo: MongoConsolesChartsRepository,
  records: readonly SavedConsoleRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const legacyMap = await resolveLegacyUserIdsForMongo(
    db,
    records.flatMap(rec => [
      rec.createdBy,
      rec.owner_id,
      rec.lastRun?.runBy,
      ...rec.sharedWith.flatMap(s => [s.userId, s.addedBy]),
    ]),
  );
  for (const rec of records) {
    await mongoRepo.upsertConsole({
      ...rec,
      createdBy: mapToMongoUserId(rec.createdBy, legacyMap) ?? "",
      owner_id: mapToMongoUserId(rec.owner_id, legacyMap),
      sharedWith: rec.sharedWith.map(s => ({
        ...s,
        userId: mapToMongoUserId(s.userId, legacyMap) ?? s.userId,
        ...(s.addedBy
          ? { addedBy: mapToMongoUserId(s.addedBy, legacyMap) }
          : {}),
      })),
      ...(rec.lastRun
        ? {
            lastRun: {
              ...rec.lastRun,
              runBy:
                mapToMongoUserId(rec.lastRun.runBy, legacyMap) ??
                rec.lastRun.runBy,
            },
          }
        : {}),
    });
  }
}

async function replaySyncToMongo(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const payload = data.payload ?? {};
  const table = payload.table as ConsolesChartsTableName | undefined;
  const action = String(payload.action ?? "upsert");
  const wsId = String(payload.workspaceId ?? data.workspaceId ?? "");
  const id = String(payload.id ?? data.entityId ?? "");
  const mongoRepo = new MongoConsolesChartsRepository();
  const pgRepo = new PgConsolesChartsRepository({
    getDb: () => db,
    resolveUserUuid: makeDbUserResolver(db),
  });

  if (!table) return;

  if (action === "delete") {
    if (table === "console_folders" && wsId && id) {
      await mongoRepo.deleteConsoleFolder(wsId, id);
    } else if (table === "notebook_indexes" && wsId && payload.notebookId) {
      await mongoRepo.deleteNotebookIndex(wsId, String(payload.notebookId));
    }
    return;
  }
  if (
    action === "delete_subtree" &&
    table === "notebook_folders" &&
    wsId &&
    id
  ) {
    await mongoRepo.deleteNotebookFolderSubtree(wsId, id);
    return;
  }
  if (
    action === "delete_subtree" &&
    table === "favourites" &&
    wsId &&
    payload.userId &&
    id
  ) {
    const legacyMap = await resolveLegacyUserIdsForMongo(db, [
      String(payload.userId),
    ]);
    const mongoUserId =
      mapToMongoUserId(String(payload.userId), legacyMap) ??
      String(payload.userId);
    await mongoRepo.deleteFavouriteSubtree(wsId, mongoUserId, id);
    return;
  }
  if (
    action === "delete_by_ref" &&
    table === "favourites" &&
    wsId &&
    payload.userId &&
    payload.kind &&
    payload.refId
  ) {
    const legacyMap = await resolveLegacyUserIdsForMongo(db, [
      String(payload.userId),
    ]);
    const mongoUserId =
      mapToMongoUserId(String(payload.userId), legacyMap) ??
      String(payload.userId);
    await mongoRepo.deleteFavouriteByRef(
      wsId,
      mongoUserId,
      payload.kind as FavouriteRecord["kind"] & string,
      String(payload.refId),
    );
    return;
  }
  if (action === "purge_workspace_index" && wsId) {
    const hinted =
      payload.deletedByTable && typeof payload.deletedByTable === "object"
        ? (payload.deletedByTable as Record<string, unknown>)
        : null;
    if (!hinted) {
      return;
    }

    const filterAbsentFromPg = async (
      rawIds: string[],
      tableRef:
        | typeof savedConsoles
        | typeof consoleFolders
        | typeof entityVersions
        | typeof notebookIndexes
        | typeof notebookFolders,
    ): Promise<string[]> => {
      const pairs: Array<{ oid: string; uuid: string }> = [];
      const seen = new Set<string>();
      for (const rawId of rawIds) {
        const parsed = parseEntityId(rawId);
        if (!parsed?.oid || seen.has(parsed.oid)) continue;
        seen.add(parsed.oid);
        pairs.push({ oid: parsed.oid, uuid: parsed.uuid });
      }
      if (pairs.length === 0) return [];
      const existing = await db
        .select({ id: tableRef.id })
        .from(tableRef)
        .where(
          inArray(
            tableRef.id,
            pairs.map(p => p.uuid),
          ),
        );
      const existingSet = new Set(existing.map(r => r.id.toLowerCase()));
      return pairs
        .filter(p => !existingSet.has(p.uuid.toLowerCase()))
        .map(p => p.oid);
    };

    const [
      absentConsoles,
      absentFolders,
      absentVersions,
      absentNotebooks,
      absentNbFolders,
    ] = await Promise.all([
      filterAbsentFromPg(
        extractStringArray(hinted.saved_consoles),
        savedConsoles,
      ),
      filterAbsentFromPg(
        extractStringArray(hinted.console_folders),
        consoleFolders,
      ),
      filterAbsentFromPg(
        extractStringArray(hinted.entity_versions),
        entityVersions,
      ),
      filterAbsentFromPg(
        extractStringArray(hinted.notebook_indexes),
        notebookIndexes,
      ),
      filterAbsentFromPg(
        extractStringArray(hinted.notebook_folders),
        notebookFolders,
      ),
    ]);

    await mongoRepo.deleteWorkspaceContentIndexByIds(wsId, {
      saved_consoles: absentConsoles,
      console_folders: absentFolders,
      entity_versions: absentVersions,
      notebook_indexes: absentNotebooks,
      notebook_folders: absentNbFolders,
    });
    return;
  }
  if (
    action === "delete_in_folder" &&
    table === "saved_consoles" &&
    wsId &&
    payload.folderId
  ) {
    await mongoRepo.deleteConsolesInFolder(wsId, String(payload.folderId));
    return;
  }
  if (
    action === "update_folder_access" &&
    table === "saved_consoles" &&
    wsId &&
    payload.folderId
  ) {
    const pgConsoles = await pgRepo.listConsolesByWorkspace(wsId, {
      folderId: String(payload.folderId),
      includeEmbedding: true,
    });
    await upsertPgConsolesToMongo(db, mongoRepo, pgConsoles);
    return;
  }
  if (
    action === "reorder" &&
    table === "favourites" &&
    wsId &&
    payload.userId
  ) {
    const wsUuid = optionalPgUuid(wsId);
    const rawIds = Array.isArray(payload.ids)
      ? extractStringArray(payload.ids)
      : Array.isArray(payload.updates)
        ? (payload.updates as ReorderFavouriteUpdate[]).map(u => u.id)
        : [];
    const pgUuids = rawIds
      .map(raw => optionalPgUuid(raw))
      .filter((u): u is string => u !== null);
    if (wsUuid && pgUuids.length > 0) {
      const rows = await db
        .select()
        .from(favourites)
        .where(
          and(
            eq(favourites.workspaceId, wsUuid),
            inArray(favourites.id, pgUuids),
          ),
        );
      const records = rows.map(pgFavouriteToRecord);
      const legacyMap = await resolveLegacyUserIdsForMongo(
        db,
        records.map(r => r.userId),
      );
      for (const rec of records) {
        await mongoRepo.upsertFavourite({
          ...rec,
          userId: mapToMongoUserId(rec.userId, legacyMap) ?? rec.userId,
        });
      }
    }
    return;
  }

  // Upsert replay from PG authoritative record -> Mongo (remapping UUIDv7 -> legacy_id)
  if (table === "console_folders" && wsId && id) {
    const rec = await pgRepo.findConsoleFolderById(wsId, id);
    if (rec) {
      const legacyMap = await resolveLegacyUserIdsForMongo(db, [rec.ownerId]);
      await mongoRepo.upsertConsoleFolder({
        ...rec,
        ownerId: mapToMongoUserId(rec.ownerId, legacyMap),
      });
    }
  } else if (table === "saved_consoles" && wsId && id) {
    const rec = await pgRepo.findConsoleById(wsId, id, {
      includeEmbedding: true,
    });
    if (rec) {
      await upsertPgConsolesToMongo(db, mongoRepo, [rec]);
    }
  } else if (table === "notebook_folders" && wsId && id) {
    const rec = await pgRepo.findNotebookFolderById(wsId, id);
    if (rec) {
      const legacyMap = await resolveLegacyUserIdsForMongo(db, [rec.ownerId]);
      await mongoRepo.upsertNotebookFolder({
        ...rec,
        ownerId: mapToMongoUserId(rec.ownerId, legacyMap),
      });
    }
  } else if (table === "notebook_indexes" && wsId && payload.notebookId) {
    const rec = await pgRepo.findNotebookIndex(
      wsId,
      String(payload.notebookId),
    );
    if (rec) {
      const legacyMap = await resolveLegacyUserIdsForMongo(db, [
        rec.ownerId,
        ...rec.sharedWith.flatMap(s => [s.userId, s.addedBy]),
      ]);
      await mongoRepo.upsertNotebookIndex({
        ...rec,
        ownerId: mapToMongoUserId(rec.ownerId, legacyMap) ?? rec.ownerId,
        sharedWith: rec.sharedWith.map(s => ({
          ...s,
          userId: mapToMongoUserId(s.userId, legacyMap) ?? s.userId,
          ...(s.addedBy
            ? { addedBy: mapToMongoUserId(s.addedBy, legacyMap) }
            : {}),
        })),
      });
    }
  } else if (table === "scheduled_query_runs" && id) {
    const rec = await pgRepo.findScheduledQueryRunById(id, wsId || undefined);
    if (rec) {
      const legacyMap = await resolveLegacyUserIdsForMongo(db, [
        rec.triggeredBy,
      ]);
      await mongoRepo.upsertScheduledQueryRun({
        ...rec,
        triggeredBy: mapToMongoUserId(rec.triggeredBy, legacyMap),
      });
    }
  } else if (table === "favourites" && wsId) {
    const pgId = optionalPgUuid(id);
    const wsUuid = optionalPgUuid(wsId);
    if (pgId && wsUuid) {
      const rows = await db
        .select()
        .from(favourites)
        .where(and(eq(favourites.id, pgId), eq(favourites.workspaceId, wsUuid)))
        .limit(1);
      if (rows[0]) {
        const rec = pgFavouriteToRecord(rows[0]);
        const legacyMap = await resolveLegacyUserIdsForMongo(db, [rec.userId]);
        await mongoRepo.upsertFavourite({
          ...rec,
          userId: mapToMongoUserId(rec.userId, legacyMap) ?? rec.userId,
        });
      }
    }
  } else if (table === "entity_versions") {
    const pgId = optionalPgUuid(id);
    if (pgId) {
      const rows = await db
        .select()
        .from(entityVersions)
        .where(eq(entityVersions.id, pgId))
        .limit(1);
      if (rows[0]) {
        const rec = pgEntityVersionToRecord(rows[0]);
        const legacyMap = await resolveLegacyUserIdsForMongo(db, [rec.savedBy]);
        await mongoRepo.createEntityVersion({
          ...rec,
          savedBy: mapToMongoUserId(rec.savedBy, legacyMap) ?? rec.savedBy,
        });
      }
    }
  }
}

export function registerConsolesChartsMigrationDomain(): void {
  registerBackfillDomain(createConsolesChartsBackfillHandler());
  registerVerifierDomain(createConsolesChartsVerifierHandler());

  for (const meta of VERIFIER_TABLES) {
    registerBackfillDomain(createSingleTableBackfillHandler(meta.table));
    registerVerifierDomain(createSingleTableVerifierHandler(meta.table));
  }

  registerSyncRetryHandler("pg", CONSOLES_CHARTS_DOMAIN, data =>
    replaySyncToPg(data),
  );
  registerSyncRetryHandler("mongo", CONSOLES_CHARTS_DOMAIN, data =>
    replaySyncToMongo(data),
  );

  // Sparse 90-day TTL on `scheduled_query_runs.completed_at` (`reapExpiredRows`
  // enforces `completed_at IS NOT NULL`, so in-progress queued/running rows are untouched).
  registerTtlRule({
    tableName: "scheduled_query_runs",
    timestampColumn: "completed_at",
    olderThanMs: SCHEDULED_QUERY_RUNS_TTL_MS,
  });
}

export { replaySyncToMongo, replaySyncToPg, sql };
