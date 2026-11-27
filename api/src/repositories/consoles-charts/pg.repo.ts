/**
 * Postgres (Drizzle / Neon / PGlite) implementation of `ConsolesChartsRepository`.
 *
 * Covers all 7 Phase 2A-2 tables (`console_folders`, `saved_consoles`, `entity_versions`,
 * `notebook_folders`, `notebook_indexes`, `favourites`, `scheduled_query_runs`) with:
 *   - Bijective UUIDv8 ObjectId conversion (`toPgUuid` / `toWireId`).
 *   - Native `uuid` user FKs resolved via `authRepo.resolveUserUuid()` (Decision #3),
 *     mapping system sentinels (`""`, `"system"`, `"git"`, `"agent"`, `"unowned:*"`) to `NULL`.
 *   - pgvector `<=>` HNSW cosine search, `tsvector` `websearch_to_tsquery` + `ts_rank`,
 *     and `ILIKE` trigram fallback.
 *   - Recursive CTE subtree deletions for `favourites` and `notebook_folders`.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import { isUuidString, newDualId, toWireId } from "../../database/pg/id-codec";
import { databaseConnections } from "../../database/pg/schema/connections";
import {
  consoleFolders,
  entityVersions,
  favourites,
  notebookFolders,
  notebookIndexes,
  savedConsoles,
  scheduledQueryRuns,
  type NewSavedConsoleRow,
  type SavedConsoleRow,
} from "../../database/pg/schema/consoles-charts";
import { authRepo } from "../auth";
import {
  lastRunToPgJson,
  optionalPgUuid,
  pgConsoleFolderToRecord,
  pgEntityVersionToRecord,
  pgFavouriteToRecord,
  pgNotebookFolderToRecord,
  pgNotebookIndexToRecord,
  pgSavedConsoleToRecord,
  pgScheduledQueryRunToRecord,
  resolveOptionalUserUuid,
  shareEntriesToPgJson,
  toPgUuid,
  wireId,
  type UserUuidResolver,
} from "./mapper";
import type {
  ConsoleFolderRecord,
  ConsoleLastRunRecord,
  ConsoleSearchCandidate,
  ConsolesChartsRepository,
  CreateConsoleFolderInput,
  CreateConsoleInput,
  CreateEntityVersionInput,
  CreateFavouriteInput,
  CreateNotebookFolderInput,
  CreateNotebookIndexInput,
  CreateScheduledQueryRunInput,
  DueScheduledConsole,
  EntityVersionListItem,
  EntityVersionRecord,
  ExternalSource,
  FavouriteKind,
  FavouriteRecord,
  GuardedSaveConsoleInput,
  ListConsolesFilter,
  NotebookFolderRecord,
  NotebookIndexRecord,
  RecordScheduleOutcomeInput,
  ReorderFavouriteUpdate,
  SavedConsoleRecord,
  ScheduledQueryRunRecord,
  UpdateConsoleFolderInput,
  UpdateConsolePatch,
  UpdateNotebookFolderInput,
  UpdateNotebookIndexInput,
  UpdateScheduledQueryRunInput,
} from "./types";

const MAX_VERSION_RETRIES = 3;

/** Explicit column projection for `saved_consoles` omitting heavy `description_embedding` & `search_tsv`. */
const SAVED_CONSOLE_BASE_COLUMNS = {
  id: savedConsoles.id,
  workspaceId: savedConsoles.workspaceId,
  folderId: savedConsoles.folderId,
  connectionId: savedConsoles.connectionId,
  databaseName: savedConsoles.databaseName,
  databaseId: savedConsoles.databaseId,
  name: savedConsoles.name,
  description: savedConsoles.description,
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
  scheduledRunLastRowsAffected: savedConsoles.scheduledRunLastRowsAffected,
  scheduledRunLastRowCount: savedConsoles.scheduledRunLastRowCount,
  scheduledRunCount: savedConsoles.scheduledRunCount,
  scheduledRunConsecutiveFailures:
    savedConsoles.scheduledRunConsecutiveFailures,
  scheduledRunPermanentFailures: savedConsoles.scheduledRunPermanentFailures,
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
} as const;

const SAVED_CONSOLE_WITH_EMBEDDING_COLUMNS = {
  ...SAVED_CONSOLE_BASE_COLUMNS,
  descriptionEmbedding: savedConsoles.descriptionEmbedding,
} as const;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function formatPgVectorLiteral(vec: readonly number[]): string {
  const nums = vec.map(v => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("Embedding vector contains non-finite number");
    }
    return v;
  });
  return `[${nums.join(",")}]`;
}

function isPgUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code =
    (error as { code?: string; cause?: { code?: string } }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  return code === "23505";
}

function isConsolesConnectionFkViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: { code?: string; constraint?: string; message?: string };
  };
  const code = err.code ?? err.cause?.code;
  if (code !== "23503") return false;
  const constraint = err.constraint ?? err.cause?.constraint;
  if (constraint) return constraint === "saved_consoles_connection_id_fk";
  const msg = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  return msg.includes("saved_consoles_connection_id_fk");
}

/**
 * True once post-backfill step `0005a_consoles_connection_fk.sql` has attached
 * `saved_consoles_connection_id_fk` referencing `database_connections(id)`.
 */
export async function hasConsolesConnectionFk(db: MakoPgDb): Promise<boolean> {
  const raw = await db.execute(sql`
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'saved_consoles_connection_id_fk'
    LIMIT 1
  `);
  return extractRows(raw).length > 0;
}

async function resolveConnectionIdForFk(
  db: MakoPgDb,
  connectionUuid: string | null,
): Promise<string | null> {
  if (!connectionUuid) return null;
  if (!(await hasConsolesConnectionFk(db))) return connectionUuid;
  const existing = await db
    .select({ id: databaseConnections.id })
    .from(databaseConnections)
    .where(eq(databaseConnections.id, connectionUuid))
    .limit(1);
  return existing.length > 0 ? connectionUuid : null;
}

function safePgUuid(id: string | null | undefined): string | null {
  try {
    return optionalPgUuid(id);
  } catch {
    return null;
  }
}

export interface PgConsolesChartsRepositoryDeps {
  getDb?: () => MakoPgDb;
  resolveUserUuid?: UserUuidResolver;
}

export class PgConsolesChartsRepository implements ConsolesChartsRepository {
  private readonly getDb: () => MakoPgDb;
  private readonly resolveUserUuidFn: UserUuidResolver;

  constructor(deps: PgConsolesChartsRepositoryDeps = {}) {
    this.getDb = deps.getDb ?? getPgDb;
    this.resolveUserUuidFn =
      deps.resolveUserUuid ?? (id => authRepo.resolveUserUuid(id));
  }

  private async resolveRequiredUserUuid(userId: string): Promise<string> {
    const resolved = await resolveOptionalUserUuid(
      userId,
      this.resolveUserUuidFn,
    );
    if (!resolved) {
      throw new Error(
        `Cannot resolve userId ${JSON.stringify(userId)} to a Postgres users.id UUID`,
      );
    }
    return resolved;
  }

  private async resolveUserUuidForRead(userId: string): Promise<string | null> {
    if (!userId) return null;
    const resolved = await this.resolveUserUuidFn(userId);
    if (resolved && isUuidString(resolved)) return resolved.toLowerCase();
    return isUuidString(userId) ? userId.toLowerCase() : null;
  }

  private async buildInsertConsoleRow(
    input: CreateConsoleInput,
  ): Promise<NewSavedConsoleRow> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const access = input.access ?? (input.isPrivate ? "private" : "private");
    const [createdByUuid, ownerUuid, sharedWithJson, lastRunJson] =
      await Promise.all([
        resolveOptionalUserUuid(input.createdBy, this.resolveUserUuidFn),
        resolveOptionalUserUuid(input.owner_id, this.resolveUserUuidFn),
        shareEntriesToPgJson(input.sharedWith, this.resolveUserUuidFn),
        lastRunToPgJson(input.lastRun, this.resolveUserUuidFn),
      ]);

    const now = new Date();
    const sr = input.scheduledRun;
    return {
      id,
      workspaceId: toPgUuid(input.workspaceId),
      folderId: optionalPgUuid(input.folderId),
      connectionId: optionalPgUuid(input.connectionId),
      databaseName: input.databaseName ?? null,
      databaseId: input.databaseId ?? null,
      name: input.name,
      description: input.description ?? null,
      descriptionEmbedding:
        input.descriptionEmbedding && input.descriptionEmbedding.length > 0
          ? input.descriptionEmbedding
          : null,
      embeddingModel: input.embeddingModel ?? null,
      descriptionGeneratedAt: input.descriptionGeneratedAt ?? null,
      path: input.path ?? null,
      sourceBlobSha: input.sourceBlobSha ?? null,
      descriptionSourceSha: input.descriptionSourceSha ?? null,
      descriptionSource: input.descriptionSource ?? null,
      code: input.code,
      language: input.language,
      chartSpec: input.chartSpec ?? null,
      resultsViewMode: input.resultsViewMode ?? null,
      mongoOptions: input.mongoOptions ?? null,
      createdBy: createdByUuid,
      ownerId: ownerUuid,
      isPrivate: input.isPrivate ?? access === "private",
      isSaved: input.isSaved ?? false,
      access,
      workspaceRole: input.workspaceRole ?? "viewer",
      sharedWith: sharedWithJson,
      scheduleCron: input.schedule?.cron ?? null,
      scheduleTimezone: input.schedule?.timezone ?? null,
      scheduledRunNextAt: sr?.nextAt ?? null,
      scheduledRunLastAt: sr?.lastAt ?? null,
      scheduledRunLastStatus: sr?.lastStatus ?? null,
      scheduledRunLastError: sr?.lastError ?? null,
      scheduledRunLastDurationMs: sr?.lastDurationMs ?? null,
      scheduledRunLastRowsAffected: sr?.lastRowsAffected ?? null,
      scheduledRunLastRowCount: sr?.lastRowCount ?? null,
      scheduledRunCount: sr?.runCount ?? 0,
      scheduledRunConsecutiveFailures: sr?.consecutiveFailures ?? 0,
      scheduledRunPermanentFailures: sr?.permanentFailures ?? null,
      scheduledRunPausedAt: sr?.pausedAt ?? null,
      scheduledRunPausedReason: sr?.pausedReason ?? null,
      version: input.version ?? 1,
      draftRevision: input.draftRevision ?? 1,
      lastDraftOrigin: input.lastDraftOrigin ?? null,
      lastRun: lastRunJson,
      lastExecutedAt: input.lastExecutedAt ?? null,
      executionCount: input.executionCount ?? 0,
      lastExternalUsedAt: input.lastExternalUsedAt ?? null,
      externalUseCount: input.externalUseCount ?? 0,
      lastExternalSource: input.lastExternalSource ?? null,
      isDeleted: input.is_deleted ?? false,
      deletedAt: input.deletedAt ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
  }

