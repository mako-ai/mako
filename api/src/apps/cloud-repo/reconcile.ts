/**
 * Branch deletions on the mirror: a branch deleted on GitHub is dropped from
 * the local cache too (throttled per workspace).
 */
import { runGit } from "../git";
import { DEFAULT_BRANCH, repoDirFor, repoExists } from "../repository.service";
import { loggers } from "../../logging";
import { BoundedMap } from "../../utils/bounded-map";
import {
  remoteUrl,
  resolveReadableMirrorTarget,
  tokenFor,
  authArgs,
} from "./target";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Branch deletions on the mirror
// ---------------------------------------------------------------------------

/**
 * What the mirror's heads were the last time we looked. Never pushed (the
 * push refspecs are heads, tags and refs/mako/*) and hidden from sandboxes by
 * the git endpoint, so it is purely this instance's bookkeeping.
 */
export const MIRROR_TRACKING_PREFIX = "refs/remotes/mirror/";

export async function readRefs(
  repoDir: string,
  prefix: string,
): Promise<Map<string, string>> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    prefix,
  ]);
  const refs = new Map<string, string>();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [ref, oid] = line.split("\0");
    refs.set(ref.slice(prefix.length), oid);
  }
  return refs;
}

const reconcileInFlight = new Map<string, Promise<string[]>>();

/**
 * Delete local branches that were deleted on the mirror.
 *
 * "Absent on the mirror" alone cannot mean deleted: Mako creates branches
 * locally (Source Control, a sandbox `checkout -b`) and only then pushes
 * them. So a branch is dropped only when the mirror HAD it at our last look
 * (a tracking ref exists), no longer has it, and it has not moved locally
 * since — i.e. the mirror deleted exactly what we have. A branch that gained
 * local commits meanwhile is kept and pushed again: deletion never wins over
 * unmirrored work. The objects stay in the store until gc.
 *
 * Returns the names deleted. Shared per workspace: the push path and the
 * background sweep never run it twice at once.
 */
export function reconcileMirrorDeletions(
  workspaceId: string,
  repoDir: string,
  url: string,
  token: string | undefined,
): Promise<string[]> {
  const existing = reconcileInFlight.get(workspaceId);
  if (existing) return existing;
  const run = (async () => {
    const before = await readRefs(repoDir, MIRROR_TRACKING_PREFIX);
    await runGit([
      "-C",
      repoDir,
      ...authArgs(token),
      "fetch",
      "--quiet",
      "--prune",
      "--no-tags",
      url,
      `+refs/heads/*:${MIRROR_TRACKING_PREFIX}*`,
    ]);
    const after = await readRefs(repoDir, MIRROR_TRACKING_PREFIX);
    const local = await readRefs(repoDir, "refs/heads/");
    const deleted: string[] = [];
    for (const [name, oid] of before) {
      if (name === DEFAULT_BRANCH || after.has(name)) continue;
      if (local.get(name) !== oid) continue;
      try {
        // Compare-and-delete: a commit landing in between keeps the branch.
        await runGit([
          "-C",
          repoDir,
          "update-ref",
          "-d",
          `refs/heads/${name}`,
          oid,
        ]);
        deleted.push(name);
      } catch {
        // Moved meanwhile — it is unmirrored work now; the push keeps it.
      }
    }
    if (deleted.length > 0) {
      logger.info("Dropped branches deleted on the mirror", {
        workspaceId,
        count: deleted.length,
        branches: deleted.slice(0, 20),
      });
    }
    return deleted;
  })().finally(() => reconcileInFlight.delete(workspaceId));
  reconcileInFlight.set(workspaceId, run);
  return run;
}

const MIRROR_RECONCILE_INTERVAL_MS = 60_000;
// Throttle stamps: an entry past the interval means nothing, so expire it.
const lastReconcileAt = new BoundedMap<string, number>({
  maxEntries: 5_000,
  ttlMs: MIRROR_RECONCILE_INTERVAL_MS,
});

/**
 * Fire-and-forget, throttled: drop branches deleted on the mirror without
 * waiting for this instance's next push. Called from reads (branch listing),
 * so it never blocks one and never throws.
 */
export function scheduleMirrorBranchReconcile(workspaceId: string): void {
  const now = Date.now();
  if (
    now - (lastReconcileAt.get(workspaceId) ?? 0) <
    MIRROR_RECONCILE_INTERVAL_MS
  ) {
    return;
  }
  lastReconcileAt.set(workspaceId, now);
  void (async () => {
    const target = await resolveReadableMirrorTarget(workspaceId);
    if (!target) return;
    const repoDir = repoDirFor(workspaceId);
    if (!(await repoExists(repoDir))) return;
    const token = await tokenFor(target);
    await reconcileMirrorDeletions(
      workspaceId,
      repoDir,
      remoteUrl(target.owner, target.repo),
      token,
    );
  })().catch(error =>
    logger.warn("Mirror branch-deletion reconcile failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Test seam: run the reconcile now, unthrottled, and report what it dropped. */
export async function reconcileMirrorDeletionsForTests(
  workspaceId: string,
): Promise<string[]> {
  const target = await resolveReadableMirrorTarget(workspaceId);
  if (!target) return [];
  return reconcileMirrorDeletions(
    workspaceId,
    repoDirFor(workspaceId),
    remoteUrl(target.owner, target.repo),
    await tokenFor(target),
  );
}
