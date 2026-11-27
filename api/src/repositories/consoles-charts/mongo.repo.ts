/**
 * MongoDB implementation of `ConsolesChartsRepository` (Stages 1–3 primary, Stage 4 secondary).
 */
import { Types } from "mongoose";
import { parseEntityId } from "../../database/pg/id-codec";
import {
  ConsoleFolder,
  EntityVersion,
  Favourite,
  NotebookFolder,
  NotebookIndex,
  SavedConsole,
  ScheduledQueryRun,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import {
  collectDescendantFolderIds,
  wouldCreateFolderCycle,
} from "../../utils/folder-tree";
import {
  isValidFavouriteKind,
  mongoConsoleFolderToRecord,
  mongoEntityVersionToRecord,
  mongoFavouriteToRecord,
  mongoNotebookFolderToRecord,
  mongoNotebookIndexToRecord,
  mongoSavedConsoleToRecord,
  mongoScheduledQueryRunToRecord,
  optionalWireId,
  wireId,
  type MongoConsoleFolderLike,
  type MongoEntityVersionLike,
  type MongoFavouriteLike,
  type MongoNotebookFolderLike,
  type MongoNotebookIndexLike,
  type MongoSavedConsoleLike,
  type MongoScheduledQueryRunLike,
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

function toObjectId(id: string): Types.ObjectId {
  const parsed = parseEntityId(id);
  return new Types.ObjectId(parsed?.oid ?? id);
}

function isValidOid(id: string | null | undefined): id is string {
  if (typeof id !== "string") return false;
  return parseEntityId(id)?.oid != null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMongoDupKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 11000
  );
}

function buildConsoleUpdateOps(patch: UpdateConsolePatch): {
  $set: Record<string, unknown>;
  $unset: Record<string, unknown>;
  $inc: Record<string, number>;
} {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, unknown> = {};
  const $inc: Record<string, number> = {};

  if (patch.folderId !== undefined) {
    if (patch.folderId) $set.folderId = toObjectId(patch.folderId);
    else $unset.folderId = "";
  }
  if (patch.connectionId !== undefined) {
    if (patch.connectionId) $set.connectionId = toObjectId(patch.connectionId);
    else $unset.connectionId = "";
  }
  if (patch.databaseName !== undefined) {
    if (patch.databaseName === null) $unset.databaseName = "";
    else $set.databaseName = patch.databaseName;
  }
  if (patch.databaseId !== undefined) {
    if (patch.databaseId === null) $unset.databaseId = "";
    else $set.databaseId = patch.databaseId;
  }
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description === null) $unset.description = "";
    else $set.description = patch.description;
  }
  if (patch.descriptionEmbedding !== undefined) {
    if (patch.descriptionEmbedding === null) $unset.descriptionEmbedding = "";
    else $set.descriptionEmbedding = patch.descriptionEmbedding;
  }
  if (patch.embeddingModel !== undefined) {
    if (patch.embeddingModel === null) $unset.embeddingModel = "";
    else $set.embeddingModel = patch.embeddingModel;
  }
  if (patch.descriptionGeneratedAt !== undefined) {
    if (patch.descriptionGeneratedAt === null) {
      $unset.descriptionGeneratedAt = "";
    } else $set.descriptionGeneratedAt = patch.descriptionGeneratedAt;
  }
  if (patch.path !== undefined) {
    if (patch.path === null) $unset.path = "";
    else $set.path = patch.path;
  }
  if (patch.sourceBlobSha !== undefined) {
    if (patch.sourceBlobSha === null) $unset.sourceBlobSha = "";
    else $set.sourceBlobSha = patch.sourceBlobSha;
  }
  if (patch.descriptionSourceSha !== undefined) {
    if (patch.descriptionSourceSha === null) $unset.descriptionSourceSha = "";
    else $set.descriptionSourceSha = patch.descriptionSourceSha;
  }
  if (patch.descriptionSource !== undefined) {
    if (patch.descriptionSource === null) $unset.descriptionSource = "";
    else $set.descriptionSource = patch.descriptionSource;
  }
  if (patch.code !== undefined) $set.code = patch.code;
  if (patch.language !== undefined) $set.language = patch.language;
  if (patch.chartSpec !== undefined) {
    if (patch.chartSpec === null) $unset.chartSpec = "";
    else $set.chartSpec = patch.chartSpec;
  }
  if (patch.resultsViewMode !== undefined) {
    if (patch.resultsViewMode === null) $unset.resultsViewMode = "";
    else $set.resultsViewMode = patch.resultsViewMode;
  }
  if (patch.mongoOptions !== undefined) {
    if (patch.mongoOptions === null) $unset.mongoOptions = "";
    else $set.mongoOptions = patch.mongoOptions;
  }
  if (patch.owner_id !== undefined) {
    if (patch.owner_id === null) $unset.owner_id = "";
    else $set.owner_id = patch.owner_id;
  }
  if (patch.isPrivate !== undefined) $set.isPrivate = patch.isPrivate;
  if (patch.isSaved !== undefined) $set.isSaved = patch.isSaved;
  if (patch.access !== undefined) $set.access = patch.access;
  if (patch.workspaceRole !== undefined) {
    $set.workspaceRole = patch.workspaceRole;
  }
  if (patch.sharedWith !== undefined) $set.sharedWith = patch.sharedWith;
  if (patch.schedule !== undefined) {
    if (patch.schedule === null) $unset.schedule = 1;
    else $set.schedule = patch.schedule;
  }
  if (patch.scheduledRun !== undefined) {
    if (patch.scheduledRun === null) $unset.scheduledRun = 1;
    else $set.scheduledRun = patch.scheduledRun;
  }
  if (patch.clearScheduledRunNextAt) {
    $unset["scheduledRun.nextAt"] = 1;
  }
  if (patch.version !== undefined) $set.version = patch.version;
  if (patch.draftRevision !== undefined) {
    $set.draftRevision = patch.draftRevision;
  }
  if (patch.incVersion) $inc.version = patch.incVersion;
  if (patch.incDraftRevision) $inc.draftRevision = patch.incDraftRevision;
  if (patch.lastDraftOrigin !== undefined) {
    if (patch.lastDraftOrigin === null) $unset.lastDraftOrigin = "";
    else $set.lastDraftOrigin = patch.lastDraftOrigin;
  }
  if (patch.lastRun !== undefined) {
    if (patch.lastRun === null) $unset.lastRun = "";
    else $set.lastRun = patch.lastRun;
  }
  if (patch.lastExecutedAt !== undefined) {
    if (patch.lastExecutedAt === null) $unset.lastExecutedAt = "";
    else $set.lastExecutedAt = patch.lastExecutedAt;
  }
  if (patch.executionCount !== undefined) {
    $set.executionCount = patch.executionCount;
  }
  if (patch.incExecutionCount) $inc.executionCount = patch.incExecutionCount;
  if (patch.lastExternalUsedAt !== undefined) {
    if (patch.lastExternalUsedAt === null) $unset.lastExternalUsedAt = "";
    else $set.lastExternalUsedAt = patch.lastExternalUsedAt;
  }
  if (patch.externalUseCount !== undefined) {
    $set.externalUseCount = patch.externalUseCount;
  }
  if (patch.incExternalUseCount) {
    $inc.externalUseCount = patch.incExternalUseCount;
  }
  if (patch.lastExternalSource !== undefined) {
    if (patch.lastExternalSource === null) $unset.lastExternalSource = "";
    else $set.lastExternalSource = patch.lastExternalSource;
  }
  if (patch.is_deleted !== undefined) $set.is_deleted = patch.is_deleted;
  if (patch.deletedAt !== undefined) {
    if (patch.deletedAt === null) $unset.deletedAt = "";
    else $set.deletedAt = patch.deletedAt;
  }
  if (patch.updatedAt !== undefined) $set.updatedAt = patch.updatedAt;

  return { $set, $unset, $inc };
}

