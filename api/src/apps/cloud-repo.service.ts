/**
 * Apps durable mirror — where a workspace repo's history is replicated.
 *
 * ONE tier (apps.md §17): the workspace's CONNECTED GitHub repo (Settings →
 * GitHub, `workspaceRepos[]`). That repo IS the durable mirror — commits push
 * there, restores clone from there. A customer remote is never force-pushed:
 * heads and tags go without force (a direct GitHub-side push is never
 * clobbered), and only Mako's own `refs/mako/*` WIP namespace is forced.
 * The mirror is the source of truth and the local repo its cache: every
 * write onto `main` here freshens from the mirror first
 * (`freshenBeforeMainWrite`), and a local branch found diverged from the
 * mirror is reset to it with its commits parked under `refs/mako/diverged/*`
 * (`fetchFromCloud`).
 *
 * Reads always use a connected repo when one is bound: serverless preview
 * instances have an empty filesystem and must be able to rebuild their local
 * cache. Writes to that repo only engage on production
 * (APPS_REQUIRE_CONNECTED_REPO) or under the explicit
 * APPS_CONNECTED_REPO_PUSH=allow opt-in. Previews and dev can therefore read
 * real workspace content without a test commit ever landing in a customer
 * repo.
 *
 * The local bare repo remains the working store the API reads from; the
 * mirror is the durable replica. Mirror pushes run after commits/merges
 * (not per WIP flush — too chatty), serialized per workspace and coalesced
 * so concurrent commits produce one trailing push, never an interleaving.
 *
 * The implementation lives in `./cloud-repo/`; this barrel keeps the import
 * path:
 *
 *   target.ts     which repo is the mirror, its token, restoring the cache
 *   push.ts       serialized, coalesced mirror pushes
 *   reconcile.ts  branch deletions on the mirror
 *   fetch.ts      bringing commits and main in from the mirror
 *   adopt.ts      adopting a newly connected repo, verifying main's tree
 *   durable-main.ts  a main write that lands on the mirror or fails
 */
export {
  connectedTierEnabled,
  resolveMirrorTarget,
  ensureLocalRepo,
} from "./cloud-repo/target";
export type { MirrorTarget } from "./cloud-repo/target";
export {
  queueMirrorPush,
  mirrorPushNow,
  mirrorPushDefaultBranchNow,
} from "./cloud-repo/push";
export {
  scheduleMirrorBranchReconcile,
  reconcileMirrorDeletionsForTests,
} from "./cloud-repo/reconcile";
export {
  ensureCommitLocally,
  freshenForServe,
  fetchFromCloud,
  freshenBeforeMainWrite,
} from "./cloud-repo/fetch";
export {
  TreeNotVerifiedError,
  assertTreeAtMirrorMain,
  adoptConnectedRepo,
  ensureWorkspaceRepo,
} from "./cloud-repo/adopt";
export type { ConnectedRepoAdoption } from "./cloud-repo/adopt";
export {
  DURABLE_MAIN_ATTEMPTS,
  DurableMainWriteError,
  commitToMainDurably,
  keyedSerial,
  withMainWriteLock,
} from "./cloud-repo/durable-main";
export type {
  DurableMainCommit,
  MainMutation,
} from "./cloud-repo/durable-main";
