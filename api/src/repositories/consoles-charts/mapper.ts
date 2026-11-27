/**
 * Pure bidirectional mappers & canonicalizers for Phase 2A-2 (`consoles_charts` domain).
 *
 * Translates between MongoDB documents, Postgres Drizzle rows, and store-agnostic DTOs:
 *   - All ObjectId PKs/FKs map bijectively via `objectIdToUuid` / `toWireId`.
 *   - User IDs map to canonical UUIDv7 strings (`users.id`) in Postgres and nullable
 *     `NULL` for non-user sentinels (`""`, `"system"`, `"git"`, `"agent"`, `"unowned:*"`).
 *   - Embedded JSONB user references (`shared_with[].{userId,addedBy}`, `last_run.runBy`)
 *     are rewritten via caller-supplied resolvers without mutating inputs.
 */
import type { Types } from "mongoose";
import {
  isUuidString,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import type {
  ConsoleFolderRow,
  ConsoleLastRunJson,
  EntityVersionRow,
  FavouriteRow,
  NotebookFolderRow,
  NotebookIndexRow,
  ResourceShareEntryJson,
  SavedConsoleRow,
  ScheduledQueryRunRow,
} from "../../database/pg/schema/consoles-charts";
import type {
  ConsoleAccessLevel,
  ConsoleFolderRecord,
  ConsoleLanguage,
  ConsoleLastRunRecord,
  ConsoleScheduledRunRecord,
  ConsoleSearchCandidate,
  EntityVersionRecord,
  FavouriteKind,
  FavouriteRecord,
  NotebookFolderRecord,
  NotebookIndexRecord,
  ResourceShareEntryRecord,
  SavedConsoleRecord,
  ScheduledQueryRunRecord,
} from "./types";

export type UserUuidResolver = (
  idOrLegacyId: string,
) => Promise<string | null> | string | null;

const NON_USER_SENTINELS = new Set(["", "system", "git", "agent"]);

export function isNonUserSentinel(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (NON_USER_SENTINELS.has(trimmed)) return true;
  if (trimmed.startsWith("unowned:")) return true;
  return false;
}

/** Convert an ObjectId or UUID to its canonical 24-hex wire string (when ObjectId-backed). */
export function wireId(value: Types.ObjectId | string): string {
  const str = typeof value === "string" ? value : value.toString();
  const parsed = parseEntityId(str);
  return parsed ? toWireId(parsed.uuid) : str;
}

export function optionalWireId(
  value: Types.ObjectId | string | null | undefined,
): string | undefined {
  if (value == null) return undefined;
  const str = typeof value === "string" ? value : value.toString();
  if (!str) return undefined;
  return wireId(str);
}

/** Convert a 24-hex ObjectId or 36-char UUID into Postgres lowercase UUID. */
export function toPgUuid(value: Types.ObjectId | string): string {
  const str = typeof value === "string" ? value : value.toString();
  const parsed = parseEntityId(str);
  if (parsed) return parsed.uuid;
  throw new Error(`Invalid ObjectId/UUID value: ${JSON.stringify(str)}`);
}

export function optionalPgUuid(
  value: Types.ObjectId | string | null | undefined,
): string | null {
  if (value == null) return null;
  const str = typeof value === "string" ? value : value.toString();
  if (!str) return null;
  return parseEntityId(str)?.uuid ?? null;
}

export function toDate(value: Date | string | number | null | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

export function optionalDate(
  value: Date | string | number | null | undefined,
): Date | undefined {
  if (value == null) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Resolve an optional user ID into a PG `users.id` UUIDv7 (or `null` for sentinels / unknown).
 */
export async function resolveOptionalUserUuid(
  raw: string | null | undefined,
  resolve: UserUuidResolver,
): Promise<string | null> {
  if (raw == null || isNonUserSentinel(raw)) return null;
  const resolved = await resolve(raw);
  return resolved && isUuidString(resolved) ? resolved.toLowerCase() : null;
}

/** Serialize `ResourceShareEntryRecord[]` to PG JSONB, rewriting embedded user IDs. */
export async function shareEntriesToPgJson(
  entries: readonly ResourceShareEntryRecord[] | undefined,
  resolve: UserUuidResolver,
): Promise<ResourceShareEntryJson[]> {
  if (!entries || entries.length === 0) return [];
  const out: ResourceShareEntryJson[] = [];
  for (const entry of entries) {
    const resolvedUserId =
      (await resolveOptionalUserUuid(entry.userId, resolve)) ?? entry.userId;
    const resolvedAddedBy = entry.addedBy
      ? ((await resolveOptionalUserUuid(entry.addedBy, resolve)) ??
        entry.addedBy)
      : undefined;
    out.push({
      userId: resolvedUserId,
      role: entry.role,
      addedAt: toDate(entry.addedAt).toISOString(),
      ...(resolvedAddedBy !== undefined ? { addedBy: resolvedAddedBy } : {}),
    });
  }
  return out;
}

export function pgJsonToShareEntries(
  raw: readonly ResourceShareEntryJson[] | null | undefined,
): ResourceShareEntryRecord[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map(entry => ({
    userId: String(entry.userId),
    role: entry.role === "editor" ? "editor" : "viewer",
    addedAt: toDate(entry.addedAt),
    ...(entry.addedBy ? { addedBy: String(entry.addedBy) } : {}),
  }));
}

/** Serialize `ConsoleLastRunRecord` to PG JSONB, rewriting `runBy` when it is a real user. */
export async function lastRunToPgJson(
  lastRun: ConsoleLastRunRecord | null | undefined,
  resolve: UserUuidResolver,
): Promise<ConsoleLastRunJson | null> {
  if (!lastRun) return null;
  const resolvedRunBy =
    (await resolveOptionalUserUuid(lastRun.runBy, resolve)) ?? lastRun.runBy;
  return {
    at: toDate(lastRun.at).toISOString(),
    status: lastRun.status,
    ...(lastRun.rowCount !== undefined ? { rowCount: lastRun.rowCount } : {}),
    durationMs: lastRun.durationMs,
    ...(lastRun.error !== undefined ? { error: lastRun.error } : {}),
    ...(Array.isArray(lastRun.sampleRows) && lastRun.sampleRows.length > 0
      ? { sampleRows: lastRun.sampleRows }
      : {}),
    ...(lastRun.fields !== undefined ? { fields: lastRun.fields } : {}),
    runBy: resolvedRunBy,
    source: lastRun.source,
    ...(lastRun.startedAt
      ? { startedAt: toDate(lastRun.startedAt).toISOString() }
      : {}),
    ...(lastRun.executionId !== undefined
      ? { executionId: lastRun.executionId }
      : {}),
  };
}

export function pgJsonToLastRun(
  raw: ConsoleLastRunJson | null | undefined,
): ConsoleLastRunRecord | undefined {
  if (!raw) return undefined;
  return {
    at: toDate(raw.at),
    status: raw.status,
    ...(raw.rowCount !== undefined ? { rowCount: raw.rowCount } : {}),
    durationMs: raw.durationMs,
    ...(raw.error !== undefined ? { error: raw.error } : {}),
    ...(Array.isArray(raw.sampleRows) && raw.sampleRows.length > 0
      ? { sampleRows: raw.sampleRows }
      : {}),
    ...(raw.fields !== undefined ? { fields: raw.fields } : {}),
    runBy: raw.runBy,
    source: raw.source,
    ...(raw.startedAt ? { startedAt: toDate(raw.startedAt) } : {}),
    ...(raw.executionId !== undefined ? { executionId: raw.executionId } : {}),
  };
}

// ── 1. ConsoleFolder mappers ────────────────────────────────────────────────

export interface MongoConsoleFolderLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  name: string;
  parentId?: Types.ObjectId | string | null;
  isPrivate?: boolean;
  ownerId?: string | null;
  access?: ConsoleAccessLevel;
  createdAt?: Date | string;
}

export function mongoConsoleFolderToRecord(
  doc: MongoConsoleFolderLike,
): ConsoleFolderRecord {
  const id = wireId(doc._id);
  const access: ConsoleAccessLevel =
    doc.access ?? (doc.isPrivate ? "private" : "workspace");
  return {
    id,
    _id: id,
    workspaceId: wireId(doc.workspaceId),
    name: doc.name,
    ...(optionalWireId(doc.parentId)
      ? { parentId: optionalWireId(doc.parentId) }
      : {}),
    isPrivate: doc.isPrivate ?? access === "private",
    ...(doc.ownerId ? { ownerId: String(doc.ownerId) } : {}),
    access,
    createdAt: toDate(doc.createdAt),
  };
}

export function pgConsoleFolderToRecord(
  row: ConsoleFolderRow,
): ConsoleFolderRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    ...(row.parentId ? { parentId: toWireId(row.parentId) } : {}),
    isPrivate: row.isPrivate,
    ...(row.ownerId ? { ownerId: row.ownerId.toLowerCase() } : {}),
    access: row.access,
    createdAt: toDate(row.createdAt),
  };
}

