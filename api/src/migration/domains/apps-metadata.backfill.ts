/**
 * Phase 2B (`apps_metadata` domain) migration handlers:
 *   - Resumable MongoDB -> Postgres backfill (`apps_metadata` + 10 per-table sub-domains)
 *   - Chunked parity verifier + `--repair` healer (`apps_metadata` + 10 per-table sub-domains)
 *       * Uses `APPS_METADATA_SHADOW_OPTIONS` so `env`, `valueEncrypted`, `passwordHash`,
 *         and `passwordEncrypted` are NEVER logged in plaintext or ciphertext.
 *   - Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`).
 *
 * Blob-safety invariant:
 *   - `app_binding_drafts` and `app_binding_jobs` are NEVER registered in
 *     `migration-pg-ttl-reaper`! Their expiry MUST go through app-side
 *     `pruneExpiredDrafts()` / `pruneExpiredJobs()`, which delete GCS/artifact
 *     parquet blobs BEFORE deleting database rows.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { Types } from "mongoose";
import { isPersonActorId } from "../../apps/actor-id";
import {
  AppDeployCommitStatus,
  AppEmbedding,
  AppIndexEntry,
  AppIndexHead,
  AppLifecycleState,
  AppProject,
  AppWorktree,
} from "../../database/workspace-schema";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import { workspaces } from "../../database/pg/schema/workspaces";
import {
  appBindingDrafts,
  appBindingJobs,
  appBindingState,
  appDeployCommitStatuses,
  appEmbeddings,
  appIndex,
  appIndexHeads,
  appLifecycle,
  appProjects,
  appWorktrees,
} from "../../database/pg/schema/apps-metadata";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import {
  APPS_METADATA_DOMAIN,
  APPS_METADATA_SHADOW_OPTIONS,
  PgAppsMetadataRepository,
  entityIdToPgUuid,
  getMongoAppBindingDraftModel,
  getMongoAppBindingJobModel,
  getMongoAppBindingStateModel,
  mongoAppBindingDraftToRecord,
  mongoAppBindingJobToRecord,
  mongoAppBindingStateToRecord,
  mongoAppDeployCommitStatusToRecord,
  mongoAppEmbeddingToRecord,
  mongoAppIndexEntryToRecord,
  mongoAppIndexHeadToRecord,
  mongoAppLifecycleToRecord,
  mongoAppProjectToRecord,
  mongoAppWorktreeToRecord,
  optionalEntityIdToPgUuid,
  pgAppBindingDraftToRecord,
  pgAppBindingJobToRecord,
  pgAppBindingStateToRecord,
  pgAppDeployCommitStatusToRecord,
  pgAppEmbeddingToRecord,
  pgAppIndexEntryToRecord,
  pgAppIndexHeadToRecord,
  pgAppLifecycleToRecord,
  pgAppProjectToRecord,
  pgAppWorktreeToRecord,
  serializeBindingRefreshErrors,
  serializeBindingRun,
  serializeDeployProgress,
  serializeJobProgress,
  serializeLastDeployError,
  serializeShareEntries,
  toMongoObjectId,
  type AppBindingDraftRecord,
  type AppBindingJobRecord,
  type AppBindingStateRecord,
  type AppDeployCommitStatusRecord,
  type AppEmbeddingRecord,
  type AppIndexEntryRecord,
  type AppIndexHeadRecord,
  type AppLifecycleRecord,
  type AppProjectRecord,
  type AppWorktreeRecord,
  type MongoAppBindingDraftLike,
  type MongoAppBindingJobLike,
  type MongoAppBindingStateLike,
  type MongoAppDeployCommitStatusLike,
  type MongoAppEmbeddingLike,
  type MongoAppIndexEntryLike,
  type MongoAppIndexHeadLike,
  type MongoAppLifecycleLike,
  type MongoAppProjectLike,
  type MongoAppWorktreeLike,
} from "../../repositories/apps-metadata";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

export type AppsMetadataTable =
  | "app_projects"
  | "app_index"
  | "app_index_heads"
  | "app_embeddings"
  | "app_lifecycle"
  | "app_deploy_commit_statuses"
  | "app_worktrees"
  | "app_binding_state"
  | "app_binding_drafts"
  | "app_binding_jobs";

interface AppsStageMeta {
  stage: number;
  table: AppsMetadataTable;
  collection: string;
}

const APPS_STAGES: readonly AppsStageMeta[] = [
  { stage: 1, table: "app_projects", collection: "app_projects" },
  { stage: 2, table: "app_index", collection: "app_index" },
  { stage: 3, table: "app_index_heads", collection: "app_index_heads" },
  { stage: 4, table: "app_embeddings", collection: "app_embeddings" },
  { stage: 5, table: "app_lifecycle", collection: "app_lifecycle" },
  {
    stage: 6,
    table: "app_deploy_commit_statuses",
    collection: "app_deploy_commit_statuses",
  },
  { stage: 7, table: "app_worktrees", collection: "app_worktrees" },
  { stage: 8, table: "app_binding_state", collection: "app_binding_state" },
  { stage: 9, table: "app_binding_drafts", collection: "app_binding_drafts" },
  { stage: 10, table: "app_binding_jobs", collection: "app_binding_jobs" },
] as const;

const PGVECTOR_DIMS = 1536;

type AppsBackfillDoc =
  | { table: "app_projects"; record: AppProjectRecord }
  | { table: "app_index"; record: AppIndexEntryRecord }
  | { table: "app_index_heads"; record: AppIndexHeadRecord }
  | { table: "app_embeddings"; record: AppEmbeddingRecord }
  | { table: "app_lifecycle"; record: AppLifecycleRecord }
  | {
      table: "app_deploy_commit_statuses";
      record: AppDeployCommitStatusRecord;
    }
  | { table: "app_worktrees"; record: AppWorktreeRecord }
  | { table: "app_binding_state"; record: AppBindingStateRecord }
  | { table: "app_binding_drafts"; record: AppBindingDraftRecord }
  | { table: "app_binding_jobs"; record: AppBindingJobRecord };

function encodeCursor(
  stage: number,
  table: AppsMetadataTable,
  mongoId: string,
): string {
  return `${stage}:${table}:${mongoId}`;
}

function decodeCursor(cursor: string | null): {
  stage: number;
  table: AppsMetadataTable;
  mongoId: string;
} | null {
  if (!cursor) return null;
  const match = /^([1-9]|10):([a-z_]+):(.*)$/.exec(cursor);
  if (!match) return null;
  return {
    stage: Number(match[1]),
    table: match[2] as AppsMetadataTable,
    mongoId: match[3],
  };
}

function encodeVerifierKey(
  table: AppsMetadataTable,
  pgEntityId: string,
): string {
  return `${table}:${pgEntityId}`;
}

function decodeVerifierKey(
  key: string,
): { table: AppsMetadataTable; pgEntityId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as AppsMetadataTable,
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
      `Invalid Mongo workspaceId for apps_metadata backfill: ${JSON.stringify(workspaceId)}`,
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

async function resolveWorkspaceProjectObjectIds(
  workspaceId: string,
): Promise<Types.ObjectId[]> {
  const wsOid = mongoWorkspaceObjectId(workspaceId);
  if (!wsOid) return [];
  const [projects, indexed] = await Promise.all([
    AppProject.find({ workspaceId: wsOid }, { _id: 1 }).lean<
      Array<{ _id: Types.ObjectId }>
    >(),
    AppIndexEntry.find({ workspaceId: wsOid }, { appId: 1 }).lean<
      Array<{ appId: string }>
    >(),
  ]);
  const seen = new Set<string>();
  const out: Types.ObjectId[] = [];
  for (const p of projects) {
    const hex = p._id.toString();
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(p._id);
    }
  }
  for (const idx of indexed) {
    if (isObjectIdHex(idx.appId) && !seen.has(idx.appId)) {
      seen.add(idx.appId);
      out.push(new Types.ObjectId(idx.appId));
    }
  }
  return out;
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
  if (uuids.length === 0) return new Set();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.id, uuids));
  return new Set(rows.map(r => r.id.toLowerCase()));
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
  raw: string | undefined,
  uuidToLegacy: ReadonlyMap<string, string>,
): string | undefined {
  if (!raw) return undefined;
  return uuidToLegacy.get(raw.toLowerCase()) ?? raw;
}

function buildMongoSetAndUnset(
  setFields: Record<string, unknown>,
  clearableFields: Record<string, unknown>,
  setOnInsert?: Record<string, unknown>,
): Record<string, unknown> {
  const $set: Record<string, unknown> = { ...setFields };
  const $unset: Record<string, 1> = {};
  for (const [key, value] of Object.entries(clearableFields)) {
    if (value === undefined) {
      $unset[key] = 1;
    } else {
      $set[key] = value;
    }
  }
  const update: Record<string, unknown> = {};
  if (Object.keys($set).length > 0) {
    update.$set = $set;
  }
  if (Object.keys($unset).length > 0) {
    update.$unset = $unset;
  }
  if (setOnInsert && Object.keys(setOnInsert).length > 0) {
    update.$setOnInsert = setOnInsert;
  }
  return update;
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
  meta: AppsStageMeta,
  afterId: string | null,
  limit: number,
  workspaceId: string | null,
  composite: boolean,
): Promise<Array<BackfillItem<AppsBackfillDoc>>> {
  if (limit <= 0) return [];
  const makeCursor = (mongoId: string) =>
    composite ? encodeCursor(meta.stage, meta.table, mongoId) : mongoId;

  switch (meta.table) {
    case "app_projects": {
      const docs = await AppProject.find(buildMongoFilter(afterId, workspaceId))
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppProjectLike[]>();
      return docs.map(doc => {
        const record = mongoAppProjectToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_projects",
          collectionName: meta.collection,
          doc: { table: "app_projects", record },
        };
      });
    }

    case "app_index": {
      const docs = await AppIndexEntry.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppIndexEntryLike[]>();
      return docs.map(doc => {
        const record = mongoAppIndexEntryToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_index",
          collectionName: meta.collection,
          doc: { table: "app_index", record },
        };
      });
    }

    case "app_index_heads": {
      const docs = await AppIndexHead.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppIndexHeadLike[]>();
      return docs.map(doc => {
        const record = mongoAppIndexHeadToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_index_heads",
          collectionName: meta.collection,
          doc: { table: "app_index_heads", record },
        };
      });
    }

    case "app_embeddings": {
      const docs = await AppEmbedding.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppEmbeddingLike[]>();
      return docs.map(doc => {
        const record = mongoAppEmbeddingToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_embeddings",
          collectionName: meta.collection,
          doc: { table: "app_embeddings", record },
        };
      });
    }

    case "app_lifecycle": {
      const docs = await AppLifecycleState.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppLifecycleLike[]>();
      return docs.map(doc => {
        const record = mongoAppLifecycleToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_lifecycle",
          collectionName: meta.collection,
          doc: { table: "app_lifecycle", record },
        };
      });
    }

    case "app_deploy_commit_statuses": {
      const docs = await AppDeployCommitStatus.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppDeployCommitStatusLike[]>();
      return docs.map(doc => {
        const record = mongoAppDeployCommitStatusToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_deploy_commit_statuses",
          collectionName: meta.collection,
          doc: { table: "app_deploy_commit_statuses", record },
        };
      });
    }

    case "app_worktrees": {
      const docs = await AppWorktree.find(
        buildMongoFilter(afterId, workspaceId),
      )
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppWorktreeLike[]>();
      return docs.map(doc => {
        const record = mongoAppWorktreeToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_worktrees",
          collectionName: meta.collection,
          doc: { table: "app_worktrees", record },
        };
      });
    }

    case "app_binding_state": {
      const filter: Record<string, unknown> = {};
      if (workspaceId) {
        const projOids = await resolveWorkspaceProjectObjectIds(workspaceId);
        if (projOids.length === 0) return [];
        filter.projectId = { $in: projOids };
      }
      if (afterId && isObjectIdHex(afterId)) {
        filter._id = { $gt: new Types.ObjectId(afterId) };
      }
      const docs = await getMongoAppBindingStateModel()
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppBindingStateLike[]>();
      return docs.map(doc => {
        const record = mongoAppBindingStateToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: workspaceId ?? null,
          targetTable: "app_binding_state",
          collectionName: meta.collection,
          doc: { table: "app_binding_state", record },
        };
      });
    }

    case "app_binding_drafts": {
      const filter: Record<string, unknown> = {};
      if (workspaceId) {
        const projOids = await resolveWorkspaceProjectObjectIds(workspaceId);
        if (projOids.length === 0) return [];
        filter.projectId = { $in: projOids };
      }
      if (afterId && isObjectIdHex(afterId)) {
        filter._id = { $gt: new Types.ObjectId(afterId) };
      }
      const docs = await getMongoAppBindingDraftModel()
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppBindingDraftLike[]>();
      return docs.map(doc => {
        const record = mongoAppBindingDraftToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: workspaceId ?? null,
          targetTable: "app_binding_drafts",
          collectionName: meta.collection,
          doc: { table: "app_binding_drafts", record },
        };
      });
    }

    case "app_binding_jobs": {
      const docs = await getMongoAppBindingJobModel()
        .find(buildMongoFilter(afterId, workspaceId))
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAppBindingJobLike[]>();
      return docs.map(doc => {
        const record = mongoAppBindingJobToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: isObjectIdHex(record.id)
            ? objectIdToUuid(record.id)
            : record.id,
          workspaceId: record.workspaceId,
          targetTable: "app_binding_jobs",
          collectionName: meta.collection,
          doc: { table: "app_binding_jobs", record },
        };
      });
    }
  }
}

async function validateAppsBackfillItem(
  item: BackfillItem<AppsBackfillDoc>,
  db: MakoPgDb,
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
    case "app_projects":
      if (!(await checkWorkspace(doc.record.workspaceId))) {
        return {
          ok: false,
          reason: "orphaned_workspace_missing",
          sanitizedPayload: {
            table: doc.table,
            id: doc.record.id,
            workspaceId: doc.record.workspaceId,
          },
        };
      }
      return { ok: true };

    case "app_index":
      if (!parseEntityId(doc.record.appId)) {
        return {
          ok: false,
          reason: "invalid_app_id",
          sanitizedPayload: { table: doc.table, appId: doc.record.appId },
        };
      }
      if (doc.record.duplicateOf && !parseEntityId(doc.record.duplicateOf)) {
        return {
          ok: false,
          reason: "invalid_duplicate_of",
          sanitizedPayload: {
            table: doc.table,
            duplicateOf: doc.record.duplicateOf,
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

    case "app_index_heads":
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

    case "app_embeddings":
      if (!parseEntityId(doc.record.appId)) {
        return {
          ok: false,
          reason: "invalid_app_id",
          sanitizedPayload: { table: doc.table, appId: doc.record.appId },
        };
      }
      if (
        !Array.isArray(doc.record.vector) ||
        doc.record.vector.length !== PGVECTOR_DIMS
      ) {
        return {
          ok: false,
          reason: "invalid_embedding_dimension",
          sanitizedPayload: {
            table: doc.table,
            appId: doc.record.appId,
            dims: Array.isArray(doc.record.vector)
              ? doc.record.vector.length
              : -1,
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

    case "app_lifecycle":
    case "app_deploy_commit_statuses":
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

    case "app_worktrees":
      if (doc.record.projectId && !parseEntityId(doc.record.projectId)) {
        return {
          ok: false,
          reason: "invalid_project_id",
          sanitizedPayload: {
            table: doc.table,
            projectId: doc.record.projectId,
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

    case "app_binding_state":
    case "app_binding_drafts":
      if (!parseEntityId(doc.record.projectId)) {
        return {
          ok: false,
          reason: "invalid_project_id",
          sanitizedPayload: {
            table: doc.table,
            projectId: doc.record.projectId,
          },
        };
      }
      return { ok: true };

    case "app_binding_jobs":
      if (!parseEntityId(doc.record.projectId)) {
        return {
          ok: false,
          reason: "invalid_project_id",
          sanitizedPayload: {
            table: doc.table,
            projectId: doc.record.projectId,
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
}

async function upsertProjectRecordToPg(
  rec: AppProjectRecord,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const [ownerId, createdBy, publicShareCreatedBy] = await Promise.all([
    pgRepo.resolveNullableUserUuid(rec.owner_id, db),
    pgRepo.resolveNullableUserUuid(rec.createdBy, db),
    pgRepo.resolveNullableUserUuid(rec.publicShare?.createdBy, db),
  ]);

  let sharedWithJson: ReturnType<typeof serializeShareEntries> = null;
  if (rec.sharedWith !== undefined) {
    const rawUserIds = new Set<string>();
    for (const s of rec.sharedWith) {
      if (s.userId) rawUserIds.add(s.userId);
      if (s.addedBy) rawUserIds.add(s.addedBy);
    }
    const userMap = await resolvePgUserMap(db, [...rawUserIds]);
    sharedWithJson = serializeShareEntries(
      rec.sharedWith,
      raw => userMap.get(raw) ?? raw,
    );
  }

  const values: typeof appProjects.$inferInsert = {
    id: idUuid,
    workspaceId: wsUuid,
    title: rec.title,
    slug: rec.slug ?? null,
    path: rec.path ?? null,
    description: rec.description ?? null,
    access: rec.access,
    workspaceRole: rec.workspaceRole ?? null,
    sharedWith: sharedWithJson,
    ownerId,
    createdBy,
    defaultBranch: rec.defaultBranch,
    cloudRepoOwner: rec.cloudRepo?.owner ?? null,
    cloudRepoName: rec.cloudRepo?.repo ?? null,
    publishedSha: rec.publishedSha ?? null,
    chatEnabled: rec.chatEnabled ?? null,
    publishedAt: rec.publishedAt ?? null,
    lastDeployError: serializeLastDeployError(rec.lastDeployError),
    bindingRefreshErrors: serializeBindingRefreshErrors(
      rec.bindingRefreshErrors,
    ),
    deployProgress: serializeDeployProgress(rec.deployProgress),
    publicShareEnabled: Boolean(rec.publicShare?.enabled),
    publicShareToken: rec.publicShare?.token ?? null,
    publicSharePasswordHash: rec.publicShare?.passwordHash ?? null,
    publicSharePasswordEncrypted: rec.publicShare?.passwordEncrypted ?? null,
    publicShareCreatedAt: rec.publicShare?.createdAt ?? null,
    publicShareCreatedBy,
    publicShareAllowLiveQueries: Boolean(rec.publicShare?.allowLiveQueries),
    env: rec.env ?? null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };

  await db
    .insert(appProjects)
    .values(values)
    .onConflictDoUpdate({
      target: appProjects.id,
      set: {
        title: values.title,
        slug: values.slug,
        path: values.path,
        description: values.description,
        access: values.access,
        workspaceRole: values.workspaceRole,
        sharedWith: values.sharedWith,
        ownerId: values.ownerId,
        createdBy: values.createdBy,
        defaultBranch: values.defaultBranch,
        cloudRepoOwner: values.cloudRepoOwner,
        cloudRepoName: values.cloudRepoName,
        publishedSha: values.publishedSha,
        chatEnabled: values.chatEnabled,
        publishedAt: values.publishedAt,
        lastDeployError: values.lastDeployError,
        bindingRefreshErrors: values.bindingRefreshErrors,
        deployProgress: values.deployProgress,
        publicShareEnabled: values.publicShareEnabled,
        publicShareToken: values.publicShareToken,
        publicSharePasswordHash: values.publicSharePasswordHash,
        publicSharePasswordEncrypted: values.publicSharePasswordEncrypted,
        publicShareCreatedAt: values.publicShareCreatedAt,
        publicShareCreatedBy: values.publicShareCreatedBy,
        publicShareAllowLiveQueries: values.publicShareAllowLiveQueries,
        env: values.env,
        updatedAt: values.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appProjects.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appProjects.updatedAt}`,
          }
        : {}),
    });
}

async function upsertIndexEntryRecordToPg(
  rec: AppIndexEntryRecord,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const appUuid = entityIdToPgUuid(rec.appId);
  const ownerId = await pgRepo.resolveNullableUserUuid(rec.ownerId, db);
  const duplicateOf = optionalEntityIdToPgUuid(rec.duplicateOf);

  const values: typeof appIndex.$inferInsert = {
    id: idUuid,
    workspaceId: wsUuid,
    appId: appUuid,
    path: rec.path,
    slug: rec.slug,
    scope: rec.scope,
    ownerId,
    treeOid: rec.treeOid,
    title: rec.title,
    description: rec.description ?? null,
    hasManifestId: rec.hasManifestId,
    duplicateOf,
    schedules: rec.schedules,
    tables: rec.tables ?? null,
    bindingTables: rec.bindingTables ?? null,
    bindings: rec.bindings ?? null,
    authorEmail: rec.authorEmail ?? null,
    firstCommitAt: rec.firstCommitAt ?? null,
    thumbnail: rec.thumbnail ?? null,
    icon: rec.icon ?? null,
    indexedSha: rec.indexedSha,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };

  const updated = await db
    .insert(appIndex)
    .values(values)
    .onConflictDoUpdate({
      target: appIndex.appId,
      set: {
        id: idUuid,
        workspaceId: values.workspaceId,
        path: values.path,
        slug: values.slug,
        scope: values.scope,
        ownerId: values.ownerId,
        treeOid: values.treeOid,
        title: values.title,
        description: values.description,
        hasManifestId: values.hasManifestId,
        duplicateOf: values.duplicateOf,
        schedules: values.schedules,
        tables: values.tables,
        bindingTables: values.bindingTables,
        bindings: values.bindings,
        authorEmail: values.authorEmail,
        firstCommitAt: values.firstCommitAt,
        thumbnail: values.thumbnail,
        icon: values.icon,
        indexedSha: values.indexedSha,
        updatedAt: values.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appIndex.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appIndex.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appIndex.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appIndex)
      .set({ id: idUuid })
      .where(and(eq(appIndex.appId, appUuid), ne(appIndex.id, idUuid)));
  }
}

async function upsertIndexHeadRecordToPg(
  rec: AppIndexHeadRecord,
  db: MakoPgDb,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const updated = await db
    .insert(appIndexHeads)
    .values({
      id: idUuid,
      workspaceId: wsUuid,
      sha: rec.sha,
      schemaVersion: rec.schemaVersion ?? null,
      folders: rec.folders,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: appIndexHeads.workspaceId,
      set: {
        id: idUuid,
        sha: rec.sha,
        schemaVersion: rec.schemaVersion ?? null,
        folders: rec.folders,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appIndexHeads.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appIndexHeads.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appIndexHeads.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appIndexHeads)
      .set({ id: idUuid })
      .where(
        and(
          eq(appIndexHeads.workspaceId, wsUuid),
          ne(appIndexHeads.id, idUuid),
        ),
      );
  }
}

async function upsertEmbeddingRecordToPg(
  rec: AppEmbeddingRecord,
  db: MakoPgDb,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const appUuid = entityIdToPgUuid(rec.appId);
  const updated = await db
    .insert(appEmbeddings)
    .values({
      id: idUuid,
      workspaceId: wsUuid,
      appId: appUuid,
      path: rec.path,
      treeOid: rec.treeOid,
      docHash: rec.docHash,
      embeddingModel: rec.embeddingModel,
      vector: rec.vector,
      terms: rec.terms ?? null,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: [appEmbeddings.workspaceId, appEmbeddings.appId],
      set: {
        id: idUuid,
        path: rec.path,
        treeOid: rec.treeOid,
        docHash: rec.docHash,
        embeddingModel: rec.embeddingModel,
        vector: rec.vector,
        terms: rec.terms ?? null,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appEmbeddings.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appEmbeddings.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appEmbeddings.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appEmbeddings)
      .set({ id: idUuid })
      .where(
        and(
          eq(appEmbeddings.workspaceId, wsUuid),
          eq(appEmbeddings.appId, appUuid),
          ne(appEmbeddings.id, idUuid),
        ),
      );
  }
}

async function upsertLifecycleRecordToPg(
  rec: AppLifecycleRecord,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const appUuid = entityIdToPgUuid(rec.appId);
  const [verifiedBy, restoredBy] = await Promise.all([
    pgRepo.resolveNullableUserUuid(rec.verifiedBy, db),
    pgRepo.resolveNullableUserUuid(rec.restoredBy, db),
  ]);

  const updated = await db
    .insert(appLifecycle)
    .values({
      id: idUuid,
      workspaceId: wsUuid,
      appId: appUuid,
      verifiedAt: rec.verifiedAt ?? null,
      verifiedBy,
      staleSince: rec.staleSince ?? null,
      staleNotifiedTo: rec.staleNotifiedTo ?? null,
      schedulesPausedAt: rec.schedulesPausedAt ?? null,
      archivedAt: rec.archivedAt ?? null,
      archivedFrom: rec.archivedFrom ?? null,
      archivedTo: rec.archivedTo ?? null,
      restoredAt: rec.restoredAt ?? null,
      restoredBy,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: [appLifecycle.workspaceId, appLifecycle.appId],
      set: {
        id: idUuid,
        verifiedAt: rec.verifiedAt ?? null,
        verifiedBy,
        staleSince: rec.staleSince ?? null,
        staleNotifiedTo: rec.staleNotifiedTo ?? null,
        schedulesPausedAt: rec.schedulesPausedAt ?? null,
        archivedAt: rec.archivedAt ?? null,
        archivedFrom: rec.archivedFrom ?? null,
        archivedTo: rec.archivedTo ?? null,
        restoredAt: rec.restoredAt ?? null,
        restoredBy,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appLifecycle.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appLifecycle.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appLifecycle.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appLifecycle)
      .set({ id: idUuid })
      .where(
        and(
          eq(appLifecycle.workspaceId, wsUuid),
          eq(appLifecycle.appId, appUuid),
          ne(appLifecycle.id, idUuid),
        ),
      );
  }
}

async function upsertCommitStatusRecordToPg(
  rec: AppDeployCommitStatusRecord,
  db: MakoPgDb,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const appUuid = entityIdToPgUuid(rec.appId);
  const updated = await db
    .insert(appDeployCommitStatuses)
    .values({
      id: idUuid,
      workspaceId: wsUuid,
      appId: appUuid,
      sha: rec.sha,
      state: rec.state,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        appDeployCommitStatuses.workspaceId,
        appDeployCommitStatuses.appId,
        appDeployCommitStatuses.sha,
      ],
      set: {
        id: idUuid,
        state: rec.state,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appDeployCommitStatuses.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appDeployCommitStatuses.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appDeployCommitStatuses.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appDeployCommitStatuses)
      .set({ id: idUuid })
      .where(
        and(
          eq(appDeployCommitStatuses.workspaceId, wsUuid),
          eq(appDeployCommitStatuses.appId, appUuid),
          eq(appDeployCommitStatuses.sha, rec.sha),
          ne(appDeployCommitStatuses.id, idUuid),
        ),
      );
  }
}

async function upsertWorktreeRecordToPg(
  rec: AppWorktreeRecord,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const projectId = optionalEntityIdToPgUuid(rec.projectId);
  const actor = await pgRepo.resolveWorktreeActor(rec.userId, db);

  const updated = await db
    .insert(appWorktrees)
    .values({
      id: idUuid,
      workspaceId: wsUuid,
      projectId,
      actorId: actor.actorId,
      userId: actor.userId,
      branch: rec.branch,
      lastActivityAt: rec.lastActivityAt ?? null,
      activeUntil: rec.activeUntil ?? null,
      idlePausedAt: rec.idlePausedAt ?? null,
      idlePauseHoldUntil: rec.idlePauseHoldUntil ?? null,
      idlePauseHoldSetAt: rec.idlePauseHoldSetAt ?? null,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: [appWorktrees.workspaceId, appWorktrees.actorId],
      set: {
        id: idUuid,
        projectId,
        userId: actor.userId,
        branch: rec.branch,
        lastActivityAt: options.guarded
          ? sql`GREATEST(${appWorktrees.lastActivityAt}, EXCLUDED."last_activity_at")`
          : (rec.lastActivityAt ?? null),
        activeUntil: options.guarded
          ? sql`GREATEST(${appWorktrees.activeUntil}, EXCLUDED."active_until")`
          : (rec.activeUntil ?? null),
        idlePausedAt: rec.idlePausedAt ?? null,
        idlePauseHoldUntil: rec.idlePauseHoldUntil ?? null,
        idlePauseHoldSetAt: rec.idlePauseHoldSetAt ?? null,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appWorktrees.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appWorktrees.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appWorktrees.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appWorktrees)
      .set({ id: idUuid })
      .where(
        and(
          eq(appWorktrees.workspaceId, wsUuid),
          eq(appWorktrees.actorId, actor.actorId),
          ne(appWorktrees.id, idUuid),
        ),
      );
  }
}

async function upsertBindingStateRecordToPg(
  rec: AppBindingStateRecord,
  db: MakoPgDb,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const projUuid = entityIdToPgUuid(rec.projectId);
  const historyJson = rec.history ? rec.history.map(serializeBindingRun) : null;

  const updated = await db
    .insert(appBindingState)
    .values({
      id: idUuid,
      projectId: projUuid,
      name: rec.name,
      lastMaterializedAt: rec.lastMaterializedAt ?? null,
      lastRowCount: rec.lastRowCount ?? null,
      publicRefreshAt: rec.publicRefreshAt ?? null,
      history: historyJson,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: [appBindingState.projectId, appBindingState.name],
      set: {
        id: idUuid,
        lastMaterializedAt: rec.lastMaterializedAt ?? null,
        lastRowCount: rec.lastRowCount ?? null,
        publicRefreshAt: options.guarded
          ? sql`GREATEST(${appBindingState.publicRefreshAt}, EXCLUDED."public_refresh_at")`
          : (rec.publicRefreshAt ?? null),
        history: historyJson,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appBindingState.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appBindingState.updatedAt}`,
          }
        : {}),
    })
    .returning({ id: appBindingState.id });
  if (options.guarded && updated.length === 0) {
    await db
      .update(appBindingState)
      .set({ id: idUuid })
      .where(
        and(
          eq(appBindingState.projectId, projUuid),
          eq(appBindingState.name, rec.name),
          ne(appBindingState.id, idUuid),
        ),
      );
  }
}

async function upsertBindingDraftRecordToPg(
  rec: AppBindingDraftRecord,
  db: MakoPgDb,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const projUuid = entityIdToPgUuid(rec.projectId);

  if (rec.kind === "failure") {
    const existing = await db
      .select({
        id: appBindingDrafts.id,
        updatedAt: appBindingDrafts.updatedAt,
      })
      .from(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, projUuid),
          eq(appBindingDrafts.hash, rec.hash),
          eq(appBindingDrafts.kind, "failure"),
        ),
      );
    if (existing.length > 0) {
      const target =
        existing.find(r => r.id.toLowerCase() === idUuid) ?? existing[0];
      const extraIds = existing.filter(r => r.id !== target.id).map(r => r.id);
      if (extraIds.length > 0) {
        await db
          .delete(appBindingDrafts)
          .where(inArray(appBindingDrafts.id, extraIds));
      }
      const allowDataUpdate =
        !options.guarded ||
        target.updatedAt == null ||
        rec.updatedAt >= target.updatedAt;
      if (allowDataUpdate) {
        await db
          .update(appBindingDrafts)
          .set({
            id: idUuid,
            kind: rec.kind,
            name: rec.name,
            key: rec.key ?? null,
            builtAt: rec.builtAt ?? null,
            rowCount: rec.rowCount ?? null,
            byteSize: rec.byteSize ?? null,
            failures: rec.failures ?? null,
            until: rec.until ?? null,
            error: rec.error ?? null,
            expiresAt: rec.expiresAt,
            updatedAt: rec.updatedAt,
          })
          .where(eq(appBindingDrafts.id, target.id));
      } else if (target.id.toLowerCase() !== idUuid) {
        await db
          .update(appBindingDrafts)
          .set({ id: idUuid })
          .where(eq(appBindingDrafts.id, target.id));
      }
      return;
    }
  }

  await db
    .insert(appBindingDrafts)
    .values({
      id: idUuid,
      projectId: projUuid,
      hash: rec.hash,
      kind: rec.kind,
      name: rec.name,
      key: rec.key ?? null,
      builtAt: rec.builtAt ?? null,
      rowCount: rec.rowCount ?? null,
      byteSize: rec.byteSize ?? null,
      failures: rec.failures ?? null,
      until: rec.until ?? null,
      error: rec.error ?? null,
      expiresAt: rec.expiresAt,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: appBindingDrafts.id,
      set: {
        kind: rec.kind,
        name: rec.name,
        key: rec.key ?? null,
        builtAt: rec.builtAt ?? null,
        rowCount: rec.rowCount ?? null,
        byteSize: rec.byteSize ?? null,
        failures: rec.failures ?? null,
        until: rec.until ?? null,
        error: rec.error ?? null,
        expiresAt: rec.expiresAt,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appBindingDrafts.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appBindingDrafts.updatedAt}`,
          }
        : {}),
    });
}

async function upsertBindingJobRecordToPg(
  rec: AppBindingJobRecord,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
  options: { guarded?: boolean } = {},
): Promise<void> {
  const idUuid = entityIdToPgUuid(rec.id);
  const wsUuid = entityIdToPgUuid(rec.workspaceId);
  const projUuid = entityIdToPgUuid(rec.projectId);
  const [actorId, userId] = await Promise.all([
    pgRepo.resolveBindingJobActorId(rec.actorId, db),
    pgRepo.resolveNullableUserUuid(rec.userId, db),
  ]);

  await db
    .insert(appBindingJobs)
    .values({
      id: idUuid,
      workspaceId: wsUuid,
      projectId: projUuid,
      name: rec.name,
      kind: rec.kind ?? null,
      actorId,
      userId,
      canWrite: rec.canWrite,
      unregistered: rec.unregistered ?? null,
      request: rec.request,
      status: rec.status,
      result: rec.result ?? null,
      error: rec.error ?? null,
      errorStatus: rec.errorStatus ?? null,
      heartbeatAt: rec.heartbeatAt ?? null,
      progress: serializeJobProgress(rec.progress),
      expiresAt: rec.expiresAt,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: appBindingJobs.id,
      set: {
        actorId,
        userId,
        status: rec.status,
        result: rec.result ?? null,
        error: rec.error ?? null,
        errorStatus: rec.errorStatus ?? null,
        heartbeatAt: rec.heartbeatAt ?? null,
        progress: serializeJobProgress(rec.progress),
        expiresAt: rec.expiresAt,
        updatedAt: rec.updatedAt,
      },
      ...(options.guarded
        ? {
            setWhere: sql`${appBindingJobs.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appBindingJobs.updatedAt}`,
          }
        : {}),
    });
}

async function upsertAppsBackfillItems(
  items: Array<BackfillItem<AppsBackfillDoc>>,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
): Promise<number> {
  let upserted = 0;
  const guarded = { guarded: true };
  for (const item of items) {
    const { doc } = item;
    switch (doc.table) {
      case "app_projects":
        await upsertProjectRecordToPg(doc.record, db, pgRepo, guarded);
        break;
      case "app_index":
        await upsertIndexEntryRecordToPg(doc.record, db, pgRepo, guarded);
        break;
      case "app_index_heads":
        await upsertIndexHeadRecordToPg(doc.record, db, guarded);
        break;
      case "app_embeddings":
        await upsertEmbeddingRecordToPg(doc.record, db, guarded);
        break;
      case "app_lifecycle":
        await upsertLifecycleRecordToPg(doc.record, db, pgRepo, guarded);
        break;
      case "app_deploy_commit_statuses":
        await upsertCommitStatusRecordToPg(doc.record, db, guarded);
        break;
      case "app_worktrees":
        await upsertWorktreeRecordToPg(doc.record, db, pgRepo, guarded);
        break;
      case "app_binding_state":
        await upsertBindingStateRecordToPg(doc.record, db, guarded);
        break;
      case "app_binding_drafts":
        await upsertBindingDraftRecordToPg(doc.record, db, guarded);
        break;
      case "app_binding_jobs":
        await upsertBindingJobRecordToPg(doc.record, db, pgRepo, guarded);
        break;
    }
    upserted += 1;
  }
  return upserted;
}

export function createAppsMetadataBackfillHandler(): BackfillDomainHandler<AppsBackfillDoc> {
  const pgRepo = new PgAppsMetadataRepository();
  const workspaceCache = new Map<string, boolean>();

  return {
    domain: APPS_METADATA_DOMAIN,
    collectionName: "app_projects",
    targetTable: "app_projects",
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      workspaceCache.clear();
      const parsed = decodeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<AppsBackfillDoc>> = [];

      for (const meta of APPS_STAGES) {
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
        );
        items.push(...batch);
      }
      return items;
    },
    validate(item, db) {
      return validateAppsBackfillItem(item, db, workspaceCache);
    },
    upsertBatch(items, db) {
      return upsertAppsBackfillItems(items, db, pgRepo);
    },
  };
}

export function createAppsMetadataTableBackfillHandler(
  meta: AppsStageMeta,
): BackfillDomainHandler<AppsBackfillDoc> {
  const pgRepo = new PgAppsMetadataRepository();
  const workspaceCache = new Map<string, boolean>();

  return {
    domain: `${APPS_METADATA_DOMAIN}:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit, workspaceId }) {
      workspaceCache.clear();
      return fetchStageItems(meta, afterCursor, limit, workspaceId, false);
    },
    validate(item, db) {
      return validateAppsBackfillItem(item, db, workspaceCache);
    },
    upsertBatch(items, db) {
      return upsertAppsBackfillItems(items, db, pgRepo);
    },
  };
}

// ── Parity Verifier (+ --repair) ─────────────────────────────────────────────

function canonicalizeProjectForCompare(rec: AppProjectRecord): unknown {
  const { sharedWith, env, publicShare: rawPublicShare, ...rest } = rec;
  const publicShare = rawPublicShare
    ? {
        enabled: Boolean(rawPublicShare.enabled),
        ...(rawPublicShare.token ? { token: rawPublicShare.token } : {}),
        passwordHash: rawPublicShare.passwordHash ?? null,
        passwordEncrypted: rawPublicShare.passwordEncrypted ?? null,
        ...(rawPublicShare.createdAt
          ? { createdAt: rawPublicShare.createdAt }
          : {}),
        ...(rawPublicShare.createdBy
          ? { createdBy: rawPublicShare.createdBy }
          : {}),
        allowLiveQueries: Boolean(rawPublicShare.allowLiveQueries),
      }
    : undefined;
  return {
    ...rest,
    ...(sharedWith && sharedWith.length > 0 ? { sharedWith } : {}),
    ...(env && env.length > 0 ? { env } : {}),
    ...(publicShare ? { publicShare } : {}),
  };
}

function collectRawUserIdsFromItems(
  items: ReadonlyArray<BackfillItem<AppsBackfillDoc>>,
): string[] {
  const ids: string[] = [];
  for (const { doc } of items) {
    switch (doc.table) {
      case "app_projects":
        if (doc.record.owner_id) ids.push(doc.record.owner_id);
        if (doc.record.createdBy) ids.push(doc.record.createdBy);
        if (doc.record.publicShare?.createdBy) {
          ids.push(doc.record.publicShare.createdBy);
        }
        for (const s of doc.record.sharedWith ?? []) {
          if (s.userId) ids.push(s.userId);
          if (s.addedBy) ids.push(s.addedBy);
        }
        break;
      case "app_index":
        if (doc.record.ownerId) ids.push(doc.record.ownerId);
        break;
      case "app_lifecycle":
        if (doc.record.verifiedBy) ids.push(doc.record.verifiedBy);
        if (doc.record.restoredBy) ids.push(doc.record.restoredBy);
        break;
      case "app_worktrees":
        if (doc.record.userId) ids.push(doc.record.userId);
        break;
      case "app_binding_jobs":
        if (doc.record.actorId) ids.push(doc.record.actorId);
        if (doc.record.userId) ids.push(doc.record.userId);
        break;
      default:
        break;
    }
  }
  return ids;
}

function buildVerifierRecord(
  item: BackfillItem<AppsBackfillDoc>,
  userMap: Map<string, string>,
  composite: boolean,
): VerifierMongoRecord {
  const { doc } = item;
  const pgUuid = item.entityId.toLowerCase();
  const resolveOpt = (raw: string | undefined): string | undefined =>
    raw ? userMap.get(raw) : undefined;

  let comparable: unknown;
  switch (doc.table) {
    case "app_projects": {
      const rec = doc.record;
      const rewritten: AppProjectRecord = {
        ...rec,
        ...(rec.owner_id ? { owner_id: resolveOpt(rec.owner_id) } : {}),
        createdBy: resolveOpt(rec.createdBy) ?? "",
        ...(rec.sharedWith !== undefined
          ? {
              sharedWith: rec.sharedWith.map(s => ({
                ...s,
                userId: userMap.get(s.userId) ?? s.userId,
                ...(s.addedBy
                  ? { addedBy: userMap.get(s.addedBy) ?? s.addedBy }
                  : {}),
              })),
            }
          : {}),
        ...(rec.publicShare
          ? {
              publicShare: {
                ...rec.publicShare,
                createdBy: resolveOpt(rec.publicShare.createdBy),
              },
            }
          : {}),
      };
      if (!rewritten.owner_id) delete rewritten.owner_id;
      if (rewritten.publicShare && !rewritten.publicShare.createdBy) {
        delete rewritten.publicShare.createdBy;
      }
      comparable = canonicalizeProjectForCompare(rewritten);
      break;
    }

    case "app_index": {
      const ownerId = resolveOpt(doc.record.ownerId);
      const next: AppIndexEntryRecord = { ...doc.record };
      if (ownerId) next.ownerId = ownerId;
      else delete next.ownerId;
      comparable = next;
      break;
    }

    case "app_index_heads":
    case "app_embeddings":
    case "app_deploy_commit_statuses":
    case "app_binding_state":
    case "app_binding_drafts":
      comparable = doc.record;
      break;

    case "app_lifecycle": {
      const verifiedBy = resolveOpt(doc.record.verifiedBy);
      const restoredBy = resolveOpt(doc.record.restoredBy);
      const next: AppLifecycleRecord = { ...doc.record };
      if (verifiedBy) next.verifiedBy = verifiedBy;
      else delete next.verifiedBy;
      if (restoredBy) next.restoredBy = restoredBy;
      else delete next.restoredBy;
      comparable = next;
      break;
    }

    case "app_worktrees": {
      const resolved = userMap.get(doc.record.userId);
      comparable = {
        ...doc.record,
        userId: resolved ?? doc.record.userId,
      };
      break;
    }

    case "app_binding_jobs": {
      const actorId = isPersonActorId(doc.record.actorId)
        ? (userMap.get(doc.record.actorId) ?? doc.record.actorId)
        : doc.record.actorId;
      const userId = resolveOpt(doc.record.userId);
      const next: AppBindingJobRecord = { ...doc.record, actorId };
      if (userId) next.userId = userId;
      else delete next.userId;
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

async function fetchPgRecordsForTable(
  table: AppsMetadataTable,
  uuids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const valid = uuids.filter(isUuidString).map(u => u.toLowerCase());
  if (valid.length === 0) return out;

  switch (table) {
    case "app_projects": {
      const rows = await db
        .select()
        .from(appProjects)
        .where(inArray(appProjects.id, valid));
      for (const row of rows) {
        out.set(
          row.id.toLowerCase(),
          canonicalizeProjectForCompare(pgAppProjectToRecord(row)),
        );
      }
      return out;
    }
    case "app_index": {
      const rows = await db
        .select()
        .from(appIndex)
        .where(inArray(appIndex.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppIndexEntryToRecord(row));
      }
      return out;
    }
    case "app_index_heads": {
      const rows = await db
        .select()
        .from(appIndexHeads)
        .where(inArray(appIndexHeads.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppIndexHeadToRecord(row));
      }
      return out;
    }
    case "app_embeddings": {
      const rows = await db
        .select()
        .from(appEmbeddings)
        .where(inArray(appEmbeddings.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppEmbeddingToRecord(row));
      }
      return out;
    }
    case "app_lifecycle": {
      const rows = await db
        .select()
        .from(appLifecycle)
        .where(inArray(appLifecycle.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppLifecycleToRecord(row));
      }
      return out;
    }
    case "app_deploy_commit_statuses": {
      const rows = await db
        .select()
        .from(appDeployCommitStatuses)
        .where(inArray(appDeployCommitStatuses.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppDeployCommitStatusToRecord(row));
      }
      return out;
    }
    case "app_worktrees": {
      const rows = await db
        .select()
        .from(appWorktrees)
        .where(inArray(appWorktrees.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppWorktreeToRecord(row));
      }
      return out;
    }
    case "app_binding_state": {
      const rows = await db
        .select()
        .from(appBindingState)
        .where(inArray(appBindingState.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppBindingStateToRecord(row));
      }
      return out;
    }
    case "app_binding_drafts": {
      const rows = await db
        .select()
        .from(appBindingDrafts)
        .where(inArray(appBindingDrafts.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppBindingDraftToRecord(row));
      }
      return out;
    }
    case "app_binding_jobs": {
      const rows = await db
        .select()
        .from(appBindingJobs)
        .where(inArray(appBindingJobs.id, valid));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgAppBindingJobToRecord(row));
      }
      return out;
    }
  }
}

async function repairAppsEntityInPg(
  table: AppsMetadataTable,
  pgUuid: string,
  db: MakoPgDb,
  pgRepo: PgAppsMetadataRepository,
): Promise<boolean> {
  const parsed = parseEntityId(pgUuid);
  if (!parsed?.oid) return false;
  const oid = new Types.ObjectId(parsed.oid);
  const guarded = { guarded: true };
  switch (table) {
    case "app_projects": {
      const doc = await AppProject.findById(
        oid,
      ).lean<MongoAppProjectLike | null>();
      if (!doc) return false;
      const rec = mongoAppProjectToRecord(doc);
      if (!(await workspaceExistsInPg(db, rec.workspaceId))) return false;
      await upsertProjectRecordToPg(rec, db, pgRepo, guarded);
      return true;
    }
    case "app_index": {
      const doc = await AppIndexEntry.findById(
        oid,
      ).lean<MongoAppIndexEntryLike | null>();
      if (!doc) return false;
      const rec = mongoAppIndexEntryToRecord(doc);
      if (
        !parseEntityId(rec.appId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await upsertIndexEntryRecordToPg(rec, db, pgRepo, guarded);
      return true;
    }
    case "app_index_heads": {
      const doc = await AppIndexHead.findById(
        oid,
      ).lean<MongoAppIndexHeadLike | null>();
      if (!doc) return false;
      const rec = mongoAppIndexHeadToRecord(doc);
      if (!(await workspaceExistsInPg(db, rec.workspaceId))) return false;
      await upsertIndexHeadRecordToPg(rec, db, guarded);
      return true;
    }
    case "app_embeddings": {
      const doc = await AppEmbedding.findById(
        oid,
      ).lean<MongoAppEmbeddingLike | null>();
      if (!doc) return false;
      const rec = mongoAppEmbeddingToRecord(doc);
      if (
        rec.vector.length !== PGVECTOR_DIMS ||
        !parseEntityId(rec.appId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await upsertEmbeddingRecordToPg(rec, db, guarded);
      return true;
    }
    case "app_lifecycle": {
      const doc = await AppLifecycleState.findById(
        oid,
      ).lean<MongoAppLifecycleLike | null>();
      if (!doc) return false;
      const rec = mongoAppLifecycleToRecord(doc);
      if (
        !parseEntityId(rec.appId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await upsertLifecycleRecordToPg(rec, db, pgRepo, guarded);
      return true;
    }
    case "app_deploy_commit_statuses": {
      const doc = await AppDeployCommitStatus.findById(
        oid,
      ).lean<MongoAppDeployCommitStatusLike | null>();
      if (!doc) return false;
      const rec = mongoAppDeployCommitStatusToRecord(doc);
      if (
        !parseEntityId(rec.appId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await upsertCommitStatusRecordToPg(rec, db, guarded);
      return true;
    }
    case "app_worktrees": {
      const doc = await AppWorktree.findById(
        oid,
      ).lean<MongoAppWorktreeLike | null>();
      if (!doc) return false;
      const rec = mongoAppWorktreeToRecord(doc);
      if (!(await workspaceExistsInPg(db, rec.workspaceId))) return false;
      await upsertWorktreeRecordToPg(rec, db, pgRepo, guarded);
      return true;
    }
    case "app_binding_state": {
      const doc = await getMongoAppBindingStateModel()
        .findById(oid)
        .lean<MongoAppBindingStateLike | null>();
      if (!doc) return false;
      const rec = mongoAppBindingStateToRecord(doc);
      if (!parseEntityId(rec.projectId)) return false;
      await upsertBindingStateRecordToPg(rec, db, guarded);
      return true;
    }
    case "app_binding_drafts": {
      const doc = await getMongoAppBindingDraftModel()
        .findById(oid)
        .lean<MongoAppBindingDraftLike | null>();
      if (!doc) return false;
      const rec = mongoAppBindingDraftToRecord(doc);
      if (!parseEntityId(rec.projectId)) return false;
      await upsertBindingDraftRecordToPg(rec, db, guarded);
      return true;
    }
    case "app_binding_jobs": {
      const doc = await getMongoAppBindingJobModel()
        .findById(oid)
        .lean<MongoAppBindingJobLike | null>();
      if (!doc) return false;
      const rec = mongoAppBindingJobToRecord(doc);
      if (
        !parseEntityId(rec.projectId) ||
        !(await workspaceExistsInPg(db, rec.workspaceId))
      ) {
        return false;
      }
      await upsertBindingJobRecordToPg(rec, db, pgRepo, guarded);
      return true;
    }
  }
}

export function createAppsMetadataVerifierHandler(): VerifierDomainHandler {
  const pgRepo = new PgAppsMetadataRepository();

  return {
    domain: APPS_METADATA_DOMAIN,
    targetTable: "app_projects",
    compareOptions: { ...APPS_METADATA_SHADOW_OPTIONS, floatEpsilon: 1e-5 },
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const parsed = decodeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<AppsBackfillDoc>> = [];

      for (const meta of APPS_STAGES) {
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
          )),
        );
      }

      const userMap = await resolvePgUserMap(
        db,
        collectRawUserIdsFromItems(items),
      );
      return items.map(item => buildVerifierRecord(item, userMap, true));
    },
    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<AppsMetadataTable, string[]>();
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
          await repairAppsEntityInPg(
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

export function createAppsMetadataTableVerifierHandler(
  meta: AppsStageMeta,
): VerifierDomainHandler {
  const pgRepo = new PgAppsMetadataRepository();

  return {
    domain: `${APPS_METADATA_DOMAIN}:${meta.table}`,
    targetTable: meta.table,
    compareOptions:
      meta.table === "app_embeddings"
        ? { ...APPS_METADATA_SHADOW_OPTIONS, floatEpsilon: 1e-5 }
        : APPS_METADATA_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit, workspaceId, db }) {
      const items = await fetchStageItems(
        meta,
        afterCursor,
        limit,
        workspaceId,
        false,
      );
      const userMap = await resolvePgUserMap(
        db,
        collectRawUserIdsFromItems(items),
      );
      return items.map(item => buildVerifierRecord(item, userMap, false));
    },
    fetchPgByIds(entityIds, db) {
      return fetchPgRecordsForTable(meta.table, entityIds, db);
    },
    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const id of entityIds) {
        if (await repairAppsEntityInPg(meta.table, id, db, pgRepo)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

// ── Dead-letter sync-retry replay handlers ───────────────────────────────────

export async function replayAppsMetadataWriteToPg(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
  const payload = data.payload ?? {};
  const table = String(payload.table ?? "");
  const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");

  switch (table) {
    case "app_projects": {
      if (payload.deletedWorkspace && workspaceId) {
        await pgRepo.deleteProjectsByWorkspace(workspaceId, db);
        return;
      }
      if (payload.deleted && payload.id && workspaceId) {
        await pgRepo.deleteProject(workspaceId, String(payload.id), db);
        return;
      }
      const ids = Array.isArray(payload.ids)
        ? (payload.ids as string[])
        : [String(payload.id ?? data.entityId)];
      for (const rawId of ids) {
        const parsed = parseEntityId(rawId);
        if (!parsed) continue;
        const doc = await AppProject.findById(
          toMongoObjectId(rawId),
        ).lean<MongoAppProjectLike | null>();
        if (!doc) {
          if (workspaceId) await pgRepo.deleteProject(workspaceId, rawId, db);
          continue;
        }
        await upsertProjectRecordToPg(mongoAppProjectToRecord(doc), db, pgRepo);
      }
      return;
    }

    case "app_index": {
      if (!workspaceId) return;
      const wsOid = toMongoObjectId(workspaceId);
      const wsUuid = entityIdToPgUuid(workspaceId);
      const mongoDocs = await AppIndexEntry.find({ workspaceId: wsOid }).lean<
        MongoAppIndexEntryLike[]
      >();
      const mongoAppUuids = new Set<string>();
      for (const doc of mongoDocs) {
        const rec = mongoAppIndexEntryToRecord(doc);
        if (!parseEntityId(rec.appId)) continue;
        mongoAppUuids.add(entityIdToPgUuid(rec.appId));
        await upsertIndexEntryRecordToPg(rec, db, pgRepo);
      }
      const pgExisting = await db
        .select({ id: appIndex.id, appId: appIndex.appId })
        .from(appIndex)
        .where(eq(appIndex.workspaceId, wsUuid));
      const staleIds = pgExisting
        .filter(r => !mongoAppUuids.has(r.appId.toLowerCase()))
        .map(r => r.id);
      if (staleIds.length > 0) {
        await db.delete(appIndex).where(inArray(appIndex.id, staleIds));
      }
      return;
    }

    case "app_index_heads": {
      if (!workspaceId) return;
      const doc = await AppIndexHead.findOne({
        workspaceId: toMongoObjectId(workspaceId),
      }).lean<MongoAppIndexHeadLike | null>();
      if (!doc) return;
      await upsertIndexHeadRecordToPg(mongoAppIndexHeadToRecord(doc), db);
      return;
    }

    case "app_embeddings": {
      if (!workspaceId) return;
      if (Array.isArray(payload.deletedAppIds)) {
        await pgRepo.deleteEmbeddingsByAppIds(
          workspaceId,
          payload.deletedAppIds as string[],
          db,
        );
        return;
      }
      const docs = await AppEmbedding.find({
        workspaceId: toMongoObjectId(workspaceId),
      }).lean<MongoAppEmbeddingLike[]>();
      for (const doc of docs) {
        const rec = mongoAppEmbeddingToRecord(doc);
        if (rec.vector.length === PGVECTOR_DIMS && parseEntityId(rec.appId)) {
          await upsertEmbeddingRecordToPg(rec, db);
        }
      }
      return;
    }

    case "app_lifecycle": {
      const appId = String(payload.appId ?? data.entityId);
      if (!workspaceId || !appId) return;
      const doc = await AppLifecycleState.findOne({
        workspaceId: toMongoObjectId(workspaceId),
        appId,
      }).lean<MongoAppLifecycleLike | null>();
      if (!doc) return;
      await upsertLifecycleRecordToPg(
        mongoAppLifecycleToRecord(doc),
        db,
        pgRepo,
      );
      return;
    }

    case "app_deploy_commit_statuses": {
      const appId = String(payload.appId ?? "");
      const sha = String(payload.sha ?? "");
      if (!workspaceId || !appId || !sha) return;
      const doc = await AppDeployCommitStatus.findOne({
        workspaceId: toMongoObjectId(workspaceId),
        appId,
        sha,
      }).lean<MongoAppDeployCommitStatusLike | null>();
      if (!doc) return;
      await upsertCommitStatusRecordToPg(
        mongoAppDeployCommitStatusToRecord(doc),
        db,
      );
      return;
    }

    case "app_worktrees": {
      const actorId = String(payload.actorId ?? data.entityId);
      if (!workspaceId || !actorId) return;
      const doc = await AppWorktree.findOne({
        workspaceId: toMongoObjectId(workspaceId),
        userId: actorId,
      }).lean<MongoAppWorktreeLike | null>();
      if (!doc) return;
      await upsertWorktreeRecordToPg(mongoAppWorktreeToRecord(doc), db, pgRepo);
      return;
    }

    case "app_binding_state": {
      const projectId = String(payload.projectId ?? "");
      const name = String(payload.name ?? "");
      if (!projectId || !name) return;
      const doc = await getMongoAppBindingStateModel()
        .findOne({ projectId: toMongoObjectId(projectId), name })
        .lean<MongoAppBindingStateLike | null>();
      if (!doc) return;
      await upsertBindingStateRecordToPg(mongoAppBindingStateToRecord(doc), db);
      return;
    }

    case "app_binding_drafts": {
      if (Array.isArray(payload.deletedIds) && payload.projectId) {
        await pgRepo.deleteDraftsByIds(
          String(payload.projectId),
          payload.deletedIds as string[],
          workspaceId || undefined,
          db,
        );
        return;
      }
      if (payload.deletedFailures && payload.projectId && payload.hash) {
        await pgRepo.deleteDraftFailures(
          String(payload.projectId),
          String(payload.hash),
          workspaceId || undefined,
          db,
        );
        return;
      }
      if (payload.deletedByKey && payload.projectId && payload.key) {
        await pgRepo.deleteDraftBuildByKey(
          String(payload.projectId),
          String(payload.key),
          workspaceId || undefined,
          db,
        );
        return;
      }
      if (payload.kind === "failure" && payload.projectId && payload.hash) {
        const doc = await getMongoAppBindingDraftModel()
          .findOne({
            projectId: toMongoObjectId(String(payload.projectId)),
            hash: String(payload.hash),
            kind: "failure",
          })
          .lean<MongoAppBindingDraftLike | null>();
        if (doc) {
          await upsertBindingDraftRecordToPg(
            mongoAppBindingDraftToRecord(doc),
            db,
          );
        }
        return;
      }
      const id = String(payload.id ?? data.entityId);
      if (!parseEntityId(id)) return;
      const doc = await getMongoAppBindingDraftModel()
        .findById(toMongoObjectId(id))
        .lean<MongoAppBindingDraftLike | null>();
      if (doc) {
        await upsertBindingDraftRecordToPg(
          mongoAppBindingDraftToRecord(doc),
          db,
        );
      }
      return;
    }

    case "app_binding_jobs": {
      if (Array.isArray(payload.deletedIds) && payload.projectId) {
        await pgRepo.deleteBindingJobsByIds(
          String(payload.projectId),
          payload.deletedIds as string[],
          workspaceId || undefined,
          db,
        );
        return;
      }
      const id = String(payload.id ?? data.entityId);
      if (!parseEntityId(id)) return;
      const doc = await getMongoAppBindingJobModel()
        .findById(toMongoObjectId(id))
        .lean<MongoAppBindingJobLike | null>();
      if (doc) {
        await upsertBindingJobRecordToPg(
          mongoAppBindingJobToRecord(doc),
          db,
          pgRepo,
        );
      }
      return;
    }
  }
}

export async function replayAppsMetadataWriteToMongo(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const payload = data.payload ?? {};
  const table = String(payload.table ?? "");
  const workspaceId = String(payload.workspaceId ?? data.workspaceId ?? "");

  switch (table) {
    case "app_projects": {
      if (payload.deletedWorkspace && workspaceId) {
        await AppProject.deleteMany({
          workspaceId: toMongoObjectId(workspaceId),
        });
        return;
      }
      if (payload.deleted && payload.id && workspaceId) {
        await AppProject.deleteOne({
          _id: toMongoObjectId(String(payload.id)),
          workspaceId: toMongoObjectId(workspaceId),
        });
        return;
      }
      const ids = Array.isArray(payload.ids)
        ? (payload.ids as string[])
        : [String(payload.id ?? data.entityId)];
      for (const rawId of ids) {
        const parsed = parseEntityId(rawId);
        if (!parsed) continue;
        const rows = await db
          .select()
          .from(appProjects)
          .where(eq(appProjects.id, parsed.uuid))
          .limit(1);
        if (!rows[0]) {
          await AppProject.deleteOne({ _id: toMongoObjectId(rawId) });
          continue;
        }
        const rec = pgAppProjectToRecord(rows[0]);
        const userMap = await buildPgUuidToMongoUserIdMap(db, [
          rec.owner_id,
          rec.createdBy,
          rec.publicShare?.createdBy,
          ...(rec.sharedWith ?? []).flatMap(s => [s.userId, s.addedBy]),
        ]);
        const mappedSharedWith = rec.sharedWith?.map(s => ({
          ...s,
          userId: toMongoUserId(s.userId, userMap) ?? s.userId,
          ...(s.addedBy
            ? { addedBy: toMongoUserId(s.addedBy, userMap) ?? s.addedBy }
            : {}),
        }));
        const mappedPublicShare = rec.publicShare
          ? {
              ...rec.publicShare,
              ...(rec.publicShare.createdBy
                ? {
                    createdBy:
                      toMongoUserId(rec.publicShare.createdBy, userMap) ??
                      rec.publicShare.createdBy,
                  }
                : {}),
            }
          : undefined;
        await AppProject.updateOne(
          { _id: toMongoObjectId(rec.id) },
          buildMongoSetAndUnset(
            {
              workspaceId: toMongoObjectId(rec.workspaceId),
              title: rec.title,
              access: rec.access,
              createdBy: toMongoUserId(rec.createdBy, userMap) ?? rec.createdBy,
              defaultBranch: rec.defaultBranch,
            },
            {
              slug: rec.slug,
              path: rec.path,
              description: rec.description,
              workspaceRole: rec.workspaceRole,
              sharedWith: mappedSharedWith,
              owner_id: toMongoUserId(rec.owner_id, userMap),
              cloudRepo: rec.cloudRepo,
              publishedSha: rec.publishedSha,
              chatEnabled: rec.chatEnabled,
              publishedAt: rec.publishedAt,
              lastDeployError: rec.lastDeployError,
              bindingRefreshErrors: rec.bindingRefreshErrors,
              deployProgress: rec.deployProgress,
              publicShare: mappedPublicShare,
              env: rec.env,
            },
          ),
          { upsert: true },
        );
      }
      return;
    }

    case "app_index": {
      if (!workspaceId) return;
      const wsUuid = entityIdToPgUuid(workspaceId);
      const wsOid = toMongoObjectId(workspaceId);
      const pgRows = await db
        .select()
        .from(appIndex)
        .where(eq(appIndex.workspaceId, wsUuid));
      const recs = pgRows.map(pgAppIndexEntryToRecord);
      const userMap = await buildPgUuidToMongoUserIdMap(
        db,
        recs.map(r => r.ownerId),
      );
      const keepAppIds = new Set<string>();
      for (const rec of recs) {
        keepAppIds.add(rec.appId);
        await AppIndexEntry.updateOne(
          { workspaceId: wsOid, appId: rec.appId },
          buildMongoSetAndUnset(
            {
              path: rec.path,
              slug: rec.slug,
              scope: rec.scope,
              treeOid: rec.treeOid,
              title: rec.title,
              hasManifestId: rec.hasManifestId,
              schedules: rec.schedules,
              indexedSha: rec.indexedSha,
            },
            {
              ownerId: toMongoUserId(rec.ownerId, userMap),
              description: rec.description,
              duplicateOf: rec.duplicateOf,
              tables: rec.tables,
              bindingTables: rec.bindingTables,
              bindings: rec.bindings,
              authorEmail: rec.authorEmail,
              firstCommitAt: rec.firstCommitAt,
              thumbnail: rec.thumbnail,
              icon: rec.icon,
            },
            { _id: toMongoObjectId(rec.id) },
          ),
          { upsert: true },
        );
      }
      await AppIndexEntry.deleteMany({
        workspaceId: wsOid,
        appId: { $nin: [...keepAppIds] },
      });
      return;
    }

    case "app_index_heads": {
      if (!workspaceId) return;
      const rows = await db
        .select()
        .from(appIndexHeads)
        .where(eq(appIndexHeads.workspaceId, entityIdToPgUuid(workspaceId)))
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppIndexHeadToRecord(rows[0]);
      await AppIndexHead.updateOne(
        { workspaceId: toMongoObjectId(rec.workspaceId) },
        buildMongoSetAndUnset(
          {
            sha: rec.sha,
            folders: rec.folders,
          },
          {
            schemaVersion: rec.schemaVersion,
          },
          { _id: toMongoObjectId(rec.id) },
        ),
        { upsert: true },
      );
      return;
    }

    case "app_embeddings": {
      if (!workspaceId) return;
      const wsOid = toMongoObjectId(workspaceId);
      if (Array.isArray(payload.deletedAppIds)) {
        await AppEmbedding.deleteMany({
          workspaceId: wsOid,
          appId: { $in: payload.deletedAppIds as string[] },
        });
        return;
      }
      const rows = await db
        .select()
        .from(appEmbeddings)
        .where(eq(appEmbeddings.workspaceId, entityIdToPgUuid(workspaceId)));
      for (const row of rows) {
        const rec = pgAppEmbeddingToRecord(row);
        await AppEmbedding.updateOne(
          { workspaceId: wsOid, appId: rec.appId },
          buildMongoSetAndUnset(
            {
              path: rec.path,
              treeOid: rec.treeOid,
              docHash: rec.docHash,
              embeddingModel: rec.embeddingModel,
              vector: rec.vector,
            },
            {
              terms: rec.terms,
            },
            { _id: toMongoObjectId(rec.id) },
          ),
          { upsert: true },
        );
      }
      return;
    }

    case "app_lifecycle": {
      const appId = String(payload.appId ?? data.entityId);
      if (!workspaceId || !appId) return;
      const rows = await db
        .select()
        .from(appLifecycle)
        .where(
          and(
            eq(appLifecycle.workspaceId, entityIdToPgUuid(workspaceId)),
            eq(appLifecycle.appId, entityIdToPgUuid(appId)),
          ),
        )
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppLifecycleToRecord(rows[0]);
      const userMap = await buildPgUuidToMongoUserIdMap(db, [
        rec.verifiedBy,
        rec.restoredBy,
      ]);
      await AppLifecycleState.updateOne(
        { workspaceId: toMongoObjectId(rec.workspaceId), appId: rec.appId },
        buildMongoSetAndUnset(
          {},
          {
            verifiedAt: rec.verifiedAt,
            verifiedBy: toMongoUserId(rec.verifiedBy, userMap),
            staleSince: rec.staleSince,
            staleNotifiedTo: rec.staleNotifiedTo,
            schedulesPausedAt: rec.schedulesPausedAt,
            archivedAt: rec.archivedAt,
            archivedFrom: rec.archivedFrom,
            archivedTo: rec.archivedTo,
            restoredAt: rec.restoredAt,
            restoredBy: toMongoUserId(rec.restoredBy, userMap),
          },
          { _id: toMongoObjectId(rec.id) },
        ),
        { upsert: true },
      );
      return;
    }

    case "app_deploy_commit_statuses": {
      const appId = String(payload.appId ?? "");
      const sha = String(payload.sha ?? "");
      if (!workspaceId || !appId || !sha) return;
      const rows = await db
        .select()
        .from(appDeployCommitStatuses)
        .where(
          and(
            eq(
              appDeployCommitStatuses.workspaceId,
              entityIdToPgUuid(workspaceId),
            ),
            eq(appDeployCommitStatuses.appId, entityIdToPgUuid(appId)),
            eq(appDeployCommitStatuses.sha, sha),
          ),
        )
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppDeployCommitStatusToRecord(rows[0]);
      await AppDeployCommitStatus.updateOne(
        {
          workspaceId: toMongoObjectId(rec.workspaceId),
          appId: rec.appId,
          sha: rec.sha,
        },
        {
          $set: { state: rec.state },
          $setOnInsert: { _id: toMongoObjectId(rec.id) },
        },
        { upsert: true },
      );
      return;
    }

    case "app_worktrees": {
      const actorId = String(payload.actorId ?? data.entityId);
      if (!workspaceId || !actorId) return;
      const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
      const resolved = await pgRepo.resolveWorktreeActor(actorId, db);
      const rows = await db
        .select()
        .from(appWorktrees)
        .where(
          and(
            eq(appWorktrees.workspaceId, entityIdToPgUuid(workspaceId)),
            eq(appWorktrees.actorId, resolved.actorId),
          ),
        )
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppWorktreeToRecord(rows[0]);
      const userMap = await buildPgUuidToMongoUserIdMap(db, [rec.userId]);
      const mongoActorId = isPersonActorId(rec.userId)
        ? (toMongoUserId(rec.userId, userMap) ?? rec.userId)
        : rec.userId;
      await AppWorktree.updateOne(
        {
          workspaceId: toMongoObjectId(rec.workspaceId),
          userId: mongoActorId,
        },
        buildMongoSetAndUnset(
          { branch: rec.branch },
          {
            projectId: rec.projectId
              ? toMongoObjectId(rec.projectId)
              : undefined,
            lastActivityAt: rec.lastActivityAt,
            activeUntil: rec.activeUntil,
            idlePausedAt: rec.idlePausedAt,
            idlePauseHoldUntil: rec.idlePauseHoldUntil,
            idlePauseHoldSetAt: rec.idlePauseHoldSetAt,
          },
          { _id: toMongoObjectId(rec.id) },
        ),
        { upsert: true },
      );
      return;
    }

    case "app_binding_state": {
      const projectId = String(payload.projectId ?? "");
      const name = String(payload.name ?? "");
      if (!projectId || !name) return;
      const rows = await db
        .select()
        .from(appBindingState)
        .where(
          and(
            eq(appBindingState.projectId, entityIdToPgUuid(projectId)),
            eq(appBindingState.name, name),
          ),
        )
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppBindingStateToRecord(rows[0]);
      await getMongoAppBindingStateModel().updateOne(
        { projectId: toMongoObjectId(rec.projectId), name: rec.name },
        buildMongoSetAndUnset(
          {},
          {
            lastMaterializedAt: rec.lastMaterializedAt,
            lastRowCount: rec.lastRowCount,
            publicRefreshAt: rec.publicRefreshAt,
            history: rec.history,
          },
          { _id: toMongoObjectId(rec.id) },
        ),
        { upsert: true },
      );
      return;
    }

    case "app_binding_drafts": {
      const DraftModel = getMongoAppBindingDraftModel();
      if (Array.isArray(payload.deletedIds) && payload.projectId) {
        await DraftModel.deleteMany({
          _id: {
            $in: (payload.deletedIds as string[]).map(id =>
              toMongoObjectId(id),
            ),
          },
          projectId: toMongoObjectId(String(payload.projectId)),
        });
        return;
      }
      if (payload.deletedFailures && payload.projectId && payload.hash) {
        await DraftModel.deleteMany({
          projectId: toMongoObjectId(String(payload.projectId)),
          hash: String(payload.hash),
          kind: "failure",
        });
        return;
      }
      if (payload.deletedByKey && payload.projectId && payload.key) {
        await DraftModel.deleteMany({
          projectId: toMongoObjectId(String(payload.projectId)),
          kind: "build",
          key: String(payload.key),
        });
        return;
      }
      if (payload.kind === "failure" && payload.projectId && payload.hash) {
        const rows = await db
          .select()
          .from(appBindingDrafts)
          .where(
            and(
              eq(
                appBindingDrafts.projectId,
                entityIdToPgUuid(String(payload.projectId)),
              ),
              eq(appBindingDrafts.hash, String(payload.hash)),
              eq(appBindingDrafts.kind, "failure"),
            ),
          )
          .limit(1);
        if (!rows[0]) return;
        const rec = pgAppBindingDraftToRecord(rows[0]);
        await DraftModel.updateOne(
          {
            projectId: toMongoObjectId(rec.projectId),
            hash: rec.hash,
            kind: "failure",
          },
          buildMongoSetAndUnset(
            {
              name: rec.name,
              expiresAt: rec.expiresAt,
            },
            {
              failures: rec.failures,
              until: rec.until,
              error: rec.error,
            },
            { _id: toMongoObjectId(rec.id) },
          ),
          { upsert: true },
        );
        return;
      }
      const id = String(payload.id ?? data.entityId);
      const parsed = parseEntityId(id);
      if (!parsed) return;
      const rows = await db
        .select()
        .from(appBindingDrafts)
        .where(eq(appBindingDrafts.id, parsed.uuid))
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppBindingDraftToRecord(rows[0]);
      await DraftModel.updateOne(
        { _id: toMongoObjectId(rec.id) },
        buildMongoSetAndUnset(
          {
            projectId: toMongoObjectId(rec.projectId),
            hash: rec.hash,
            kind: rec.kind,
            name: rec.name,
            expiresAt: rec.expiresAt,
          },
          {
            key: rec.key,
            builtAt: rec.builtAt,
            rowCount: rec.rowCount,
            byteSize: rec.byteSize,
            failures: rec.failures,
            until: rec.until,
            error: rec.error,
          },
        ),
        { upsert: true },
      );
      return;
    }

    case "app_binding_jobs": {
      const JobModel = getMongoAppBindingJobModel();
      if (Array.isArray(payload.deletedIds) && payload.projectId) {
        const rawProj = String(payload.projectId);
        const mongoProj = parseEntityId(rawProj)?.oid ?? rawProj;
        await JobModel.deleteMany({
          _id: {
            $in: (payload.deletedIds as string[]).map(id =>
              toMongoObjectId(id),
            ),
          },
          projectId: mongoProj,
        });
        return;
      }
      const id = String(payload.id ?? data.entityId);
      const parsed = parseEntityId(id);
      if (!parsed) return;
      const rows = await db
        .select()
        .from(appBindingJobs)
        .where(eq(appBindingJobs.id, parsed.uuid))
        .limit(1);
      if (!rows[0]) return;
      const rec = pgAppBindingJobToRecord(rows[0]);
      const userMap = await buildPgUuidToMongoUserIdMap(db, [
        isPersonActorId(rec.actorId) ? rec.actorId : undefined,
        rec.userId,
      ]);
      const mappedActorId = isPersonActorId(rec.actorId)
        ? (toMongoUserId(rec.actorId, userMap) ?? rec.actorId)
        : rec.actorId;
      await JobModel.updateOne(
        { _id: toMongoObjectId(rec.id) },
        buildMongoSetAndUnset(
          {
            workspaceId: rec.workspaceId,
            projectId: rec.projectId,
            name: rec.name,
            actorId: mappedActorId,
            canWrite: rec.canWrite,
            request: rec.request,
            status: rec.status,
            expiresAt: rec.expiresAt,
          },
          {
            kind: rec.kind,
            userId: toMongoUserId(rec.userId, userMap),
            unregistered: rec.unregistered,
            result: rec.result,
            error: rec.error,
            errorStatus: rec.errorStatus,
            heartbeatAt: rec.heartbeatAt,
            progress: rec.progress,
          },
        ),
        { upsert: true },
      );
      return;
    }
  }
}

/**
 * Register all `apps_metadata` backfill handlers, parity verifiers, and
 * Inngest sync-retry handlers.
 *
 * Intentionally registers ZERO TTL reaper rules: `app_binding_drafts` and
 * `app_binding_jobs` own GCS/artifact parquet blobs and are pruned exclusively
 * by app-side `pruneExpiredDrafts` / `pruneExpiredJobs`.
 */
export function registerAppsMetadataMigrationDomain(): void {
  registerBackfillDomain(createAppsMetadataBackfillHandler());
  registerVerifierDomain(createAppsMetadataVerifierHandler());

  for (const meta of APPS_STAGES) {
    registerBackfillDomain(createAppsMetadataTableBackfillHandler(meta));
    registerVerifierDomain(createAppsMetadataTableVerifierHandler(meta));
  }

  registerSyncRetryHandler("pg", APPS_METADATA_DOMAIN, data =>
    replayAppsMetadataWriteToPg(data),
  );
  registerSyncRetryHandler("mongo", APPS_METADATA_DOMAIN, data =>
    replayAppsMetadataWriteToMongo(data),
  );
}
