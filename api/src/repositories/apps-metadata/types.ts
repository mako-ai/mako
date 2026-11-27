/**
 * Store-agnostic DTOs and repository contract for the Phase 2B `apps_metadata` domain.
 *
 * Covers the 10 Apps control-plane, git-derived index, lifecycle, worktree,
 * and binding tables:
 *   - `app_projects`
 *   - `app_index`
 *   - `app_index_heads`
 *   - `app_embeddings`
 *   - `app_lifecycle`
 *   - `app_deploy_commit_statuses`
 *   - `app_worktrees`
 *   - `app_binding_state`
 *   - `app_binding_drafts`  (blob-safe app-side pruning; NEVER blind TTL-reaped)
 *   - `app_binding_jobs`    (blob-safe app-side pruning; NEVER blind TTL-reaped)
 */
import type {
  AppAccessScope,
  AppBindingDraftKind,
  AppBindingJobKindPg,
  AppBindingJobRequestJson,
  AppBindingJobResultJson,
  AppBindingJobStatusPg,
  AppDeployCommitStatePg,
  AppEnvVarJson,
  AppIndexAssetRefJson,
  AppIndexBindingTablesJson,
  AppIndexScheduleJson,
  AppResourceRole,
} from "../../database/pg/schema/apps-metadata";
import type {
  AppDeployStage,
  IAppDeployProgress,
  IPublicShare,
  IResourceShareEntry,
} from "../../database/workspace-schema";
import type { ParquetCodec } from "../../utils/parquet-compression";

export type {
  AppAccessScope,
  AppBindingDraftKind,
  AppBindingJobKindPg,
  AppBindingJobRequestJson,
  AppBindingJobResultJson,
  AppBindingJobStatusPg,
  AppDeployCommitStatePg,
  AppDeployStage,
  AppEnvVarJson,
  AppIndexAssetRefJson,
  AppIndexBindingTablesJson,
  AppIndexScheduleJson,
  AppResourceRole,
};

// ── app_projects ─────────────────────────────────────────────────────────────

export interface AppLastDeployErrorRecord {
  sha: string;
  stage: "bindings" | "build" | "publish";
  message: string;
  at: Date;
}

export interface AppBindingRefreshErrorRecord {
  sha: string;
  message: string;
  attempts: number;
  at: Date;
}