// ── 2. SavedConsole mappers ─────────────────────────────────────────────────

export interface MongoSavedConsoleLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  folderId?: Types.ObjectId | string | null;
  connectionId?: Types.ObjectId | string | null;
  databaseName?: string | null;
  databaseId?: string | null;
  name: string;
  description?: string | null;
  descriptionEmbedding?: number[] | null;
  embeddingModel?: string | null;
  descriptionGeneratedAt?: Date | string | null;
  path?: string | null;
  sourceBlobSha?: string | null;
  descriptionSourceSha?: string | null;
  descriptionSource?: "authored" | "generated" | null;
  code: string;
  language: ConsoleLanguage;
  chartSpec?: Record<string, unknown> | null;
  resultsViewMode?: "table" | "json" | "chart" | null;
  mongoOptions?: SavedConsoleRecord["mongoOptions"] | null;
  createdBy?: string | null;
  owner_id?: string | null;
  isPrivate?: boolean;
  isSaved?: boolean;
  access?: ConsoleAccessLevel;
  workspaceRole?: "viewer" | "editor";
  sharedWith?: Array<{
    userId: string;
    role: "viewer" | "editor";
    addedAt: Date | string;
    addedBy?: string;
  }> | null;
  schedule?: { cron?: string; timezone?: string } | null;
  scheduledRun?: {
    nextAt?: Date | string | null;
    lastAt?: Date | string | null;
    lastStatus?: "success" | "error" | null;
    lastError?: string | null;
    lastDurationMs?: number | null;
    lastRowsAffected?: number | null;
    lastRowCount?: number | null;
    runCount?: number | null;
    consecutiveFailures?: number | null;
    permanentFailures?: number | null;
    pausedAt?: Date | string | null;
    pausedReason?: string | null;
  } | null;
  version?: number;
  draftRevision?: number;
  lastDraftOrigin?: "user" | "agent" | null;
  lastRun?: {
    at: Date | string;
    status: "running" | "success" | "error" | "cancelled";
    rowCount?: number;
    durationMs: number;
    error?: string;
    sampleRows?: unknown[];
    fields?: unknown;
    runBy: string;
    source: string;
    startedAt?: Date | string;
    executionId?: string;
  } | null;
  lastExecutedAt?: Date | string | null;
  executionCount?: number;
  lastExternalUsedAt?: Date | string | null;
  externalUseCount?: number;
  lastExternalSource?: "api" | "mcp" | null;
  is_deleted?: boolean;
  deletedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoSavedConsoleToRecord(
  doc: MongoSavedConsoleLike,
): SavedConsoleRecord {
  const id = wireId(doc._id);
  const access: ConsoleAccessLevel =
    doc.access ?? (doc.isPrivate ? "private" : "private");
  const folderId = optionalWireId(doc.folderId);
  const connectionId = optionalWireId(doc.connectionId);

  const schedule =
    doc.schedule?.cron && doc.schedule.cron.length > 0
      ? {
          cron: doc.schedule.cron,
          timezone: doc.schedule.timezone || "UTC",
        }
      : undefined;

  const sr = doc.scheduledRun;
  const hasScheduledRun =
    sr != null &&
    (sr.nextAt != null ||
      sr.lastAt != null ||
      sr.lastStatus != null ||
      sr.lastError != null ||
      sr.lastDurationMs != null ||
      sr.lastRowsAffected != null ||
      sr.lastRowCount != null ||
      (sr.runCount ?? 0) > 0 ||
      (sr.consecutiveFailures ?? 0) > 0 ||
      sr.permanentFailures != null ||
      sr.pausedAt != null ||
      sr.pausedReason != null);

  let scheduledRun: ConsoleScheduledRunRecord | undefined;
  if (hasScheduledRun && sr) {
    const nextAtDate = optionalDate(sr.nextAt);
    const lastAtDate = optionalDate(sr.lastAt);
    const pausedAtDate = optionalDate(sr.pausedAt);
    scheduledRun = {
      ...(nextAtDate ? { nextAt: nextAtDate } : {}),
      ...(lastAtDate ? { lastAt: lastAtDate } : {}),
      ...(sr.lastStatus ? { lastStatus: sr.lastStatus } : {}),
      ...(sr.lastError != null ? { lastError: sr.lastError } : {}),
      ...(sr.lastDurationMs != null
        ? { lastDurationMs: sr.lastDurationMs }
        : {}),
      ...(sr.lastRowsAffected != null
        ? { lastRowsAffected: sr.lastRowsAffected }
        : {}),
      ...(sr.lastRowCount != null ? { lastRowCount: sr.lastRowCount } : {}),
      runCount: sr.runCount ?? 0,
      consecutiveFailures: sr.consecutiveFailures ?? 0,
      ...(sr.permanentFailures != null
        ? { permanentFailures: sr.permanentFailures }
        : {}),
      ...(pausedAtDate ? { pausedAt: pausedAtDate } : {}),
      ...(sr.pausedReason != null ? { pausedReason: sr.pausedReason } : {}),
    };
  }

  const lastRun: ConsoleLastRunRecord | undefined = doc.lastRun
    ? {
        at: toDate(doc.lastRun.at),
        status: doc.lastRun.status,
        ...(doc.lastRun.rowCount !== undefined
          ? { rowCount: doc.lastRun.rowCount }
          : {}),
        durationMs: doc.lastRun.durationMs,
        ...(doc.lastRun.error !== undefined
          ? { error: doc.lastRun.error }
          : {}),
        ...(Array.isArray(doc.lastRun.sampleRows) &&
        doc.lastRun.sampleRows.length > 0
          ? { sampleRows: doc.lastRun.sampleRows }
          : {}),
        ...(doc.lastRun.fields !== undefined
          ? { fields: doc.lastRun.fields }
          : {}),
        runBy: doc.lastRun.runBy,
        source: doc.lastRun.source,
        ...(optionalDate(doc.lastRun.startedAt)
          ? { startedAt: optionalDate(doc.lastRun.startedAt) }
          : {}),
        ...(doc.lastRun.executionId !== undefined
          ? { executionId: doc.lastRun.executionId }
          : {}),
      }
    : undefined;

  const sharedWith: ResourceShareEntryRecord[] = Array.isArray(doc.sharedWith)
    ? doc.sharedWith.map(s => ({
        userId: String(s.userId),
        role: s.role === "editor" ? "editor" : "viewer",
        addedAt: toDate(s.addedAt),
        ...(s.addedBy ? { addedBy: String(s.addedBy) } : {}),
      }))
    : [];

  return {
    id,
    _id: id,
    workspaceId: wireId(doc.workspaceId),
    ...(folderId ? { folderId } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(doc.databaseName != null ? { databaseName: doc.databaseName } : {}),
    ...(doc.databaseId != null ? { databaseId: doc.databaseId } : {}),
    name: doc.name,
    ...(doc.description != null ? { description: doc.description } : {}),
    ...(Array.isArray(doc.descriptionEmbedding) &&
    doc.descriptionEmbedding.length > 0
      ? { descriptionEmbedding: [...doc.descriptionEmbedding] }
      : {}),
    ...(doc.embeddingModel != null
      ? { embeddingModel: doc.embeddingModel }
      : {}),
    ...(optionalDate(doc.descriptionGeneratedAt)
      ? { descriptionGeneratedAt: optionalDate(doc.descriptionGeneratedAt) }
      : {}),
    ...(doc.path != null ? { path: doc.path } : {}),
    ...(doc.sourceBlobSha != null ? { sourceBlobSha: doc.sourceBlobSha } : {}),
    ...(doc.descriptionSourceSha != null
      ? { descriptionSourceSha: doc.descriptionSourceSha }
      : {}),
    ...(doc.descriptionSource != null
      ? { descriptionSource: doc.descriptionSource }
      : {}),
    code: doc.code ?? "",
    language: doc.language ?? "sql",
    ...(doc.chartSpec != null ? { chartSpec: doc.chartSpec } : {}),
    ...(doc.resultsViewMode != null
      ? { resultsViewMode: doc.resultsViewMode }
      : {}),
    ...(doc.mongoOptions?.collection ? { mongoOptions: doc.mongoOptions } : {}),
    createdBy: doc.createdBy ?? "",
    ...(doc.owner_id != null && doc.owner_id !== ""
      ? { owner_id: doc.owner_id }
      : {}),
    isPrivate: doc.isPrivate ?? access === "private",
    isSaved: doc.isSaved ?? false,
    access,
    workspaceRole: doc.workspaceRole ?? "viewer",
    sharedWith,
    ...(schedule ? { schedule } : {}),
    ...(scheduledRun ? { scheduledRun } : {}),
    version: doc.version ?? 1,
    draftRevision: doc.draftRevision ?? 1,
    ...(doc.lastDraftOrigin != null
      ? { lastDraftOrigin: doc.lastDraftOrigin }
      : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(optionalDate(doc.lastExecutedAt)
      ? { lastExecutedAt: optionalDate(doc.lastExecutedAt) }
      : {}),
    executionCount: doc.executionCount ?? 0,
    ...(optionalDate(doc.lastExternalUsedAt)
      ? { lastExternalUsedAt: optionalDate(doc.lastExternalUsedAt) }
      : {}),
    externalUseCount: doc.externalUseCount ?? 0,
    ...(doc.lastExternalSource != null
      ? { lastExternalSource: doc.lastExternalSource }
      : {}),
    is_deleted: doc.is_deleted === true,
    ...(optionalDate(doc.deletedAt)
      ? { deletedAt: optionalDate(doc.deletedAt) }
      : {}),
    createdAt: toDate(doc.createdAt),
    updatedAt: toDate(doc.updatedAt),
  };
}

export function pgSavedConsoleToRecord(
  row: Omit<SavedConsoleRow, "searchTsv"> & { searchTsv?: unknown },
): SavedConsoleRecord {
  const id = toWireId(row.id);

  const schedule =
    row.scheduleCron && row.scheduleCron.length > 0
      ? {
          cron: row.scheduleCron,
          timezone: row.scheduleTimezone || "UTC",
        }
      : undefined;

  const hasScheduledRun =
    row.scheduledRunNextAt != null ||
    row.scheduledRunLastAt != null ||
    row.scheduledRunLastStatus != null ||
    row.scheduledRunLastError != null ||
    row.scheduledRunLastDurationMs != null ||
    row.scheduledRunLastRowsAffected != null ||
    row.scheduledRunLastRowCount != null ||
    row.scheduledRunCount > 0 ||
    row.scheduledRunConsecutiveFailures > 0 ||
    row.scheduledRunPermanentFailures != null ||
    row.scheduledRunPausedAt != null ||
    row.scheduledRunPausedReason != null;

  const scheduledRun: ConsoleScheduledRunRecord | undefined = hasScheduledRun
    ? {
        ...(row.scheduledRunNextAt
          ? { nextAt: toDate(row.scheduledRunNextAt) }
          : {}),
        ...(row.scheduledRunLastAt
          ? { lastAt: toDate(row.scheduledRunLastAt) }
          : {}),
        ...(row.scheduledRunLastStatus
          ? { lastStatus: row.scheduledRunLastStatus }
          : {}),
        ...(row.scheduledRunLastError != null
          ? { lastError: row.scheduledRunLastError }
          : {}),
        ...(row.scheduledRunLastDurationMs != null
          ? { lastDurationMs: row.scheduledRunLastDurationMs }
          : {}),
        ...(row.scheduledRunLastRowsAffected != null
          ? { lastRowsAffected: Number(row.scheduledRunLastRowsAffected) }
          : {}),
        ...(row.scheduledRunLastRowCount != null
          ? { lastRowCount: Number(row.scheduledRunLastRowCount) }
          : {}),
        runCount: row.scheduledRunCount,
        consecutiveFailures: row.scheduledRunConsecutiveFailures,
        ...(row.scheduledRunPermanentFailures != null
          ? { permanentFailures: row.scheduledRunPermanentFailures }
          : {}),
        ...(row.scheduledRunPausedAt
          ? { pausedAt: toDate(row.scheduledRunPausedAt) }
          : {}),
        ...(row.scheduledRunPausedReason != null
          ? { pausedReason: row.scheduledRunPausedReason }
          : {}),
      }
    : undefined;

  const lastRun = pgJsonToLastRun(row.lastRun);

  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    ...(row.folderId ? { folderId: toWireId(row.folderId) } : {}),
    ...(row.connectionId ? { connectionId: toWireId(row.connectionId) } : {}),
    ...(row.databaseName != null ? { databaseName: row.databaseName } : {}),
    ...(row.databaseId != null ? { databaseId: row.databaseId } : {}),
    name: row.name,
    ...(row.description != null ? { description: row.description } : {}),
    ...(Array.isArray(row.descriptionEmbedding) &&
    row.descriptionEmbedding.length > 0
      ? { descriptionEmbedding: [...row.descriptionEmbedding] }
      : {}),
    ...(row.embeddingModel != null
      ? { embeddingModel: row.embeddingModel }
      : {}),
    ...(row.descriptionGeneratedAt
      ? { descriptionGeneratedAt: toDate(row.descriptionGeneratedAt) }
      : {}),
    ...(row.path != null ? { path: row.path } : {}),
    ...(row.sourceBlobSha != null ? { sourceBlobSha: row.sourceBlobSha } : {}),
    ...(row.descriptionSourceSha != null
      ? { descriptionSourceSha: row.descriptionSourceSha }
      : {}),
    ...(row.descriptionSource != null
      ? { descriptionSource: row.descriptionSource }
      : {}),
    code: row.code,
    language: row.language,
    ...(row.chartSpec != null ? { chartSpec: row.chartSpec } : {}),
    ...(row.resultsViewMode != null
      ? { resultsViewMode: row.resultsViewMode }
      : {}),
    ...(row.mongoOptions != null ? { mongoOptions: row.mongoOptions } : {}),
    createdBy: row.createdBy ? row.createdBy.toLowerCase() : "",
    ...(row.ownerId ? { owner_id: row.ownerId.toLowerCase() } : {}),
    isPrivate: row.isPrivate,
    isSaved: row.isSaved,
    access: row.access,
    workspaceRole: row.workspaceRole,
    sharedWith: pgJsonToShareEntries(row.sharedWith),
    ...(schedule ? { schedule } : {}),
    ...(scheduledRun ? { scheduledRun } : {}),
    version: row.version,
    draftRevision: row.draftRevision,
    ...(row.lastDraftOrigin != null
      ? { lastDraftOrigin: row.lastDraftOrigin }
      : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(row.lastExecutedAt
      ? { lastExecutedAt: toDate(row.lastExecutedAt) }
      : {}),
    executionCount: row.executionCount,
    ...(row.lastExternalUsedAt
      ? { lastExternalUsedAt: toDate(row.lastExternalUsedAt) }
      : {}),
    externalUseCount: row.externalUseCount,
    ...(row.lastExternalSource != null
      ? { lastExternalSource: row.lastExternalSource }
      : {}),
    is_deleted: row.isDeleted,
    ...(row.deletedAt ? { deletedAt: toDate(row.deletedAt) } : {}),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

// ── 3. EntityVersion mappers ────────────────────────────────────────────────

export interface MongoEntityVersionLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  entityType: string;
  entityId: Types.ObjectId | string;
  version: number;
  snapshot: Record<string, unknown>;
  savedBy?: string | null;
  savedByName: string;
  comment?: string;
  restoredFrom?: number | null;
  createdAt?: Date | string;
}

export function mongoEntityVersionToRecord(
  doc: MongoEntityVersionLike,
): EntityVersionRecord {
  const id = wireId(doc._id);
  return {
    id,
    _id: id,
    workspaceId: wireId(doc.workspaceId),
    entityType: "console",
    entityId: wireId(doc.entityId),
    version: doc.version,
    snapshot: doc.snapshot ?? {},
    savedBy: doc.savedBy ?? "",
    savedByName: doc.savedByName,
    comment: doc.comment ?? "",
    ...(doc.restoredFrom != null ? { restoredFrom: doc.restoredFrom } : {}),
    createdAt: toDate(doc.createdAt),
  };
}

export function pgEntityVersionToRecord(
  row: EntityVersionRow,
): EntityVersionRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    entityType: row.entityType,
    entityId: toWireId(row.entityId),
    version: row.version,
    snapshot: row.snapshot ?? {},
    savedBy: row.savedBy ? row.savedBy.toLowerCase() : "",
    savedByName: row.savedByName,
    comment: row.comment,
    ...(row.restoredFrom != null ? { restoredFrom: row.restoredFrom } : {}),
    createdAt: toDate(row.createdAt),
  };
}

// ── 4. NotebookFolder mappers ───────────────────────────────────────────────

export interface MongoNotebookFolderLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  name: string;
  parentId?: Types.ObjectId | string | null;
  ownerId?: string | null;
  access?: ConsoleAccessLevel;
  createdAt?: Date | string;
}

