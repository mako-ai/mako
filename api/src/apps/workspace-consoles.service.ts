/**
 * Consoles in the workspace repo — git is the source of truth, Mongo's
 * `SavedConsole` is the derived index (apps.md §16).
 *
 * The concerns below live in `./workspace-consoles/` (one module each);
 * this path is the stable barrel callers import from:
 *
 * 1. WRITE-THROUGH. Every saved-console mutation commits to `main` first
 *    (`commitConsoleState` / `commitConsoleRemoval` / `commitConsoleBatch`),
 *    then the caller updates the row with the returned `path` and
 *    `sourceBlobSha`. Index plumbing, no clone (`commitBlobsOnBranch`).
 * 2. SYNC. `syncConsolesIndexFromRepo` reconciles the index with the tree
 *    after any push (terminal, laptop clone, GitHub webhook). Content
 *    addressed: a row whose blob id equals the tree's is skipped; a vanished
 *    row whose blob reappears elsewhere is a rename (id, telemetry, shares,
 *    embedding survive); a vanished path soft-deletes its row. Never touches
 *    a repo that has not adopted (`consoles/README.md` absent).
 * 3. READ. GET/list serves the files at `main` (`consoles/`,
 *    `users/<id>/consoles/`). Mongo is joined only for ACL, runtime, SHA,
 *    and embeddings. A file with no row still appears; a row with no file
 *    is not a live definition. Reads never reconcile Mongo or publish
 *    realtime events — push/webhook sync owns that mutation. No GitHub
 *    binding → empty list, never 412. Leftover local git without a binding
 *    is not a read surface.
 * 4. DERIVATION. Description + embedding are derived from the file and
 *    stamped with `descriptionSourceSha`; `deriveConsoleDescription` runs
 *    only while that differs from `sourceBlobSha`, behind a debounced
 *    Inngest function. Search itself does not change — it keeps reading the
 *    index (§16.4).
 *
 * Adoption (`adoptWorkspaceConsoles`) replays `entity_versions` as commits
 * and writes the marker; the DB migration and the operator CLI both call it,
 * and so does the first console write on a not-yet-adopted workspace.
 *
 * Must not import worktree.service (it imports this module for the push
 * hook) — everything needed is in repository.service / cloud-repo.service.
 */
export { authorForUser } from "./workspace-consoles/authors";
export {
  consolesAdopted,
  descriptionIsAuthored,
  ensureConsolesRepo,
  ensureFolderChain,
  fileStateFromRow,
  folderSegmentsFor,
  repoPathForRow,
  rowScope,
  unownedConsoleOwner,
} from "./workspace-consoles/files";
export {
  derivedConsoleId,
  listConsoleDefinitionsAtMain,
  liveConsoleCode,
  loadLiveConsoleById,
  loadLiveConsoles,
  readConsoleDefinitionAtMain,
  type ConsoleDefinitionAtMain,
  type LiveConsole,
} from "./workspace-consoles/definitions";
export {
  commitConsoleBatch,
  commitConsoleMoves,
  commitConsoleRemoval,
  commitConsoleState,
  projectSavedConsole,
  type ConsoleCommitResult,
  type Projection,
} from "./workspace-consoles/write-through";
export {
  CONSOLE_DESCRIPTION_EVENT,
  deriveConsoleDescription,
  reconcileConsoleDescriptions,
  requestConsoleDescription,
  type ConsoleDescriptionEventData,
  type DeriveOutcome,
} from "./workspace-consoles/descriptions";
export {
  syncConsolesIndexFromRepo,
  type ConsoleSyncStats,
} from "./workspace-consoles/sync";
export {
  adoptWorkspaceConsoles,
  type AdoptionReport,
} from "./workspace-consoles/adoption";
export {
  consoleCommitChanges,
  consoleFileVersions,
  consoleHistory,
  restoreConsoleTo,
  savedConsoleStateFromRepo,
} from "./workspace-consoles/history";
