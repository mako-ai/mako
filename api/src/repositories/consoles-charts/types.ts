/**
 * Store-agnostic DTOs and repository contract for Phase 2A-2 (`consoles_charts` domain).
 *
 * Covers 7 workspace-scoped tables:
 *   - `console_folders`      (Mongo `consolefolders`)
 *   - `saved_consoles`       (Mongo `savedconsoles`)
 *   - `entity_versions`      (Mongo `entity_versions`, `entityType = 'console'`)
 *   - `notebook_folders`     (Mongo `notebookfolders`)
 *   - `notebook_indexes`     (Mongo `notebookindexes`)
 *   - `favourites`           (Mongo `favourites`)
 *   - `scheduled_query_runs` (Mongo `scheduled_query_runs`)
 */
import type {
  ConsoleAccessLevelPg,
  ConsoleDescriptionSourcePg,
  ConsoleLanguagePg,
  ConsoleMongoOptionsJson,
  ConsoleResultsViewModePg,
  DraftOriginPg,
  ExternalSourcePg,
  FavouriteKindPg,
  FavouriteTypePg,
  ResourceShareRolePg,
  ScheduledQueryRunStatusPg,
  ScheduledQueryTriggerTypePg,
  ScheduledRunLastStatusPg,
} from "../../database/pg/schema/consoles-charts";

export type ConsoleAccessLevel = ConsoleAccessLevelPg;
export type ConsoleLanguage = ConsoleLanguagePg;
export type ConsoleResultsViewMode = ConsoleResultsViewModePg;
export type ConsoleDescriptionSource = ConsoleDescriptionSourcePg;
export type ResourceShareRole = ResourceShareRolePg;
export type ScheduledRunLastStatus = ScheduledRunLastStatusPg;
export type DraftOrigin = DraftOriginPg;
export type ExternalSource = ExternalSourcePg;
export type FavouriteType = FavouriteTypePg;
export type FavouriteKind = FavouriteKindPg;
export type ScheduledQueryRunStatus = ScheduledQueryRunStatusPg;
export type ScheduledQueryTriggerType = ScheduledQueryTriggerTypePg;
export type ConsoleMongoOptions = ConsoleMongoOptionsJson;

export interface ResourceShareEntryRecord {
  userId: string;
  role: ResourceShareRole;
  addedAt: Date;
  addedBy?: string;
}

export interface ConsoleScheduleRecord {
  cron: string;
  timezone: string;
}

export interface ConsoleScheduledRunRecord {
  nextAt?: Date;
  lastAt?: Date;
  lastStatus?: ScheduledRunLastStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastRowsAffected?: number;
  lastRowCount?: number;
  runCount: number;
  consecutiveFailures: number;
  permanentFailures?: number;
  pausedAt?: Date;
  pausedReason?: string;
}

export interface ConsoleLastRunRecord {
  at: Date;
  status: "running" | "success" | "error" | "cancelled";
  rowCount?: number;
  durationMs: number;
  error?: string;
  sampleRows?: unknown[];
  fields?: unknown;
  runBy: string;
  source: string;
  startedAt?: Date;
  executionId?: string;
}

// ── 1. ConsoleFolder ────────────────────────────────────────────────────────

export interface ConsoleFolderRecord {
  /** Wire 24-hex ObjectId string. */
  id: string;
  /** Compatibility alias mirroring `id`. */
  _id: string;
  workspaceId: string;
  name: string;
  parentId?: string;
  isPrivate: boolean;
  ownerId?: string;
  access: ConsoleAccessLevel;
  createdAt: Date;
}

export interface CreateConsoleFolderInput {
  id?: string;
  workspaceId: string;
  name: string;
  parentId?: string | null;
  isPrivate?: boolean;
  ownerId?: string | null;
  access?: ConsoleAccessLevel;
  createdAt?: Date;
}

export interface UpdateConsoleFolderInput {
  name?: string;
  /** Pass `null` to move folder to workspace root. */
  parentId?: string | null;
  isPrivate?: boolean;
  access?: ConsoleAccessLevel;
  ownerId?: string | null;
}