export function mongoNotebookFolderToRecord(
  doc: MongoNotebookFolderLike,
): NotebookFolderRecord {
  const id = wireId(doc._id);
  return {
    id,
    _id: id,
    workspaceId: wireId(doc.workspaceId),
    name: doc.name,
    ...(optionalWireId(doc.parentId)
      ? { parentId: optionalWireId(doc.parentId) }
      : {}),
    ...(doc.ownerId ? { ownerId: String(doc.ownerId) } : {}),
    access: doc.access ?? "private",
    createdAt: toDate(doc.createdAt),
  };
}

export function pgNotebookFolderToRecord(
  row: NotebookFolderRow,
): NotebookFolderRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    ...(row.parentId ? { parentId: toWireId(row.parentId) } : {}),
    ...(row.ownerId ? { ownerId: row.ownerId.toLowerCase() } : {}),
    access: row.access,
    createdAt: toDate(row.createdAt),
  };
}

// ── 5. NotebookIndex mappers ────────────────────────────────────────────────

export interface MongoNotebookIndexLike {
  _id: Types.ObjectId | string;
  notebookId: string;
  workspaceId: Types.ObjectId | string;
  name: string;
  folderId?: Types.ObjectId | string | null;
  ownerId?: string | null;
  access?: ConsoleAccessLevel;
  path?: string | null;
  checkpointBlobSha?: string | null;
  workspaceRole?: "viewer" | "editor";
  sharedWith?: Array<{
    userId: string;
    role: "viewer" | "editor";
    addedAt: Date | string;
    addedBy?: string;
  }> | null;
  updatedAt?: Date | string;
}

