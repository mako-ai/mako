/**
 * Consoles & Charts domain repository entry point (`consoles_charts` — 7 tables).
 *
 * Exports the singleton `consolesChartsRepo` (backed by `DualConsolesChartsRepository`,
 * defaulting to `mongo_only` until `migration_domain_state` advances a workspace or global
 * scope) plus test override hooks and concrete repository classes.
 */
import { DualConsolesChartsRepository } from "./dual.repo";
import type { ConsolesChartsRepository } from "./types";

export * from "./types";
export * from "./mapper";
export { MongoConsolesChartsRepository } from "./mongo.repo";
export {
  PgConsolesChartsRepository,
  type PgConsolesChartsRepositoryDeps,
} from "./pg.repo";
export {
  CONSOLES_CHARTS_DOMAIN,
  CONSOLES_CHARTS_SHADOW_OPTIONS,
  DualConsolesChartsRepository,
  type DualConsolesChartsRepositoryDeps,
} from "./dual.repo";

const defaultConsolesChartsRepo: ConsolesChartsRepository =
  new DualConsolesChartsRepository();
let activeConsolesChartsRepo: ConsolesChartsRepository =
  defaultConsolesChartsRepo;

export function getConsolesChartsRepo(): ConsolesChartsRepository {
  return activeConsolesChartsRepo;
}

export function setConsolesChartsRepoForTests(
  repo: ConsolesChartsRepository,
): void {
  activeConsolesChartsRepo = repo;
}

export function resetConsolesChartsRepoForTests(): void {
  activeConsolesChartsRepo = defaultConsolesChartsRepo;
}

/**
 * Delegating proxy singleton so callers importing `consolesChartsRepo` directly
 * automatically observe `setConsolesChartsRepoForTests()` / `resetConsolesChartsRepoForTests()`.
 */