export interface AppProjectRecord {
  /** Wire 24-hex ObjectId (or canonical UUID post-migration). */
  id: string;
  workspaceId: string;
  title: string;
  slug?: string;
  path?: string;
  description?: string;
  access: AppAccessScope;
  workspaceRole?: AppResourceRole;
  sharedWith?: IResourceShareEntry[];
  owner_id?: string;
  createdBy: string;
  defaultBranch: string;
  cloudRepo?: { owner: string; repo: string };
  publishedSha?: string;
  chatEnabled?: boolean;
  publishedAt?: Date;
  lastDeployError?: AppLastDeployErrorRecord;
  bindingRefreshErrors?: Record<string, AppBindingRefreshErrorRecord>;
  deployProgress?: IAppDeployProgress;
  publicShare?: IPublicShare;
  env?: AppEnvVarJson[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAppProjectInput {
  id?: string;
  workspaceId: string;
  title: string;
  slug?: string;
  path?: string;
  description?: string;
  access?: AppAccessScope;
  workspaceRole?: AppResourceRole;
  sharedWith?: IResourceShareEntry[];
  owner_id?: string;
  createdBy?: string;
  defaultBranch?: string;
  cloudRepo?: { owner: string; repo: string };
  publishedSha?: string;
  chatEnabled?: boolean;
  publishedAt?: Date;
  lastDeployError?: AppLastDeployErrorRecord;
  bindingRefreshErrors?: Record<string, AppBindingRefreshErrorRecord>;
  deployProgress?: IAppDeployProgress;
  publicShare?: IPublicShare;
  env?: AppEnvVarJson[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateAppProjectSharingPatch {
  access?: AppAccessScope;
  workspaceRole?: AppResourceRole;
  sharedWith?: IResourceShareEntry[];
  /** Pass `null` to disable & clear publicShare; `undefined` leaves unchanged. */
  publicShare?: IPublicShare | null;
  chatEnabled?: boolean;
}

export interface UpdateAppProjectLocationPatch {
  /** Pass `null` to unset path. */
  path?: string | null;
  slug?: string;
  title?: string;
  access?: AppAccessScope;
  /** Pass `null` to unset owner_id. */
  ownerId?: string | null;
}

export interface ProjectMoveSyncUpdate {
  appId: string;
  path: string;
  slug: string;
  title: string;
  access?: AppAccessScope;
  ownerId?: string | null;
}

// ── app_index ────────────────────────────────────────────────────────────────

export interface AppIndexEntryRecord {
  id: string;
  workspaceId: string;
  appId: string;
  path: string;
  slug: string;
  scope: AppAccessScope;
  ownerId?: string;
  treeOid: string;
  title: string;
  description?: string;
  hasManifestId: boolean;
  duplicateOf?: string;
  schedules: AppIndexScheduleJson[];
  tables?: string[];
  bindingTables?: AppIndexBindingTablesJson[];
  bindings?: string[];
  authorEmail?: string;
  firstCommitAt?: Date;
  thumbnail?: AppIndexAssetRefJson;
  icon?: AppIndexAssetRefJson;
  indexedSha: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertAppIndexEntryInput {
  id?: string;
  appId: string;
  path: string;
  slug: string;
  scope: AppAccessScope;
  ownerId?: string | null;
  treeOid: string;
  title: string;
  description?: string | null;
  hasManifestId: boolean;
  duplicateOf?: string | null;
  schedules: AppIndexScheduleJson[];
  tables?: string[];
  bindingTables?: AppIndexBindingTablesJson[];
  bindings?: string[];
  authorEmail?: string | null;
  firstCommitAt?: Date | null;
  thumbnail?: AppIndexAssetRefJson | null;
  icon?: AppIndexAssetRefJson | null;
  indexedSha: string;
}

// ── app_index_heads ──────────────────────────────────────────────────────────

export interface AppIndexHeadRecord {
  id: string;
  workspaceId: string;
  sha: string;
  schemaVersion?: number;
  folders: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ── app_embeddings ───────────────────────────────────────────────────────────

export interface AppEmbeddingRecord {
  id: string;
  workspaceId: string;
  appId: string;
  path: string;
  treeOid: string;
  docHash: string;
  embeddingModel: string;
  vector: number[];
  terms?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AppEmbeddingMeta {
  appId: string;
  path: string;
  treeOid: string;
  docHash: string;
  embeddingModel: string;
}

export interface AppEmbeddingVectorEntry {
  appId: string;
  vector: number[];
  terms?: string[];
}

export interface UpsertAppEmbeddingInput {
  id?: string;
  appId: string;
  path: string;
  treeOid: string;
  docHash: string;
  embeddingModel: string;
  vector: number[];
  terms?: string[];
}

export interface AppEmbeddingPathUpdate {
  appId: string;
  path: string;
  treeOid: string;
}

// ── app_lifecycle ────────────────────────────────────────────────────────────

export interface AppLifecycleRecord {
  id: string;
  workspaceId: string;
  appId: string;
  verifiedAt?: Date;
  verifiedBy?: string;
  staleSince?: Date;
  staleNotifiedTo?: string[];
  schedulesPausedAt?: Date;
  archivedAt?: Date;
  archivedFrom?: string;
  archivedTo?: string;
  restoredAt?: Date;
  restoredBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppLifecyclePatch {
  set?: Partial<{
    verifiedAt: Date;
    verifiedBy: string;
    staleSince: Date;
    staleNotifiedTo: string[];
    schedulesPausedAt: Date;
    archivedAt: Date;
    archivedFrom: string;
    archivedTo: string;
    restoredAt: Date;
    restoredBy: string;
  }>;
  unset?: Array<
    | "verifiedAt"
    | "verifiedBy"
    | "staleSince"
    | "staleNotifiedTo"
    | "schedulesPausedAt"
    | "archivedAt"
    | "archivedFrom"
    | "archivedTo"
    | "restoredAt"
    | "restoredBy"
  >;
}

// ── app_deploy_commit_statuses ───────────────────────────────────────────────

export interface AppDeployCommitStatusRecord {
  id: string;
  workspaceId: string;
  appId: string;
  sha: string;
  state: AppDeployCommitStatePg;
  createdAt: Date;
  updatedAt: Date;
}

// ── app_worktrees ────────────────────────────────────────────────────────────

export interface AppWorktreeRecord {
  id: string;
  workspaceId: string;
  projectId?: string;
  /** User ID or system actor (`"publish"`, `"api-key"`). */
  userId: string;
  branch: string;
  lastActivityAt?: Date;
  activeUntil?: Date;
  idlePausedAt?: Date[];
  idlePauseHoldUntil?: Date;
  idlePauseHoldSetAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface HotWorktreeWorkspaceRecord {
  workspaceId: string;
  at: Date;
}

// ── app_binding_state ────────────────────────────────────────────────────────

export interface AppBindingRunRecord {
  at: Date;
  status: "ready" | "error";
  rowCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
  artifactKey?: string | null;
  byteSize?: number | null;
  compression?: ParquetCodec | null;
}

export interface AppBindingStateRecord {
  id: string;
  projectId: string;
  name: string;
  lastMaterializedAt?: Date;
  lastRowCount?: number;
  publicRefreshAt?: Date;
  history?: AppBindingRunRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BindingStateSummaryRecord {
  projectId: string;
  name: string;
  lastMaterializedAt?: Date;
  history?: AppBindingRunRecord[];
}

export type ClaimPublicBindingRefreshResult =
  { claimed: true } | { claimed: false; retryAfterMs: number };

// ── app_binding_drafts ───────────────────────────────────────────────────────

export interface AppBindingDraftRecord {
  id: string;
  projectId: string;
  hash: string;
  kind: AppBindingDraftKind;
  name: string;
  key?: string | null;
  builtAt?: Date | null;
  rowCount?: number | null;
  byteSize?: number | null;
  failures?: number;
  until?: Date | null;
  error?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBindingDraftBuildInput {
  id?: string;
  projectId: string;
  hash: string;
  name: string;
  key: string;
  builtAt: Date;
  rowCount: number;
  byteSize: number;
  expiresAt: Date;
}

export interface UpsertBindingDraftFailureInput {
  id?: string;
  projectId: string;
  hash: string;
  name: string;
  failures: number;
  until: Date;
  error: string;
  expiresAt: Date;
}

// ── app_binding_jobs ─────────────────────────────────────────────────────────

export interface AppBindingJobProgressRecord {
  phase: string;
  rowsWritten?: number;
  bytes?: number;
  at: Date;
}

export interface AppBindingJobRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  kind?: AppBindingJobKindPg;
  actorId: string;
  userId?: string;
  canWrite: boolean;
  unregistered?: boolean;
  request: AppBindingJobRequestJson;
  status: AppBindingJobStatusPg;
  result?: AppBindingJobResultJson | null;
  error?: string | null;
  errorStatus?: number | null;
  heartbeatAt?: Date | null;
  progress?: AppBindingJobProgressRecord | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBindingJobInput {
  id?: string;
  workspaceId: string;
  projectId: string;
  name: string;
  kind?: AppBindingJobKindPg;
  actorId: string;
  userId?: string;
  canWrite: boolean;
  unregistered?: boolean;
  request: AppBindingJobRequestJson;
  expiresAt: Date;
}

export type MarkBindingJobUpdate =
  | { status: "running" }
  | { status: "ready"; result: AppBindingJobResultJson }
  | { status: "error"; error: string; errorStatus: number };

// ── Repository Contract ──────────────────────────────────────────────────────

export interface AppsMetadataRepository {
  // 1. app_projects
  findProjectById(
    id: string,
    workspaceId?: string,
  ): Promise<AppProjectRecord | null>;
  findProjectByPath(
    workspaceId: string,
    path: string,
  ): Promise<AppProjectRecord | null>;
  findProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<AppProjectRecord | null>;
  findProjectByShareToken(token: string): Promise<AppProjectRecord | null>;
  isShareTokenTaken(token: string, excludeId?: string): Promise<boolean>;
  projectExistsMatching(params: {
    id: string;
    workspaceId: string;
    path: string;
    slug: string;
  }): Promise<boolean>;
  listProjectsByWorkspace(workspaceId: string): Promise<AppProjectRecord[]>;
  listProjectsByIds(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<AppProjectRecord[]>;
  listForeignProjectIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
  ): Promise<string[]>;
  listExistingProjectIds(ids: readonly string[]): Promise<string[]>;
  listDistinctProjectWorkspaceIds(): Promise<string[]>;
  listPublishedProjects(): Promise<AppProjectRecord[]>;
  listOwnerlessProjects(workspaceId?: string): Promise<AppProjectRecord[]>;
  createProject(input: CreateAppProjectInput): Promise<AppProjectRecord>;
  claimOwnerlessProjectRow(
    workspaceId: string,
    id: string,
    ownerId: string,
  ): Promise<boolean>;
  updateProjectSharing(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectSharingPatch,
  ): Promise<void>;
  updateProjectEnv(
    workspaceId: string,
    id: string,
    env: AppEnvVarJson[],
  ): Promise<void>;
  updateProjectLocation(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectLocationPatch,
    expectedPath?: string,
  ): Promise<void>;
  unsetProjectsPath(workspaceId: string, ids: readonly string[]): Promise<void>;
  syncMovedProjects(
    workspaceId: string,
    updates: readonly ProjectMoveSyncUpdate[],
  ): Promise<void>;
  setDeployProgressQueued(
    workspaceId: string,
    id: string,
    progress: IAppDeployProgress,
  ): Promise<void>;
  advanceDeployProgressStage(
    workspaceId: string,
    id: string,
    sha: string,
    stage: AppDeployStage,
    now: Date,
    staleBefore: Date,
  ): Promise<void>;
  updateDeployProgressBindings(
    workspaceId: string,
    id: string,
    sha: string,
    bindings: NonNullable<IAppDeployProgress["bindings"]>,
    now: Date,
  ): Promise<void>;
  clearDeployProgress(
    workspaceId: string,
    id: string,
    sha: string,
  ): Promise<void>;
  setPublishedSha(
    workspaceId: string,
    id: string,
    sha: string,
    publishedAt: Date,
    expectedSha?: string | null,
  ): Promise<{ matched: boolean }>;
  clearPublishedSha(workspaceId: string, id: string): Promise<void>;
  setLastDeployError(
    workspaceId: string,
    id: string,
    error: AppLastDeployErrorRecord,
  ): Promise<void>;
  clearLastDeployErrorIfSha(
    workspaceId: string,
    id: string,
    failedSha: string,
  ): Promise<void>;
  setBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
    error: AppBindingRefreshErrorRecord,
  ): Promise<void>;
  clearBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
  ): Promise<void>;
  deleteProject(workspaceId: string, id: string): Promise<void>;
  deleteProjectsByWorkspace(workspaceId: string): Promise<number>;

  // 2. app_index
  listIndexEntriesByWorkspace(
    workspaceId: string,
  ): Promise<AppIndexEntryRecord[]>;
  findIndexEntryByAppId(
    appId: string,
    workspaceId?: string,
  ): Promise<AppIndexEntryRecord | null>;
  indexEntryExistsByAppId(appId: string): Promise<boolean>;
  listIndexEntriesBySlugAndScope(
    slug: string,
    scope: AppAccessScope,
    limit: number,
  ): Promise<Array<{ workspaceId: string; appId: string }>>;
  listIndexEntriesWithSchedules(): Promise<
    Array<{
      workspaceId: string;
      appId: string;
      schedules: AppIndexScheduleJson[];
    }>
  >;
  listIndexEntriesByAppIds(
    appIds: readonly string[],
  ): Promise<Array<{ workspaceId: string; appId: string; path: string }>>;
  listForeignIndexAppIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
  ): Promise<string[]>;
  listDistinctWorkspaceIdsWithThumbnails(): Promise<string[]>;
  listDistinctIndexWorkspaceIds(): Promise<string[]>;
  replaceWorkspaceIndexEntries(
    workspaceId: string,
    staleEntryIds: readonly string[],
    entries: readonly UpsertAppIndexEntryInput[],
  ): Promise<void>;

  // 3. app_index_heads
  findIndexHeadByWorkspace(
    workspaceId: string,
  ): Promise<AppIndexHeadRecord | null>;
  upsertIndexHead(
    workspaceId: string,
    input: { sha: string; schemaVersion: number; folders: string[] },
  ): Promise<void>;

  // 4. app_embeddings
  listEmbeddingsMetaByWorkspace(
    workspaceId: string,
  ): Promise<AppEmbeddingMeta[]>;
  listEmbeddingsByWorkspaceAndModel(
    workspaceId: string,
    embeddingModel: string,
  ): Promise<AppEmbeddingVectorEntry[]>;
  deleteEmbeddingsByAppIds(
    workspaceId: string,
    appIds: readonly string[],
  ): Promise<void>;
  upsertEmbeddingsBatch(
    workspaceId: string,
    fullUpserts: readonly UpsertAppEmbeddingInput[],
    pathOnlyUpdates: readonly AppEmbeddingPathUpdate[],
  ): Promise<void>;

  // 5. app_lifecycle
  listLifecycleByWorkspace(workspaceId: string): Promise<AppLifecycleRecord[]>;
  listLifecycleByArchivedTo(
    workspaceId: string,
    archivedToPaths: readonly string[],
  ): Promise<Array<{ archivedTo: string; archivedFrom: string }>>;
  listVerifiedAppIds(workspaceId: string): Promise<string[]>;
  listPausedScheduleAppIds(): Promise<string[]>;
  clearStaleAndPausedOnOpen(workspaceId: string, appId: string): Promise<void>;
  markAppRestored(
    workspaceId: string,
    appId: string,
    restoredAt: Date,
    restoredBy?: string,
  ): Promise<void>;
  upsertLifecyclePatch(
    workspaceId: string,
    appId: string,
    patch: AppLifecyclePatch,
  ): Promise<void>;

  // 6. app_deploy_commit_statuses
  listPendingCommitStatusesExcludingSha(
    workspaceId: string,
    appId: string,
    excludeSha: string,
  ): Promise<string[]>;
  casResolvePendingCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    newState: AppDeployCommitStatePg,
  ): Promise<boolean>;
  upsertCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    state: AppDeployCommitStatePg,
  ): Promise<void>;

  // 7. app_worktrees
  findWorktree(
    workspaceId: string,
    actorId: string,
  ): Promise<AppWorktreeRecord | null>;
  ensureWorktreeRow(
    workspaceId: string,
    actorId: string,
    defaultBranch: string,
  ): Promise<AppWorktreeRecord>;
  updateWorktreeBranch(
    workspaceId: string,
    actorId: string,
    branch: string,
  ): Promise<void>;
  bumpWorktreeActivity(
    workspaceId: string,
    actorId: string,
    lastActivityAt: Date,
    activeUntil?: Date,
  ): Promise<void>;
  listWorktreesActivity(
    pairs: ReadonlyArray<{ workspaceId: string; actorId: string }>,
  ): Promise<
    Array<{
      workspaceId: string;
      userId: string;
      lastActivityAt: Date | null;
      activeUntil: Date | null;
    }>
  >;
  getWorktreePauseHistory(
    workspaceId: string,
    actorId: string,
  ): Promise<{
    pausedAt: Date[];
    holdUntil: Date | null;
    holdSetAt: Date | null;
  }>;
  recordWorktreePause(
    workspaceId: string,
    actorId: string,
    at: Date,
  ): Promise<void>;
  holdWorktreePausing(
    workspaceId: string,
    actorId: string,
    until: Date,
    setAt: Date,
  ): Promise<void>;
  listHotWorktreeWorkspacesSince(
    since: Date,
  ): Promise<HotWorktreeWorkspaceRecord[]>;

  // 8. app_binding_state
  getBindingState(
    projectId: string,
    name: string,
    workspaceId?: string,
  ): Promise<AppBindingStateRecord | null>;
  listBindingStatesByProjects(
    workspaceId: string,
    projectIds: readonly string[],
  ): Promise<BindingStateSummaryRecord[]>;
  recordBindingRun(
    projectId: string,
    name: string,
    run: AppBindingRunRecord,
    workspaceId?: string,
  ): Promise<void>;
  claimPublicBindingRefresh(
    projectId: string,
    name: string,
    cooldownMs: number,
    now?: Date,
    workspaceId?: string,
  ): Promise<ClaimPublicBindingRefreshResult>;

  // 9. app_binding_drafts (app-pruned with artifact blob cleanup!)
  findActiveDraftBuild(
    projectId: string,
    hash: string,
    now: Date,
    workspaceId?: string,
  ): Promise<AppBindingDraftRecord | null>;
  findDraftFailure(
    projectId: string,
    hash: string,
    workspaceId?: string,
  ): Promise<AppBindingDraftRecord | null>;
  createDraftBuild(
    input: CreateBindingDraftBuildInput,
    workspaceId?: string,
  ): Promise<AppBindingDraftRecord>;
  deleteDraftFailures(
    projectId: string,
    hash: string,
    workspaceId?: string,
  ): Promise<void>;
  deleteDraftBuildByKey(
    projectId: string,
    key: string,
    workspaceId?: string,
  ): Promise<void>;
  upsertDraftFailure(
    input: UpsertBindingDraftFailureInput,
    workspaceId?: string,
  ): Promise<void>;
  listExpiredDrafts(
    projectId: string,
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<Array<{ id: string; key: string | null }>>;
  deleteDraftsByIds(
    projectId: string,
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<void>;

  // 10. app_binding_jobs (app-pruned with artifact blob cleanup!)
  createBindingJob(input: CreateBindingJobInput): Promise<AppBindingJobRecord>;
  findBindingJobById(
    jobId: string,
    projectId?: string,
    workspaceId?: string,
  ): Promise<AppBindingJobRecord | null>;
  casFailStaleBindingJob(
    jobId: string,
    staleBefore: Date,
    error: string,
    errorStatus: number,
    newExpiresAt: Date,
    workspaceId?: string,
  ): Promise<AppBindingJobRecord | null>;
  listStaleRunningBindingJobs(
    staleBefore: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      workspaceId: string;
      projectId: string;
      heartbeatAt: Date | null;
    }>
  >;
  heartbeatBindingJob(
    jobId: string,
    now: Date,
    newExpiresAt: Date,
    workspaceId?: string,
  ): Promise<void>;
  updateBindingJobProgress(
    jobId: string,
    progress: AppBindingJobProgressRecord,
    workspaceId?: string,
  ): Promise<void>;
  markBindingJob(
    jobId: string,
    update: MarkBindingJobUpdate,
    newExpiresAt: Date,
    heartbeatAt?: Date,
    workspaceId?: string,
  ): Promise<void>;
  listExpiredFinishedBindingJobs(
    projectId: string,
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<Array<{ id: string; result: AppBindingJobRecord["result"] }>>;
  deleteBindingJobsByIds(
    projectId: string,
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<void>;
}