export function mongoNotebookIndexToRecord(
  doc: MongoNotebookIndexLike,
): NotebookIndexRecord {
  const id = wireId(doc._id);
  return {
    id,
    _id: id,
    notebookId: doc.notebookId,
    workspaceId: wireId(doc.workspaceId),
    name: doc.name,
    ...(optionalWireId(doc.folderId)
      ? { folderId: optionalWireId(doc.folderId) }
      : {}),
    ownerId: doc.ownerId ?? "system",
    access: doc.access ?? "private",
    ...(doc.path != null ? { path: doc.path } : {}),
    ...(doc.checkpointBlobSha != null
      ? { checkpointBlobSha: doc.checkpointBlobSha }
      : {}),
    workspaceRole: doc.workspaceRole ?? "viewer",
    sharedWith: Array.isArray(doc.sharedWith)
      ? doc.sharedWith.map(s => ({
          userId: String(s.userId),
          role: s.role === "editor" ? "editor" : "viewer",
          addedAt: toDate(s.addedAt),
          ...(s.addedBy ? { addedBy: String(s.addedBy) } : {}),
        }))
      : [],
    updatedAt: toDate(doc.updatedAt),
  };
}

export function pgNotebookIndexToRecord(
  row: NotebookIndexRow,
): NotebookIndexRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    notebookId: row.notebookId,
    workspaceId: toWireId(row.workspaceId),
    name: row.name,
    ...(row.folderId ? { folderId: toWireId(row.folderId) } : {}),
    ownerId: row.ownerId ? row.ownerId.toLowerCase() : "system",
    access: row.access,
    ...(row.path != null ? { path: row.path } : {}),
    ...(row.checkpointBlobSha != null
      ? { checkpointBlobSha: row.checkpointBlobSha }
      : {}),
    workspaceRole: row.workspaceRole,
    sharedWith: pgJsonToShareEntries(row.sharedWith),
    updatedAt: toDate(row.updatedAt),
  };
}