function consoleCreateInputToMongoDoc(
  input: CreateConsoleInput,
): Record<string, unknown> {
  const access = input.access ?? (input.isPrivate ? "private" : "private");
  const doc: Record<string, unknown> = {
    ...(input.id && isValidOid(input.id) ? { _id: toObjectId(input.id) } : {}),
    workspaceId: toObjectId(input.workspaceId),
    ...(input.folderId ? { folderId: toObjectId(input.folderId) } : {}),
    ...(input.connectionId
      ? { connectionId: toObjectId(input.connectionId) }
      : {}),
    ...(input.databaseName != null ? { databaseName: input.databaseName } : {}),
    ...(input.databaseId != null ? { databaseId: input.databaseId } : {}),
    name: input.name,
    ...(input.description != null ? { description: input.description } : {}),
    ...(input.descriptionEmbedding && input.descriptionEmbedding.length > 0
      ? { descriptionEmbedding: input.descriptionEmbedding }
      : {}),
    ...(input.embeddingModel != null
      ? { embeddingModel: input.embeddingModel }
      : {}),
    ...(input.descriptionGeneratedAt != null
      ? { descriptionGeneratedAt: input.descriptionGeneratedAt }
      : {}),
    ...(input.path != null ? { path: input.path } : {}),
    ...(input.sourceBlobSha != null
      ? { sourceBlobSha: input.sourceBlobSha }
      : {}),
    ...(input.descriptionSourceSha != null
      ? { descriptionSourceSha: input.descriptionSourceSha }
      : {}),
    ...(input.descriptionSource != null
      ? { descriptionSource: input.descriptionSource }
      : {}),
    code: input.code,
    language: input.language,
    ...(input.chartSpec != null ? { chartSpec: input.chartSpec } : {}),
    ...(input.resultsViewMode != null
      ? { resultsViewMode: input.resultsViewMode }
      : {}),
    ...(input.mongoOptions != null ? { mongoOptions: input.mongoOptions } : {}),
    createdBy: input.createdBy || "system",
    ...(input.owner_id ? { owner_id: input.owner_id } : {}),
    isPrivate: input.isPrivate ?? access === "private",
    isSaved: input.isSaved ?? false,
    access,
    workspaceRole: input.workspaceRole ?? "viewer",
    sharedWith: input.sharedWith ?? [],
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.scheduledRun ? { scheduledRun: input.scheduledRun } : {}),
    version: input.version ?? 1,
    draftRevision: input.draftRevision ?? 1,
    ...(input.lastDraftOrigin != null
      ? { lastDraftOrigin: input.lastDraftOrigin }
      : {}),
    ...(input.lastRun != null ? { lastRun: input.lastRun } : {}),
    ...(input.lastExecutedAt != null
      ? { lastExecutedAt: input.lastExecutedAt }
      : {}),
    executionCount: input.executionCount ?? 0,
    ...(input.lastExternalUsedAt != null
      ? { lastExternalUsedAt: input.lastExternalUsedAt }
      : {}),
    externalUseCount: input.externalUseCount ?? 0,
    ...(input.lastExternalSource != null
      ? { lastExternalSource: input.lastExternalSource }
      : {}),
    is_deleted: input.is_deleted ?? false,
    ...(input.deletedAt != null ? { deletedAt: input.deletedAt } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
  return doc;
}

const CLEARABLE_CONSOLE_MONGO_FIELDS = [
  "folderId",
  "connectionId",
  "databaseName",
  "databaseId",
  "description",
  "descriptionEmbedding",
  "embeddingModel",
  "descriptionGeneratedAt",
  "path",
  "sourceBlobSha",
  "descriptionSourceSha",
  "descriptionSource",
  "chartSpec",
  "resultsViewMode",
  "mongoOptions",
  "owner_id",
  "schedule",
  "scheduledRun",
  "lastDraftOrigin",
  "lastRun",
  "lastExecutedAt",
  "lastExternalUsedAt",
  "lastExternalSource",
  "deletedAt",
] as const;

export class MongoConsolesChartsRepository implements ConsolesChartsRepository {
  // ── 1. Console folders ────────────────────────────────────────────────

  async listConsoleFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<ConsoleFolderRecord[]> {
    if (!isValidOid(workspaceId)) return [];
    const query = ConsoleFolder.find({ workspaceId: toObjectId(workspaceId) });
    if (opts?.sortByName) query.sort({ name: 1 });
    const docs = await query.lean<MongoConsoleFolderLike[]>();
    return docs.map(mongoConsoleFolderToRecord);
  }

  async findConsoleFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<ConsoleFolderRecord | null> {
    if (!isValidOid(folderId) || !isValidOid(workspaceId)) return null;
    const doc = await ConsoleFolder.findOne({
      _id: toObjectId(folderId),
      workspaceId: toObjectId(workspaceId),
    }).lean<MongoConsoleFolderLike | null>();
    return doc ? mongoConsoleFolderToRecord(doc) : null;
  }

  async findConsoleFoldersByIds(
    workspaceId: string,
    folderIds: readonly string[],
  ): Promise<ConsoleFolderRecord[]> {
    const valid = folderIds.filter(isValidOid).map(toObjectId);
    if (valid.length === 0 || !isValidOid(workspaceId)) return [];
    const docs = await ConsoleFolder.find({
      _id: { $in: valid },
      workspaceId: toObjectId(workspaceId),
    }).lean<MongoConsoleFolderLike[]>();
    return docs.map(mongoConsoleFolderToRecord);
  }

  async findConsoleFolderByNameAndParent(
    workspaceId: string,
    name: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    if (parentId !== null && !isValidOid(parentId)) return null;
    const parentFilter = parentId
      ? { parentId: toObjectId(parentId) }
      : { $or: [{ parentId: null }, { parentId: { $exists: false } }] };
    const doc = await ConsoleFolder.findOne({
      workspaceId: toObjectId(workspaceId),
      name,
      ...parentFilter,
    }).lean<MongoConsoleFolderLike | null>();
    return doc ? mongoConsoleFolderToRecord(doc) : null;
  }

  async listChildConsoleFolders(
    workspaceId: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord[]> {
    if (!isValidOid(workspaceId)) return [];
    if (parentId !== null && !isValidOid(parentId)) return [];
    const parentFilter = parentId
      ? { parentId: toObjectId(parentId) }
      : { $or: [{ parentId: null }, { parentId: { $exists: false } }] };
    const docs = await ConsoleFolder.find({
      workspaceId: toObjectId(workspaceId),
      ...parentFilter,
    }).lean<MongoConsoleFolderLike[]>();
    return docs.map(mongoConsoleFolderToRecord);
  }

  async createConsoleFolder(
    input: CreateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord> {
    const access = input.access ?? "private";
    const doc = await ConsoleFolder.create({
      ...(input.id && isValidOid(input.id)
        ? { _id: toObjectId(input.id) }
        : {}),
      workspaceId: toObjectId(input.workspaceId),
      name: input.name,
      ...(input.parentId ? { parentId: toObjectId(input.parentId) } : {}),
      isPrivate: input.isPrivate ?? access === "private",
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      access,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return mongoConsoleFolderToRecord(doc.toObject() as MongoConsoleFolderLike);
  }

  async upsertConsoleFolder(record: ConsoleFolderRecord): Promise<void> {
    const $set: Record<string, unknown> = {
      workspaceId: toObjectId(record.workspaceId),
      name: record.name,
      isPrivate: record.isPrivate,
      access: record.access,
      createdAt: record.createdAt,
    };
    const $unset: Record<string, unknown> = {};
    if (record.parentId) $set.parentId = toObjectId(record.parentId);
    else $unset.parentId = "";
    if (record.ownerId) $set.ownerId = record.ownerId;
    else $unset.ownerId = "";
    await ConsoleFolder.updateOne(
      { _id: toObjectId(record.id) },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { upsert: true },
    );
  }

  async updateConsoleFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord | null> {
    if (!isValidOid(folderId) || !isValidOid(workspaceId)) return null;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.parentId !== undefined) {
      if (patch.parentId) $set.parentId = toObjectId(patch.parentId);
      else $unset.parentId = "";
    }
    if (patch.isPrivate !== undefined) $set.isPrivate = patch.isPrivate;
    if (patch.access !== undefined) $set.access = patch.access;
    if (patch.ownerId !== undefined) {
      if (patch.ownerId) $set.ownerId = patch.ownerId;
      else $unset.ownerId = "";
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length === 0) {
      return this.findConsoleFolderById(workspaceId, folderId);
    }
    const doc = await ConsoleFolder.findOneAndUpdate(
      { _id: toObjectId(folderId), workspaceId: toObjectId(workspaceId) },
      update,
      { returnDocument: "after" },
    ).lean<MongoConsoleFolderLike | null>();
    return doc ? mongoConsoleFolderToRecord(doc) : null;
  }

  async deleteConsoleFolderReturningIds(
    workspaceId: string,
    folderId: string,
  ): Promise<string[]> {
    if (!isValidOid(folderId) || !isValidOid(workspaceId)) return [];
    const wsId = toObjectId(workspaceId);
    const rootId = toObjectId(folderId);
    const root = await ConsoleFolder.findOne({
      _id: rootId,
      workspaceId: wsId,
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();
    if (!root) return [];
    const allFolderIds = [
      rootId,
      ...(await collectDescendantFolderIds(ConsoleFolder, wsId, rootId)),
    ];
    // Match Postgres `saved_consoles.folder_id ON DELETE SET NULL` without bumping `updatedAt`.
    await SavedConsole.updateMany(
      { workspaceId: wsId, folderId: { $in: allFolderIds } },
      { $unset: { folderId: "" } },
      { timestamps: false },
    );
    const res = await ConsoleFolder.deleteMany({
      workspaceId: wsId,
      _id: { $in: allFolderIds },
    });
    return res.deletedCount > 0 ? allFolderIds.map(id => id.toString()) : [];
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
    if (
      !isValidOid(workspaceId) ||
      !isValidOid(folderId) ||
      !isValidOid(targetParentId)
    ) {
      return false;
    }
    return wouldCreateFolderCycle(
      ConsoleFolder,
      wireId(folderId),
      wireId(targetParentId),
      wireId(workspaceId),
    );
  }

  // ── 2. Saved consoles ─────────────────────────────────────────────────

  async findConsoleById(
    workspaceId: string,
    consoleId: string,
    opts?: { includeEmbedding?: boolean; excludeDeleted?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return null;
    const filter: Record<string, unknown> = {
      _id: toObjectId(consoleId),
      workspaceId: toObjectId(workspaceId),
    };
    if (opts?.excludeDeleted) {
      filter.$or = [
        { is_deleted: { $ne: true } },
        { is_deleted: { $exists: false } },
      ];
    }
    const q = SavedConsole.findOne(filter);
    if (opts?.includeEmbedding) q.select("+descriptionEmbedding");
    const doc = await q.lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
  }

  async findConsoleByIdGlobal(
    consoleId: string,
    opts?: { includeEmbedding?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(consoleId)) return null;
    const q = SavedConsole.findById(toObjectId(consoleId));
    if (opts?.includeEmbedding) q.select("+descriptionEmbedding");
    const doc = await q.lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
  }

  async findConsolesByIds(
    workspaceId: string,
    consoleIds: readonly string[],
  ): Promise<SavedConsoleRecord[]> {
    const valid = consoleIds.filter(isValidOid).map(toObjectId);
    if (valid.length === 0 || !isValidOid(workspaceId)) return [];
    const docs = await SavedConsole.find({
      _id: { $in: valid },
      workspaceId: toObjectId(workspaceId),
    }).lean<MongoSavedConsoleLike[]>();
    return docs.map(mongoSavedConsoleToRecord);
  }

  async findConsoleByPath(
    workspaceId: string,
    path: string,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      path,
    };
    if (opts?.isSavedOnly) filter.isSaved = true;
    const doc = await SavedConsole.findOne(filter)
      .sort({ updatedAt: -1 })
      .lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
  }

  async findConsoleByNameAndFolder(
    workspaceId: string,
    name: string,
    folderId: string | null,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    if (folderId !== null && !isValidOid(folderId)) return null;
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      name,
    };
    if (opts?.isSavedOnly) filter.isSaved = true;
    if (folderId) {
      filter.folderId = toObjectId(folderId);
    } else {
      filter.$or = [{ folderId: null }, { folderId: { $exists: false } }];
    }
    const doc = await SavedConsole.findOne(filter)
      .sort({ updatedAt: -1 })
      .lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
  }

  async listConsolesByWorkspace(
    workspaceId: string,
    filter?: ListConsolesFilter,
  ): Promise<SavedConsoleRecord[]> {
    if (!isValidOid(workspaceId)) return [];
    const mongoFilter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
    };
    if (filter?.draftsOnly) {
      mongoFilter.isSaved = { $ne: true };
    } else if (filter?.isSaved !== undefined) {
      mongoFilter.isSaved = filter.isSaved;
    }
    if (filter?.excludeDeleted) {
      mongoFilter.$or = [
        { is_deleted: { $ne: true } },
        { is_deleted: { $exists: false } },
      ];
    }
    if (filter?.hasPath) {
      mongoFilter.path = { $exists: true, $ne: null };
    }
    if (filter?.hasSchedule) {
      mongoFilter["schedule.cron"] = { $exists: true, $ne: "" };
    }
    if (filter?.folderId !== undefined) {
      if (filter.folderId === null) {
        mongoFilter.folderId = null;
      } else {
        if (!isValidOid(filter.folderId)) return [];
        mongoFilter.folderId = toObjectId(filter.folderId);
      }
    }

    const q = SavedConsole.find(mongoFilter);
    if (filter?.includeEmbedding) q.select("+descriptionEmbedding");
    if (filter?.sortBy === "updatedAtDesc") q.sort({ updatedAt: -1 });
    else if (filter?.sortBy === "createdAtAsc") q.sort({ createdAt: 1 });
    else if (filter?.sortBy === "nameAsc") q.sort({ name: 1 });

    const docs = await q.lean<MongoSavedConsoleLike[]>();
    return docs.map(mongoSavedConsoleToRecord);
  }

  async listConsolesNeedingDescription(opts?: {
    workspaceId?: string;
    currentEmbeddingModel?: string | null;
  }): Promise<Array<{ id: string; workspaceId: string }>> {
    const filter: Record<string, unknown> = {
      isSaved: true,
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
      $and: [
        {
          $or: [
            { $expr: { $ne: ["$descriptionSourceSha", "$sourceBlobSha"] } },
            ...(opts?.currentEmbeddingModel
              ? [
                  {
                    embeddingModel: {
                      $exists: true,
                      $ne: opts.currentEmbeddingModel,
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    };
    if (opts?.workspaceId !== undefined) {
      if (!isValidOid(opts.workspaceId)) return [];
      filter.workspaceId = toObjectId(opts.workspaceId);
    }
    const rows = await SavedConsole.find(filter)
      .select("_id workspaceId")
      .lean<Array<{ _id: Types.ObjectId; workspaceId: Types.ObjectId }>>();
    return rows.map(r => ({
      id: r._id.toString(),
      workspaceId: r.workspaceId.toString(),
    }));
  }

  async createConsole(input: CreateConsoleInput): Promise<SavedConsoleRecord> {
    const doc = await SavedConsole.create(consoleCreateInputToMongoDoc(input));
    const obj = doc.toObject() as MongoSavedConsoleLike;
    if (input.descriptionEmbedding && input.descriptionEmbedding.length > 0) {
      obj.descriptionEmbedding = [...input.descriptionEmbedding];
    }
    return mongoSavedConsoleToRecord(obj);
  }

  async upsertConsole(record: SavedConsoleRecord): Promise<void> {
    const doc = consoleCreateInputToMongoDoc({
      ...record,
      id: record.id,
      createdBy: record.createdBy || "system",
    });
    delete doc._id;
    const $unset: Record<string, unknown> = {};
    for (const field of CLEARABLE_CONSOLE_MONGO_FIELDS) {
      if (!(field in doc)) {
        $unset[field] = "";
      }
    }
    const update: Record<string, unknown> = { $set: doc };
    if (Object.keys($unset).length > 0) {
      update.$unset = $unset;
    }
    await SavedConsole.updateOne({ _id: toObjectId(record.id) }, update, {
      upsert: true,
      timestamps: false,
    });
  }

  async updateConsole(
    workspaceId: string,
    consoleId: string,
    patch: UpdateConsolePatch,
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return null;
    const { $set, $unset, $inc } = buildConsoleUpdateOps(patch);
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys($inc).length) update.$inc = $inc;
    if (Object.keys(update).length === 0) {
      return this.findConsoleById(workspaceId, consoleId);
    }
    const doc = await SavedConsole.findOneAndUpdate(
      { _id: toObjectId(consoleId), workspaceId: toObjectId(workspaceId) },
      update,
      {
        returnDocument: "after",
        ...(patch.updatedAt !== undefined ? { timestamps: false } : {}),
      },
    ).lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
  }

  async updateConsolesInFolder(
    workspaceId: string,
    folderId: string,
    patch: Pick<UpdateConsolePatch, "access" | "isPrivate">,
    updatedAt: Date = new Date(),
  ): Promise<number> {
    if (!isValidOid(workspaceId) || !isValidOid(folderId)) return 0;
    const $set: Record<string, unknown> = { updatedAt };
    if (patch.access !== undefined) $set.access = patch.access;
    if (patch.isPrivate !== undefined) $set.isPrivate = patch.isPrivate;
    const result = await SavedConsole.updateMany(
      { workspaceId: toObjectId(workspaceId), folderId: toObjectId(folderId) },
      { $set },
      { timestamps: false },
    );
    return result.modifiedCount;
  }

  async guardedSaveConsole(
    input: GuardedSaveConsoleInput,
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(input.consoleId) || !isValidOid(input.workspaceId)) {
      return null;
    }
    const filter: Record<string, unknown> = {
      _id: toObjectId(input.consoleId),
      workspaceId: toObjectId(input.workspaceId),
    };
    if (input.expectedVersion !== undefined) {
      filter.version =
        input.expectedVersion === 1
          ? { $in: [1, null] }
          : input.expectedVersion;
    }
    if (input.expectedDraftRevision !== undefined) {
      filter.draftRevision =
        input.expectedDraftRevision === 1
          ? { $in: [1, null] }
          : input.expectedDraftRevision;
    }

    const { $set, $unset, $inc } = buildConsoleUpdateOps(input.set);
    if (input.incVersion) $inc.version = ($inc.version ?? 0) + input.incVersion;
    if (input.incDraftRevision) {
      $inc.draftRevision = ($inc.draftRevision ?? 0) + input.incDraftRevision;
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys($inc).length) update.$inc = $inc;

    if (input.upsert && input.setOnInsert) {
      const insertDoc = consoleCreateInputToMongoDoc({
        workspaceId: input.workspaceId,
        name: input.setOnInsert.name ?? "Untitled",
        code: input.setOnInsert.code ?? "",
        language: input.setOnInsert.language ?? "sql",
        ...input.setOnInsert,
      });
      delete insertDoc._id;
      delete insertDoc.workspaceId;
      for (const k of [
        ...Object.keys($set),
        ...Object.keys($unset),
        ...Object.keys($inc),
      ]) {
        delete insertDoc[k];
      }
      if (Object.keys(insertDoc).length) {
        update.$setOnInsert = insertDoc;
      }
    }

    const doc = await SavedConsole.findOneAndUpdate(filter, update, {
      upsert: input.upsert,
      returnDocument: "after",
      ...(input.set.updatedAt !== undefined ? { timestamps: false } : {}),
    }).lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
  }

  async bumpConsoleDraftRevision(
    workspaceId: string,
    consoleId: string,
    updatedAt: Date = new Date(),
  ): Promise<SavedConsoleRecord | null> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return null;
    const doc = await SavedConsole.findOneAndUpdate(
      { _id: toObjectId(consoleId), workspaceId: toObjectId(workspaceId) },
      { $inc: { draftRevision: 1 }, $set: { updatedAt } },
      { returnDocument: "after", timestamps: false },
    ).lean<MongoSavedConsoleLike | null>();
    return doc ? mongoSavedConsoleToRecord(doc) : null;
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
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return false;
    const $set: Record<string, unknown> = {
      lastExecutedAt: input.lastExecutedAt,
      updatedAt: input.updatedAt ?? input.lastExecutedAt,
    };
    if (input.lastRun !== undefined) $set.lastRun = input.lastRun;
    const $inc: Record<string, number> = { executionCount: 1 };
    if (input.bumpDraftRevision) $inc.draftRevision = 1;
    const res = await SavedConsole.updateOne(
      { _id: toObjectId(consoleId), workspaceId: toObjectId(workspaceId) },
      { $set, $inc },
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async recordConsoleExternalUse(
    workspaceId: string,
    consoleId: string,
    source: ExternalSource,
    mode: "execute" | "access",
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return false;
    const filter: Record<string, unknown> = {
      _id: toObjectId(consoleId),
      workspaceId: toObjectId(workspaceId),
    };
    if (mode === "access") {
      filter.$or = [
        { lastExternalUsedAt: { $exists: false } },
        { lastExternalUsedAt: null },
        { lastExternalUsedAt: { $lte: new Date(now.getTime() - 60_000) } },
      ];
      const res = await SavedConsole.updateOne(
        filter,
        {
          $set: {
            lastExternalUsedAt: now,
            lastExternalSource: source,
            updatedAt: now,
          },
        },
        { timestamps: false },
      );
      return res.modifiedCount > 0;
    }
    const res = await SavedConsole.updateOne(
      filter,
      {
        $set: {
          lastExternalUsedAt: now,
          lastExternalSource: source,
          updatedAt: now,
        },
        $inc: { externalUseCount: 1 },
      },
      { timestamps: false },
    );
    return res.modifiedCount > 0;
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
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return false;
    const filter: Record<string, unknown> = {
      _id: toObjectId(consoleId),
      workspaceId: toObjectId(workspaceId),
    };
    if (expectedSourceBlobSha) filter.sourceBlobSha = expectedSourceBlobSha;
    else filter.sourceBlobSha = { $in: [null, undefined] };
    const { $set, $unset } = buildConsoleUpdateOps(patch);
    $set.updatedAt = updatedAt;
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    const res = await SavedConsole.updateOne(filter, update, {
      timestamps: false,
    });
    return res.matchedCount > 0;
  }

  async softDeleteConsole(
    workspaceId: string,
    consoleId: string,
    deletedAt: Date = new Date(),
    opts?: { onlyIfNotDeleted?: boolean },
  ): Promise<boolean> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return false;
    const filter: Record<string, unknown> = {
      _id: toObjectId(consoleId),
      workspaceId: toObjectId(workspaceId),
    };
    if (opts?.onlyIfNotDeleted) {
      filter.is_deleted = { $ne: true };
    }
    const res = await SavedConsole.updateOne(
      filter,
      {
        $set: { is_deleted: true, deletedAt, updatedAt: deletedAt },
      },
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async restoreConsole(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return false;
    const $set: Record<string, unknown> = { is_deleted: false, updatedAt };
    if (patch?.path !== undefined) $set.path = patch.path;
    if (patch?.sourceBlobSha !== undefined) {
      $set.sourceBlobSha = patch.sourceBlobSha;
    }
    const res = await SavedConsole.updateOne(
      { _id: toObjectId(consoleId), workspaceId: toObjectId(workspaceId) },
      { $set, $unset: { deletedAt: "" } },
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async deleteConsolesInFolderReturningIds(
    workspaceId: string,
    folderId: string,
  ): Promise<string[]> {
    if (!isValidOid(workspaceId) || !isValidOid(folderId)) return [];
    const wsOid = toObjectId(workspaceId);
    const fOid = toObjectId(folderId);
    const docs = await SavedConsole.find({
      workspaceId: wsOid,
      folderId: fOid,
    })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>();
    if (docs.length === 0) return [];
    const oids = docs.map(d => d._id);
    await SavedConsole.deleteMany({
      workspaceId: wsOid,
      _id: { $in: oids },
    });
    return oids.map(id => id.toString());
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
    if (!isValidOid(input.consoleId) || !isValidOid(input.workspaceId)) {
      return false;
    }
    const $set: Record<string, unknown> = {
      "scheduledRun.lastAt": input.lastAt,
      "scheduledRun.lastStatus": input.isError ? "error" : "success",
      "scheduledRun.permanentFailures": input.permanentFailures,
      updatedAt: input.updatedAt ?? input.lastAt,
    };
    if (input.lastDurationMs !== undefined) {
      $set["scheduledRun.lastDurationMs"] = input.lastDurationMs;
    }
    if (input.lastRowCount !== undefined) {
      $set["scheduledRun.lastRowCount"] = input.lastRowCount;
    }
    if (input.lastRowsAffected !== undefined) {
      $set["scheduledRun.lastRowsAffected"] = input.lastRowsAffected;
    }
    if (input.nextAt !== undefined && !input.clearNextAt) {
      $set["scheduledRun.nextAt"] = input.nextAt;
    }
    const $unset: Record<string, unknown> = {};
    if (input.clearNextAt) {
      $unset["scheduledRun.nextAt"] = 1;
    }
    if (!input.isError) {
      $set["scheduledRun.consecutiveFailures"] = 0;
      $unset["scheduledRun.lastError"] = 1;
    } else if (input.lastError !== undefined) {
      $set["scheduledRun.lastError"] = input.lastError;
    }
    if (input.pausedAt !== undefined && input.pausedAt !== null) {
      $set["scheduledRun.pausedAt"] = input.pausedAt;
    }
    if (input.pausedReason !== undefined && input.pausedReason !== null) {
      $set["scheduledRun.pausedReason"] = input.pausedReason;
    }

    const $inc: Record<string, number> = {
      "scheduledRun.runCount": 1,
      ...(input.isError ? { "scheduledRun.consecutiveFailures": 1 } : {}),
    };
    const res = await SavedConsole.updateOne(
      {
        _id: toObjectId(input.consoleId),
        workspaceId: toObjectId(input.workspaceId),
      },
      {
        $set,
        $inc,
        ...(Object.keys($unset).length ? { $unset } : {}),
      },
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async clearConsoleSchedule(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    if (!isValidOid(consoleId) || !isValidOid(workspaceId)) return false;
    const $set: Record<string, unknown> = { updatedAt };
    if (patch?.path !== undefined) $set.path = patch.path;
    if (patch?.sourceBlobSha !== undefined) {
      $set.sourceBlobSha = patch.sourceBlobSha;
    }
    const res = await SavedConsole.updateOne(
      { _id: toObjectId(consoleId), workspaceId: toObjectId(workspaceId) },
      {
        $set,
        $unset: { schedule: 1, "scheduledRun.nextAt": 1 },
      },
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async findDueScheduledConsoles(now: Date): Promise<DueScheduledConsole[]> {
    const docs = await SavedConsole.find({
      "schedule.cron": { $exists: true, $ne: "" },
      "scheduledRun.nextAt": { $lte: now },
      isSaved: true,
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    })
      .select("_id workspaceId schedule scheduledRun")
      .lean<
        Array<{
          _id: Types.ObjectId;
          workspaceId: Types.ObjectId;
          schedule?: { cron?: string | null; timezone?: string | null } | null;
          scheduledRun?: { nextAt?: Date | null } | null;
        }>
      >();
    return docs.map(doc => ({
      id: doc._id.toString(),
      workspaceId: doc.workspaceId.toString(),
      nextAt: doc.scheduledRun?.nextAt ?? null,
      schedule: doc.schedule ?? null,
    }));
  }

  async claimScheduledConsole(
    doc: DueScheduledConsole,
    nextAt: Date,
    updatedAt: Date = new Date(),
  ): Promise<{ modifiedCount: number }> {
    if (!isValidOid(doc.id) || !isValidOid(doc.workspaceId) || !doc.nextAt) {
      return { modifiedCount: 0 };
    }
    const expectedNextAt =
      doc.nextAt instanceof Date
        ? doc.nextAt
        : typeof doc.nextAt === "string"
          ? new Date(doc.nextAt)
          : doc.nextAt;
    const res = await SavedConsole.updateOne(
      {
        _id: toObjectId(doc.id),
        workspaceId: toObjectId(doc.workspaceId),
        "scheduledRun.nextAt": expectedNextAt,
      },
      { $set: { "scheduledRun.nextAt": nextAt, updatedAt } },
      { timestamps: false },
    );
    return { modifiedCount: res.modifiedCount };
  }

  async isPgVectorAvailable(): Promise<boolean> {
    return false;
  }

  async searchConsolesVector(
    workspaceId: string,
    queryEmbedding: number[],
    opts: { limit: number; embeddingModel?: string | null },
  ): Promise<ConsoleSearchCandidate[]> {
    if (!isValidOid(workspaceId)) return [];
    const { db } = await databaseConnectionService.getMainConnection();
    const results = await db
      .collection("savedconsoles")
      .aggregate([
        {
          $vectorSearch: {
            index: "console_embeddings",
            path: "descriptionEmbedding",
            queryVector: queryEmbedding,
            numCandidates: opts.limit * 10,
            limit: opts.limit * 2,
            filter: {
              workspaceId: toObjectId(workspaceId),
              is_deleted: { $ne: true },
            },
          },
        },
        {
          $addFields: {
            vectorScore: { $meta: "vectorSearchScore" },
          },
        },
        {
          $project: {
            _id: 1,
            name: 1,
            description: 1,
            connectionId: 1,
            databaseName: 1,
            language: 1,
            isSaved: 1,
            embeddingModel: 1,
            updatedAt: 1,
            vectorScore: 1,
          },
        },
      ])
      .toArray();

    return results
      .filter(r => r.isSaved === true)
      .filter(
        r =>
          !opts.embeddingModel ||
          !r.embeddingModel ||
          r.embeddingModel === opts.embeddingModel,
      )
      .map(r => ({
        id: r._id.toString(),
        title: String(r.name),
        description: String(r.description || ""),
        connectionId: r.connectionId?.toString(),
        databaseName: r.databaseName as string | undefined,
        language: (r.language || "sql") as ConsoleSearchCandidate["language"],
        isSaved: true,
        embeddingModel: r.embeddingModel as string | undefined,
        updatedAt: r.updatedAt ? new Date(r.updatedAt as Date) : undefined,
        score: Number(r.vectorScore || 0),
      }));
  }

  async searchConsolesText(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]> {
    if (!isValidOid(workspaceId)) return [];
    const results = await SavedConsole.find(
      {
        $text: { $search: query },
        workspaceId: toObjectId(workspaceId),
        isSaved: true,
        $or: [
          { is_deleted: { $ne: true } },
          { is_deleted: { $exists: false } },
        ],
      },
      { score: { $meta: "textScore" } },
    )
      .select(
        "name description connectionId databaseName language isSaved updatedAt",
      )
      .sort({ score: { $meta: "textScore" } })
      .limit(opts.limit * 2)
      .lean<Array<Record<string, unknown>>>();

    return results.map(r => ({
      id: String(r._id),
      title: String(r.name),
      description: String(r.description || ""),
      connectionId: r.connectionId ? String(r.connectionId) : undefined,
      databaseName: r.databaseName as string | undefined,
      language: (r.language || "sql") as ConsoleSearchCandidate["language"],
      isSaved: r.isSaved === true,
      updatedAt: r.updatedAt ? new Date(r.updatedAt as Date) : undefined,
      score: Number(r.score ?? r._score ?? 0),
    }));
  }

  async searchConsolesName(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]> {
    if (!isValidOid(workspaceId)) return [];
    const results = await SavedConsole.find({
      name: { $regex: escapeRegex(query), $options: "i" },
      workspaceId: toObjectId(workspaceId),
      isSaved: true,
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    })
      .select(
        "name description connectionId databaseName language isSaved updatedAt",
      )
      .sort({ updatedAt: -1 })
      .limit(opts.limit * 2)
      .lean<Array<Record<string, unknown>>>();

    return results.map(r => ({
      id: String(r._id),
      title: String(r.name),
      description: String(r.description || ""),
      connectionId: r.connectionId ? String(r.connectionId) : undefined,
      databaseName: r.databaseName as string | undefined,
      language: (r.language || "sql") as ConsoleSearchCandidate["language"],
      isSaved: r.isSaved === true,
      updatedAt: r.updatedAt ? new Date(r.updatedAt as Date) : undefined,
      score: 0.5,
    }));
  }

  // ── 3. Entity versions ────────────────────────────────────────────────

  async findEntityVersionWorkspaceId(
    entityId: string,
    entityType: "console",
  ): Promise<string | null> {
    if (!isValidOid(entityId)) return null;
    const doc = await EntityVersion.findOne(
      { entityId: toObjectId(entityId), entityType },
      { workspaceId: 1 },
    ).lean<{ workspaceId?: Types.ObjectId } | null>();
    return doc?.workspaceId ? doc.workspaceId.toString() : null;
  }

  async getLatestEntityVersionNumber(
    entityId: string,
    entityType: "console",
    workspaceId?: string,
  ): Promise<number> {
    if (!isValidOid(entityId)) return 0;
    const filter: Record<string, unknown> = {
      entityId: toObjectId(entityId),
      entityType,
    };
    if (workspaceId !== undefined) {
      if (!isValidOid(workspaceId)) return 0;
      filter.workspaceId = toObjectId(workspaceId);
    }
    const latest = await EntityVersion.findOne(filter, { version: 1 })
      .sort({ version: -1 })
      .lean<{ version?: number } | null>();
    return latest?.version ?? 0;
  }

  async createEntityVersion(
    input: CreateEntityVersionInput,
  ): Promise<EntityVersionRecord> {
    if (input.version !== undefined) {
      try {
        const doc = await EntityVersion.create({
          ...(input.id && isValidOid(input.id)
            ? { _id: toObjectId(input.id) }
            : {}),
          workspaceId: toObjectId(input.workspaceId),
          entityType: input.entityType,
          entityId: toObjectId(input.entityId),
          version: input.version,
          snapshot: input.snapshot,
          savedBy: input.savedBy || "system",
          savedByName: input.savedByName,
          comment: input.comment ?? "",
          ...(input.restoredFrom !== undefined
            ? { restoredFrom: input.restoredFrom }
            : {}),
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        });
        return mongoEntityVersionToRecord(
          doc.toObject() as MongoEntityVersionLike,
        );
      } catch (err) {
        if (isMongoDupKey(err)) {
          const existing = await this.getEntityVersion(
            input.entityId,
            input.entityType,
            input.version,
            input.workspaceId,
          );
          if (existing) return existing;
        }
        throw err;
      }
    }

    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
      const nextVersion =
        (await this.getLatestEntityVersionNumber(
          input.entityId,
          input.entityType,
          input.workspaceId,
        )) + 1;
      try {
        const doc = await EntityVersion.create({
          ...(input.id && isValidOid(input.id)
            ? { _id: toObjectId(input.id) }
            : {}),
          workspaceId: toObjectId(input.workspaceId),
          entityType: input.entityType,
          entityId: toObjectId(input.entityId),
          version: nextVersion,
          snapshot: input.snapshot,
          savedBy: input.savedBy || "system",
          savedByName: input.savedByName,
          comment: input.comment ?? "",
          ...(input.restoredFrom !== undefined
            ? { restoredFrom: input.restoredFrom }
            : {}),
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        });
        return mongoEntityVersionToRecord(
          doc.toObject() as MongoEntityVersionLike,
        );
      } catch (err) {
        if (isMongoDupKey(err) && attempt < MAX_VERSION_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Failed to create entity version after retries");
  }

  async listEntityVersions(
    entityId: string,
    entityType: "console",
    opts: { workspaceId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ versions: EntityVersionListItem[]; total: number }> {
    if (!isValidOid(entityId)) return { versions: [], total: 0 };
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;
    const filter: Record<string, unknown> = {
      entityId: toObjectId(entityId),
      entityType,
    };
    if (opts.workspaceId !== undefined) {
      if (!isValidOid(opts.workspaceId)) return { versions: [], total: 0 };
      filter.workspaceId = toObjectId(opts.workspaceId);
    }
    const [versions, total] = await Promise.all([
      EntityVersion.find(filter, {
        version: 1,
        savedBy: 1,
        savedByName: 1,
        comment: 1,
        restoredFrom: 1,
        createdAt: 1,
      })
        .sort({ version: -1 })
        .skip(offset)
        .limit(limit)
        .lean<EntityVersionListItem[]>(),
      EntityVersion.countDocuments(filter),
    ]);
    return {
      versions: versions.map(v => ({
        version: v.version,
        savedBy: v.savedBy ?? "",
        savedByName: v.savedByName,
        comment: v.comment ?? "",
        ...(v.restoredFrom != null ? { restoredFrom: v.restoredFrom } : {}),
        createdAt: new Date(v.createdAt),
      })),
      total,
    };
  }

  async listEntityVersionsAscending(
    workspaceId: string,
    entityId: string,
    entityType: "console",
  ): Promise<EntityVersionRecord[]> {
    if (!isValidOid(entityId) || !isValidOid(workspaceId)) return [];
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      entityId: toObjectId(entityId),
      entityType,
    };
    const docs = await EntityVersion.find(filter)
      .sort({ version: 1 })
      .lean<MongoEntityVersionLike[]>();
    return docs.map(mongoEntityVersionToRecord);
  }

  async getEntityVersion(
    entityId: string,
    entityType: "console",
    version: number,
    workspaceId?: string,
  ): Promise<EntityVersionRecord | null> {
    if (!isValidOid(entityId)) return null;
    const filter: Record<string, unknown> = {
      entityId: toObjectId(entityId),
      entityType,
      version,
    };
    if (workspaceId !== undefined) {
      if (!isValidOid(workspaceId)) return null;
      filter.workspaceId = toObjectId(workspaceId);
    }
    const doc = await EntityVersion.findOne(
      filter,
    ).lean<MongoEntityVersionLike | null>();
    return doc ? mongoEntityVersionToRecord(doc) : null;
  }

  async countEntityVersions(
    workspaceId: string,
    entityType: "console",
    entityIds: readonly string[],
  ): Promise<number> {
    const valid = entityIds.filter(isValidOid).map(toObjectId);
    if (valid.length === 0 || !isValidOid(workspaceId)) return 0;
    return EntityVersion.countDocuments({
      workspaceId: toObjectId(workspaceId),
      entityType,
      entityId: { $in: valid },
    });
  }

  // ── 4. Notebook folders ───────────────────────────────────────────────

  async listNotebookFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<NotebookFolderRecord[]> {
    if (!isValidOid(workspaceId)) return [];
    const q = NotebookFolder.find({ workspaceId: toObjectId(workspaceId) });
    if (opts?.sortByName) q.sort({ name: 1 });
    const docs = await q.lean<MongoNotebookFolderLike[]>();
    return docs.map(mongoNotebookFolderToRecord);
  }

  async findNotebookFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<NotebookFolderRecord | null> {
    if (!isValidOid(folderId) || !isValidOid(workspaceId)) return null;
    const doc = await NotebookFolder.findOne({
      _id: toObjectId(folderId),
      workspaceId: toObjectId(workspaceId),
    }).lean<MongoNotebookFolderLike | null>();
    return doc ? mongoNotebookFolderToRecord(doc) : null;
  }

  async createNotebookFolder(
    input: CreateNotebookFolderInput,
  ): Promise<NotebookFolderRecord> {
    const doc = await NotebookFolder.create({
      ...(input.id && isValidOid(input.id)
        ? { _id: toObjectId(input.id) }
        : {}),
      workspaceId: toObjectId(input.workspaceId),
      name: input.name,
      ...(input.parentId ? { parentId: toObjectId(input.parentId) } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      access: input.access ?? "private",
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return mongoNotebookFolderToRecord(
      doc.toObject() as MongoNotebookFolderLike,
    );
  }

  async upsertNotebookFolder(record: NotebookFolderRecord): Promise<void> {
    const $set: Record<string, unknown> = {
      workspaceId: toObjectId(record.workspaceId),
      name: record.name,
      access: record.access,
      createdAt: record.createdAt,
    };
    const $unset: Record<string, unknown> = {};
    if (record.parentId) $set.parentId = toObjectId(record.parentId);
    else $unset.parentId = "";
    if (record.ownerId) $set.ownerId = record.ownerId;
    else $unset.ownerId = "";
    await NotebookFolder.updateOne(
      { _id: toObjectId(record.id) },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { upsert: true },
    );
  }

  async updateNotebookFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateNotebookFolderInput,
  ): Promise<NotebookFolderRecord | null> {
    if (!isValidOid(folderId) || !isValidOid(workspaceId)) return null;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.parentId !== undefined) {
      if (patch.parentId) $set.parentId = toObjectId(patch.parentId);
      else $unset.parentId = "";
    }
    if (patch.access !== undefined) $set.access = patch.access;
    if (patch.ownerId !== undefined) {
      if (patch.ownerId) $set.ownerId = patch.ownerId;
      else $unset.ownerId = "";
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length === 0) {
      return this.findNotebookFolderById(workspaceId, folderId);
    }
    const doc = await NotebookFolder.findOneAndUpdate(
      { _id: toObjectId(folderId), workspaceId: toObjectId(workspaceId) },
      update,
      { returnDocument: "after" },
    ).lean<MongoNotebookFolderLike | null>();
    return doc ? mongoNotebookFolderToRecord(doc) : null;
  }

  async deleteNotebookFolderSubtreeReturningIds(
    workspaceId: string,
    folderId: string,
  ): Promise<string[]> {
    if (!isValidOid(folderId) || !isValidOid(workspaceId)) return [];
    const wsId = toObjectId(workspaceId);
    const rootId = toObjectId(folderId);
    const root = await NotebookFolder.findOne({
      _id: rootId,
      workspaceId: wsId,
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();
    if (!root) return [];
    const allFolderIds = [
      rootId,
      ...(await collectDescendantFolderIds(NotebookFolder, wsId, rootId)),
    ];
    await NotebookIndex.updateMany(
      { workspaceId: wsId, folderId: { $in: allFolderIds } },
      { $unset: { folderId: "" } },
    );
    const res = await NotebookFolder.deleteMany({
      workspaceId: wsId,
      _id: { $in: allFolderIds },
    });
    return res.deletedCount > 0 ? allFolderIds.map(id => id.toString()) : [];
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
    if (
      !isValidOid(workspaceId) ||
      !isValidOid(folderId) ||
      !isValidOid(targetParentId)
    ) {
      return false;
    }
    return wouldCreateFolderCycle(
      NotebookFolder,
      wireId(folderId),
      wireId(targetParentId),
      wireId(workspaceId),
    );
  }

  // ── 5. Notebook indexes ───────────────────────────────────────────────

  async findNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<NotebookIndexRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    const doc = await NotebookIndex.findOne({
      workspaceId: toObjectId(workspaceId),
      notebookId,
    }).lean<MongoNotebookIndexLike | null>();
    return doc ? mongoNotebookIndexToRecord(doc) : null;
  }

  async findNotebookIndexByPath(
    workspaceId: string,
    path: string,
    opts?: { excludeNotebookId?: string },
  ): Promise<NotebookIndexRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      path,
    };
    if (opts?.excludeNotebookId) {
      filter.notebookId = { $ne: opts.excludeNotebookId };
    }
    const doc = await NotebookIndex.findOne(
      filter,
    ).lean<MongoNotebookIndexLike | null>();
    return doc ? mongoNotebookIndexToRecord(doc) : null;
  }

  async listNotebookIndexes(
    workspaceId: string,
    opts?: { sortByName?: boolean; visibleForUserId?: string },
  ): Promise<NotebookIndexRecord[]> {
    if (!isValidOid(workspaceId)) return [];
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
    };
    if (opts?.visibleForUserId) {
      filter.$or = [
        { access: "workspace" },
        { access: "private", ownerId: opts.visibleForUserId },
        { "sharedWith.userId": opts.visibleForUserId },
      ];
    }
    const q = NotebookIndex.find(filter);
    if (opts?.sortByName) q.sort({ name: 1 });
    const docs = await q.lean<MongoNotebookIndexLike[]>();
    return docs.map(mongoNotebookIndexToRecord);
  }

  async createNotebookIndex(
    input: CreateNotebookIndexInput,
  ): Promise<NotebookIndexRecord> {
    const access = input.access ?? "private";
    const doc = await NotebookIndex.create({
      ...(input.id && isValidOid(input.id)
        ? { _id: toObjectId(input.id) }
        : {}),
      notebookId: input.notebookId,
      workspaceId: toObjectId(input.workspaceId),
      name: input.name,
      ownerId: input.ownerId || "system",
      access,
      workspaceRole:
        input.workspaceRole ?? (access === "workspace" ? "editor" : "viewer"),
      ...(input.folderId ? { folderId: toObjectId(input.folderId) } : {}),
      ...(input.path != null ? { path: input.path } : {}),
      ...(input.checkpointBlobSha != null
        ? { checkpointBlobSha: input.checkpointBlobSha }
        : {}),
      sharedWith: input.sharedWith ?? [],
      updatedAt: input.updatedAt ?? new Date(),
    });
    return mongoNotebookIndexToRecord(doc.toObject() as MongoNotebookIndexLike);
  }

  async upsertNotebookIndex(record: NotebookIndexRecord): Promise<void> {
    const $set: Record<string, unknown> = {
      notebookId: record.notebookId,
      workspaceId: toObjectId(record.workspaceId),
      name: record.name,
      ownerId: record.ownerId || "system",
      access: record.access,
      workspaceRole: record.workspaceRole,
      sharedWith: record.sharedWith,
      updatedAt: record.updatedAt,
    };
    const $unset: Record<string, unknown> = {};
    if (record.folderId) $set.folderId = toObjectId(record.folderId);
    else $unset.folderId = "";
    if (record.path != null) $set.path = record.path;
    else $unset.path = "";
    if (record.checkpointBlobSha != null) {
      $set.checkpointBlobSha = record.checkpointBlobSha;
    } else $unset.checkpointBlobSha = "";
    await NotebookIndex.updateOne(
      {
        workspaceId: toObjectId(record.workspaceId),
        notebookId: record.notebookId,
      },
      {
        $set,
        ...(Object.keys($unset).length ? { $unset } : {}),
        $setOnInsert: { _id: toObjectId(record.id) },
      },
      { upsert: true },
    );
  }

  async updateNotebookIndex(
    workspaceId: string,
    notebookId: string,
    patch: UpdateNotebookIndexInput,
  ): Promise<NotebookIndexRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.access !== undefined) {
      $set.access = patch.access;
      if (patch.access === "workspace" && patch.workspaceRole === undefined) {
        $set.workspaceRole = "editor";
      }
    }
    if (patch.workspaceRole !== undefined) {
      $set.workspaceRole = patch.workspaceRole;
    }
    if (patch.updatedAt !== undefined) $set.updatedAt = patch.updatedAt;
    if (patch.folderId !== undefined) {
      if (patch.folderId) $set.folderId = toObjectId(patch.folderId);
      else $set.folderId = null;
    }
    if (patch.path !== undefined) {
      if (patch.path === null) $unset.path = "";
      else $set.path = patch.path;
    }
    if (patch.checkpointBlobSha !== undefined) {
      if (patch.checkpointBlobSha === null) $unset.checkpointBlobSha = "";
      else $set.checkpointBlobSha = patch.checkpointBlobSha;
    }
    if (patch.sharedWith !== undefined) $set.sharedWith = patch.sharedWith;

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length === 0) {
      return this.findNotebookIndex(workspaceId, notebookId);
    }

    const doc = await NotebookIndex.findOneAndUpdate(
      { workspaceId: toObjectId(workspaceId), notebookId },
      update,
      { returnDocument: "after" },
    ).lean<MongoNotebookIndexLike | null>();
    return doc ? mongoNotebookIndexToRecord(doc) : null;
  }

  async deleteNotebookIndexReturningId(
    workspaceId: string,
    notebookId: string,
  ): Promise<string | null> {
    if (!isValidOid(workspaceId)) return null;
    const doc = await NotebookIndex.findOneAndDelete(
      {
        workspaceId: toObjectId(workspaceId),
        notebookId,
      },
      { projection: { _id: 1 } },
    ).lean<{ _id: Types.ObjectId } | null>();
    return doc ? doc._id.toString() : null;
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
    if (!isValidOid(workspaceId)) return [];
    const rows = await Favourite.find({
      workspaceId: toObjectId(workspaceId),
      userId,
    })
      .sort({ parentId: 1, position: 1, _id: 1 })
      .lean<MongoFavouriteLike[]>();
    return rows
      .filter(row => row.type !== "item" || isValidFavouriteKind(row.kind))
      .map(mongoFavouriteToRecord);
  }

  async countFavourites(workspaceId: string, userId: string): Promise<number> {
    if (!isValidOid(workspaceId)) return 0;
    return Favourite.countDocuments({
      workspaceId: toObjectId(workspaceId),
      userId,
    });
  }

  async findFavouriteById(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<FavouriteRecord | null> {
    if (!isValidOid(workspaceId) || !isValidOid(id)) return null;
    const doc = await Favourite.findOne({
      _id: toObjectId(id),
      workspaceId: toObjectId(workspaceId),
      userId,
    }).lean<MongoFavouriteLike | null>();
    return doc ? mongoFavouriteToRecord(doc) : null;
  }

  async findFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<FavouriteRecord | null> {
    if (!isValidOid(workspaceId)) return null;
    const doc = await Favourite.findOne({
      workspaceId: toObjectId(workspaceId),
      userId,
      type: "item",
      kind,
      refId,
    }).lean<MongoFavouriteLike | null>();
    return doc ? mongoFavouriteToRecord(doc) : null;
  }

  async listFavouriteSiblings(
    workspaceId: string,
    userId: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<FavouriteRecord[]> {
    if (!isValidOid(workspaceId)) return [];
    if (parentId !== null && !isValidOid(parentId)) return [];
    const filter: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
      userId,
      parentId: parentId ? wireId(parentId) : null,
    };
    if (excludeId && isValidOid(excludeId)) {
      filter._id = { $ne: toObjectId(excludeId) };
    }
    const rows = await Favourite.find(filter)
      .sort({ position: 1, _id: 1 })
      .lean<MongoFavouriteLike[]>();
    return rows.map(mongoFavouriteToRecord);
  }

  async getNextFavouritePosition(
    workspaceId: string,
    userId: string,
    parentId: string | null,
  ): Promise<number> {
    if (!isValidOid(workspaceId)) return 0;
    if (parentId !== null && !isValidOid(parentId)) return 0;
    const last = await Favourite.findOne({
      workspaceId: toObjectId(workspaceId),
      userId,
      parentId: parentId ? wireId(parentId) : null,
    })
      .sort({ position: -1 })
      .select("position")
      .lean<{ position?: number } | null>();
    return (last?.position ?? -1) + 1;
  }

  async createFavourite(input: CreateFavouriteInput): Promise<FavouriteRecord> {
    const normParentId = optionalWireId(input.parentId) ?? null;
    try {
      const doc = await Favourite.create({
        ...(input.id && isValidOid(input.id)
          ? { _id: toObjectId(input.id) }
          : {}),
        workspaceId: toObjectId(input.workspaceId),
        userId: input.userId,
        parentId: normParentId,
        type: input.type,
        ...(input.type === "folder" ? { title: input.title ?? "" } : {}),
        ...(input.type === "item"
          ? { kind: input.kind, refId: input.refId }
          : {}),
        position: input.position,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
      });
      return mongoFavouriteToRecord(doc.toObject() as MongoFavouriteLike);
    } catch (error) {
      if (input.type === "item" && input.kind && input.refId) {
        const winner = await this.findFavouriteByRef(
          input.workspaceId,
          input.userId,
          input.kind,
          input.refId,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }

  async upsertFavourite(record: FavouriteRecord): Promise<void> {
    await Favourite.updateOne(
      { _id: toObjectId(record.id) },
      {
        $set: {
          workspaceId: toObjectId(record.workspaceId),
          userId: record.userId,
          parentId: optionalWireId(record.parentId) ?? null,
          type: record.type,
          ...(record.type === "folder" ? { title: record.title ?? "" } : {}),
          ...(record.type === "item"
            ? { kind: record.kind, refId: record.refId }
            : {}),
          position: record.position,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      },
      { upsert: true, timestamps: false },
    );
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
    if (!isValidOid(workspaceId) || !isValidOid(id)) return null;
    const $set: Record<string, unknown> = {};
    if (patch.parentId !== undefined) {
      $set.parentId = optionalWireId(patch.parentId) ?? null;
    }
    if (patch.position !== undefined) $set.position = patch.position;
    if (patch.title !== undefined) $set.title = patch.title;
    if (Object.keys($set).length === 0) {
      return this.findFavouriteById(workspaceId, userId, id);
    }
    $set.updatedAt = patch.updatedAt ?? new Date();
    const doc = await Favourite.findOneAndUpdate(
      {
        _id: toObjectId(id),
        workspaceId: toObjectId(workspaceId),
        userId,
      },
      { $set },
      { returnDocument: "after", timestamps: false },
    ).lean<MongoFavouriteLike | null>();
    return doc ? mongoFavouriteToRecord(doc) : null;
  }

  async reorderFavourites(
    workspaceId: string,
    userId: string,
    updates: readonly ReorderFavouriteUpdate[],
    updatedAt: Date = new Date(),
  ): Promise<void> {
    if (updates.length === 0 || !isValidOid(workspaceId)) return;
    const wsOid = toObjectId(workspaceId);
    const ops = updates
      .filter(u => isValidOid(u.id))
      .map(u => {
        const $set: Record<string, unknown> = {
          position: u.position,
          updatedAt,
        };
        if (u.parentId !== undefined) {
          $set.parentId = optionalWireId(u.parentId) ?? null;
        }
        if (u.title !== undefined) $set.title = u.title;
        return {
          updateOne: {
            filter: { _id: toObjectId(u.id), workspaceId: wsOid, userId },
            update: { $set },
          },
        };
      });
    if (ops.length === 0) return;
    // Use native driver collection.bulkWrite so Mongoose's timestamps plugin does
    // not overwrite the caller-supplied `updatedAt` (required for Stage 3/4 parity).
    await Favourite.collection.bulkWrite(ops, { ordered: false });
  }

  async deleteFavouriteByRefReturningId(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<string | null> {
    if (!isValidOid(workspaceId)) return null;
    const doc = await Favourite.findOneAndDelete(
      {
        workspaceId: toObjectId(workspaceId),
        userId,
        type: "item",
        kind,
        refId,
      },
      { projection: { _id: 1 } },
    ).lean<{ _id: Types.ObjectId } | null>();
    return doc ? doc._id.toString() : null;
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
    if (!isValidOid(workspaceId) || !isValidOid(id)) return [];
    const wsOid = toObjectId(workspaceId);
    const root = await Favourite.findOne({
      _id: toObjectId(id),
      workspaceId: wsOid,
      userId,
    })
      .select("_id type")
      .lean<{ _id: Types.ObjectId; type: "folder" | "item" } | null>();
    if (!root) return [];
    const ids: Types.ObjectId[] = [root._id];
    if (root.type === "folder") {
      let frontier = [root._id.toString()];
      while (frontier.length > 0) {
        const children = await Favourite.find({
          workspaceId: wsOid,
          userId,
          parentId: { $in: frontier },
        })
          .select("_id")
          .lean<Array<{ _id: Types.ObjectId }>>();
        frontier = children.map(c => c._id.toString());
        ids.push(...children.map(c => c._id));
      }
    }
    const res = await Favourite.deleteMany({
      workspaceId: wsOid,
      userId,
      _id: { $in: ids },
    });
    return res.deletedCount > 0 ? ids.map(oid => oid.toString()) : [];
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
    const doc = await ScheduledQueryRun.create({
      ...(input.id && isValidOid(input.id)
        ? { _id: toObjectId(input.id) }
        : {}),
      workspaceId: toObjectId(input.workspaceId),
      consoleId: toObjectId(input.consoleId),
      triggeredAt: input.triggeredAt ?? new Date(),
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      status: input.status,
      triggerType: input.triggerType,
      ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
      ...(input.durationMs !== undefined
        ? { durationMs: input.durationMs }
        : {}),
      ...(input.rowsAffected !== undefined
        ? { rowsAffected: input.rowsAffected }
        : {}),
      ...(input.rowCount !== undefined ? { rowCount: input.rowCount } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.inngestRunId ? { inngestRunId: input.inngestRunId } : {}),
    });
    return mongoScheduledQueryRunToRecord(
      doc.toObject() as MongoScheduledQueryRunLike,
    );
  }

  async upsertScheduledQueryRun(
    record: ScheduledQueryRunRecord,
  ): Promise<void> {
    const $set: Record<string, unknown> = {
      workspaceId: toObjectId(record.workspaceId),
      consoleId: toObjectId(record.consoleId),
      triggeredAt: record.triggeredAt,
      status: record.status,
      triggerType: record.triggerType,
    };
    const $unset: Record<string, unknown> = {};
    if (record.startedAt) $set.startedAt = record.startedAt;
    else $unset.startedAt = "";
    if (record.completedAt) $set.completedAt = record.completedAt;
    else $unset.completedAt = "";
    if (record.triggeredBy) $set.triggeredBy = record.triggeredBy;
    else $unset.triggeredBy = "";
    if (record.durationMs !== undefined) $set.durationMs = record.durationMs;
    else $unset.durationMs = "";
    if (record.rowsAffected !== undefined) {
      $set.rowsAffected = record.rowsAffected;
    } else $unset.rowsAffected = "";
    if (record.rowCount !== undefined) $set.rowCount = record.rowCount;
    else $unset.rowCount = "";
    if (record.error) $set.error = record.error;
    else $unset.error = "";
    if (record.inngestRunId) $set.inngestRunId = record.inngestRunId;
    else $unset.inngestRunId = "";

    await ScheduledQueryRun.updateOne(
      { _id: toObjectId(record.id) },
      { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
      { upsert: true },
    );
  }

  async findScheduledQueryRunById(
    runId: string,
    workspaceId?: string,
  ): Promise<ScheduledQueryRunRecord | null> {
    if (!isValidOid(runId)) return null;
    const filter: Record<string, unknown> = { _id: toObjectId(runId) };
    if (workspaceId !== undefined) {
      if (!isValidOid(workspaceId)) return null;
      filter.workspaceId = toObjectId(workspaceId);
    }
    const doc = await ScheduledQueryRun.findOne(
      filter,
    ).lean<MongoScheduledQueryRunLike | null>();
    return doc ? mongoScheduledQueryRunToRecord(doc) : null;
  }

  async updateScheduledQueryRun(
    workspaceId: string,
    runId: string,
    patch: UpdateScheduledQueryRunInput,
  ): Promise<boolean> {
    if (!isValidOid(runId) || !isValidOid(workspaceId)) return false;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};
    if (patch.startedAt !== undefined) {
      if (patch.startedAt === null) $unset.startedAt = "";
      else $set.startedAt = patch.startedAt;
    }
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) $unset.completedAt = "";
      else $set.completedAt = patch.completedAt;
    }
    if (patch.status !== undefined) $set.status = patch.status;
    if (patch.durationMs !== undefined) {
      if (patch.durationMs === null) $unset.durationMs = "";
      else $set.durationMs = patch.durationMs;
    }
    if (patch.rowsAffected !== undefined) {
      if (patch.rowsAffected === null) $unset.rowsAffected = "";
      else $set.rowsAffected = patch.rowsAffected;
    }
    if (patch.rowCount !== undefined) {
      if (patch.rowCount === null) $unset.rowCount = "";
      else $set.rowCount = patch.rowCount;
    }
    if (patch.error !== undefined) {
      if (patch.error === null) $unset.error = "";
      else $set.error = patch.error;
    }
    const filter: Record<string, unknown> = {
      _id: toObjectId(runId),
      workspaceId: toObjectId(workspaceId),
    };
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length === 0) return true;
    const res = await ScheduledQueryRun.updateOne(filter, update);
    return res.matchedCount > 0;
  }

  async listScheduledQueryRuns(
    workspaceId: string,
    consoleId: string,
    limit: number,
  ): Promise<ScheduledQueryRunRecord[]> {
    if (!isValidOid(workspaceId) || !isValidOid(consoleId)) return [];
    const docs = await ScheduledQueryRun.find({
      workspaceId: toObjectId(workspaceId),
      consoleId: toObjectId(consoleId),
    })
      .sort({ triggeredAt: -1 })
      .limit(limit)
      .lean<MongoScheduledQueryRunLike[]>();
    return docs.map(mongoScheduledQueryRunToRecord);
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
    if (!isValidOid(workspaceId)) return empty;
    const wsOid = toObjectId(workspaceId);
    const [consoles, folders, versions, notebooks, nbFolders] =
      await Promise.all([
        SavedConsole.find({ workspaceId: wsOid })
          .select("_id")
          .lean<Array<{ _id: Types.ObjectId }>>(),
        ConsoleFolder.find({ workspaceId: wsOid })
          .select("_id")
          .lean<Array<{ _id: Types.ObjectId }>>(),
        EntityVersion.find({ workspaceId: wsOid, entityType: "console" })
          .select("_id")
          .lean<Array<{ _id: Types.ObjectId }>>(),
        NotebookIndex.find({ workspaceId: wsOid })
          .select("_id")
          .lean<Array<{ _id: Types.ObjectId }>>(),
        NotebookFolder.find({ workspaceId: wsOid })
          .select("_id")
          .lean<Array<{ _id: Types.ObjectId }>>(),
      ]);
    await Promise.all([
      SavedConsole.deleteMany({ workspaceId: wsOid }),
      ConsoleFolder.deleteMany({ workspaceId: wsOid }),
      EntityVersion.deleteMany({ workspaceId: wsOid, entityType: "console" }),
      NotebookIndex.deleteMany({ workspaceId: wsOid }),
      NotebookFolder.deleteMany({ workspaceId: wsOid }),
    ]);
    return {
      saved_consoles: consoles.map(d => d._id.toString()),
      console_folders: folders.map(d => d._id.toString()),
      entity_versions: versions.map(d => d._id.toString()),
      notebook_indexes: notebooks.map(d => d._id.toString()),
      notebook_folders: nbFolders.map(d => d._id.toString()),
    };
  }

  async purgeWorkspaceContentIndex(workspaceId: string): Promise<void> {
    await this.purgeWorkspaceContentIndexReturningIds(workspaceId);
  }

  /**
   * Delete ONLY the specified captured IDs per table within `workspaceId`.
   * Used by delayed Stage 4 `replaySyncToMongo` purge retries so content
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
  ): Promise<void> {
    if (!isValidOid(workspaceId)) return;
    const wsOid = toObjectId(workspaceId);
    const toOids = (ids: readonly string[] | undefined): Types.ObjectId[] =>
      (ids ?? []).filter(isValidOid).map(toObjectId);

    const consoleOids = toOids(idsByTable.saved_consoles);
    const folderOids = toOids(idsByTable.console_folders);
    const versionOids = toOids(idsByTable.entity_versions);
    const notebookOids = toOids(idsByTable.notebook_indexes);
    const nbFolderOids = toOids(idsByTable.notebook_folders);

    await Promise.all([
      consoleOids.length > 0
        ? SavedConsole.deleteMany({
            workspaceId: wsOid,
            _id: { $in: consoleOids },
          })
        : Promise.resolve(),
      folderOids.length > 0
        ? ConsoleFolder.deleteMany({
            workspaceId: wsOid,
            _id: { $in: folderOids },
          })
        : Promise.resolve(),
      versionOids.length > 0
        ? EntityVersion.deleteMany({
            workspaceId: wsOid,
            entityType: "console",
            _id: { $in: versionOids },
          })
        : Promise.resolve(),
      notebookOids.length > 0
        ? NotebookIndex.deleteMany({
            workspaceId: wsOid,
            _id: { $in: notebookOids },
          })
        : Promise.resolve(),
      nbFolderOids.length > 0
        ? NotebookFolder.deleteMany({
            workspaceId: wsOid,
            _id: { $in: nbFolderOids },
          })
        : Promise.resolve(),
    ]);
  }
}
