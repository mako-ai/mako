/**
 * Apps metadata domain repository entry point (Neon Postgres `pg_only`).
 */
import { createPgFirstRepoProxy } from "../resolve-repo";
import { MongoAppsMetadataRepository } from "./mongo.repo";
import { PgAppsMetadataRepository } from "./pg.repo";
import type { AppsMetadataRepository } from "./types";

export * from "./types";
export * from "./mapper";
export {
  MongoAppsMetadataRepository,
  getMongoAppBindingDraftModel,
  getMongoAppBindingJobModel,
  getMongoAppBindingStateModel,
} from "./mongo.repo";
export { PgAppsMetadataRepository } from "./pg.repo";

const defaultAppsMetadataRepo: AppsMetadataRepository =
  createPgFirstRepoProxy<AppsMetadataRepository>(
    "apps_metadata",
    new PgAppsMetadataRepository(),
    new MongoAppsMetadataRepository(),
  );
let activeAppsMetadataRepo: AppsMetadataRepository = defaultAppsMetadataRepo;

export function getAppsMetadataRepo(): AppsMetadataRepository {
  return activeAppsMetadataRepo;
}

export function setAppsMetadataRepoForTests(
  repo: AppsMetadataRepository,
): void {
  activeAppsMetadataRepo = repo;
}

export function resetAppsMetadataRepoForTests(): void {
  activeAppsMetadataRepo = defaultAppsMetadataRepo;
}