// ── 6. Favourite mappers ────────────────────────────────────────────────────

export interface MongoFavouriteLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  userId: string;
  parentId?: Types.ObjectId | string | null;
  type: "folder" | "item";
  title?: string | null;
  kind?: string | null;
  refId?: string | null;
  position: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

const VALID_FAVOURITE_KINDS = new Set<string>(["app", "console", "notebook"]);

export function isValidFavouriteKind(
  kind: string | null | undefined,
): kind is FavouriteKind {
  return typeof kind === "string" && VALID_FAVOURITE_KINDS.has(kind);
}

export function mongoFavouriteToRecord(
  doc: MongoFavouriteLike,
): FavouriteRecord {
  const id = wireId(doc._id);
  return {
    id,
    _id: id,
    workspaceId: wireId(doc.workspaceId),
    userId: String(doc.userId),
    parentId: optionalWireId(doc.parentId) ?? null,
    type: doc.type,
    ...(doc.type === "folder" && doc.title != null ? { title: doc.title } : {}),
    ...(doc.type === "item" && isValidFavouriteKind(doc.kind)
      ? { kind: doc.kind }
      : {}),
    ...(doc.type === "item" && doc.refId != null ? { refId: doc.refId } : {}),
    position: doc.position ?? 0,
    createdAt: toDate(doc.createdAt),
    updatedAt: toDate(doc.updatedAt),
  };
}

