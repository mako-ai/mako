/**
 * Apps worktree service.
 *
 * What this module is, after the sandbox got a real git remote:
 *
 * 1. The SANDBOX is the working copy, and it is an ordinary clone. It fetches
 *    and pushes to Mako's git-over-HTTP endpoint, which serves the same bare
 *    repo this module reads. One repository, two ordinary git clients.
 * 2. Uncommitted work lives in the working copy, the way it does on a laptop.
 *    `git push` is what makes work durable — there is no shadow commit, no WIP
 *    ref, and no database mirror of either.
 * 3. Reads come from the working copy when the sandbox is up, and from the
 *    last commit when it is not. That is not two implementations of one thing;
 *    it is the difference between an editor and a code host, and the only
 *    honest answer when the machine is off.
 * 4. What remains server-side is what genuinely belongs there: creating and
 *    deleting apps, listing branches and history, and the publish merge —
 *    plain git against the bare repo, no sandbox involved.
 *
 * The implementation lives in `./worktree/`, one module per concern; this
 * barrel keeps the import path every caller uses.
 *
 *   repo.ts           repo dir + app root resolution, handles, scopes
 *   push.ts           what a push to main sets off (index syncs, deploys)
 *   box-session.ts    the actor's sandbox: identity, hydration, caches
 *   projects.ts       creating and deleting apps
 *   folders.ts        app folders, moves, archive / restore, id stamping
 *   worktrees.ts      opening a worktree handle (ensureWorktree)
 *   files.ts          exec, reads, writes, listing, grep / glob
 *   status.ts         status and history
 *   commits.ts        commits, per-file git actions, restore
 *   branches.ts       branch listing, merge, checkout, discard
 *   publish-merge.ts  the publish trial merge and promote
 *   project-rows.ts   folder-only apps, their rows, resolving a ref
 */
export {
  repoForWorkspace,
  appRootFor,
  handleProject,
  WorktreeConflictError,
  scopeOf,
  workspaceScope,
} from "./worktree/repo";
export type { WorktreeHandle, RepoScope } from "./worktree/repo";
export { notifyRepoPushed, syncRepoBackedResources } from "./worktree/push";
export {
  boxCtx,
  sessionKeyFor,
  resolveActorIdentity,
  invalidatePullThrottle,
  forgetBoxCaches,
  isMissingCwd,
  rehydrateBox,
  ensureBox,
} from "./worktree/box-session";
export {
  slugify,
  folderTargetFromPath,
  commitFilesOnBranch,
  createProject,
  deleteProject,
} from "./worktree/projects";
export type { AppFolderTarget } from "./worktree/projects";
export {
  AppFolderError,
  moveWritesUnder,
  commitOnMainDurably,
  moveProject,
  withManifestDescription,
  ARCHIVE_DIR,
  archiveProject,
  restoreArchivedProject,
  createAppFolder,
  moveAppFolder,
  deleteAppFolder,
  stampAppId,
} from "./worktree/folders";
export {
  PUBLISH_ACTOR,
  ensureWorktree,
  ensureWorkspaceWorktree,
} from "./worktree/worktrees";
export {
  execInWorktree,
  withBoxPushLock,
  writeWorktreeScratchFile,
  listFiles,
  readFile,
  grepFiles,
  globFiles,
  writeFile,
  readSessionFile,
} from "./worktree/files";
export type { ExecOutcome, FileListing } from "./worktree/files";
export {
  catchUpLiveBox,
  afterTerminalSession,
  worktreeStatus,
  defaultBranchSha,
  projectHistory,
} from "./worktree/status";
export type { WorktreeStatus } from "./worktree/status";
export {
  gitPathsAction,
  commitChanges,
  commitFileVersions,
  restoreWorktreeTo,
  fileVersions,
  commitWorktree,
  commitPathToBranch,
  autoCommitFileEdit,
  commitAgentTurn,
} from "./worktree/commits";
export type { CommitResult } from "./worktree/commits";
export {
  listBranches,
  countAheadOfDefault,
  mergeBranchToMain,
  checkoutInBox,
  checkoutBranch,
  discardWorktree,
} from "./worktree/branches";
export type { BranchInfo, MergeResult } from "./worktree/branches";
export { trialMerge, promoteToMain } from "./worktree/publish-merge";
export type { TrialMergeResult } from "./worktree/publish-merge";
export {
  listAppFolders,
  listAppFolderPaths,
  ensureProjectRow,
  synthesizeProjectFromFolder,
  projectFromIndexRow,
  resolveProjectRef,
} from "./worktree/project-rows";
export type { AppFolder } from "./worktree/project-rows";
export { derivedAppId } from "./app-paths";
// The doctrine of which branch an actor starts on — and where each content
// kind's commits land — lives in branch-policy.ts (apps.md §18). Re-exported
// so existing importers keep working.
export { defaultBranchForActor, sessionBranchFor } from "./branch-policy";
export type { AppSchedule } from "./app-index.service";
