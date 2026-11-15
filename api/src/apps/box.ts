/**
 * The sandbox as an ordinary clone.
 *
 * This replaces a private transfer layer — bundles in both directions, shadow
 * "WIP" commits to decide what to transfer, and a Mongo mirror of the result —
 * with the thing every developer already has: a working copy with a remote it
 * can fetch from and push to.
 *
 * The remote is Mako's own git-over-HTTP endpoint (routes/apps-git.ts),
 * serving the same bare repo the API reads. So there is one repository and two
 * ordinary git clients: the API on the server side of it, the sandbox on the
 * client side. Nothing has to be kept in step, because nothing is duplicated.
 *
 * The practical test of the design is that nothing in the box knows about
 * Mako. `git push`, `git pull`, `git log`, a coding agent running inside the
 * sandbox — all of it is just git talking to a git server.
 *
 * The implementation lives in `./box/`; this barrel keeps the import path:
 *
 *   shell.ts    quoting, the box root, running a command, NEVER_COMMIT
 *   remote.ts   the clone and its remote: clone, configure, heal, pull
 *   files.ts    the working copy: exec, list, read, write, grep, glob, status
 *   commits.ts  commits, per-path git actions, file versions, push, checkout
 */
export { NEVER_COMMIT, workspaceRootGitignore, sh, boxRoot } from "./box/shell";
export {
  boxHasRepo,
  boxHasValidCheckout,
  boxEnvPath,
  configureBoxRemote,
  cloneIntoBox,
  boxHead,
  isUnreachableOrigin,
  healBoxOrigin,
  boxPull,
  readBoxDir,
} from "./box/remote";
export {
  boxExec,
  boxListFiles,
  boxReadFile,
  boxWriteFile,
  boxGrep,
  boxGlob,
  boxStatus,
} from "./box/files";
export type { BoxFileListing, BoxStatus } from "./box/files";
export {
  boxRestoreTreeFrom,
  boxCommitAll,
  boxCommitPathToBranch,
  boxGitPaths,
  boxFileVersions,
  boxPorcelain,
  boxPushIfAhead,
  boxCheckout,
  boxDiscard,
} from "./box/commits";
export type { BoxCommitResult, BoxFileVersions } from "./box/commits";