  private async buildConsoleSetValues(
    patch: UpdateConsolePatch,
  ): Promise<Record<string, unknown>> {
    const set: Record<string, unknown> = {};
    if (patch.folderId !== undefined) {
      set.folderId = optionalPgUuid(patch.folderId);
    }
    if (patch.connectionId !== undefined) {
      set.connectionId = optionalPgUuid(patch.connectionId);
    }
    if (patch.databaseName !== undefined) set.databaseName = patch.databaseName;
    if (patch.databaseId !== undefined) set.databaseId = patch.databaseId;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.descriptionEmbedding !== undefined) {
      set.descriptionEmbedding =
        patch.descriptionEmbedding && patch.descriptionEmbedding.length > 0
          ? patch.descriptionEmbedding
          : null;
    }
    if (patch.embeddingModel !== undefined) {
      set.embeddingModel = patch.embeddingModel;
    }
    if (patch.descriptionGeneratedAt !== undefined) {
      set.descriptionGeneratedAt = patch.descriptionGeneratedAt;
    }
    if (patch.path !== undefined) set.path = patch.path;
    if (patch.sourceBlobSha !== undefined) {
      set.sourceBlobSha = patch.sourceBlobSha;
    }
    if (patch.descriptionSourceSha !== undefined) {
      set.descriptionSourceSha = patch.descriptionSourceSha;
    }
    if (patch.descriptionSource !== undefined) {
      set.descriptionSource = patch.descriptionSource;
    }
    if (patch.code !== undefined) set.code = patch.code;
    if (patch.language !== undefined) set.language = patch.language;
    if (patch.chartSpec !== undefined) set.chartSpec = patch.chartSpec;
    if (patch.resultsViewMode !== undefined) {
      set.resultsViewMode = patch.resultsViewMode;
    }
    if (patch.mongoOptions !== undefined) set.mongoOptions = patch.mongoOptions;
    if (patch.owner_id !== undefined) {
      set.ownerId = await resolveOptionalUserUuid(
        patch.owner_id,
        this.resolveUserUuidFn,
      );
    }
    if (patch.isPrivate !== undefined) set.isPrivate = patch.isPrivate;
    if (patch.isSaved !== undefined) set.isSaved = patch.isSaved;
    if (patch.access !== undefined) set.access = patch.access;
    if (patch.workspaceRole !== undefined) {
      set.workspaceRole = patch.workspaceRole;
    }
    if (patch.sharedWith !== undefined) {
      set.sharedWith = await shareEntriesToPgJson(
        patch.sharedWith,
        this.resolveUserUuidFn,
      );
    }
    if (patch.schedule !== undefined) {
      set.scheduleCron = patch.schedule?.cron ?? null;
      set.scheduleTimezone = patch.schedule?.timezone ?? null;
    }
    if (patch.scheduledRun !== undefined) {
      const sr = patch.scheduledRun;
      set.scheduledRunNextAt = sr?.nextAt ?? null;
      set.scheduledRunLastAt = sr?.lastAt ?? null;
      set.scheduledRunLastStatus = sr?.lastStatus ?? null;
      set.scheduledRunLastError = sr?.lastError ?? null;
      set.scheduledRunLastDurationMs = sr?.lastDurationMs ?? null;
      set.scheduledRunLastRowsAffected = sr?.lastRowsAffected ?? null;
      set.scheduledRunLastRowCount = sr?.lastRowCount ?? null;
      set.scheduledRunCount = sr?.runCount ?? 0;
      set.scheduledRunConsecutiveFailures = sr?.consecutiveFailures ?? 0;
      set.scheduledRunPermanentFailures = sr?.permanentFailures ?? null;
      set.scheduledRunPausedAt = sr?.pausedAt ?? null;
      set.scheduledRunPausedReason = sr?.pausedReason ?? null;
    }
    if (patch.clearScheduledRunNextAt) {
      set.scheduledRunNextAt = null;
    }
    if (patch.version !== undefined) set.version = patch.version;
    if (patch.incVersion) {
      set.version = sql`${savedConsoles.version} + ${patch.incVersion}`;
    }
    if (patch.draftRevision !== undefined) {
      set.draftRevision = patch.draftRevision;
    }
    if (patch.incDraftRevision) {
      set.draftRevision = sql`${savedConsoles.draftRevision} + ${patch.incDraftRevision}`;
    }
    if (patch.lastDraftOrigin !== undefined) {
      set.lastDraftOrigin = patch.lastDraftOrigin;
    }
    if (patch.lastRun !== undefined) {
      set.lastRun = await lastRunToPgJson(
        patch.lastRun,
        this.resolveUserUuidFn,
      );
    }
    if (patch.lastExecutedAt !== undefined) {
      set.lastExecutedAt = patch.lastExecutedAt;
    }
    if (patch.executionCount !== undefined) {
      set.executionCount = patch.executionCount;
    }
    if (patch.incExecutionCount) {
      set.executionCount = sql`${savedConsoles.executionCount} + ${patch.incExecutionCount}`;
    }
    if (patch.lastExternalUsedAt !== undefined) {
      set.lastExternalUsedAt = patch.lastExternalUsedAt;
    }
    if (patch.externalUseCount !== undefined) {
      set.externalUseCount = patch.externalUseCount;
    }
    if (patch.incExternalUseCount) {
      set.externalUseCount = sql`${savedConsoles.externalUseCount} + ${patch.incExternalUseCount}`;
    }
    if (patch.lastExternalSource !== undefined) {
      set.lastExternalSource = patch.lastExternalSource;
    }
    if (patch.is_deleted !== undefined) set.isDeleted = patch.is_deleted;
    if (patch.deletedAt !== undefined) set.deletedAt = patch.deletedAt;
    if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
    return set;
  }

  // ── 1. Console folders ────────────────────────────────────────────────

  async listConsoleFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<ConsoleFolderRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    const db = this.getDb();
    const base = db
      .select()
      .from(consoleFolders)
      .where(eq(consoleFolders.workspaceId, wsUuid));
    const rows = opts?.sortByName
      ? await base.orderBy(
          sql`${consoleFolders.name} COLLATE "C" ASC`,
          asc(consoleFolders.id),
        )
      : await base;
    return rows.map(pgConsoleFolderToRecord);
  }

  async findConsoleFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<ConsoleFolderRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(folderId);
    if (!wsUuid || !idUuid) return null;
    const rows = await this.getDb()
      .select()
      .from(consoleFolders)
      .where(
        and(
          eq(consoleFolders.id, idUuid),
          eq(consoleFolders.workspaceId, wsUuid),
        ),
      )
      .limit(1);
    return rows[0] ? pgConsoleFolderToRecord(rows[0]) : null;
  }

  async findConsoleFoldersByIds(
    workspaceId: string,
    folderIds: readonly string[],
  ): Promise<ConsoleFolderRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    const uuids = folderIds
      .map(safePgUuid)
      .filter((u): u is string => u !== null);
    if (uuids.length === 0) return [];
    const rows = await this.getDb()
      .select()
      .from(consoleFolders)
      .where(
        and(
          eq(consoleFolders.workspaceId, wsUuid),
          inArray(consoleFolders.id, uuids),
        ),
      );
    return rows.map(pgConsoleFolderToRecord);
  }

  async findConsoleFolderByNameAndParent(
    workspaceId: string,
    name: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    let parentCond = isNull(consoleFolders.parentId);
    if (parentId !== null) {
      const parentUuid = safePgUuid(parentId);
      if (!parentUuid) return null;
      parentCond = eq(consoleFolders.parentId, parentUuid);
    }
    const rows = await this.getDb()
      .select()
      .from(consoleFolders)
      .where(
        and(
          eq(consoleFolders.workspaceId, wsUuid),
          eq(consoleFolders.name, name),
          parentCond,
        ),
      )
      .limit(1);
    return rows[0] ? pgConsoleFolderToRecord(rows[0]) : null;
  }

  async listChildConsoleFolders(
    workspaceId: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    let parentCond = isNull(consoleFolders.parentId);
    if (parentId !== null) {
      const parentUuid = safePgUuid(parentId);
      if (!parentUuid) return [];
      parentCond = eq(consoleFolders.parentId, parentUuid);
    }
    const rows = await this.getDb()
      .select()
      .from(consoleFolders)
      .where(and(eq(consoleFolders.workspaceId, wsUuid), parentCond));
    return rows.map(pgConsoleFolderToRecord);
  }

  async createConsoleFolder(
    input: CreateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const access = input.access ?? "private";
    const ownerUuid = await resolveOptionalUserUuid(
      input.ownerId,
      this.resolveUserUuidFn,
    );
    const [row] = await this.getDb()
      .insert(consoleFolders)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        name: input.name,
        parentId: optionalPgUuid(input.parentId),
        isPrivate: input.isPrivate ?? access === "private",
        ownerId: ownerUuid,
        access,
        createdAt: input.createdAt ?? new Date(),
      })
      .returning();
    return pgConsoleFolderToRecord(row);
  }

  async upsertConsoleFolder(
    record: ConsoleFolderRecord,
    options: { db?: MakoPgDb; ignoreUpdatedAtGuard?: boolean } = {},
  ): Promise<void> {
    const db = options.db ?? this.getDb();
    const ownerUuid = await resolveOptionalUserUuid(
      record.ownerId,
      this.resolveUserUuidFn,
    );
    const insert = db.insert(consoleFolders).values({
      id: toPgUuid(record.id),
      workspaceId: toPgUuid(record.workspaceId),
      name: record.name,
      parentId: optionalPgUuid(record.parentId),
      isPrivate: record.isPrivate,
      ownerId: ownerUuid,
      access: record.access,
      createdAt: record.createdAt,
    });
    if (options.ignoreUpdatedAtGuard) {
      await insert.onConflictDoUpdate({
        target: consoleFolders.id,
        set: {
          name: record.name,
          parentId: optionalPgUuid(record.parentId),
          isPrivate: record.isPrivate,
          ownerId: ownerUuid,
          access: record.access,
        },
      });
    } else {
      // `console_folders` has no `updated_at` column; during Stage 2 backfill
      // an existing row in PG came from live dual-write and must not be clobbered.
      await insert.onConflictDoNothing({ target: consoleFolders.id });
    }
  }

  async updateConsoleFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(folderId);
    if (!wsUuid || !idUuid) return null;
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.parentId !== undefined) {
      set.parentId = optionalPgUuid(patch.parentId);
    }
    if (patch.isPrivate !== undefined) set.isPrivate = patch.isPrivate;
    if (patch.access !== undefined) set.access = patch.access;
    if (patch.ownerId !== undefined) {
      set.ownerId = await resolveOptionalUserUuid(
        patch.ownerId,
        this.resolveUserUuidFn,
      );
    }
    if (Object.keys(set).length === 0) {
      return this.findConsoleFolderById(workspaceId, folderId);
    }
    const rows = await this.getDb()
      .update(consoleFolders)
      .set(set)
      .where(
        and(
          eq(consoleFolders.id, idUuid),
          eq(consoleFolders.workspaceId, wsUuid),
        ),
      )
      .returning();
    return rows[0] ? pgConsoleFolderToRecord(rows[0]) : null;
  }

  async deleteConsoleFolderReturningIds(
    workspaceId: string,
    folderId: string,
  ): Promise<string[]> {
    const wsUuid = safePgUuid(workspaceId);
    const rootUuid = safePgUuid(folderId);
    if (!wsUuid || !rootUuid) return [];

    return this.getDb().transaction(async tx => {
      const raw = await tx.execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM console_folders
          WHERE id = ${rootUuid}::uuid AND workspace_id = ${wsUuid}::uuid
          UNION
          SELECT cf.id FROM console_folders cf
          JOIN subtree s ON cf.parent_id = s.id
          WHERE cf.workspace_id = ${wsUuid}::uuid
        )
        SELECT id FROM subtree
      `);
      const ids = extractRows<{ id: string }>(raw).map(r => r.id.toLowerCase());
      if (ids.length === 0) return [];
      await tx
        .delete(consoleFolders)
        .where(
          and(
            eq(consoleFolders.workspaceId, wsUuid),
            inArray(consoleFolders.id, ids),
          ),
        );
      return ids;
    });
  }

  async deleteConsoleFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<boolean> {
    return (
      (await this.deleteConsoleFolderReturningIds(workspaceId, folderId))
        .length > 0
    );
  }

  async wouldCreateConsoleFolderCycle(
    workspaceId: string,
    folderId: string,
    targetParentId: string | null,
  ): Promise<boolean> {
    if (!targetParentId) return false;
    const normFolderId = wireId(folderId);
    const normTarget = wireId(targetParentId);
    if (normFolderId === normTarget) return true;
    const folders = await this.listConsoleFolders(workspaceId);
    const parentMap = new Map<string, string | undefined>();
    for (const f of folders) parentMap.set(f.id, f.parentId);
    let current: string | undefined = normTarget;
    const visited = new Set<string>();
    while (current) {
      if (current === normFolderId) return true;
      if (visited.has(current)) return true;
      visited.add(current);
      current = parentMap.get(current);
    }
    return false;
  }

  // ── 2. Saved consoles ─────────────────────────────────────────────────

  async findConsoleById(
    workspaceId: string,
    consoleId: string,
    opts?: { includeEmbedding?: boolean; excludeDeleted?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return null;
    const conds = [
      eq(savedConsoles.id, idUuid),
      eq(savedConsoles.workspaceId, wsUuid),
    ];
    if (opts?.excludeDeleted) conds.push(eq(savedConsoles.isDeleted, false));
    const cols = opts?.includeEmbedding
      ? SAVED_CONSOLE_WITH_EMBEDDING_COLUMNS
      : SAVED_CONSOLE_BASE_COLUMNS;
    const rows = await this.getDb()
      .select(cols)
      .from(savedConsoles)
      .where(and(...conds))
      .limit(1);
    return rows[0]
      ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
      : null;
  }

  async findConsoleByIdGlobal(
    consoleId: string,
    opts?: { includeEmbedding?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    const idUuid = safePgUuid(consoleId);
    if (!idUuid) return null;
    const cols = opts?.includeEmbedding
      ? SAVED_CONSOLE_WITH_EMBEDDING_COLUMNS
      : SAVED_CONSOLE_BASE_COLUMNS;
    const rows = await this.getDb()
      .select(cols)
      .from(savedConsoles)
      .where(eq(savedConsoles.id, idUuid))
      .limit(1);
    return rows[0]
      ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
      : null;
  }

  async findConsolesByIds(
    workspaceId: string,
    consoleIds: readonly string[],
  ): Promise<SavedConsoleRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    const uuids = consoleIds
      .map(safePgUuid)
      .filter((u): u is string => u !== null);
    if (uuids.length === 0) return [];
    const rows = await this.getDb()
      .select(SAVED_CONSOLE_BASE_COLUMNS)
      .from(savedConsoles)
      .where(
        and(
          eq(savedConsoles.workspaceId, wsUuid),
          inArray(savedConsoles.id, uuids),
        ),
      );
    return rows.map(r =>
      pgSavedConsoleToRecord(r as Omit<SavedConsoleRow, "searchTsv">),
    );
  }

  async findConsoleByPath(
    workspaceId: string,
    path: string,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    const conds = [
      eq(savedConsoles.workspaceId, wsUuid),
      eq(savedConsoles.path, path),
    ];
    if (opts?.isSavedOnly) conds.push(eq(savedConsoles.isSaved, true));
    const rows = await this.getDb()
      .select(SAVED_CONSOLE_BASE_COLUMNS)
      .from(savedConsoles)
      .where(and(...conds))
      .orderBy(desc(savedConsoles.updatedAt))
      .limit(1);
    return rows[0]
      ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
      : null;
  }

  async findConsoleByNameAndFolder(
    workspaceId: string,
    name: string,
    folderId: string | null,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    let folderCond = isNull(savedConsoles.folderId);
    if (folderId !== null) {
      const folderUuid = safePgUuid(folderId);
      if (!folderUuid) return null;
      folderCond = eq(savedConsoles.folderId, folderUuid);
    }
    const conds = [
      eq(savedConsoles.workspaceId, wsUuid),
      eq(savedConsoles.name, name),
      folderCond,
    ];
    if (opts?.isSavedOnly) conds.push(eq(savedConsoles.isSaved, true));
    const rows = await this.getDb()
      .select(SAVED_CONSOLE_BASE_COLUMNS)
      .from(savedConsoles)
      .where(and(...conds))
      .orderBy(desc(savedConsoles.updatedAt))
      .limit(1);
    return rows[0]
      ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
      : null;
  }

  async listConsolesByWorkspace(
    workspaceId: string,
    filter?: ListConsolesFilter,
  ): Promise<SavedConsoleRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    const conds = [eq(savedConsoles.workspaceId, wsUuid)];
    if (filter?.draftsOnly) {
      conds.push(eq(savedConsoles.isSaved, false));
    } else if (filter?.isSaved !== undefined) {
      conds.push(eq(savedConsoles.isSaved, filter.isSaved));
    }
    if (filter?.excludeDeleted) {
      conds.push(eq(savedConsoles.isDeleted, false));
    }
    if (filter?.hasPath) {
      conds.push(isNotNull(savedConsoles.path));
    }
    if (filter?.hasSchedule) {
      conds.push(isNotNull(savedConsoles.scheduleCron));
      conds.push(ne(savedConsoles.scheduleCron, ""));
    }
    if (filter?.folderId !== undefined) {
      if (filter.folderId === null) {
        conds.push(isNull(savedConsoles.folderId));
      } else {
        const fUuid = safePgUuid(filter.folderId);
        if (!fUuid) return [];
        conds.push(eq(savedConsoles.folderId, fUuid));
      }
    }

    const cols = filter?.includeEmbedding
      ? SAVED_CONSOLE_WITH_EMBEDDING_COLUMNS
      : SAVED_CONSOLE_BASE_COLUMNS;
    const base = this.getDb()
      .select(cols)
      .from(savedConsoles)
      .where(and(...conds));
    const rows =
      filter?.sortBy === "updatedAtDesc"
        ? await base.orderBy(desc(savedConsoles.updatedAt))
        : filter?.sortBy === "createdAtAsc"
          ? await base.orderBy(asc(savedConsoles.createdAt))
          : filter?.sortBy === "nameAsc"
            ? await base.orderBy(asc(savedConsoles.name))
            : await base;
    return rows.map(r =>
      pgSavedConsoleToRecord(r as Omit<SavedConsoleRow, "searchTsv">),
    );
  }

  async listConsolesNeedingDescription(opts?: {
    workspaceId?: string;
    currentEmbeddingModel?: string | null;
  }): Promise<Array<{ id: string; workspaceId: string }>> {
    const conds = [
      eq(savedConsoles.isSaved, true),
      eq(savedConsoles.isDeleted, false),
      opts?.currentEmbeddingModel
        ? or(
            sql`${savedConsoles.descriptionSourceSha} IS DISTINCT FROM ${savedConsoles.sourceBlobSha}`,
            and(
              isNotNull(savedConsoles.embeddingModel),
              ne(savedConsoles.embeddingModel, opts.currentEmbeddingModel),
            ),
          )
        : sql`${savedConsoles.descriptionSourceSha} IS DISTINCT FROM ${savedConsoles.sourceBlobSha}`,
    ];
    if (opts?.workspaceId !== undefined) {
      const wsUuid = safePgUuid(opts.workspaceId);
      if (!wsUuid) return [];
      conds.push(eq(savedConsoles.workspaceId, wsUuid));
    }
    const rows = await this.getDb()
      .select({
        id: savedConsoles.id,
        workspaceId: savedConsoles.workspaceId,
      })
      .from(savedConsoles)
      .where(and(...conds));
    return rows.map(r => ({
      id: toWireId(r.id),
      workspaceId: toWireId(r.workspaceId),
    }));
  }

  async createConsole(input: CreateConsoleInput): Promise<SavedConsoleRecord> {
    const values = await this.buildInsertConsoleRow(input);
    const db = this.getDb();
    try {
      const [row] = await db
        .insert(savedConsoles)
        .values(values)
        .returning(SAVED_CONSOLE_WITH_EMBEDDING_COLUMNS);
      return pgSavedConsoleToRecord(row as Omit<SavedConsoleRow, "searchTsv">);
    } catch (error) {
      if (values.connectionId && isConsolesConnectionFkViolation(error)) {
        const [row] = await db
          .insert(savedConsoles)
          .values({ ...values, connectionId: null })
          .returning(SAVED_CONSOLE_WITH_EMBEDDING_COLUMNS);
        return pgSavedConsoleToRecord(
          row as Omit<SavedConsoleRow, "searchTsv">,
        );
      }
      throw error;
    }
  }

  async upsertConsole(
    record: SavedConsoleRecord,
    options: {
      db?: MakoPgDb;
      ignoreUpdatedAtGuard?: boolean;
      connectionValidated?: boolean;
    } = {},
  ): Promise<void> {
    const db = options.db ?? this.getDb();
    const values = await this.buildInsertConsoleRow({
      ...record,
      id: record.id,
    });
    if (values.connectionId && !options.connectionValidated) {
      values.connectionId = await resolveConnectionIdForFk(
        db,
        values.connectionId,
      );
    }
    const runUpsert = async (rowValues: NewSavedConsoleRow): Promise<void> => {
      const {
        id: _id,
        workspaceId: _ws,
        createdAt: _createdAt,
        ...updateSet
      } = rowValues;
      await db
        .insert(savedConsoles)
        .values(rowValues)
        .onConflictDoUpdate({
          target: savedConsoles.id,
          set: updateSet,
          ...(options.ignoreUpdatedAtGuard
            ? {}
            : {
                setWhere: sql`${savedConsoles.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${savedConsoles.updatedAt}`,
              }),
        });
    };
    try {
      await runUpsert(values);
    } catch (error) {
      if (values.connectionId && isConsolesConnectionFkViolation(error)) {
        await runUpsert({ ...values, connectionId: null });
        return;
      }
      throw error;
    }
  }

  async updateConsole(
    workspaceId: string,
    consoleId: string,
    patch: UpdateConsolePatch,
  ): Promise<SavedConsoleRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return null;
    const set = await this.buildConsoleSetValues(patch);
    if (Object.keys(set).length === 0) {
      return this.findConsoleById(workspaceId, consoleId);
    }
    const db = this.getDb();
    const runUpdate = (setValues: Record<string, unknown>) =>
      db
        .update(savedConsoles)
        .set(setValues)
        .where(
          and(
            eq(savedConsoles.id, idUuid),
            eq(savedConsoles.workspaceId, wsUuid),
          ),
        )
        .returning(SAVED_CONSOLE_BASE_COLUMNS);
    try {
      const rows = await runUpdate(set);
      return rows[0]
        ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
        : null;
    } catch (error) {
      if (set.connectionId && isConsolesConnectionFkViolation(error)) {
        const rows = await runUpdate({ ...set, connectionId: null });
        return rows[0]
          ? pgSavedConsoleToRecord(
              rows[0] as Omit<SavedConsoleRow, "searchTsv">,
            )
          : null;
      }
      throw error;
    }
  }

  async updateConsolesInFolder(
    workspaceId: string,
    folderId: string,
    patch: Pick<UpdateConsolePatch, "access" | "isPrivate">,
    updatedAt: Date = new Date(),
  ): Promise<number> {
    const wsUuid = safePgUuid(workspaceId);
    const fUuid = safePgUuid(folderId);
    if (!wsUuid || !fUuid) return 0;
    const set: Record<string, unknown> = {};
    if (patch.access !== undefined) set.access = patch.access;
    if (patch.isPrivate !== undefined) set.isPrivate = patch.isPrivate;
    if (Object.keys(set).length === 0) return 0;
    set.updatedAt = updatedAt;
    const rows = await this.getDb()
      .update(savedConsoles)
      .set(set)
      .where(
        and(
          eq(savedConsoles.workspaceId, wsUuid),
          eq(savedConsoles.folderId, fUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length;
  }

  async guardedSaveConsole(
    input: GuardedSaveConsoleInput,
  ): Promise<SavedConsoleRecord | null> {
    const wsUuid = safePgUuid(input.workspaceId);
    const idUuid = safePgUuid(input.consoleId);
    if (!wsUuid || !idUuid) return null;

    const patchWithInc: UpdateConsolePatch = {
      ...input.set,
      ...(input.incVersion ? { incVersion: input.incVersion } : {}),
      ...(input.incDraftRevision
        ? { incDraftRevision: input.incDraftRevision }
        : {}),
    };
    const setValues = await this.buildConsoleSetValues(patchWithInc);

    const guardActive =
      input.expectedVersion !== undefined ||
      input.expectedDraftRevision !== undefined;

    if (!guardActive && input.upsert) {
      const definedSet = Object.fromEntries(
        Object.entries(input.set).filter(([, v]) => v !== undefined),
      ) as Partial<CreateConsoleInput>;
      const mergedCreate: CreateConsoleInput = {
        ...input.setOnInsert,
        ...definedSet,
        workspaceId: input.workspaceId,
        id: input.consoleId,
        name: input.set.name ?? input.setOnInsert?.name ?? "Untitled",
        code: input.set.code ?? input.setOnInsert?.code ?? "",
        language: input.set.language ?? input.setOnInsert?.language ?? "sql",
        version:
          (input.set.version ??
            (input.setOnInsert?.version ?? 0) + (input.incVersion ?? 0)) ||
          1,
        draftRevision:
          (input.set.draftRevision ??
            (input.setOnInsert?.draftRevision ?? 0) +
              (input.incDraftRevision ?? 0)) ||
          1,
      };
      const insertValues = await this.buildInsertConsoleRow(mergedCreate);
      const db = this.getDb();
      const runUpsert = (
        rowValues: NewSavedConsoleRow,
        updateSet: Record<string, unknown>,
      ) =>
        db
          .insert(savedConsoles)
          .values(rowValues)
          .onConflictDoUpdate({
            target: savedConsoles.id,
            set: updateSet,
            setWhere: eq(savedConsoles.workspaceId, wsUuid),
          })
          .returning(SAVED_CONSOLE_BASE_COLUMNS);
      try {
        const [row] = await runUpsert(insertValues, setValues);
        return row
          ? pgSavedConsoleToRecord(row as Omit<SavedConsoleRow, "searchTsv">)
          : null;
      } catch (error) {
        if (
          (insertValues.connectionId || setValues.connectionId) &&
          isConsolesConnectionFkViolation(error)
        ) {
          const [row] = await runUpsert(
            { ...insertValues, connectionId: null },
            setValues.connectionId !== undefined
              ? { ...setValues, connectionId: null }
              : setValues,
          );
          return row
            ? pgSavedConsoleToRecord(row as Omit<SavedConsoleRow, "searchTsv">)
            : null;
        }
        throw error;
      }
    }

    const conds = [
      eq(savedConsoles.id, idUuid),
      eq(savedConsoles.workspaceId, wsUuid),
    ];
    if (input.expectedVersion !== undefined) {
      conds.push(eq(savedConsoles.version, input.expectedVersion));
    }
    if (input.expectedDraftRevision !== undefined) {
      conds.push(eq(savedConsoles.draftRevision, input.expectedDraftRevision));
    }

    const db = this.getDb();
    const runGuardedUpdate = (updateSet: Record<string, unknown>) =>
      db
        .update(savedConsoles)
        .set(updateSet)
        .where(and(...conds))
        .returning(SAVED_CONSOLE_BASE_COLUMNS);
    try {
      const rows = await runGuardedUpdate(setValues);
      return rows[0]
        ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
        : null;
    } catch (error) {
      if (setValues.connectionId && isConsolesConnectionFkViolation(error)) {
        const rows = await runGuardedUpdate({
          ...setValues,
          connectionId: null,
        });
        return rows[0]
          ? pgSavedConsoleToRecord(
              rows[0] as Omit<SavedConsoleRow, "searchTsv">,
            )
          : null;
      }
      throw error;
    }
  }

  async bumpConsoleDraftRevision(
    workspaceId: string,
    consoleId: string,
    updatedAt: Date = new Date(),
  ): Promise<SavedConsoleRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return null;
    const rows = await this.getDb()
      .update(savedConsoles)
      .set({
        draftRevision: sql`${savedConsoles.draftRevision} + 1`,
        updatedAt,
      })
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
        ),
      )
      .returning(SAVED_CONSOLE_BASE_COLUMNS);
    return rows[0]
      ? pgSavedConsoleToRecord(rows[0] as Omit<SavedConsoleRow, "searchTsv">)
      : null;
  }

  async recordConsoleExecution(
    workspaceId: string,
    consoleId: string,
    input: {
      lastExecutedAt: Date;
      lastRun?: ConsoleLastRunRecord;
      bumpDraftRevision?: boolean;
      updatedAt?: Date;
    },
  ): Promise<boolean> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return false;
    const set: Record<string, unknown> = {
      lastExecutedAt: input.lastExecutedAt,
      executionCount: sql`${savedConsoles.executionCount} + 1`,
      updatedAt: input.updatedAt ?? input.lastExecutedAt,
    };
    if (input.lastRun !== undefined) {
      set.lastRun = await lastRunToPgJson(
        input.lastRun,
        this.resolveUserUuidFn,
      );
    }
    if (input.bumpDraftRevision) {
      set.draftRevision = sql`${savedConsoles.draftRevision} + 1`;
    }
    const rows = await this.getDb()
      .update(savedConsoles)
      .set(set)
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async recordConsoleExternalUse(
    workspaceId: string,
    consoleId: string,
    source: ExternalSource,
    mode: "execute" | "access",
    now: Date = new Date(),
  ): Promise<boolean> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return false;
    if (mode === "access") {
      const cutoff = new Date(now.getTime() - 60_000);
      const rows = await this.getDb()
        .update(savedConsoles)
        .set({
          lastExternalUsedAt: now,
          lastExternalSource: source,
          updatedAt: now,
        })
        .where(
          and(
            eq(savedConsoles.id, idUuid),
            eq(savedConsoles.workspaceId, wsUuid),
            or(
              isNull(savedConsoles.lastExternalUsedAt),
              lte(savedConsoles.lastExternalUsedAt, cutoff),
            ),
          ),
        )
        .returning({ id: savedConsoles.id });
      return rows.length > 0;
    }
    const rows = await this.getDb()
      .update(savedConsoles)
      .set({
        lastExternalUsedAt: now,
        lastExternalSource: source,
        externalUseCount: sql`${savedConsoles.externalUseCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async guardedUpdateConsoleDescription(
    workspaceId: string,
    consoleId: string,
    expectedSourceBlobSha: string | null | undefined,
    patch: Pick<
      UpdateConsolePatch,
      | "description"
      | "descriptionSource"
      | "descriptionGeneratedAt"
      | "descriptionSourceSha"
      | "descriptionEmbedding"
      | "embeddingModel"
    >,
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return false;
    const set = await this.buildConsoleSetValues(patch);
    set.updatedAt = updatedAt;
    const shaCond = expectedSourceBlobSha
      ? eq(savedConsoles.sourceBlobSha, expectedSourceBlobSha)
      : isNull(savedConsoles.sourceBlobSha);
    const rows = await this.getDb()
      .update(savedConsoles)
      .set(set)
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
          shaCond,
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async softDeleteConsole(
    workspaceId: string,
    consoleId: string,
    deletedAt: Date = new Date(),
    opts?: { onlyIfNotDeleted?: boolean },
  ): Promise<boolean> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return false;
    const conds = [
      eq(savedConsoles.id, idUuid),
      eq(savedConsoles.workspaceId, wsUuid),
    ];
    if (opts?.onlyIfNotDeleted) conds.push(eq(savedConsoles.isDeleted, false));
    const rows = await this.getDb()
      .update(savedConsoles)
      .set({ isDeleted: true, deletedAt, updatedAt: deletedAt })
      .where(and(...conds))
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async restoreConsole(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return false;
    const set: Record<string, unknown> = {
      isDeleted: false,
      deletedAt: null,
      updatedAt,
    };
    if (patch?.path !== undefined) set.path = patch.path;
    if (patch?.sourceBlobSha !== undefined) {
      set.sourceBlobSha = patch.sourceBlobSha;
    }
    const rows = await this.getDb()
      .update(savedConsoles)
      .set(set)
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async deleteConsolesInFolderReturningIds(
    workspaceId: string,
    folderId: string,
  ): Promise<string[]> {
    const wsUuid = safePgUuid(workspaceId);
    const fUuid = safePgUuid(folderId);
    if (!wsUuid || !fUuid) return [];
    const rows = await this.getDb()
      .delete(savedConsoles)
      .where(
        and(
          eq(savedConsoles.workspaceId, wsUuid),
          eq(savedConsoles.folderId, fUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.map(r => r.id.toLowerCase());
  }

  async deleteConsolesInFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<number> {
    return (
      await this.deleteConsolesInFolderReturningIds(workspaceId, folderId)
    ).length;
  }

  async updateConsoleScheduleOutcome(
    input: RecordScheduleOutcomeInput,
  ): Promise<boolean> {
    const wsUuid = safePgUuid(input.workspaceId);
    const idUuid = safePgUuid(input.consoleId);
    if (!wsUuid || !idUuid) return false;
    const set: Record<string, unknown> = {
      scheduledRunLastAt: input.lastAt,
      scheduledRunLastStatus: input.isError ? "error" : "success",
      scheduledRunPermanentFailures: input.permanentFailures,
      scheduledRunCount: sql`${savedConsoles.scheduledRunCount} + 1`,
      updatedAt: input.updatedAt ?? input.lastAt,
    };
    if (input.lastDurationMs !== undefined) {
      set.scheduledRunLastDurationMs = input.lastDurationMs;
    }
    if (input.lastRowCount !== undefined) {
      set.scheduledRunLastRowCount = input.lastRowCount;
    }
    if (input.lastRowsAffected !== undefined) {
      set.scheduledRunLastRowsAffected = input.lastRowsAffected;
    }
    if (input.clearNextAt) {
      set.scheduledRunNextAt = null;
    } else if (input.nextAt !== undefined) {
      set.scheduledRunNextAt = input.nextAt;
    }
    if (!input.isError) {
      set.scheduledRunConsecutiveFailures = 0;
      set.scheduledRunLastError = null;
    } else {
      set.scheduledRunConsecutiveFailures = sql`${savedConsoles.scheduledRunConsecutiveFailures} + 1`;
      if (input.lastError !== undefined) {
        set.scheduledRunLastError = input.lastError;
      }
    }
    if (input.pausedAt !== undefined && input.pausedAt !== null) {
      set.scheduledRunPausedAt = input.pausedAt;
    }
    if (input.pausedReason !== undefined && input.pausedReason !== null) {
      set.scheduledRunPausedReason = input.pausedReason;
    }

    const rows = await this.getDb()
      .update(savedConsoles)
      .set(set)
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async clearConsoleSchedule(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(consoleId);
    if (!wsUuid || !idUuid) return false;
    const set: Record<string, unknown> = {
      scheduleCron: null,
      scheduleTimezone: null,
      scheduledRunNextAt: null,
      updatedAt,
    };
    if (patch?.path !== undefined) set.path = patch.path;
    if (patch?.sourceBlobSha !== undefined) {
      set.sourceBlobSha = patch.sourceBlobSha;
    }
    const rows = await this.getDb()
      .update(savedConsoles)
      .set(set)
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
        ),
      )
      .returning({ id: savedConsoles.id });
    return rows.length > 0;
  }

  async findDueScheduledConsoles(now: Date): Promise<DueScheduledConsole[]> {
    const rows = await this.getDb()
      .select({
        id: savedConsoles.id,
        workspaceId: savedConsoles.workspaceId,
        scheduleCron: savedConsoles.scheduleCron,
        scheduleTimezone: savedConsoles.scheduleTimezone,
        scheduledRunNextAt: savedConsoles.scheduledRunNextAt,
      })
      .from(savedConsoles)
      .where(
        and(
          eq(savedConsoles.isSaved, true),
          eq(savedConsoles.isDeleted, false),
          isNotNull(savedConsoles.scheduleCron),
          ne(savedConsoles.scheduleCron, ""),
          isNotNull(savedConsoles.scheduledRunNextAt),
          lte(savedConsoles.scheduledRunNextAt, now),
        ),
      );
    return rows.map(r => ({
      id: toWireId(r.id),
      workspaceId: toWireId(r.workspaceId),
      nextAt: r.scheduledRunNextAt,
      schedule: r.scheduleCron
        ? { cron: r.scheduleCron, timezone: r.scheduleTimezone }
        : null,
    }));
  }

  async claimScheduledConsole(
    doc: DueScheduledConsole,
    nextAt: Date,
    updatedAt: Date = new Date(),
  ): Promise<{ modifiedCount: number }> {
    const idUuid = safePgUuid(doc.id);
    const wsUuid = safePgUuid(doc.workspaceId);
    if (!idUuid || !wsUuid || !doc.nextAt) return { modifiedCount: 0 };
    const expectedNextAt =
      doc.nextAt instanceof Date ? doc.nextAt : new Date(doc.nextAt);
    const rows = await this.getDb()
      .update(savedConsoles)
      .set({ scheduledRunNextAt: nextAt, updatedAt })
      .where(
        and(
          eq(savedConsoles.id, idUuid),
          eq(savedConsoles.workspaceId, wsUuid),
          eq(savedConsoles.scheduledRunNextAt, expectedNextAt),
        ),
      )
      .returning({ id: savedConsoles.id });
    return { modifiedCount: rows.length };
  }

  async isPgVectorAvailable(): Promise<boolean> {
    try {
      const raw = await this.getDb().execute(
        sql`SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector' LIMIT 1`,
      );
      return extractRows(raw).length > 0;
    } catch {
      return false;
    }
  }

  async searchConsolesVector(
    workspaceId: string,
    queryEmbedding: number[],
    opts: { limit: number; embeddingModel?: string | null },
  ): Promise<ConsoleSearchCandidate[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid || queryEmbedding.length !== 1536) return [];
    const vecLiteral = formatPgVectorLiteral(queryEmbedding);
    const modelFilter = opts.embeddingModel
      ? sql`AND (embedding_model IS NULL OR embedding_model = ${opts.embeddingModel})`
      : sql``;
    // Scope to the workspace in a MATERIALIZED CTE first (using `idx_saved_consoles_ws_saved`)
    // before ordering by exact cosine distance so small workspaces are never starved by
    // global multi-tenant HNSW `ef_search` candidate limits (matches Mongo `$vectorSearch` pre-filter).
    const raw = await this.getDb().execute(sql`
      WITH ws_consoles AS MATERIALIZED (
        SELECT
          id,
          name,
          description,
          connection_id,
          database_name,
          language,
          is_saved,
          embedding_model,
          updated_at,
          description_embedding
        FROM saved_consoles
        WHERE workspace_id = ${wsUuid}::uuid
          AND is_saved = true
          AND is_deleted = false
          AND description_embedding IS NOT NULL
          ${modelFilter}
      )
      SELECT
        id,
        name,
        description,
        connection_id,
        database_name,
        language,
        is_saved,
        embedding_model,
        updated_at,
        (1.0 - (description_embedding <=> ${vecLiteral}::vector))::double precision AS score
      FROM ws_consoles
      ORDER BY description_embedding <=> ${vecLiteral}::vector ASC
      LIMIT ${opts.limit * 2}
    `);
    const rows = extractRows<{
      id: string;
      name: string;
      description: string | null;
      connection_id: string | null;
      database_name: string | null;
      language: ConsoleSearchCandidate["language"];
      is_saved: boolean;
      embedding_model: string | null;
      updated_at: Date | string | null;
      score: number | string;
    }>(raw);

    return rows.map(r => ({
      id: toWireId(r.id),
      title: r.name,
      description: r.description ?? "",
      connectionId: r.connection_id ? toWireId(r.connection_id) : undefined,
      databaseName: r.database_name ?? undefined,
      language: r.language,
      isSaved: r.is_saved,
      embeddingModel: r.embedding_model ?? undefined,
      updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
      score: Number(r.score ?? 0),
    }));
  }

  async searchConsolesText(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid || !query.trim()) return [];
    // Align with Mongo `$text` OR-semantics across positive terms while preserving
    // phrases (`<->`/`<N>`), negations (`-term`), and safe websearch parsing, and use
    // cover-density ranking (`ts_rank_cd` with weights `{0.1, 0.2, 0.6, 1.0}`) so scores
    // land in the same ~0.6–3.0 range Mongo `$meta: "textScore"` feeds into `computeCompositeScore`.
    const raw = await this.getDb().execute(sql`
      WITH parsed AS (
        SELECT websearch_to_tsquery('english', ${query})::text AS raw
      ),
      parts AS (
        SELECT unnest(string_to_array(raw, ' & ')) AS part
        FROM parsed
        WHERE raw <> ''
      ),
      grouped AS (
        SELECT
          string_agg('(' || part || ')', ' | ') FILTER (
            WHERE NOT (left(part, 1) = '!' AND position(' | ' in part) = 0)
          ) AS pos,
          string_agg('(' || part || ')', ' & ') FILTER (
            WHERE left(part, 1) = '!' AND position(' | ' in part) = 0
          ) AS neg
        FROM parts
      ),
      q AS (
        SELECT CASE
          WHEN pos IS NOT NULL AND neg IS NOT NULL THEN ('(' || pos || ') & ' || neg)::tsquery
          WHEN pos IS NOT NULL THEN pos::tsquery
          ELSE ''::tsquery
        END AS tsq
        FROM grouped
      )
      SELECT
        sc.id,
        sc.name,
        sc.description,
        sc.connection_id,
        sc.database_name,
        sc.language,
        sc.is_saved,
        sc.updated_at,
        ts_rank_cd('{0.1, 0.2, 0.6, 1.0}', sc.search_tsv, q.tsq)::double precision AS score
      FROM saved_consoles sc
      CROSS JOIN q
      WHERE sc.workspace_id = ${wsUuid}::uuid
        AND sc.is_saved = true
        AND sc.is_deleted = false
        AND q.tsq <> ''::tsquery
        AND sc.search_tsv @@ q.tsq
      ORDER BY score DESC, sc.updated_at DESC
      LIMIT ${opts.limit * 2}
    `);
    const rows = extractRows<{
      id: string;
      name: string;
      description: string | null;
      connection_id: string | null;
      database_name: string | null;
      language: ConsoleSearchCandidate["language"];
      is_saved: boolean;
      updated_at: Date | string | null;
      score: number | string;
    }>(raw);

    return rows.map(r => ({
      id: toWireId(r.id),
      title: r.name,
      description: r.description ?? "",
      connectionId: r.connection_id ? toWireId(r.connection_id) : undefined,
      databaseName: r.database_name ?? undefined,
      language: r.language,
      isSaved: r.is_saved,
      updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
      score: Number(r.score ?? 0),
    }));
  }

  async searchConsolesName(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid || !query.trim()) return [];
    const pattern = `%${escapeLike(query)}%`;
    const raw = await this.getDb().execute(sql`
      SELECT
        id,
        name,
        description,
        connection_id,
        database_name,
        language,
        is_saved,
        updated_at
      FROM saved_consoles
      WHERE workspace_id = ${wsUuid}::uuid
        AND is_saved = true
        AND is_deleted = false
        AND name ILIKE ${pattern} ESCAPE '\\'
      ORDER BY updated_at DESC
      LIMIT ${opts.limit * 2}
    `);
    const rows = extractRows<{
      id: string;
      name: string;
      description: string | null;
      connection_id: string | null;
      database_name: string | null;
      language: ConsoleSearchCandidate["language"];
      is_saved: boolean;
      updated_at: Date | string | null;
    }>(raw);

    return rows.map(r => ({
      id: toWireId(r.id),
      title: r.name,
      description: r.description ?? "",
      connectionId: r.connection_id ? toWireId(r.connection_id) : undefined,
      databaseName: r.database_name ?? undefined,
      language: r.language,
      isSaved: r.is_saved,
      updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
      score: 0.5,
    }));
  }

  // ── 3. Entity versions ────────────────────────────────────────────────

  async findEntityVersionWorkspaceId(
    entityId: string,
    entityType: "console",
  ): Promise<string | null> {
    const entityUuid = safePgUuid(entityId);
    if (!entityUuid) return null;
    const rows = await this.getDb()
      .select({ workspaceId: entityVersions.workspaceId })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.entityId, entityUuid),
          eq(entityVersions.entityType, entityType),
        ),
      )
      .limit(1);
    return rows[0] ? toWireId(rows[0].workspaceId) : null;
  }

  async getLatestEntityVersionNumber(
    entityId: string,
    entityType: "console",
    workspaceId?: string,
  ): Promise<number> {
    const entityUuid = safePgUuid(entityId);
    if (!entityUuid) return 0;
    const conds = [
      eq(entityVersions.entityId, entityUuid),
      eq(entityVersions.entityType, entityType),
    ];
    if (workspaceId !== undefined) {
      const wsUuid = safePgUuid(workspaceId);
      if (!wsUuid) return 0;
      conds.push(eq(entityVersions.workspaceId, wsUuid));
    }
    const rows = await this.getDb()
      .select({ version: entityVersions.version })
      .from(entityVersions)
      .where(and(...conds))
      .orderBy(desc(entityVersions.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  async createEntityVersion(
    input: CreateEntityVersionInput,
  ): Promise<EntityVersionRecord> {
    const savedByUuid = await resolveOptionalUserUuid(
      input.savedBy,
      this.resolveUserUuidFn,
    );
    const idUuid = input.id ? toPgUuid(input.id) : newDualId().uuid;

    if (input.version !== undefined) {
      const inserted = await this.getDb()
        .insert(entityVersions)
        .values({
          id: idUuid,
          workspaceId: toPgUuid(input.workspaceId),
          entityType: input.entityType,
          entityId: toPgUuid(input.entityId),
          version: input.version,
          snapshot: input.snapshot,
          savedBy: savedByUuid,
          savedByName: input.savedByName,
          comment: input.comment ?? "",
          restoredFrom: input.restoredFrom ?? null,
          createdAt: input.createdAt ?? new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return pgEntityVersionToRecord(inserted[0]);
      const existing = await this.getEntityVersion(
        input.entityId,
        input.entityType,
        input.version,
        input.workspaceId,
      );
      if (existing) return existing;
      throw new Error("EntityVersion conflict without matching existing row");
    }

    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
      const nextVersion =
        (await this.getLatestEntityVersionNumber(
          input.entityId,
          input.entityType,
          input.workspaceId,
        )) + 1;
      try {
        const [row] = await this.getDb()
          .insert(entityVersions)
          .values({
            id: idUuid,
            workspaceId: toPgUuid(input.workspaceId),
            entityType: input.entityType,
            entityId: toPgUuid(input.entityId),
            version: nextVersion,
            snapshot: input.snapshot,
            savedBy: savedByUuid,
            savedByName: input.savedByName,
            comment: input.comment ?? "",
            restoredFrom: input.restoredFrom ?? null,
            createdAt: input.createdAt ?? new Date(),
          })
          .returning();
        return pgEntityVersionToRecord(row);
      } catch (err) {
        if (isPgUniqueViolation(err) && attempt < MAX_VERSION_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Failed to create entity version after retries");
  }

  async upsertEntityVersion(
    record: EntityVersionRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const savedByUuid = await resolveOptionalUserUuid(
      record.savedBy,
      this.resolveUserUuidFn,
    );
    await db
      .insert(entityVersions)
      .values({
        id: toPgUuid(record.id),
        workspaceId: toPgUuid(record.workspaceId),
        entityType: record.entityType,
        entityId: toPgUuid(record.entityId),
        version: record.version,
        snapshot: record.snapshot,
        savedBy: savedByUuid,
        savedByName: record.savedByName,
        comment: record.comment,
        restoredFrom: record.restoredFrom ?? null,
        createdAt: record.createdAt,
      })
      .onConflictDoNothing();
  }

  async listEntityVersions(
    entityId: string,
    entityType: "console",
    opts: { workspaceId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ versions: EntityVersionListItem[]; total: number }> {
    const entityUuid = safePgUuid(entityId);
    if (!entityUuid) return { versions: [], total: 0 };
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;
    const conds = [
      eq(entityVersions.entityId, entityUuid),
      eq(entityVersions.entityType, entityType),
    ];
    if (opts.workspaceId !== undefined) {
      const wsUuid = safePgUuid(opts.workspaceId);
      if (!wsUuid) return { versions: [], total: 0 };
      conds.push(eq(entityVersions.workspaceId, wsUuid));
    }
    const whereClause = and(...conds);
    const [rows, countRows] = await Promise.all([
      this.getDb()
        .select({
          version: entityVersions.version,
          savedBy: entityVersions.savedBy,
          savedByName: entityVersions.savedByName,
          comment: entityVersions.comment,
          restoredFrom: entityVersions.restoredFrom,
          createdAt: entityVersions.createdAt,
        })
        .from(entityVersions)
        .where(whereClause)
        .orderBy(desc(entityVersions.version))
        .limit(limit)
        .offset(offset),
      this.getDb()
        .select({ total: sql<number>`count(*)::int` })
        .from(entityVersions)
        .where(whereClause),
    ]);
    return {
      versions: rows.map(r => ({
        version: r.version,
        savedBy: r.savedBy ? r.savedBy.toLowerCase() : "",
        savedByName: r.savedByName,
        comment: r.comment,
        ...(r.restoredFrom != null ? { restoredFrom: r.restoredFrom } : {}),
        createdAt: r.createdAt,
      })),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async listEntityVersionsAscending(
    workspaceId: string,
    entityId: string,
    entityType: "console",
  ): Promise<EntityVersionRecord[]> {
    const entityUuid = safePgUuid(entityId);
    const wsUuid = safePgUuid(workspaceId);
    if (!entityUuid || !wsUuid) return [];
    const conds = [
      eq(entityVersions.workspaceId, wsUuid),
      eq(entityVersions.entityId, entityUuid),
      eq(entityVersions.entityType, entityType),
    ];
    const rows = await this.getDb()
      .select()
      .from(entityVersions)
      .where(and(...conds))
      .orderBy(asc(entityVersions.version));
    return rows.map(pgEntityVersionToRecord);
  }

  async getEntityVersion(
    entityId: string,
    entityType: "console",
    version: number,
    workspaceId?: string,
  ): Promise<EntityVersionRecord | null> {
    const entityUuid = safePgUuid(entityId);
    if (!entityUuid) return null;
    const conds = [
      eq(entityVersions.entityId, entityUuid),
      eq(entityVersions.entityType, entityType),
      eq(entityVersions.version, version),
    ];
    if (workspaceId !== undefined) {
      const wsUuid = safePgUuid(workspaceId);
      if (!wsUuid) return null;
      conds.push(eq(entityVersions.workspaceId, wsUuid));
    }
    const rows = await this.getDb()
      .select()
      .from(entityVersions)
      .where(and(...conds))
      .limit(1);
    return rows[0] ? pgEntityVersionToRecord(rows[0]) : null;
  }

  async countEntityVersions(
    workspaceId: string,
    entityType: "console",
    entityIds: readonly string[],
  ): Promise<number> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return 0;
    const uuids = entityIds
      .map(safePgUuid)
      .filter((u): u is string => u !== null);
    if (uuids.length === 0) return 0;
    const rows = await this.getDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.workspaceId, wsUuid),
          eq(entityVersions.entityType, entityType),
          inArray(entityVersions.entityId, uuids),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  // ── 4. Notebook folders ───────────────────────────────────────────────

  async listNotebookFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<NotebookFolderRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    const base = this.getDb()
      .select()
      .from(notebookFolders)
      .where(eq(notebookFolders.workspaceId, wsUuid));
    const rows = opts?.sortByName
      ? await base.orderBy(
          sql`${notebookFolders.name} COLLATE "C" ASC`,
          asc(notebookFolders.id),
        )
      : await base;
    return rows.map(pgNotebookFolderToRecord);
  }

  async findNotebookFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<NotebookFolderRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(folderId);
    if (!wsUuid || !idUuid) return null;
    const rows = await this.getDb()
      .select()
      .from(notebookFolders)
      .where(
        and(
          eq(notebookFolders.id, idUuid),
          eq(notebookFolders.workspaceId, wsUuid),
        ),
      )
      .limit(1);
    return rows[0] ? pgNotebookFolderToRecord(rows[0]) : null;
  }

  async createNotebookFolder(
    input: CreateNotebookFolderInput,
  ): Promise<NotebookFolderRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const ownerUuid = await resolveOptionalUserUuid(
      input.ownerId,
      this.resolveUserUuidFn,
    );
    const [row] = await this.getDb()
      .insert(notebookFolders)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        name: input.name,
        parentId: optionalPgUuid(input.parentId),
        ownerId: ownerUuid,
        access: input.access ?? "private",
        createdAt: input.createdAt ?? new Date(),
      })
      .returning();
    return pgNotebookFolderToRecord(row);
  }

  async upsertNotebookFolder(
    record: NotebookFolderRecord,
    options: { db?: MakoPgDb; ignoreUpdatedAtGuard?: boolean } = {},
  ): Promise<void> {
    const db = options.db ?? this.getDb();
    const ownerUuid = await resolveOptionalUserUuid(
      record.ownerId,
      this.resolveUserUuidFn,
    );
    const insert = db.insert(notebookFolders).values({
      id: toPgUuid(record.id),
      workspaceId: toPgUuid(record.workspaceId),
      name: record.name,
      parentId: optionalPgUuid(record.parentId),
      ownerId: ownerUuid,
      access: record.access,
      createdAt: record.createdAt,
    });
    if (options.ignoreUpdatedAtGuard) {
      await insert.onConflictDoUpdate({
        target: notebookFolders.id,
        set: {
          name: record.name,
          parentId: optionalPgUuid(record.parentId),
          ownerId: ownerUuid,
          access: record.access,
        },
      });
    } else {
      // `notebook_folders` has no `updated_at` column; during Stage 2 backfill
      // an existing row in PG came from live dual-write and must not be clobbered.
      await insert.onConflictDoNothing({ target: notebookFolders.id });
    }
  }

  async updateNotebookFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateNotebookFolderInput,
  ): Promise<NotebookFolderRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(folderId);
    if (!wsUuid || !idUuid) return null;
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.parentId !== undefined) {
      set.parentId = optionalPgUuid(patch.parentId);
    }
    if (patch.access !== undefined) set.access = patch.access;
    if (patch.ownerId !== undefined) {
      set.ownerId = await resolveOptionalUserUuid(
        patch.ownerId,
        this.resolveUserUuidFn,
      );
    }
    if (Object.keys(set).length === 0) {
      return this.findNotebookFolderById(workspaceId, folderId);
    }
    const rows = await this.getDb()
      .update(notebookFolders)
      .set(set)
      .where(
        and(
          eq(notebookFolders.id, idUuid),
          eq(notebookFolders.workspaceId, wsUuid),
        ),
      )
      .returning();
    return rows[0] ? pgNotebookFolderToRecord(rows[0]) : null;
  }

  async deleteNotebookFolderSubtreeReturningIds(
    workspaceId: string,
    folderId: string,
  ): Promise<string[]> {
    const wsUuid = safePgUuid(workspaceId);
    const rootUuid = safePgUuid(folderId);
    if (!wsUuid || !rootUuid) return [];

    return this.getDb().transaction(async tx => {
      const raw = await tx.execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM notebook_folders
          WHERE id = ${rootUuid}::uuid AND workspace_id = ${wsUuid}::uuid
          UNION
          SELECT nf.id FROM notebook_folders nf
          JOIN subtree s ON nf.parent_id = s.id
          WHERE nf.workspace_id = ${wsUuid}::uuid
        )
        SELECT id FROM subtree
      `);
      const ids = extractRows<{ id: string }>(raw).map(r => r.id.toLowerCase());
      if (ids.length === 0) return [];
      await tx
        .update(notebookIndexes)
        .set({ folderId: null })
        .where(
          and(
            eq(notebookIndexes.workspaceId, wsUuid),
            inArray(notebookIndexes.folderId, ids),
          ),
        );
      await tx
        .delete(notebookFolders)
        .where(
          and(
            eq(notebookFolders.workspaceId, wsUuid),
            inArray(notebookFolders.id, ids),
          ),
        );
      return ids;
    });
  }

  async deleteNotebookFolderSubtree(
    workspaceId: string,
    folderId: string,
  ): Promise<boolean> {
    return (
      (
        await this.deleteNotebookFolderSubtreeReturningIds(
          workspaceId,
          folderId,
        )
      ).length > 0
    );
  }

  async wouldCreateNotebookFolderCycle(
    workspaceId: string,
    folderId: string,
    targetParentId: string | null,
  ): Promise<boolean> {
    if (!targetParentId) return false;
    const normFolderId = wireId(folderId);
    const normTarget = wireId(targetParentId);
    if (normFolderId === normTarget) return true;
    const folders = await this.listNotebookFolders(workspaceId);
    const parentMap = new Map<string, string | undefined>();
    for (const f of folders) parentMap.set(f.id, f.parentId);
    let current: string | undefined = normTarget;
    const visited = new Set<string>();
    while (current) {
      if (current === normFolderId) return true;
      if (visited.has(current)) return true;
      visited.add(current);
      current = parentMap.get(current);
    }
    return false;
  }

  // ── 5. Notebook indexes ───────────────────────────────────────────────

  async findNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<NotebookIndexRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    const rows = await this.getDb()
      .select()
      .from(notebookIndexes)
      .where(
        and(
          eq(notebookIndexes.workspaceId, wsUuid),
          eq(notebookIndexes.notebookId, notebookId),
        ),
      )
      .limit(1);
    return rows[0] ? pgNotebookIndexToRecord(rows[0]) : null;
  }

  async findNotebookIndexByPath(
    workspaceId: string,
    path: string,
    opts?: { excludeNotebookId?: string },
  ): Promise<NotebookIndexRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    const conds = [
      eq(notebookIndexes.workspaceId, wsUuid),
      eq(notebookIndexes.path, path),
    ];
    if (opts?.excludeNotebookId) {
      conds.push(ne(notebookIndexes.notebookId, opts.excludeNotebookId));
    }
    const rows = await this.getDb()
      .select()
      .from(notebookIndexes)
      .where(and(...conds))
      .limit(1);
    return rows[0] ? pgNotebookIndexToRecord(rows[0]) : null;
  }

  async listNotebookIndexes(
    workspaceId: string,
    opts?: { sortByName?: boolean; visibleForUserId?: string },
  ): Promise<NotebookIndexRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return [];
    const conds = [eq(notebookIndexes.workspaceId, wsUuid)];
    if (opts?.visibleForUserId) {
      const userUuid = await this.resolveUserUuidForRead(opts.visibleForUserId);
      if (userUuid) {
        const shareFilter = JSON.stringify([{ userId: userUuid }]);
        const visibility = or(
          eq(notebookIndexes.access, "workspace"),
          and(
            eq(notebookIndexes.access, "private"),
            eq(notebookIndexes.ownerId, userUuid),
          ),
          sql`${notebookIndexes.sharedWith} @> ${shareFilter}::jsonb`,
        );
        if (visibility) {
          conds.push(visibility);
        }
      } else {
        conds.push(eq(notebookIndexes.access, "workspace"));
      }
    }
    const base = this.getDb()
      .select()
      .from(notebookIndexes)
      .where(and(...conds));
    const rows = opts?.sortByName
      ? await base.orderBy(
          sql`${notebookIndexes.name} COLLATE "C" ASC`,
          asc(notebookIndexes.id),
        )
      : await base;
    return rows.map(pgNotebookIndexToRecord);
  }

  async createNotebookIndex(
    input: CreateNotebookIndexInput,
  ): Promise<NotebookIndexRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const access = input.access ?? "private";
    const [ownerUuid, sharedWithJson] = await Promise.all([
      resolveOptionalUserUuid(input.ownerId, this.resolveUserUuidFn),
      shareEntriesToPgJson(input.sharedWith, this.resolveUserUuidFn),
    ]);
    const [row] = await this.getDb()
      .insert(notebookIndexes)
      .values({
        id,
        notebookId: input.notebookId,
        workspaceId: toPgUuid(input.workspaceId),
        name: input.name,
        folderId: optionalPgUuid(input.folderId),
        ownerId: ownerUuid,
        access,
        path: input.path ?? null,
        checkpointBlobSha: input.checkpointBlobSha ?? null,
        workspaceRole:
          input.workspaceRole ?? (access === "workspace" ? "editor" : "viewer"),
        sharedWith: sharedWithJson,
        updatedAt: input.updatedAt ?? new Date(),
      })
      .returning();
    return pgNotebookIndexToRecord(row);
  }

  async upsertNotebookIndex(
    record: NotebookIndexRecord,
    options: { db?: MakoPgDb; ignoreUpdatedAtGuard?: boolean } = {},
  ): Promise<void> {
    const db = options.db ?? this.getDb();
    const [ownerUuid, sharedWithJson] = await Promise.all([
      resolveOptionalUserUuid(record.ownerId, this.resolveUserUuidFn),
      shareEntriesToPgJson(record.sharedWith, this.resolveUserUuidFn),
    ]);
    const idUuid = toPgUuid(record.id);
    await db
      .insert(notebookIndexes)
      .values({
        id: idUuid,
        notebookId: record.notebookId,
        workspaceId: toPgUuid(record.workspaceId),
        name: record.name,
        folderId: optionalPgUuid(record.folderId),
        ownerId: ownerUuid,
        access: record.access,
        path: record.path ?? null,
        checkpointBlobSha: record.checkpointBlobSha ?? null,
        workspaceRole: record.workspaceRole,
        sharedWith: sharedWithJson,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [notebookIndexes.workspaceId, notebookIndexes.notebookId],
        set: {
          // Reconcile PK on delete+recreate (no table FKs notebook_indexes.id)
          // so verifier never hits permanent missing_in_pg + extra_in_pg PK drift.
          id: idUuid,
          name: record.name,
          folderId: optionalPgUuid(record.folderId),
          ownerId: ownerUuid,
          access: record.access,
          path: record.path ?? null,
          checkpointBlobSha: record.checkpointBlobSha ?? null,
          workspaceRole: record.workspaceRole,
          sharedWith: sharedWithJson,
          updatedAt: record.updatedAt,
        },
        ...(options.ignoreUpdatedAtGuard
          ? {}
          : {
              setWhere: sql`${notebookIndexes.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${notebookIndexes.updatedAt}`,
            }),
      });
  }

  async updateNotebookIndex(
    workspaceId: string,
    notebookId: string,
    patch: UpdateNotebookIndexInput,
  ): Promise<NotebookIndexRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.access !== undefined) {
      set.access = patch.access;
      if (patch.access === "workspace" && patch.workspaceRole === undefined) {
        set.workspaceRole = "editor";
      }
    }
    if (patch.workspaceRole !== undefined) {
      set.workspaceRole = patch.workspaceRole;
    }
    if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
    if (patch.folderId !== undefined) {
      set.folderId = optionalPgUuid(patch.folderId);
    }
    if (patch.path !== undefined) set.path = patch.path;
    if (patch.checkpointBlobSha !== undefined) {
      set.checkpointBlobSha = patch.checkpointBlobSha;
    }
    if (patch.sharedWith !== undefined) {
      set.sharedWith = await shareEntriesToPgJson(
        patch.sharedWith,
        this.resolveUserUuidFn,
      );
    }
    if (Object.keys(set).length === 0) {
      return this.findNotebookIndex(workspaceId, notebookId);
    }
    const rows = await this.getDb()
      .update(notebookIndexes)
      .set(set)
      .where(
        and(
          eq(notebookIndexes.workspaceId, wsUuid),
          eq(notebookIndexes.notebookId, notebookId),
        ),
      )
      .returning();
    return rows[0] ? pgNotebookIndexToRecord(rows[0]) : null;
  }

  async deleteNotebookIndexReturningId(
    workspaceId: string,
    notebookId: string,
  ): Promise<string | null> {
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return null;
    const rows = await this.getDb()
      .delete(notebookIndexes)
      .where(
        and(
          eq(notebookIndexes.workspaceId, wsUuid),
          eq(notebookIndexes.notebookId, notebookId),
        ),
      )
      .returning({ id: notebookIndexes.id });
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  async deleteNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<boolean> {
    return (
      (await this.deleteNotebookIndexReturningId(workspaceId, notebookId)) !==
      null
    );
  }

  // ── 6. Favourites ─────────────────────────────────────────────────────

  async listFavourites(
    workspaceId: string,
    userId: string,
  ): Promise<FavouriteRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid) return [];
    const rows = await this.getDb()
      .select()
      .from(favourites)
      .where(
        and(
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
        ),
      )
      .orderBy(
        sql`${favourites.parentId} ASC NULLS FIRST`,
        asc(favourites.position),
        asc(favourites.id),
      );
    return rows.map(pgFavouriteToRecord);
  }

  async countFavourites(workspaceId: string, userId: string): Promise<number> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid) return 0;
    const rows = await this.getDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(favourites)
      .where(
        and(
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async findFavouriteById(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<FavouriteRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(id);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !idUuid || !userUuid) return null;
    const rows = await this.getDb()
      .select()
      .from(favourites)
      .where(
        and(
          eq(favourites.id, idUuid),
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
        ),
      )
      .limit(1);
    return rows[0] ? pgFavouriteToRecord(rows[0]) : null;
  }

  async findFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<FavouriteRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid) return null;
    const rows = await this.getDb()
      .select()
      .from(favourites)
      .where(
        and(
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
          eq(favourites.type, "item"),
          eq(favourites.kind, kind),
          eq(favourites.refId, refId),
        ),
      )
      .limit(1);
    return rows[0] ? pgFavouriteToRecord(rows[0]) : null;
  }

  async listFavouriteSiblings(
    workspaceId: string,
    userId: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<FavouriteRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid) return [];
    let parentCond = isNull(favourites.parentId);
    if (parentId !== null) {
      const parentUuid = safePgUuid(parentId);
      if (!parentUuid) return [];
      parentCond = eq(favourites.parentId, parentUuid);
    }
    const conds = [
      eq(favourites.workspaceId, wsUuid),
      eq(favourites.userId, userUuid),
      parentCond,
    ];
    if (excludeId) {
      const exUuid = safePgUuid(excludeId);
      if (exUuid) conds.push(ne(favourites.id, exUuid));
    }
    const rows = await this.getDb()
      .select()
      .from(favourites)
      .where(and(...conds))
      .orderBy(asc(favourites.position), asc(favourites.id));
    return rows.map(pgFavouriteToRecord);
  }

  async getNextFavouritePosition(
    workspaceId: string,
    userId: string,
    parentId: string | null,
  ): Promise<number> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid) return 0;
    let parentCond = isNull(favourites.parentId);
    if (parentId !== null) {
      const parentUuid = safePgUuid(parentId);
      if (!parentUuid) return 0;
      parentCond = eq(favourites.parentId, parentUuid);
    }
    const rows = await this.getDb()
      .select({ position: favourites.position })
      .from(favourites)
      .where(
        and(
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
          parentCond,
        ),
      )
      .orderBy(desc(favourites.position))
      .limit(1);
    return (rows[0]?.position ?? -1) + 1;
  }

  async createFavourite(input: CreateFavouriteInput): Promise<FavouriteRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const userUuid = await this.resolveRequiredUserUuid(input.userId);
    const now = new Date();
    try {
      const [row] = await this.getDb()
        .insert(favourites)
        .values({
          id,
          workspaceId: toPgUuid(input.workspaceId),
          userId: userUuid,
          parentId: optionalPgUuid(input.parentId),
          type: input.type,
          title: input.type === "folder" ? (input.title ?? "") : null,
          kind: input.type === "item" ? (input.kind ?? null) : null,
          refId: input.type === "item" ? (input.refId ?? null) : null,
          position: input.position,
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? now,
        })
        .returning();
      return pgFavouriteToRecord(row);
    } catch (error) {
      if (
        isPgUniqueViolation(error) &&
        input.type === "item" &&
        input.kind &&
        input.refId
      ) {
        const winner = await this.findFavouriteByRef(
          input.workspaceId,
          userUuid,
          input.kind,
          input.refId,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }

  async upsertFavourite(
    record: FavouriteRecord,
    options: {
      db?: MakoPgDb;
      ignoreUpdatedAtGuard?: boolean;
      preserveParentOnConflict?: boolean;
    } = {},
  ): Promise<void> {
    const db = options.db ?? this.getDb();
    const userUuid = await this.resolveRequiredUserUuid(record.userId);
    const idUuid = toPgUuid(record.id);
    const wsUuid = toPgUuid(record.workspaceId);

    // Handle delete+recreate of the same (workspace, user, kind, refId) item under a new PK
    // without crashing on `idx_favourites_item_unique`, while still honoring stale-write guards.
    if (record.type === "item" && record.kind && record.refId) {
      const existingByRef = await db
        .select({ id: favourites.id, updatedAt: favourites.updatedAt })
        .from(favourites)
        .where(
          and(
            eq(favourites.workspaceId, wsUuid),
            eq(favourites.userId, userUuid),
            eq(favourites.type, "item"),
            eq(favourites.kind, record.kind),
            eq(favourites.refId, record.refId),
          ),
        )
        .limit(1);
      if (existingByRef[0] && existingByRef[0].id.toLowerCase() !== idUuid) {
        if (
          !options.ignoreUpdatedAtGuard &&
          existingByRef[0].updatedAt &&
          existingByRef[0].updatedAt.getTime() > record.updatedAt.getTime()
        ) {
          return;
        }
        await db
          .delete(favourites)
          .where(eq(favourites.id, existingByRef[0].id));
      }
    }

    const conflictSet: Record<string, unknown> = {
      title: record.type === "folder" ? (record.title ?? "") : null,
      position: record.position,
      updatedAt: record.updatedAt,
    };
    if (!options.preserveParentOnConflict) {
      conflictSet.parentId = optionalPgUuid(record.parentId);
    }
    await db
      .insert(favourites)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        userId: userUuid,
        parentId: optionalPgUuid(record.parentId),
        type: record.type,
        title: record.type === "folder" ? (record.title ?? "") : null,
        kind: record.type === "item" ? (record.kind ?? null) : null,
        refId: record.type === "item" ? (record.refId ?? null) : null,
        position: record.position,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: favourites.id,
        set: conflictSet,
        ...(options.ignoreUpdatedAtGuard
          ? {}
          : {
              setWhere: sql`${favourites.updatedAt} IS NULL OR EXCLUDED.updated_at >= ${favourites.updatedAt}`,
            }),
      });
  }

  async updateFavouriteSimple(
    workspaceId: string,
    userId: string,
    id: string,
    patch: {
      parentId?: string | null;
      position?: number;
      title?: string;
      updatedAt?: Date;
    },
  ): Promise<FavouriteRecord | null> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(id);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !idUuid || !userUuid) return null;
    const set: Record<string, unknown> = {};
    if (patch.parentId !== undefined) {
      set.parentId = optionalPgUuid(patch.parentId);
    }
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.title !== undefined) set.title = patch.title;
    if (Object.keys(set).length === 0) {
      return this.findFavouriteById(workspaceId, userId, id);
    }
    set.updatedAt = patch.updatedAt ?? new Date();
    const rows = await this.getDb()
      .update(favourites)
      .set(set)
      .where(
        and(
          eq(favourites.id, idUuid),
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
        ),
      )
      .returning();
    return rows[0] ? pgFavouriteToRecord(rows[0]) : null;
  }

  async reorderFavourites(
    workspaceId: string,
    userId: string,
    updates: readonly ReorderFavouriteUpdate[],
    updatedAt: Date = new Date(),
  ): Promise<void> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid || updates.length === 0) return;
    await this.getDb().transaction(async tx => {
      for (const u of updates) {
        const idUuid = safePgUuid(u.id);
        if (!idUuid) continue;
        const set: Record<string, unknown> = {
          position: u.position,
          updatedAt,
        };
        if (u.parentId !== undefined) set.parentId = optionalPgUuid(u.parentId);
        if (u.title !== undefined) set.title = u.title;
        await tx
          .update(favourites)
          .set(set)
          .where(
            and(
              eq(favourites.id, idUuid),
              eq(favourites.workspaceId, wsUuid),
              eq(favourites.userId, userUuid),
            ),
          );
      }
    });
  }

  async deleteFavouriteByRefReturningId(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<string | null> {
    const wsUuid = safePgUuid(workspaceId);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !userUuid) return null;
    const rows = await this.getDb()
      .delete(favourites)
      .where(
        and(
          eq(favourites.workspaceId, wsUuid),
          eq(favourites.userId, userUuid),
          eq(favourites.type, "item"),
          eq(favourites.kind, kind),
          eq(favourites.refId, refId),
        ),
      )
      .returning({ id: favourites.id });
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  async deleteFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<boolean> {
    return (
      (await this.deleteFavouriteByRefReturningId(
        workspaceId,
        userId,
        kind,
        refId,
      )) !== null
    );
  }

  async deleteFavouriteSubtreeReturningIds(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<string[]> {
    const wsUuid = safePgUuid(workspaceId);
    const idUuid = safePgUuid(id);
    const userUuid = await this.resolveUserUuidForRead(userId);
    if (!wsUuid || !idUuid || !userUuid) return [];
    const raw = await this.getDb().execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM favourites
        WHERE id = ${idUuid}::uuid
          AND workspace_id = ${wsUuid}::uuid
          AND user_id = ${userUuid}::uuid
        UNION ALL
        SELECT f.id FROM favourites f
        JOIN subtree s ON f.parent_id = s.id
        WHERE f.workspace_id = ${wsUuid}::uuid
          AND f.user_id = ${userUuid}::uuid
      )
      DELETE FROM favourites
      WHERE id IN (SELECT id FROM subtree)
      RETURNING id
    `);
    return extractRows<{ id: string }>(raw).map(r => r.id.toLowerCase());
  }

  async deleteFavouriteSubtree(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<number> {
    return (
      await this.deleteFavouriteSubtreeReturningIds(workspaceId, userId, id)
    ).length;
  }

  // ── 7. Scheduled query runs ───────────────────────────────────────────

  async createScheduledQueryRun(
    input: CreateScheduledQueryRunInput,
  ): Promise<ScheduledQueryRunRecord> {
    const id = input.id ? toPgUuid(input.id) : newDualId().uuid;
    const triggeredByUuid = await resolveOptionalUserUuid(
      input.triggeredBy,
      this.resolveUserUuidFn,
    );
    const [row] = await this.getDb()
      .insert(scheduledQueryRuns)
      .values({
        id,
        workspaceId: toPgUuid(input.workspaceId),
        consoleId: toPgUuid(input.consoleId),
        triggeredAt: input.triggeredAt ?? new Date(),
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        status: input.status,
        triggerType: input.triggerType,
        triggeredBy: triggeredByUuid,
        durationMs: input.durationMs ?? null,
        rowsAffected: input.rowsAffected ?? null,
        rowCount: input.rowCount ?? null,
        errorMessage: input.error?.message ?? null,
        errorCode: input.error?.code ?? null,
        inngestRunId: input.inngestRunId ?? null,
      })
      .returning();
    return pgScheduledQueryRunToRecord(row);
  }

  async upsertScheduledQueryRun(
    record: ScheduledQueryRunRecord,
    options: { db?: MakoPgDb; ignoreUpdatedAtGuard?: boolean } = {},
  ): Promise<void> {
    const db = options.db ?? this.getDb();
    const triggeredByUuid = await resolveOptionalUserUuid(
      record.triggeredBy,
      this.resolveUserUuidFn,
    );
    await db
      .insert(scheduledQueryRuns)
      .values({
        id: toPgUuid(record.id),
        workspaceId: toPgUuid(record.workspaceId),
        consoleId: toPgUuid(record.consoleId),
        triggeredAt: record.triggeredAt,
        startedAt: record.startedAt ?? null,
        completedAt: record.completedAt ?? null,
        status: record.status,
        triggerType: record.triggerType,
        triggeredBy: triggeredByUuid,
        durationMs: record.durationMs ?? null,
        rowsAffected: record.rowsAffected ?? null,
        rowCount: record.rowCount ?? null,
        errorMessage: record.error?.message ?? null,
        errorCode: record.error?.code ?? null,
        inngestRunId: record.inngestRunId ?? null,
      })
      .onConflictDoUpdate({
        target: scheduledQueryRuns.id,
        set: {
          startedAt: record.startedAt ?? null,
          completedAt: record.completedAt ?? null,
          status: record.status,
          durationMs: record.durationMs ?? null,
          rowsAffected: record.rowsAffected ?? null,
          rowCount: record.rowCount ?? null,
          errorMessage: record.error?.message ?? null,
          errorCode: record.error?.code ?? null,
          inngestRunId: record.inngestRunId ?? null,
        },
        ...(options.ignoreUpdatedAtGuard
          ? {}
          : {
              // Monotonic lifecycle guard: never revert a completed run to running/pending,
              // nor revert a started run to unstarted.
              setWhere: sql`(${scheduledQueryRuns.completedAt} IS NULL OR (EXCLUDED.completed_at IS NOT NULL AND EXCLUDED.completed_at >= ${scheduledQueryRuns.completedAt})) AND (${scheduledQueryRuns.startedAt} IS NULL OR EXCLUDED.started_at IS NOT NULL)`,
            }),
      });
  }

  async findScheduledQueryRunById(
    runId: string,
    workspaceId?: string,
  ): Promise<ScheduledQueryRunRecord | null> {
    const idUuid = safePgUuid(runId);
    if (!idUuid) return null;
    const conds = [eq(scheduledQueryRuns.id, idUuid)];
    if (workspaceId !== undefined) {
      const wsUuid = safePgUuid(workspaceId);
      if (!wsUuid) return null;
      conds.push(eq(scheduledQueryRuns.workspaceId, wsUuid));
    }
    const rows = await this.getDb()
      .select()
      .from(scheduledQueryRuns)
      .where(and(...conds))
      .limit(1);
    return rows[0] ? pgScheduledQueryRunToRecord(rows[0]) : null;
  }

  async updateScheduledQueryRun(
    workspaceId: string,
    runId: string,
    patch: UpdateScheduledQueryRunInput,
  ): Promise<boolean> {
    const idUuid = safePgUuid(runId);
    const wsUuid = safePgUuid(workspaceId);
    if (!idUuid || !wsUuid) return false;
    const set: Record<string, unknown> = {};
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.durationMs !== undefined) set.durationMs = patch.durationMs;
    if (patch.rowsAffected !== undefined) set.rowsAffected = patch.rowsAffected;
    if (patch.rowCount !== undefined) set.rowCount = patch.rowCount;
    if (patch.error !== undefined) {
      set.errorMessage = patch.error?.message ?? null;
      set.errorCode = patch.error?.code ?? null;
    }
    if (Object.keys(set).length === 0) return true;
    const conds = [
      eq(scheduledQueryRuns.id, idUuid),
      eq(scheduledQueryRuns.workspaceId, wsUuid),
    ];
    const rows = await this.getDb()
      .update(scheduledQueryRuns)
      .set(set)
      .where(and(...conds))
      .returning({ id: scheduledQueryRuns.id });
    return rows.length > 0;
  }

  async listScheduledQueryRuns(
    workspaceId: string,
    consoleId: string,
    limit: number,
  ): Promise<ScheduledQueryRunRecord[]> {
    const wsUuid = safePgUuid(workspaceId);
    const consoleUuid = safePgUuid(consoleId);
    if (!wsUuid || !consoleUuid) return [];
    const rows = await this.getDb()
      .select()
      .from(scheduledQueryRuns)
      .where(
        and(
          eq(scheduledQueryRuns.workspaceId, wsUuid),
          eq(scheduledQueryRuns.consoleId, consoleUuid),
        ),
      )
      .orderBy(desc(scheduledQueryRuns.triggeredAt))
      .limit(limit);
    return rows.map(pgScheduledQueryRunToRecord);
  }

  async purgeWorkspaceContentIndexReturningIds(workspaceId: string): Promise<{
    saved_consoles: string[];
    console_folders: string[];
    entity_versions: string[];
    notebook_indexes: string[];
    notebook_folders: string[];
  }> {
    const empty = {
      saved_consoles: [] as string[],
      console_folders: [] as string[],
      entity_versions: [] as string[],
      notebook_indexes: [] as string[],
      notebook_folders: [] as string[],
    };
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return empty;
    const db = this.getDb();
    return db.transaction(async tx => {
      const deletedConsoles = await tx
        .delete(savedConsoles)
        .where(eq(savedConsoles.workspaceId, wsUuid))
        .returning({ id: savedConsoles.id });
      const deletedFolders = await tx
        .delete(consoleFolders)
        .where(eq(consoleFolders.workspaceId, wsUuid))
        .returning({ id: consoleFolders.id });
      const deletedVersions = await tx
        .delete(entityVersions)
        .where(
          and(
            eq(entityVersions.workspaceId, wsUuid),
            eq(entityVersions.entityType, "console"),
          ),
        )
        .returning({ id: entityVersions.id });
      const deletedNotebooks = await tx
        .delete(notebookIndexes)
        .where(eq(notebookIndexes.workspaceId, wsUuid))
        .returning({ id: notebookIndexes.id });
      const deletedNbFolders = await tx
        .delete(notebookFolders)
        .where(eq(notebookFolders.workspaceId, wsUuid))
        .returning({ id: notebookFolders.id });
      return {
        saved_consoles: deletedConsoles.map(r => toWireId(r.id)),
        console_folders: deletedFolders.map(r => toWireId(r.id)),
        entity_versions: deletedVersions.map(r => toWireId(r.id)),
        notebook_indexes: deletedNotebooks.map(r => toWireId(r.id)),
        notebook_folders: deletedNbFolders.map(r => toWireId(r.id)),
      };
    });
  }

  async purgeWorkspaceContentIndex(workspaceId: string): Promise<void> {
    await this.purgeWorkspaceContentIndexReturningIds(workspaceId);
  }

  /**
   * Delete ONLY the specified captured IDs per table within `workspaceId`.
   * Used by delayed Stage 2/3 `replaySyncToPg` purge retries so content
   * re-created after a workspace repo reconnect is never wiped.
   */
  async deleteWorkspaceContentIndexByIds(
    workspaceId: string,
    idsByTable: {
      saved_consoles?: readonly string[];
      console_folders?: readonly string[];
      entity_versions?: readonly string[];
      notebook_indexes?: readonly string[];
      notebook_folders?: readonly string[];
    },
  ): Promise<{
    saved_consoles: string[];
    console_folders: string[];
    entity_versions: string[];
    notebook_indexes: string[];
    notebook_folders: string[];
  }> {
    const empty = {
      saved_consoles: [] as string[],
      console_folders: [] as string[],
      entity_versions: [] as string[],
      notebook_indexes: [] as string[],
      notebook_folders: [] as string[],
    };
    const wsUuid = safePgUuid(workspaceId);
    if (!wsUuid) return empty;
    const toUuids = (ids: readonly string[] | undefined): string[] =>
      (ids ?? []).map(safePgUuid).filter((u): u is string => u !== null);

    const consoleUuids = toUuids(idsByTable.saved_consoles);
    const folderUuids = toUuids(idsByTable.console_folders);
    const versionUuids = toUuids(idsByTable.entity_versions);
    const notebookUuids = toUuids(idsByTable.notebook_indexes);
    const nbFolderUuids = toUuids(idsByTable.notebook_folders);

    if (
      consoleUuids.length === 0 &&
      folderUuids.length === 0 &&
      versionUuids.length === 0 &&
      notebookUuids.length === 0 &&
      nbFolderUuids.length === 0
    ) {
      return empty;
    }

    const db = this.getDb();
    return db.transaction(async tx => {
      const deletedConsoles =
        consoleUuids.length > 0
          ? await tx
              .delete(savedConsoles)
              .where(
                and(
                  eq(savedConsoles.workspaceId, wsUuid),
                  inArray(savedConsoles.id, consoleUuids),
                ),
              )
              .returning({ id: savedConsoles.id })
          : [];
      const deletedFolders =
        folderUuids.length > 0
          ? await tx
              .delete(consoleFolders)
              .where(
                and(
                  eq(consoleFolders.workspaceId, wsUuid),
                  inArray(consoleFolders.id, folderUuids),
                ),
              )
              .returning({ id: consoleFolders.id })
          : [];
      const deletedVersions =
        versionUuids.length > 0
          ? await tx
              .delete(entityVersions)
              .where(
                and(
                  eq(entityVersions.workspaceId, wsUuid),
                  eq(entityVersions.entityType, "console"),
                  inArray(entityVersions.id, versionUuids),
                ),
              )
              .returning({ id: entityVersions.id })
          : [];
      const deletedNotebooks =
        notebookUuids.length > 0
          ? await tx
              .delete(notebookIndexes)
              .where(
                and(
                  eq(notebookIndexes.workspaceId, wsUuid),
                  inArray(notebookIndexes.id, notebookUuids),
                ),
              )
              .returning({ id: notebookIndexes.id })
          : [];
      const deletedNbFolders =
        nbFolderUuids.length > 0
          ? await tx
              .delete(notebookFolders)
              .where(
                and(
                  eq(notebookFolders.workspaceId, wsUuid),
                  inArray(notebookFolders.id, nbFolderUuids),
                ),
              )
              .returning({ id: notebookFolders.id })
          : [];
      return {
        saved_consoles: deletedConsoles.map(r => toWireId(r.id)),
        console_folders: deletedFolders.map(r => toWireId(r.id)),
        entity_versions: deletedVersions.map(r => toWireId(r.id)),
        notebook_indexes: deletedNotebooks.map(r => toWireId(r.id)),
        notebook_folders: deletedNbFolders.map(r => toWireId(r.id)),
      };
    });
  }
}