export function pgFavouriteToRecord(row: FavouriteRow): FavouriteRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    userId: row.userId.toLowerCase(),
    parentId: row.parentId ? toWireId(row.parentId) : null,
    type: row.type,
    ...(row.type === "folder" && row.title != null ? { title: row.title } : {}),
    ...(row.type === "item" && row.kind != null ? { kind: row.kind } : {}),
    ...(row.type === "item" && row.refId != null ? { refId: row.refId } : {}),
    position: row.position,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

// ── 7. ScheduledQueryRun mappers ────────────────────────────────────────────

export interface MongoScheduledQueryRunLike {
  _id: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  consoleId: Types.ObjectId | string;
  triggeredAt: Date | string;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  status: "queued" | "running" | "success" | "error";
  triggerType: "schedule" | "manual";
  triggeredBy?: string | null;
  durationMs?: number | null;
  rowsAffected?: number | null;
  rowCount?: number | null;
  error?: { message?: string; code?: string } | null;
  inngestRunId?: string | null;
}

export function mongoScheduledQueryRunToRecord(
  doc: MongoScheduledQueryRunLike,
): ScheduledQueryRunRecord {
  const id = wireId(doc._id);
  return {
    id,
    _id: id,
    workspaceId: wireId(doc.workspaceId),
    consoleId: wireId(doc.consoleId),
    triggeredAt: toDate(doc.triggeredAt),
    ...(optionalDate(doc.startedAt)
      ? { startedAt: optionalDate(doc.startedAt) }
      : {}),
    ...(optionalDate(doc.completedAt)
      ? { completedAt: optionalDate(doc.completedAt) }
      : {}),
    status: doc.status,
    triggerType: doc.triggerType,
    ...(doc.triggeredBy ? { triggeredBy: String(doc.triggeredBy) } : {}),
    ...(doc.durationMs != null ? { durationMs: doc.durationMs } : {}),
    ...(doc.rowsAffected != null ? { rowsAffected: doc.rowsAffected } : {}),
    ...(doc.rowCount != null ? { rowCount: doc.rowCount } : {}),
    ...(doc.error?.message
      ? {
          error: {
            message: doc.error.message,
            ...(doc.error.code ? { code: doc.error.code } : {}),
          },
        }
      : {}),
    ...(doc.inngestRunId ? { inngestRunId: doc.inngestRunId } : {}),
  };
}

