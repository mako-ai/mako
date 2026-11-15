/**
 * Mirror pushes: serialized per workspace, coalesced, never forced onto a
 * customer's heads.
 */
import { runGit } from "../git";
import { DEFAULT_BRANCH, repoDirFor } from "../repository.service";
import { loggers } from "../../logging";
import {
  remoteUrl,
  connectedTierEnabled,
  MirrorTarget,
  resolveMirrorTarget,
  tokenFor,
  authArgs,
} from "./target";
import {
  MIRROR_TRACKING_PREFIX,
  readRefs,
  reconcileMirrorDeletions,
} from "./reconcile";

const logger = loggers.api("apps");

const inFlight = new Map<string, Promise<void>>();
type MirrorPushScope = "all" | "default-branch";
// Requests of the same scope coalesce; different scopes stay separate so an
// all-ref push cannot turn a queued create push into a failing operation.
const queuedPushes = new Map<string, Map<MirrorPushScope, Promise<void>>>();

async function runPush(
  workspaceId: string,
  scope: MirrorPushScope,
): Promise<void> {
  const target = await resolveMirrorTarget(workspaceId);
  if (!target) return;
  if (scope === "default-branch") {
    await pushDefaultBranchMirror(workspaceId, target);
    return;
  }
  await pushMirror(workspaceId, target);
}

/**
 * Schedule a mirror push that is guaranteed to START after this call, and
 * return a promise for its completion. Never runs two pushes for one workspace
 * at once; coalesces queued requests only when they have the same scope.
 */
function schedulePush(
  workspaceId: string,
  scope: MirrorPushScope = "all",
): Promise<void> {
  const running = inFlight.get(workspaceId);
  if (!running) {
    const p = runPush(workspaceId, scope).finally(() => {
      if (inFlight.get(workspaceId) === p) inFlight.delete(workspaceId);
    });
    inFlight.set(workspaceId, p);
    return p;
  }
  // A push is already running and may predate this commit. Keep this request's
  // scope so an unrelated all-ref push cannot make a create fail.
  let workspaceQueue = queuedPushes.get(workspaceId);
  if (!workspaceQueue) {
    workspaceQueue = new Map();
    queuedPushes.set(workspaceId, workspaceQueue);
  }
  const existing = workspaceQueue.get(scope);
  if (existing) return existing;

  const queued = running
    .catch(() => undefined)
    .then(() => {
      // Remove this placeholder before scheduling. Otherwise a different
      // queued scope can start first and this call would find and return its
      // own still-pending placeholder, creating a promise cycle.
      const queue = queuedPushes.get(workspaceId);
      if (queue?.get(scope) === queued) queue.delete(scope);
      if (queue?.size === 0) queuedPushes.delete(workspaceId);
      return schedulePush(workspaceId, scope);
    })
    .finally(() => {
      const queue = queuedPushes.get(workspaceId);
      if (queue?.get(scope) === queued) queue.delete(scope);
      if (queue?.size === 0) queuedPushes.delete(workspaceId);
    });
  workspaceQueue.set(scope, queued);
  return queued;
}

async function pushDefaultBranchMirror(
  workspaceId: string,
  target: MirrorTarget,
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  const token = await tokenFor(target);
  const url = remoteUrl(target.owner, target.repo);
  const branchRef = `refs/heads/${DEFAULT_BRANCH}`;
  const localOid = (
    await runGit(["-C", repoDir, "rev-parse", "--verify", branchRef])
  ).stdout.trim();

  // App creation only adds content to the default branch. Pushing every local
  // head here lets an unrelated stale feature branch reject creation after
  // main has advanced. Keep active non-default branches out of this write.
  await runGit([
    "-C",
    repoDir,
    ...authArgs(token),
    "push",
    "--quiet",
    url,
    `${localOid}:${branchRef}`,
  ]);
  await runGit([
    "-C",
    repoDir,
    "update-ref",
    `${MIRROR_TRACKING_PREFIX}${DEFAULT_BRANCH}`,
    localOid,
  ]).catch(() => undefined);
}

async function pushMirror(
  workspaceId: string,
  target: MirrorTarget,
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  const token = await tokenFor(target);
  const url = remoteUrl(target.owner, target.repo);
  // The push below sends EVERY local head, so a branch deleted on GitHub
  // would come straight back from any instance whose clone still has it.
  // Honour those deletions first. A failure here must not cost durability:
  // push anyway (worst case, a deleted branch is resurrected, as before).
  await reconcileMirrorDeletions(workspaceId, repoDir, url, token).catch(
    error =>
      logger.warn("Mirror branch-deletion reconcile failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  // Connected repo = a CUSTOMER remote. Heads and tags go WITHOUT force: if
  // someone pushed to GitHub directly, our push fails non-fast-forward and is
  // logged — never clobbered (the webhook fetch path reconciles when the
  // remote is simply ahead). Only Mako's own refs/mako/* WIP namespace is
  // forced, and nothing is pruned.
  await runGit([
    "-C",
    repoDir,
    ...authArgs(token),
    "push",
    "--quiet",
    url,
    "refs/heads/*:refs/heads/*",
    "refs/tags/*:refs/tags/*",
    "+refs/mako/*:refs/mako/*",
  ]);
  // The push succeeded, so the mirror now has every local head: record it,
  // so a branch created here and deleted on GitHub before our next fetch is
  // still recognised as deleted rather than as new.
  await recordMirrorHeads(repoDir).catch(() => undefined);
}

async function recordMirrorHeads(repoDir: string): Promise<void> {
  const heads = await readRefs(repoDir, "refs/heads/");
  if (heads.size === 0) return;
  const input = [...heads]
    .map(([name, oid]) => `update ${MIRROR_TRACKING_PREFIX}${name} ${oid}\n`)
    .join("");
  await runGit(["-C", repoDir, "update-ref", "--stdin"], { stdin: input });
}

/**
 * Queue a fire-and-forget mirror push. Never throws — durability is
 * best-effort on top of the local store, and a failed push must not fail the
 * user's commit. Failures are logged for a future reconciler to sweep. Loads
 * the target itself so callers holding only ids (commit paths) can use it,
 * and so a binding or pointer attached after their doc snapshot is still
 * seen.
 */
export function queueMirrorPush(workspaceId: string): void {
  if (!connectedTierEnabled()) return;
  void schedulePush(workspaceId).catch(error => {
    logger.warn("Apps mirror push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Awaitable variant for the initial push right after repo/app creation. Shares
 * the same per-workspace serialization as `queueMirrorPush`, so it never races
 * a fire-and-forget push already in flight — and the push it awaits is
 * guaranteed to start after the caller's commit.
 */
export async function mirrorPushNow(workspaceId: string): Promise<void> {
  if (!connectedTierEnabled()) return;
  await schedulePush(workspaceId);
}

/** Awaitable durable push for a new scaffold committed only to the default branch. */
export async function mirrorPushDefaultBranchNow(
  workspaceId: string,
): Promise<void> {
  if (!connectedTierEnabled()) return;
  await schedulePush(workspaceId, "default-branch");
}