// ── 2. SavedConsole ─────────────────────────────────────────────────────────

export interface SavedConsoleRecord {
  id: string;
  _id: string;
  workspaceId: string;
  folderId?: string;
  connectionId?: string;
  databaseName?: string;
  databaseId?: string;
  name: string;
  description?: string;
  descriptionEmbedding?: number[];
  embeddingModel?: string;
  descriptionGeneratedAt?: Date;
  path?: string;
  sourceBlobSha?: string;
  descriptionSourceSha?: string;
  descriptionSource?: ConsoleDescriptionSource;
  code: string;
  language: ConsoleLanguage;
  chartSpec?: Record<string, unknown>;
  resultsViewMode?: ConsoleResultsViewMode;
  mongoOptions?: ConsoleMongoOptions;
  /** Empty string when stored as NULL in Postgres (system/git/deleted creator). */
  createdBy: string;
  owner_id?: string;
  isPrivate: boolean;
  isSaved: boolean;
  access: ConsoleAccessLevel;
  workspaceRole: ResourceShareRole;
  sharedWith: ResourceShareEntryRecord[];
  schedule?: ConsoleScheduleRecord;
  scheduledRun?: ConsoleScheduledRunRecord;
  version: number;
  draftRevision: number;
  lastDraftOrigin?: DraftOrigin;
  lastRun?: ConsoleLastRunRecord;
  lastExecutedAt?: Date;
  executionCount: number;
  lastExternalUsedAt?: Date;
  externalUseCount: number;
  lastExternalSource?: ExternalSource;
  is_deleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConsoleInput {
  id?: string;
  workspaceId: string;
  folderId?: string | null;
  connectionId?: string | null;
  databaseName?: string | null;
  databaseId?: string | null;
  name: string;
  description?: string | null;
  descriptionEmbedding?: number[] | null;
  embeddingModel?: string | null;
  descriptionGeneratedAt?: Date | null;
  path?: string | null;
  sourceBlobSha?: string | null;
  descriptionSourceSha?: string | null;
  descriptionSource?: ConsoleDescriptionSource | null;
  code: string;
  language: ConsoleLanguage;
  chartSpec?: Record<string, unknown> | null;
  resultsViewMode?: ConsoleResultsViewMode | null;
  mongoOptions?: ConsoleMongoOptions | null;
  createdBy?: string | null;
  owner_id?: string | null;
  isPrivate?: boolean;
  isSaved?: boolean;
  access?: ConsoleAccessLevel;
  workspaceRole?: ResourceShareRole;
  sharedWith?: ResourceShareEntryRecord[];
  schedule?: ConsoleScheduleRecord | null;
  scheduledRun?: ConsoleScheduledRunRecord | null;
  version?: number;
  draftRevision?: number;
  lastDraftOrigin?: DraftOrigin | null;
  lastRun?: ConsoleLastRunRecord | null;
  lastExecutedAt?: Date | null;
  executionCount?: number;
  lastExternalUsedAt?: Date | null;
  externalUseCount?: number;
  lastExternalSource?: ExternalSource | null;
  is_deleted?: boolean;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateConsolePatch {
  folderId?: string | null;
  connectionId?: string | null;
  databaseName?: string | null;
  databaseId?: string | null;
  name?: string;
  description?: string | null;
  descriptionEmbedding?: number[] | null;
  embeddingModel?: string | null;
  descriptionGeneratedAt?: Date | null;
  path?: string | null;
  sourceBlobSha?: string | null;
  descriptionSourceSha?: string | null;
  descriptionSource?: ConsoleDescriptionSource | null;
  code?: string;
  language?: ConsoleLanguage;
  chartSpec?: Record<string, unknown> | null;
  resultsViewMode?: ConsoleResultsViewMode | null;
  mongoOptions?: ConsoleMongoOptions | null;
  owner_id?: string | null;
  isPrivate?: boolean;
  isSaved?: boolean;
  access?: ConsoleAccessLevel;
  workspaceRole?: ResourceShareRole;
  sharedWith?: ResourceShareEntryRecord[];
  schedule?: ConsoleScheduleRecord | null;
  scheduledRun?: ConsoleScheduledRunRecord | null;
  /** Explicitly unset only `scheduledRun.nextAt` while preserving other schedule run counters. */
  clearScheduledRunNextAt?: boolean;
  version?: number;
  draftRevision?: number;
  incVersion?: number;
  incDraftRevision?: number;
  lastDraftOrigin?: DraftOrigin | null;
  lastRun?: ConsoleLastRunRecord | null;
  lastExecutedAt?: Date | null;
  executionCount?: number;
  incExecutionCount?: number;
  lastExternalUsedAt?: Date | null;
  externalUseCount?: number;
  incExternalUseCount?: number;
  lastExternalSource?: ExternalSource | null;
  is_deleted?: boolean;
  deletedAt?: Date | null;
  updatedAt?: Date;
}

export interface ListConsolesFilter {
  isSaved?: boolean;
  /** When true, only return rows where `isSaved !== true` (drafts). */
  draftsOnly?: boolean;
  excludeDeleted?: boolean;
  hasPath?: boolean;
  hasSchedule?: boolean;
  folderId?: string | null;
  includeEmbedding?: boolean;
  sortBy?: "updatedAtDesc" | "createdAtAsc" | "nameAsc";
}

export interface GuardedSaveConsoleInput {
  workspaceId: string;
  consoleId: string;
  /** Optimistic concurrency guard on `version` (exact match; `1` matches legacy null/1). */
  expectedVersion?: number;
  /** Optimistic concurrency guard on `draftRevision` (exact match; `1` matches legacy null/1). */
  expectedDraftRevision?: number;
  /** Allow upsert when neither guard is active and document does not exist yet. */
  upsert: boolean;
  set: UpdateConsolePatch;
  incVersion?: number;
  incDraftRevision?: number;
  setOnInsert?: Partial<CreateConsoleInput>;
}

export interface ConsoleSearchCandidate {
  id: string;
  title: string;
  description: string;
  connectionId?: string;
  databaseName?: string;
  language: ConsoleLanguage;
  isSaved: boolean;
  embeddingModel?: string;
  updatedAt?: Date;
  score: number;
}

export interface DueScheduledConsole {
  id: string;
  workspaceId: string;
  nextAt: Date | string | null;
  schedule: { cron?: string | null; timezone?: string | null } | null;
}

export interface RecordScheduleOutcomeInput {
  workspaceId: string;
  consoleId: string;
  /** Set on success; undefined on error. */
  isError: boolean;
  lastAt: Date;
  lastDurationMs?: number;
  lastRowCount?: number;
  lastRowsAffected?: number;
  nextAt?: Date | null;
  lastError?: string | null;
  permanentFailures: number;
  pausedAt?: Date | null;
  pausedReason?: string | null;
  clearNextAt?: boolean;
  updatedAt?: Date;
}

// ── 3. EntityVersion ────────────────────────────────────────────────────────

export interface EntityVersionRecord {
  id: string;
  _id: string;
  workspaceId: string;
  entityType: "console";
  entityId: string;
  version: number;
  snapshot: Record<string, unknown>;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number;
  createdAt: Date;
}

export interface EntityVersionListItem {
  version: number;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number;
  createdAt: Date;
}

export interface CreateEntityVersionInput {
  id?: string;
  workspaceId: string;
  entityType: "console";
  entityId: string;
  version?: number;
  snapshot: Record<string, unknown>;
  savedBy?: string | null;
  savedByName: string;
  comment?: string;
  restoredFrom?: number;
  createdAt?: Date;
}

// ── 4. NotebookFolder ───────────────────────────────────────────────────────

export interface NotebookFolderRecord {
  id: string;
  _id: string;
  workspaceId: string;
  name: string;
  parentId?: string;
  ownerId?: string;
  access: ConsoleAccessLevel;
  createdAt: Date;
}

export interface CreateNotebookFolderInput {
  id?: string;
  workspaceId: string;
  name: string;
  parentId?: string | null;
  ownerId?: string | null;
  access?: ConsoleAccessLevel;
  createdAt?: Date;
}

export interface UpdateNotebookFolderInput {
  name?: string;
  parentId?: string | null;
  access?: ConsoleAccessLevel;
  ownerId?: string | null;
}

// ── 5. NotebookIndex ────────────────────────────────────────────────────────

export interface NotebookIndexRecord {
  id: string;
  _id: string;
  notebookId: string;
  workspaceId: string;
  name: string;
  folderId?: string;
  ownerId: string;
  access: ConsoleAccessLevel;
  path?: string;
  checkpointBlobSha?: string;
  workspaceRole: ResourceShareRole;
  sharedWith: ResourceShareEntryRecord[];
  updatedAt: Date;
}

export interface CreateNotebookIndexInput {
  id?: string;
  workspaceId: string;
  notebookId: string;
  name: string;
  folderId?: string | null;
  ownerId?: string | null;
  access?: ConsoleAccessLevel;
  path?: string | null;
  checkpointBlobSha?: string | null;
  workspaceRole?: ResourceShareRole;
  sharedWith?: ResourceShareEntryRecord[];
  updatedAt?: Date;
}

export interface UpdateNotebookIndexInput {
  name?: string;
  folderId?: string | null;
  access?: ConsoleAccessLevel;
  workspaceRole?: ResourceShareRole;
  path?: string | null;
  checkpointBlobSha?: string | null;
  sharedWith?: ResourceShareEntryRecord[];
  updatedAt?: Date;
}

// ── 6. Favourite ────────────────────────────────────────────────────────────

export interface FavouriteRecord {
  id: string;
  _id: string;
  workspaceId: string;
  userId: string;
  parentId: string | null;
  type: FavouriteType;
  title?: string;
  kind?: FavouriteKind;
  refId?: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFavouriteInput {
  id?: string;
  workspaceId: string;
  userId: string;
  parentId?: string | null;
  type: FavouriteType;
  title?: string;
  kind?: FavouriteKind;
  refId?: string;
  position: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ReorderFavouriteUpdate {
  id: string;
  position: number;
  parentId?: string | null;
  title?: string;
}

// ── 7. ScheduledQueryRun ────────────────────────────────────────────────────

export interface ScheduledQueryRunRecord {
  id: string;
  _id: string;
  workspaceId: string;
  consoleId: string;
  triggeredAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  status: ScheduledQueryRunStatus;
  triggerType: ScheduledQueryTriggerType;
  triggeredBy?: string;
  durationMs?: number;
  rowsAffected?: number;
  rowCount?: number;
  error?: { message: string; code?: string };
  inngestRunId?: string;
}

export interface CreateScheduledQueryRunInput {
  id?: string;
  workspaceId: string;
  consoleId: string;
  triggeredAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  status: ScheduledQueryRunStatus;
  triggerType: ScheduledQueryTriggerType;
  triggeredBy?: string | null;
  durationMs?: number;
  rowsAffected?: number;
  rowCount?: number;
  error?: { message: string; code?: string } | null;
  inngestRunId?: string;
}

export interface UpdateScheduledQueryRunInput {
  startedAt?: Date | null;
  completedAt?: Date | null;
  status?: ScheduledQueryRunStatus;
  durationMs?: number | null;
  rowsAffected?: number | null;
  rowCount?: number | null;
  error?: { message: string; code?: string } | null;
}

// ── Repository Contract ─────────────────────────────────────────────────────

export interface ConsolesChartsRepository {
  // ── 1. Console folders ────────────────────────────────────────────────
  listConsoleFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<ConsoleFolderRecord[]>;
  findConsoleFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<ConsoleFolderRecord | null>;
  findConsoleFoldersByIds(
    workspaceId: string,
    folderIds: readonly string[],
  ): Promise<ConsoleFolderRecord[]>;
  findConsoleFolderByNameAndParent(
    workspaceId: string,
    name: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord | null>;
  listChildConsoleFolders(
    workspaceId: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord[]>;
  createConsoleFolder(
    input: CreateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord>;
  updateConsoleFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord | null>;
  deleteConsoleFolder(workspaceId: string, folderId: string): Promise<boolean>;
  wouldCreateConsoleFolderCycle(
    workspaceId: string,
    folderId: string,
    targetParentId: string | null,
  ): Promise<boolean>;

  // ── 2. Saved consoles ─────────────────────────────────────────────────
  findConsoleById(
    workspaceId: string,
    consoleId: string,
    opts?: { includeEmbedding?: boolean; excludeDeleted?: boolean },
  ): Promise<SavedConsoleRecord | null>;
  findConsoleByIdGlobal(
    consoleId: string,
    opts?: { includeEmbedding?: boolean },
  ): Promise<SavedConsoleRecord | null>;
  findConsolesByIds(
    workspaceId: string,
    consoleIds: readonly string[],
  ): Promise<SavedConsoleRecord[]>;
  findConsoleByPath(
    workspaceId: string,
    path: string,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null>;
  findConsoleByNameAndFolder(
    workspaceId: string,
    name: string,
    folderId: string | null,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null>;
  listConsolesByWorkspace(
    workspaceId: string,
    filter?: ListConsolesFilter,
  ): Promise<SavedConsoleRecord[]>;
  listConsolesNeedingDescription(opts?: {
    workspaceId?: string;
    currentEmbeddingModel?: string | null;
  }): Promise<Array<{ id: string; workspaceId: string }>>;
  createConsole(input: CreateConsoleInput): Promise<SavedConsoleRecord>;
  updateConsole(
    workspaceId: string,
    consoleId: string,
    patch: UpdateConsolePatch,
  ): Promise<SavedConsoleRecord | null>;
  updateConsolesInFolder(
    workspaceId: string,
    folderId: string,
    patch: Pick<UpdateConsolePatch, "access" | "isPrivate">,
    updatedAt?: Date,
  ): Promise<number>;
  guardedSaveConsole(
    input: GuardedSaveConsoleInput,
  ): Promise<SavedConsoleRecord | null>;
  bumpConsoleDraftRevision(
    workspaceId: string,
    consoleId: string,
    updatedAt?: Date,
  ): Promise<SavedConsoleRecord | null>;
  recordConsoleExecution(
    workspaceId: string,
    consoleId: string,
    input: {
      lastExecutedAt: Date;
      lastRun?: ConsoleLastRunRecord;
      bumpDraftRevision?: boolean;
      updatedAt?: Date;
    },
  ): Promise<boolean>;
  recordConsoleExternalUse(
    workspaceId: string,
    consoleId: string,
    source: ExternalSource,
    mode: "execute" | "access",
    now?: Date,
  ): Promise<boolean>;
  guardedUpdateConsoleDescription(
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
    updatedAt?: Date,
  ): Promise<boolean>;
  softDeleteConsole(
    workspaceId: string,
    consoleId: string,
    deletedAt?: Date,
    opts?: { onlyIfNotDeleted?: boolean },
  ): Promise<boolean>;
  restoreConsole(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt?: Date,
  ): Promise<boolean>;
  deleteConsolesInFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<number>;
  updateConsoleScheduleOutcome(
    input: RecordScheduleOutcomeInput,
  ): Promise<boolean>;
  clearConsoleSchedule(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt?: Date,
  ): Promise<boolean>;
  findDueScheduledConsoles(now: Date): Promise<DueScheduledConsole[]>;
  claimScheduledConsole(
    doc: DueScheduledConsole,
    nextAt: Date,
    updatedAt?: Date,
  ): Promise<{ modifiedCount: number }>;

  // Search (vector + FTS + trigram)
  isPgVectorAvailable(): Promise<boolean>;
  searchConsolesVector(
    workspaceId: string,
    queryEmbedding: number[],
    opts: { limit: number; embeddingModel?: string | null },
  ): Promise<ConsoleSearchCandidate[]>;
  searchConsolesText(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]>;
  searchConsolesName(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]>;

  // ── 3. Entity versions ────────────────────────────────────────────────
  getLatestEntityVersionNumber(
    entityId: string,
    entityType: "console",
    workspaceId?: string,
  ): Promise<number>;
  createEntityVersion(
    input: CreateEntityVersionInput,
  ): Promise<EntityVersionRecord>;
  listEntityVersions(
    entityId: string,
    entityType: "console",
    opts?: { workspaceId?: string; limit?: number; offset?: number },
  ): Promise<{ versions: EntityVersionListItem[]; total: number }>;
  listEntityVersionsAscending(
    workspaceId: string,
    entityId: string,
    entityType: "console",
  ): Promise<EntityVersionRecord[]>;
  getEntityVersion(
    entityId: string,
    entityType: "console",
    version: number,
    workspaceId?: string,
  ): Promise<EntityVersionRecord | null>;
  countEntityVersions(
    workspaceId: string,
    entityType: "console",
    entityIds: readonly string[],
  ): Promise<number>;

  // ── 4. Notebook folders ───────────────────────────────────────────────
  listNotebookFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<NotebookFolderRecord[]>;
  findNotebookFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<NotebookFolderRecord | null>;
  createNotebookFolder(
    input: CreateNotebookFolderInput,
  ): Promise<NotebookFolderRecord>;
  updateNotebookFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateNotebookFolderInput,
  ): Promise<NotebookFolderRecord | null>;
  deleteNotebookFolderSubtree(
    workspaceId: string,
    folderId: string,
  ): Promise<boolean>;
  wouldCreateNotebookFolderCycle(
    workspaceId: string,
    folderId: string,
    targetParentId: string | null,
  ): Promise<boolean>;

  // ── 5. Notebook indexes ───────────────────────────────────────────────
  findNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<NotebookIndexRecord | null>;
  findNotebookIndexByPath(
    workspaceId: string,
    path: string,
    opts?: { excludeNotebookId?: string },
  ): Promise<NotebookIndexRecord | null>;
  listNotebookIndexes(
    workspaceId: string,
    opts?: { sortByName?: boolean; visibleForUserId?: string },
  ): Promise<NotebookIndexRecord[]>;
  createNotebookIndex(
    input: CreateNotebookIndexInput,
  ): Promise<NotebookIndexRecord>;
  updateNotebookIndex(
    workspaceId: string,
    notebookId: string,
    patch: UpdateNotebookIndexInput,
  ): Promise<NotebookIndexRecord | null>;
  deleteNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<boolean>;

  // ── 6. Favourites ─────────────────────────────────────────────────────
  listFavourites(
    workspaceId: string,
    userId: string,
  ): Promise<FavouriteRecord[]>;
  countFavourites(workspaceId: string, userId: string): Promise<number>;
  findFavouriteById(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<FavouriteRecord | null>;
  findFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<FavouriteRecord | null>;
  listFavouriteSiblings(
    workspaceId: string,
    userId: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<FavouriteRecord[]>;
  getNextFavouritePosition(
    workspaceId: string,
    userId: string,
    parentId: string | null,
  ): Promise<number>;
  createFavourite(input: CreateFavouriteInput): Promise<FavouriteRecord>;
  updateFavouriteSimple(
    workspaceId: string,
    userId: string,
    id: string,
    patch: {
      parentId?: string | null;
      position?: number;
      title?: string;
      updatedAt?: Date;
    },
  ): Promise<FavouriteRecord | null>;
  reorderFavourites(
    workspaceId: string,
    userId: string,
    updates: readonly ReorderFavouriteUpdate[],
    updatedAt?: Date,
  ): Promise<void>;
  deleteFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<boolean>;
  deleteFavouriteSubtree(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<number>;

  // ── 7. Scheduled query runs ───────────────────────────────────────────
  createScheduledQueryRun(
    input: CreateScheduledQueryRunInput,
  ): Promise<ScheduledQueryRunRecord>;
  findScheduledQueryRunById(
    runId: string,
    workspaceId?: string,
  ): Promise<ScheduledQueryRunRecord | null>;
  updateScheduledQueryRun(
    workspaceId: string,
    runId: string,
    patch: UpdateScheduledQueryRunInput,
  ): Promise<boolean>;
  listScheduledQueryRuns(
    workspaceId: string,
    consoleId: string,
    limit: number,
  ): Promise<ScheduledQueryRunRecord[]>;
}
