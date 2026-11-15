/**
 * The apps index — git is the list, Mongo is the derived read model.
 *
 * Every app in a workspace is a folder holding `mako.json`, anywhere under
 * `apps/` or `users/<handle>/apps/` (apps.md §13.6, folders per §16's consoles
 * pattern). This module reads that tree at `main` ONCE per push and writes
 * one flat row per app (`app_index`), so the sidebar, the agent's list, search
 * and the binding scheduler never open the repo themselves. The rows are
 * disposable: drop the collection and the next read rebuilds it.
 *
 * Identity comes from the manifest's `id`; a manifest without one keeps its
 * existing project id, or derives one from its path when it has no state. Two folders declaring the same id
 * (a copied app that kept its source's manifest) is a conflict the index
 * records rather than resolves: the incumbent keeps the id, the copy is filed
 * under a derived id with `duplicateOf` set, and the UI offers to stamp it.
 *
 * Must not import worktree.service (it imports this module).
 *
 * The implementation lives in `./app-index/`; this barrel keeps the import
 * path:
 *
 *   rows.ts       the row and snapshot shapes, owners by the handle mapping
 *   discovery.ts  discovery: pure over a tree listing, and reading it at a commit
 *   identity.ts   identity resolution: ids, incumbents, renamed folders
 *   sync.ts       syncing the rows from main, and the per-process memo
 *   resolve.ts    resolving an id / path / slug against the index
 */
export { APP_THUMBNAIL_FILES, ownerOfAppPath } from "./app-index/rows";
export type {
  AppSchedule,
  AppIndexRow,
  AppBindingTables,
  AppThumbnailRef,
  AppsIndexSnapshot,
} from "./app-index/rows";
export { discoverApps, listAppTrees, readAppsAt } from "./app-index/discovery";
export type { DiscoveredApp, Discovery } from "./app-index/discovery";
export {
  assignAppIds,
  treeIncumbentsOf,
  renamedAppFolders,
} from "./app-index/identity";
export {
  isBotCommitter,
  firstCommitsOf,
  syncAppsIndexFromRepo,
  loadAppsIndex,
  peekAppsIndexSha,
  invalidateAppsIndexCache,
} from "./app-index/sync";
export {
  findAppInSnapshot,
  resolveAppRef,
  loadIndexedApps,
  resolveIndexedAppRef,
  readIndexedAppsAt,
} from "./app-index/resolve";