export const consolesChartsRepo: ConsolesChartsRepository = {
  // 1. Console folders
  listConsoleFolders: (workspaceId, opts) =>
    activeConsolesChartsRepo.listConsoleFolders(workspaceId, opts),
  findConsoleFolderById: (workspaceId, folderId) =>
    activeConsolesChartsRepo.findConsoleFolderById(workspaceId, folderId),
  findConsoleFoldersByIds: (workspaceId, folderIds) =>
    activeConsolesChartsRepo.findConsoleFoldersByIds(workspaceId, folderIds),
  findConsoleFolderByNameAndParent: (workspaceId, name, parentId) =>
    activeConsolesChartsRepo.findConsoleFolderByNameAndParent(
      workspaceId,
      name,
      parentId,
    ),
  listChildConsoleFolders: (workspaceId, parentId) =>
    activeConsolesChartsRepo.listChildConsoleFolders(workspaceId, parentId),
  createConsoleFolder: input =>
    activeConsolesChartsRepo.createConsoleFolder(input),
  updateConsoleFolder: (workspaceId, folderId, patch) =>
    activeConsolesChartsRepo.updateConsoleFolder(workspaceId, folderId, patch),
  deleteConsoleFolder: (workspaceId, folderId) =>
    activeConsolesChartsRepo.deleteConsoleFolder(workspaceId, folderId),
  wouldCreateConsoleFolderCycle: (workspaceId, folderId, targetParentId) =>
    activeConsolesChartsRepo.wouldCreateConsoleFolderCycle(
      workspaceId,
      folderId,
      targetParentId,
    ),

  // 2. Saved consoles
  findConsoleById: (workspaceId, consoleId, opts) =>
    activeConsolesChartsRepo.findConsoleById(workspaceId, consoleId, opts),
  findConsoleByIdGlobal: (consoleId, opts) =>
    activeConsolesChartsRepo.findConsoleByIdGlobal(consoleId, opts),
  findConsolesByIds: (workspaceId, consoleIds) =>
    activeConsolesChartsRepo.findConsolesByIds(workspaceId, consoleIds),
  findConsoleByPath: (workspaceId, path, opts) =>
    activeConsolesChartsRepo.findConsoleByPath(workspaceId, path, opts),
  findConsoleByNameAndFolder: (workspaceId, name, folderId, opts) =>
    activeConsolesChartsRepo.findConsoleByNameAndFolder(
      workspaceId,
      name,
      folderId,
      opts,
    ),
  listConsolesByWorkspace: (workspaceId, filter) =>
    activeConsolesChartsRepo.listConsolesByWorkspace(workspaceId, filter),
  listConsolesNeedingDescription: opts =>
    activeConsolesChartsRepo.listConsolesNeedingDescription(opts),
  createConsole: input => activeConsolesChartsRepo.createConsole(input),
  updateConsole: (workspaceId, consoleId, patch) =>
    activeConsolesChartsRepo.updateConsole(workspaceId, consoleId, patch),
  updateConsolesInFolder: (workspaceId, folderId, patch) =>
    activeConsolesChartsRepo.updateConsolesInFolder(
      workspaceId,
      folderId,
      patch,
    ),
  guardedSaveConsole: input =>
    activeConsolesChartsRepo.guardedSaveConsole(input),
  bumpConsoleDraftRevision: (workspaceId, consoleId) =>
    activeConsolesChartsRepo.bumpConsoleDraftRevision(workspaceId, consoleId),
  recordConsoleExecution: (workspaceId, consoleId, input) =>
    activeConsolesChartsRepo.recordConsoleExecution(
      workspaceId,
      consoleId,
      input,
    ),
  recordConsoleExternalUse: (workspaceId, consoleId, source, mode, now) =>
    activeConsolesChartsRepo.recordConsoleExternalUse(
      workspaceId,
      consoleId,
      source,
      mode,
      now,
    ),
  guardedUpdateConsoleDescription: (
    workspaceId,
    consoleId,
    expectedSourceBlobSha,
    patch,
  ) =>
    activeConsolesChartsRepo.guardedUpdateConsoleDescription(
      workspaceId,
      consoleId,
      expectedSourceBlobSha,
      patch,
    ),
  softDeleteConsole: (workspaceId, consoleId, deletedAt, opts) =>
    activeConsolesChartsRepo.softDeleteConsole(
      workspaceId,
      consoleId,
      deletedAt,
      opts,
    ),
  restoreConsole: (workspaceId, consoleId, patch) =>
    activeConsolesChartsRepo.restoreConsole(workspaceId, consoleId, patch),
  deleteConsolesInFolder: (workspaceId, folderId) =>
    activeConsolesChartsRepo.deleteConsolesInFolder(workspaceId, folderId),
  updateConsoleScheduleOutcome: input =>
    activeConsolesChartsRepo.updateConsoleScheduleOutcome(input),
  clearConsoleSchedule: (workspaceId, consoleId, patch) =>
    activeConsolesChartsRepo.clearConsoleSchedule(
      workspaceId,
      consoleId,
      patch,
    ),
  findDueScheduledConsoles: now =>
    activeConsolesChartsRepo.findDueScheduledConsoles(now),
  claimScheduledConsole: (doc, nextAt) =>
    activeConsolesChartsRepo.claimScheduledConsole(doc, nextAt),

  // Search
  isPgVectorAvailable: () => activeConsolesChartsRepo.isPgVectorAvailable(),
  searchConsolesVector: (workspaceId, queryEmbedding, opts) =>
    activeConsolesChartsRepo.searchConsolesVector(
      workspaceId,
      queryEmbedding,
      opts,
    ),
  searchConsolesText: (workspaceId, query, opts) =>
    activeConsolesChartsRepo.searchConsolesText(workspaceId, query, opts),
  searchConsolesName: (workspaceId, query, opts) =>
    activeConsolesChartsRepo.searchConsolesName(workspaceId, query, opts),

  // 3. Entity versions
  getLatestEntityVersionNumber: (entityId, entityType, workspaceId) =>
    activeConsolesChartsRepo.getLatestEntityVersionNumber(
      entityId,
      entityType,
      workspaceId,
    ),
  createEntityVersion: input =>
    activeConsolesChartsRepo.createEntityVersion(input),
  listEntityVersions: (entityId, entityType, opts) =>
    activeConsolesChartsRepo.listEntityVersions(entityId, entityType, opts),
  listEntityVersionsAscending: (workspaceId, entityId, entityType) =>
    activeConsolesChartsRepo.listEntityVersionsAscending(
      workspaceId,
      entityId,
      entityType,
    ),
  getEntityVersion: (entityId, entityType, version, workspaceId) =>
    activeConsolesChartsRepo.getEntityVersion(
      entityId,
      entityType,
      version,
      workspaceId,
    ),
  countEntityVersions: (workspaceId, entityType, entityIds) =>
    activeConsolesChartsRepo.countEntityVersions(
      workspaceId,
      entityType,
      entityIds,
    ),

  // 4. Notebook folders
  listNotebookFolders: (workspaceId, opts) =>
    activeConsolesChartsRepo.listNotebookFolders(workspaceId, opts),
  findNotebookFolderById: (workspaceId, folderId) =>
    activeConsolesChartsRepo.findNotebookFolderById(workspaceId, folderId),
  createNotebookFolder: input =>
    activeConsolesChartsRepo.createNotebookFolder(input),
  updateNotebookFolder: (workspaceId, folderId, patch) =>
    activeConsolesChartsRepo.updateNotebookFolder(workspaceId, folderId, patch),
  deleteNotebookFolderSubtree: (workspaceId, folderId) =>
    activeConsolesChartsRepo.deleteNotebookFolderSubtree(workspaceId, folderId),
  wouldCreateNotebookFolderCycle: (workspaceId, folderId, targetParentId) =>
    activeConsolesChartsRepo.wouldCreateNotebookFolderCycle(
      workspaceId,
      folderId,
      targetParentId,
    ),

  // 5. Notebook indexes
  findNotebookIndex: (workspaceId, notebookId) =>
    activeConsolesChartsRepo.findNotebookIndex(workspaceId, notebookId),
  findNotebookIndexByPath: (workspaceId, path, opts) =>
    activeConsolesChartsRepo.findNotebookIndexByPath(workspaceId, path, opts),
  listNotebookIndexes: (workspaceId, opts) =>
    activeConsolesChartsRepo.listNotebookIndexes(workspaceId, opts),
  createNotebookIndex: input =>
    activeConsolesChartsRepo.createNotebookIndex(input),
  updateNotebookIndex: (workspaceId, notebookId, patch) =>
    activeConsolesChartsRepo.updateNotebookIndex(
      workspaceId,
      notebookId,
      patch,
    ),
  deleteNotebookIndex: (workspaceId, notebookId) =>
    activeConsolesChartsRepo.deleteNotebookIndex(workspaceId, notebookId),

  // 6. Favourites
  listFavourites: (workspaceId, userId) =>
    activeConsolesChartsRepo.listFavourites(workspaceId, userId),
  countFavourites: (workspaceId, userId) =>
    activeConsolesChartsRepo.countFavourites(workspaceId, userId),
  findFavouriteById: (workspaceId, userId, id) =>
    activeConsolesChartsRepo.findFavouriteById(workspaceId, userId, id),
  findFavouriteByRef: (workspaceId, userId, kind, refId) =>
    activeConsolesChartsRepo.findFavouriteByRef(
      workspaceId,
      userId,
      kind,
      refId,
    ),
  listFavouriteSiblings: (workspaceId, userId, parentId, excludeId) =>
    activeConsolesChartsRepo.listFavouriteSiblings(
      workspaceId,
      userId,
      parentId,
      excludeId,
    ),
  getNextFavouritePosition: (workspaceId, userId, parentId) =>
    activeConsolesChartsRepo.getNextFavouritePosition(
      workspaceId,
      userId,
      parentId,
    ),
  createFavourite: input => activeConsolesChartsRepo.createFavourite(input),
  updateFavouriteSimple: (workspaceId, userId, id, patch) =>
    activeConsolesChartsRepo.updateFavouriteSimple(
      workspaceId,
      userId,
      id,
      patch,
    ),
  reorderFavourites: (workspaceId, userId, updates) =>
    activeConsolesChartsRepo.reorderFavourites(workspaceId, userId, updates),
  deleteFavouriteByRef: (workspaceId, userId, kind, refId) =>
    activeConsolesChartsRepo.deleteFavouriteByRef(
      workspaceId,
      userId,
      kind,
      refId,
    ),
  deleteFavouriteSubtree: (workspaceId, userId, id) =>
    activeConsolesChartsRepo.deleteFavouriteSubtree(workspaceId, userId, id),

  // 7. Scheduled query runs
  createScheduledQueryRun: input =>
    activeConsolesChartsRepo.createScheduledQueryRun(input),
  findScheduledQueryRunById: (runId, workspaceId) =>
    activeConsolesChartsRepo.findScheduledQueryRunById(runId, workspaceId),
  updateScheduledQueryRun: (workspaceId, runId, patch) =>
    activeConsolesChartsRepo.updateScheduledQueryRun(workspaceId, runId, patch),
  listScheduledQueryRuns: (workspaceId, consoleId, limit) =>
    activeConsolesChartsRepo.listScheduledQueryRuns(
      workspaceId,
      consoleId,
      limit,
    ),
};