export function pgScheduledQueryRunToRecord(
  row: ScheduledQueryRunRow,
): ScheduledQueryRunRecord {
  const id = toWireId(row.id);
  return {
    id,
    _id: id,
    workspaceId: toWireId(row.workspaceId),
    consoleId: toWireId(row.consoleId),
    triggeredAt: toDate(row.triggeredAt),
    ...(row.startedAt ? { startedAt: toDate(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: toDate(row.completedAt) } : {}),
    status: row.status,
    triggerType: row.triggerType,
    ...(row.triggeredBy ? { triggeredBy: row.triggeredBy.toLowerCase() } : {}),
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    ...(row.rowsAffected != null
      ? { rowsAffected: Number(row.rowsAffected) }
      : {}),
    ...(row.rowCount != null ? { rowCount: Number(row.rowCount) } : {}),
    ...(row.errorMessage != null
      ? {
          error: {
            message: row.errorMessage,
            ...(row.errorCode != null ? { code: row.errorCode } : {}),
          },
        }
      : {}),
    ...(row.inngestRunId != null ? { inngestRunId: row.inngestRunId } : {}),
  };
}

// ── Shadow-compare canonicalizers ───────────────────────────────────────────

/**
 * Search parity compares top-K ID overlap rather than raw score equality because
 * Postgres `ts_rank` / pgvector cosine and Mongo `$meta: "textScore"` / Atlas
 * `$vectorSearch` emit different numerical scales.
 */
export function canonicalizeSearchResultsForCompare(
  results: readonly ConsoleSearchCandidate[],
  topK: number,
): { ids: string[] } {
  return {
    ids: results
      .slice(0, topK)
      .map(r => r.id)
      .sort(),
  };
}

export function sortRecordsById<T extends { id: string }>(
  records: readonly T[],
): T[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

const USER_ID_KEYS = new Set([
  "ownerId",
  "owner_id",
  "createdBy",
  "savedBy",
  "userId",
  "addedBy",
  "triggeredBy",
  "runBy",
]);

/** Collect all candidate user ID strings from any consoles_charts DTO / array / wrapper. */
export function collectUserIdsFromValue(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string" && USER_ID_KEYS.has(k) && v.length > 0) {
        if (!isNonUserSentinel(v)) out.add(v);
      } else if (v && typeof v === "object" && !(v instanceof Date)) {
        visit(v);
      }
    }
  };
  visit(value);
  return [...out];
}