export const appsMetadataRepo: AppsMetadataRepository = {
  // 1. app_projects
  findProjectById: (id, workspaceId) =>
    activeAppsMetadataRepo.findProjectById(id, workspaceId),
  findProjectByPath: (workspaceId, path) =>
    activeAppsMetadataRepo.findProjectByPath(workspaceId, path),
  findProjectBySlug: (workspaceId, slug) =>
    activeAppsMetadataRepo.findProjectBySlug(workspaceId, slug),
  findProjectByShareToken: token =>
    activeAppsMetadataRepo.findProjectByShareToken(token),
  isShareTokenTaken: (token, excludeId) =>
    activeAppsMetadataRepo.isShareTokenTaken(token, excludeId),
  projectExistsMatching: params =>
    activeAppsMetadataRepo.projectExistsMatching(params),
  listProjectsByWorkspace: workspaceId =>
    activeAppsMetadataRepo.listProjectsByWorkspace(workspaceId),
  listProjectsByIds: (workspaceId, ids) =>
    activeAppsMetadataRepo.listProjectsByIds(workspaceId, ids),
  listForeignProjectIds: (excludeWorkspaceId, candidateIds) =>
    activeAppsMetadataRepo.listForeignProjectIds(
      excludeWorkspaceId,
      candidateIds,
    ),
  listExistingProjectIds: ids =>
    activeAppsMetadataRepo.listExistingProjectIds(ids),
  listDistinctProjectWorkspaceIds: () =>
    activeAppsMetadataRepo.listDistinctProjectWorkspaceIds(),
  listPublishedProjects: () => activeAppsMetadataRepo.listPublishedProjects(),
  listOwnerlessProjects: workspaceId =>
    activeAppsMetadataRepo.listOwnerlessProjects(workspaceId),
  createProject: input => activeAppsMetadataRepo.createProject(input),
  claimOwnerlessProjectRow: (workspaceId, id, ownerId) =>
    activeAppsMetadataRepo.claimOwnerlessProjectRow(workspaceId, id, ownerId),
  updateProjectSharing: (workspaceId, id, patch) =>
    activeAppsMetadataRepo.updateProjectSharing(workspaceId, id, patch),
  updateProjectEnv: (workspaceId, id, env) =>
    activeAppsMetadataRepo.updateProjectEnv(workspaceId, id, env),
  updateProjectLocation: (workspaceId, id, patch, expectedPath) =>
    activeAppsMetadataRepo.updateProjectLocation(
      workspaceId,
      id,
      patch,
      expectedPath,
    ),
  unsetProjectsPath: (workspaceId, ids) =>
    activeAppsMetadataRepo.unsetProjectsPath(workspaceId, ids),
  syncMovedProjects: (workspaceId, updates) =>
    activeAppsMetadataRepo.syncMovedProjects(workspaceId, updates),
  setDeployProgressQueued: (workspaceId, id, progress) =>
    activeAppsMetadataRepo.setDeployProgressQueued(workspaceId, id, progress),
  advanceDeployProgressStage: (workspaceId, id, sha, stage, now, staleBefore) =>
    activeAppsMetadataRepo.advanceDeployProgressStage(
      workspaceId,
      id,
      sha,
      stage,
      now,
      staleBefore,
    ),
  updateDeployProgressBindings: (workspaceId, id, sha, bindings, now) =>
    activeAppsMetadataRepo.updateDeployProgressBindings(
      workspaceId,
      id,
      sha,
      bindings,
      now,
    ),
  clearDeployProgress: (workspaceId, id, sha) =>
    activeAppsMetadataRepo.clearDeployProgress(workspaceId, id, sha),
  setPublishedSha: (workspaceId, id, sha, publishedAt, expectedSha) =>
    activeAppsMetadataRepo.setPublishedSha(
      workspaceId,
      id,
      sha,
      publishedAt,
      expectedSha,
    ),
  clearPublishedSha: (workspaceId, id) =>
    activeAppsMetadataRepo.clearPublishedSha(workspaceId, id),
  setLastDeployError: (workspaceId, id, error) =>
    activeAppsMetadataRepo.setLastDeployError(workspaceId, id, error),
  clearLastDeployErrorIfSha: (workspaceId, id, failedSha) =>
    activeAppsMetadataRepo.clearLastDeployErrorIfSha(
      workspaceId,
      id,
      failedSha,
    ),
  setBindingRefreshError: (workspaceId, id, binding, error) =>
    activeAppsMetadataRepo.setBindingRefreshError(
      workspaceId,
      id,
      binding,
      error,
    ),
  clearBindingRefreshError: (workspaceId, id, binding) =>
    activeAppsMetadataRepo.clearBindingRefreshError(workspaceId, id, binding),
  deleteProject: (workspaceId, id) =>
    activeAppsMetadataRepo.deleteProject(workspaceId, id),
  deleteProjectsByWorkspace: workspaceId =>
    activeAppsMetadataRepo.deleteProjectsByWorkspace(workspaceId),

  // 2. app_index
  listIndexEntriesByWorkspace: workspaceId =>
    activeAppsMetadataRepo.listIndexEntriesByWorkspace(workspaceId),
  findIndexEntryByAppId: (appId, workspaceId) =>
    activeAppsMetadataRepo.findIndexEntryByAppId(appId, workspaceId),
  indexEntryExistsByAppId: appId =>
    activeAppsMetadataRepo.indexEntryExistsByAppId(appId),
  listIndexEntriesBySlugAndScope: (slug, scope, limit) =>
    activeAppsMetadataRepo.listIndexEntriesBySlugAndScope(slug, scope, limit),
  listIndexEntriesWithSchedules: () =>
    activeAppsMetadataRepo.listIndexEntriesWithSchedules(),
  listIndexEntriesByAppIds: appIds =>
    activeAppsMetadataRepo.listIndexEntriesByAppIds(appIds),
  listForeignIndexAppIds: (excludeWorkspaceId, candidateIds) =>
    activeAppsMetadataRepo.listForeignIndexAppIds(
      excludeWorkspaceId,
      candidateIds,
    ),
  listDistinctWorkspaceIdsWithThumbnails: () =>
    activeAppsMetadataRepo.listDistinctWorkspaceIdsWithThumbnails(),
  listDistinctIndexWorkspaceIds: () =>
    activeAppsMetadataRepo.listDistinctIndexWorkspaceIds(),
  replaceWorkspaceIndexEntries: (workspaceId, staleEntryIds, entries) =>
    activeAppsMetadataRepo.replaceWorkspaceIndexEntries(
      workspaceId,
      staleEntryIds,
      entries,
    ),

  // 3. app_index_heads
  findIndexHeadByWorkspace: workspaceId =>
    activeAppsMetadataRepo.findIndexHeadByWorkspace(workspaceId),
  upsertIndexHead: (workspaceId, input) =>
    activeAppsMetadataRepo.upsertIndexHead(workspaceId, input),

  // 4. app_embeddings
  listEmbeddingsMetaByWorkspace: workspaceId =>
    activeAppsMetadataRepo.listEmbeddingsMetaByWorkspace(workspaceId),
  listEmbeddingsByWorkspaceAndModel: (workspaceId, embeddingModel) =>
    activeAppsMetadataRepo.listEmbeddingsByWorkspaceAndModel(
      workspaceId,
      embeddingModel,
    ),
  deleteEmbeddingsByAppIds: (workspaceId, appIds) =>
    activeAppsMetadataRepo.deleteEmbeddingsByAppIds(workspaceId, appIds),
  upsertEmbeddingsBatch: (workspaceId, fullUpserts, pathOnlyUpdates) =>
    activeAppsMetadataRepo.upsertEmbeddingsBatch(
      workspaceId,
      fullUpserts,
      pathOnlyUpdates,
    ),

  // 5. app_lifecycle
  listLifecycleByWorkspace: workspaceId =>
    activeAppsMetadataRepo.listLifecycleByWorkspace(workspaceId),
  listLifecycleByArchivedTo: (workspaceId, archivedToPaths) =>
    activeAppsMetadataRepo.listLifecycleByArchivedTo(
      workspaceId,
      archivedToPaths,
    ),
  listVerifiedAppIds: workspaceId =>
    activeAppsMetadataRepo.listVerifiedAppIds(workspaceId),
  listPausedScheduleAppIds: () =>
    activeAppsMetadataRepo.listPausedScheduleAppIds(),
  clearStaleAndPausedOnOpen: (workspaceId, appId) =>
    activeAppsMetadataRepo.clearStaleAndPausedOnOpen(workspaceId, appId),
  markAppRestored: (workspaceId, appId, restoredAt, restoredBy) =>
    activeAppsMetadataRepo.markAppRestored(
      workspaceId,
      appId,
      restoredAt,
      restoredBy,
    ),
  upsertLifecyclePatch: (workspaceId, appId, patch) =>
    activeAppsMetadataRepo.upsertLifecyclePatch(workspaceId, appId, patch),

  // 6. app_deploy_commit_statuses
  listPendingCommitStatusesExcludingSha: (workspaceId, appId, excludeSha) =>
    activeAppsMetadataRepo.listPendingCommitStatusesExcludingSha(
      workspaceId,
      appId,
      excludeSha,
    ),
  casResolvePendingCommitStatus: (workspaceId, appId, sha, newState) =>
    activeAppsMetadataRepo.casResolvePendingCommitStatus(
      workspaceId,
      appId,
      sha,
      newState,
    ),
  upsertCommitStatus: (workspaceId, appId, sha, state) =>
    activeAppsMetadataRepo.upsertCommitStatus(workspaceId, appId, sha, state),

  // 7. app_worktrees
  findWorktree: (workspaceId, actorId) =>
    activeAppsMetadataRepo.findWorktree(workspaceId, actorId),
  ensureWorktreeRow: (workspaceId, actorId, defaultBranch) =>
    activeAppsMetadataRepo.ensureWorktreeRow(
      workspaceId,
      actorId,
      defaultBranch,
    ),
  updateWorktreeBranch: (workspaceId, actorId, branch) =>
    activeAppsMetadataRepo.updateWorktreeBranch(workspaceId, actorId, branch),
  bumpWorktreeActivity: (workspaceId, actorId, lastActivityAt, activeUntil) =>
    activeAppsMetadataRepo.bumpWorktreeActivity(
      workspaceId,
      actorId,
      lastActivityAt,
      activeUntil,
    ),
  listWorktreesActivity: pairs =>
    activeAppsMetadataRepo.listWorktreesActivity(pairs),
  getWorktreePauseHistory: (workspaceId, actorId) =>
    activeAppsMetadataRepo.getWorktreePauseHistory(workspaceId, actorId),
  recordWorktreePause: (workspaceId, actorId, at) =>
    activeAppsMetadataRepo.recordWorktreePause(workspaceId, actorId, at),
  holdWorktreePausing: (workspaceId, actorId, until, setAt) =>
    activeAppsMetadataRepo.holdWorktreePausing(
      workspaceId,
      actorId,
      until,
      setAt,
    ),
  listHotWorktreeWorkspacesSince: since =>
    activeAppsMetadataRepo.listHotWorktreeWorkspacesSince(since),

  // 8. app_binding_state
  getBindingState: (projectId, name, workspaceId) =>
    activeAppsMetadataRepo.getBindingState(projectId, name, workspaceId),
  listBindingStatesByProjects: (workspaceId, projectIds) =>
    activeAppsMetadataRepo.listBindingStatesByProjects(workspaceId, projectIds),
  recordBindingRun: (projectId, name, run, workspaceId) =>
    activeAppsMetadataRepo.recordBindingRun(projectId, name, run, workspaceId),
  claimPublicBindingRefresh: (projectId, name, cooldownMs, now, workspaceId) =>
    activeAppsMetadataRepo.claimPublicBindingRefresh(
      projectId,
      name,
      cooldownMs,
      now,
      workspaceId,
    ),

  // 9. app_binding_drafts
  findActiveDraftBuild: (projectId, hash, now, workspaceId) =>
    activeAppsMetadataRepo.findActiveDraftBuild(
      projectId,
      hash,
      now,
      workspaceId,
    ),
  findDraftFailure: (projectId, hash, workspaceId) =>
    activeAppsMetadataRepo.findDraftFailure(projectId, hash, workspaceId),
  createDraftBuild: (input, workspaceId) =>
    activeAppsMetadataRepo.createDraftBuild(input, workspaceId),
  deleteDraftFailures: (projectId, hash, workspaceId) =>
    activeAppsMetadataRepo.deleteDraftFailures(projectId, hash, workspaceId),
  deleteDraftBuildByKey: (projectId, key, workspaceId) =>
    activeAppsMetadataRepo.deleteDraftBuildByKey(projectId, key, workspaceId),
  upsertDraftFailure: (input, workspaceId) =>
    activeAppsMetadataRepo.upsertDraftFailure(input, workspaceId),
  listExpiredDrafts: (projectId, now, limit, workspaceId) =>
    activeAppsMetadataRepo.listExpiredDrafts(
      projectId,
      now,
      limit,
      workspaceId,
    ),
  deleteDraftsByIds: (projectId, ids, workspaceId) =>
    activeAppsMetadataRepo.deleteDraftsByIds(projectId, ids, workspaceId),

  // 10. app_binding_jobs
  createBindingJob: input => activeAppsMetadataRepo.createBindingJob(input),
  findBindingJobById: (jobId, projectId, workspaceId) =>
    activeAppsMetadataRepo.findBindingJobById(jobId, projectId, workspaceId),
  casFailStaleBindingJob: (
    jobId,
    staleBefore,
    error,
    errorStatus,
    newExpiresAt,
    workspaceId,
  ) =>
    activeAppsMetadataRepo.casFailStaleBindingJob(
      jobId,
      staleBefore,
      error,
      errorStatus,
      newExpiresAt,
      workspaceId,
    ),
  listStaleRunningBindingJobs: (staleBefore, limit) =>
    activeAppsMetadataRepo.listStaleRunningBindingJobs(staleBefore, limit),
  heartbeatBindingJob: (jobId, now, newExpiresAt, workspaceId) =>
    activeAppsMetadataRepo.heartbeatBindingJob(
      jobId,
      now,
      newExpiresAt,
      workspaceId,
    ),
  updateBindingJobProgress: (jobId, progress, workspaceId) =>
    activeAppsMetadataRepo.updateBindingJobProgress(
      jobId,
      progress,
      workspaceId,
    ),
  markBindingJob: (jobId, update, newExpiresAt, heartbeatAt, workspaceId) =>
    activeAppsMetadataRepo.markBindingJob(
      jobId,
      update,
      newExpiresAt,
      heartbeatAt,
      workspaceId,
    ),
  listExpiredFinishedBindingJobs: (projectId, now, limit, workspaceId) =>
    activeAppsMetadataRepo.listExpiredFinishedBindingJobs(
      projectId,
      now,
      limit,
      workspaceId,
    ),
  deleteBindingJobsByIds: (projectId, ids, workspaceId) =>
    activeAppsMetadataRepo.deleteBindingJobsByIds(projectId, ids, workspaceId),
};