/**
 * Synchronously canonicalize user-ID fields across any consoles_charts DTO / array
 * for Stage 3 / Stage 4 shadow-compare (normalizing legacy Lucia/v4 IDs to PG UUIDv7
 * and non-user sentinels like "system"/"git" to match PG's nullable user FK representation).
 */
export function normalizeUserIdsForShadowCompare<T>(
  value: T,
  userUuidMap: ReadonlyMap<string, string>,
): T {
  const mapUser = (raw: string): string | null => {
    if (isNonUserSentinel(raw)) return null;
    const mapped = userUuidMap.get(raw) ?? userUuidMap.get(raw.toLowerCase());
    if (mapped) return mapped.toLowerCase();
    return isUuidString(raw) ? raw.toLowerCase() : null;
  };

  const transform = (node: unknown): unknown => {
    if (!node || typeof node !== "object" || node instanceof Date) return node;
    if (Array.isArray(node)) return node.map(transform);
    const obj = node as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && USER_ID_KEYS.has(k)) {
        const normalized = mapUser(v);
        if (k === "createdBy" || k === "savedBy") {
          copy[k] = normalized ?? "";
        } else if (k === "runBy") {
          copy[k] = normalized ?? v;
        } else if (k === "userId") {
          copy[k] = normalized ?? v.toLowerCase();
        } else if (normalized !== null) {
          copy[k] = normalized;
        }
      } else if (v && typeof v === "object" && !(v instanceof Date)) {
        copy[k] = transform(v);
      } else {
        copy[k] = v;
      }
    }
    return copy;
  };

  return transform(value) as T;
}
