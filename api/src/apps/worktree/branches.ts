/**
 * Branches: the cached branch list, merging to main, checkout, discard.
 */
import { loggers } from "../../logging";
import { BoundedMap } from "../../utils/bounded-map";
import { boxCheckout, boxDiscard, boxHead, boxRoot, sh } from "../box";
import { runGit } from "../git";
import {
  commitTree,
  resolveCommit,
  updateRefCas,
  type GitAuthor,
} from "../repository.service";
import { WORKFLOWS_DIR } from "../app-paths";
import { workspaceService } from "../../services/workspace.service";
import {
  WORKFLOWS_ADMIN_ONLY,
  mayChangeWorkflows,
} from "../../workflows/policy";

import {
  freshenBeforeMainWrite,
  queueMirrorPush,
  scheduleMirrorBranchReconcile,
} from "../cloud-repo.service";
import { getSandboxProvider } from "../sandbox/provider";
import {
  repoForWorkspace,
  WorktreeConflictError,
  WorktreeHandle,
  RepoScope,
} from "./repo";
import { pokeApp, deployWorkflows } from "./push";
import { invalidatePullThrottle, ensureBox } from "./box-session";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Branches (list + merge to main)
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  head: string;
  isDefault: boolean;
  /** Commits ahead of the default branch (0 for the default itself). */
  aheadOfMain: number;
  lastCommit?: { subject: string; author: string; timestamp: number };
}

/**
 * Every branch in the workspace repo with its distance from the default
 * branch.
 *
 * The repo is the WORKSPACE's (apps, consoles, dbt, flows share it), so this
 * answer is the same for every app that asks — and it used to be computed
 * once per asking app with one `git rev-list --count` per branch, serially.
 * At 573 branches that was ~573 subprocesses per call on a 1-vCPU instance;
 * on 2026-10-19 it took 40s at the median and 71% of the service's
 * request-seconds, and Cloud Run refused ~1,700 requests while it lasted.
 *
 * Now: one `for-each-ref` (≈10ms) per call reads the branch tips, and the
 * tips ARE the cache key — nothing to invalidate, and a call made after a
 * push always sees it. Only when the tips changed does one `rev-list` walk
 * the commits not on the default branch, from which every branch's count is
 * read in memory; concurrent calls seeing the same tips share that walk.
 */
export async function listBranches(scope: RepoScope): Promise<BranchInfo[]> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  // Mirror deletions are reconciled in the background (a deleted branch
  // stays listed until then); never on the read path.
  scheduleMirrorBranchReconcile(scope.workspaceId);
  const { stdout: refs } = await runGit([
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(authordate:unix)",
    "refs/heads/",
  ]);
  const key = `${scope.workspaceId}\u0000${scope.defaultBranch}`;
  const cached = branchListCache.get(key);
  if (cached?.refs === refs) return cached.branches;
  const flightKey = `${key}\u0000${refs}`;
  const existing = branchListInFlight.get(flightKey);
  if (existing) return existing;
  const run = buildBranchList(repoDir, scope.defaultBranch, refs)
    .then(branches => {
      branchListCache.set(key, { refs, branches });
      return branches;
    })
    .finally(() => branchListInFlight.delete(flightKey));
  branchListInFlight.set(flightKey, run);
  return run;
}

const branchListInFlight = new Map<string, Promise<BranchInfo[]>>();
const branchListCache = new BoundedMap<
  string,
  { refs: string; branches: BranchInfo[] }
>({ maxEntries: 500, ttlMs: 10 * 60_000 });

async function buildBranchList(
  repoDir: string,
  defaultBranch: string,
  refs: string,
): Promise<BranchInfo[]> {
  const rows = refs
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [name, head, subject, author, at] = line.split("\0");
      return { name, head, subject, author, at };
    });
  const hasDefault = rows.some(r => r.name === defaultBranch);
  const others = rows.filter(r => r.name !== defaultBranch);
  let ahead = new Map<string, number>();
  if (hasDefault && others.length > 0) {
    try {
      // Every commit reachable from some branch but not from the default
      // branch, with its parents: the whole "ahead" graph in one process.
      const { stdout: graph } = await runGit([
        "-C",
        repoDir,
        "rev-list",
        "--parents",
        "--branches",
        "--not",
        `refs/heads/${defaultBranch}`,
      ]);
      ahead = countAheadOfDefault(
        graph,
        others.map(r => r.head),
      );
    } catch {
      ahead = new Map();
    }
  }

  const branches: BranchInfo[] = rows.map(r => ({
    name: r.name,
    head: r.head,
    isDefault: r.name === defaultBranch,
    aheadOfMain: r.name === defaultBranch ? 0 : (ahead.get(r.head) ?? 0),
    lastCommit: r.subject
      ? { subject: r.subject, author: r.author, timestamp: Number(r.at) * 1000 }
      : undefined,
  }));
  // Default branch first, then most recently committed.
  branches.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (b.lastCommit?.timestamp ?? 0) - (a.lastCommit?.timestamp ?? 0);
  });
  return branches;
}

/**
 * `rev-list --count <default>..<head>` for many heads at once, from the
 * output of `rev-list --parents --branches --not <default>`: each line is a
 * commit not on the default branch followed by its parents. A head's count is
 * the commits reachable from it inside that set — a parent outside the set is
 * on the default branch, and so is everything behind it. A head absent from
 * the set is merged (0).
 */
export function countAheadOfDefault(
  graph: string,
  heads: string[],
): Map<string, number> {
  const parents = new Map<string, string[]>();
  for (const line of graph.split("\n")) {
    if (!line) continue;
    const [commit, ...rest] = line.split(" ");
    parents.set(commit, rest);
  }
  const counts = new Map<string, number>();
  for (const head of heads) {
    if (counts.has(head)) continue;
    if (!parents.has(head)) {
      counts.set(head, 0);
      continue;
    }
    const seen = new Set<string>([head]);
    const stack = [head];
    while (stack.length > 0) {
      for (const parent of parents.get(stack.pop() as string) ?? []) {
        if (!seen.has(parent) && parents.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    counts.set(head, seen.size);
  }
  return counts;
}

export interface MergeResult {
  merged: boolean;
  commitOid?: string;
  fastForward?: boolean;
  reason?: string;
}

/**
 * Merge a branch into the default branch, broker-side. Fast-forwards when
 * possible; otherwise builds a real merge commit with `git merge-tree`
 * (content-level three-way merge, no working tree needed). Conflicts abort
 * with a structured error — v0 has no in-product conflict resolution.
 */
export async function mergeBranchToMain(
  scope: RepoScope,
  branch: string,
  author?: GitAuthor,
  /** Who merges. Given, a branch that changes `workflows/` needs an admin. */
  actorUserId?: string,
): Promise<MergeResult> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const defaultBranch = scope.defaultBranch;
  if (branch === defaultBranch) {
    return {
      merged: false,
      reason: "Cannot merge the default branch into itself",
    };
  }
  // Merge onto the mirror's main, not a stale cached tip (see
  // freshenBeforeMainWrite for why that would be unmirrorable).
  await freshenBeforeMainWrite(scope.workspaceId);
  const mainRef = `refs/heads/${defaultBranch}`;
  const branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
  const mainHead = await resolveCommit(repoDir, mainRef);
  if (!branchHead || !mainHead) {
    return { merged: false, reason: "Branch not found" };
  }
  if (branchHead === mainHead) {
    return { merged: false, reason: "Already up to date" };
  }
  // Main is where workflows go live. The git endpoint lets only admins push
  // workflow changes; the merge, which does not run hooks, asks the same.
  if (actorUserId) {
    const { stdout } = await runGit([
      // Three dots: what the branch changed since it left main, not what
      // main changed meanwhile.
      ...["-C", repoDir, "diff", "--name-only", `${mainHead}...${branchHead}`],
      ...["--", `${WORKFLOWS_DIR}/`],
    ]);
    if (stdout.trim()) {
      const member = await workspaceService.getMember(
        scope.workspaceId,
        actorUserId,
      );
      if (!mayChangeWorkflows(member?.role)) {
        throw new WorktreeConflictError(WORKFLOWS_ADMIN_ONLY);
      }
    }
  }

  // Fast-forward when main is an ancestor of the branch.
  try {
    await runGit([
      "-C",
      repoDir,
      "merge-base",
      "--is-ancestor",
      mainHead,
      branchHead,
    ]);
    const swapped = await updateRefCas(repoDir, mainRef, branchHead, mainHead);
    if (!swapped) {
      throw new WorktreeConflictError("Main advanced concurrently; retry.");
    }
    queueMirrorPush(scope.workspaceId);
    pokeApp(scope.workspaceId, scope.projectId ?? null, "merge");
    invalidatePullThrottle();
    // A merge writes main here, not through the git endpoint.
    deployWorkflows(scope.workspaceId);
    return { merged: true, commitOid: branchHead, fastForward: true };
  } catch (error) {
    if (error instanceof WorktreeConflictError) throw error;
    // Not an ancestor — fall through to a real merge.
  }

  const { stdout: mergeOut } = await runGit(
    ["-C", repoDir, "merge-tree", "--write-tree", mainHead, branchHead],
    // merge-tree exits 1 on conflicts; treat that as a structured failure.
  ).catch((e: unknown) => {
    throw new WorktreeConflictError(
      `Merge of ${branch} into ${defaultBranch} has conflicts — resolve them locally (clone the repo) or discard one side. ${e instanceof Error ? "" : ""}`.trim(),
    );
  });
  const mergedTree = mergeOut.trim().split("\n")[0];
  const commitOid = await commitTree(repoDir, {
    treeOid: mergedTree,
    parents: [mainHead, branchHead],
    message: `Merge ${branch} into ${defaultBranch}`,
    author,
  });
  const swapped = await updateRefCas(repoDir, mainRef, commitOid, mainHead);
  if (!swapped) {
    throw new WorktreeConflictError("Main advanced concurrently; retry.");
  }
  logger.info("Apps branch merged", {
    workspaceId: scope.workspaceId,
    branch,
    commitOid,
  });
  queueMirrorPush(scope.workspaceId);
  pokeApp(scope.workspaceId, scope.projectId ?? null, "merge");
  invalidatePullThrottle();
  deployWorkflows(scope.workspaceId);
  return { merged: true, commitOid, fastForward: false };
}

/**
 * Point the actor's sandbox at a specific commit.
 *
 * Publishing uses this: the merge result is computed on the server, and the
 * build has to run against exactly that commit so the artifact is what would
 * ship — not against whatever the sandbox happened to have.
 */
export async function checkoutInBox(
  handle: WorktreeHandle,
  commitOid: string,
): Promise<void> {
  const ctx = await ensureBox(handle);
  const reset = await getSandboxProvider().exec(
    ctx,
    [
      // Fetch the COMMIT, by sha. A publish candidate is reachable from no
      // branch (that is the point — main has not moved yet), so "fetch the
      // branches" cannot bring it; the endpoint allows want-by-sha
      // (uploadpack.allowAnySHA1InWant) for exactly this call.
      `git -C ${sh(boxRoot(ctx))} fetch -q origin ${sh(commitOid)}`,
      `git -C ${sh(boxRoot(ctx))} reset -q --hard ${sh(commitOid)}`,
      `git -C ${sh(boxRoot(ctx))} clean -qfd`,
    ].join(" && "),
    { timeoutMs: 180_000 },
  );
  if (reset.exitCode !== 0) {
    throw new Error(
      `Could not check out ${commitOid.slice(0, 8)} in the sandbox: ${reset.stderr.slice(-300)}`,
    );
  }
}

/**
 * Switch branches — the same `git checkout` the terminal runs, as a button.
 *
 * Git decides the outcome: it carries uncommitted work across when the two
 * branches agree about the files you touched, and refuses, naming them, when
 * it would clobber something. A rule stricter than git's is what once made
 * branch switching impossible after a build wrote a lock file into the tree.
 */
export async function checkoutBranch(
  handle: WorktreeHandle,
  branch: string,
  options: { create?: boolean } = {},
): Promise<{ branch: string; head: string }> {
  const { doc, repoDir } = handle;
  const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!head && !options.create) throw new Error(`No such branch: ${branch}`);
  if (head && options.create) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  if (options.create && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new Error(`Not a valid branch name: ${branch}`);
  }

  const ctx = await ensureBox(handle);
  await boxCheckout(ctx, branch, { create: options.create });
  const after = await boxHead(ctx);

  doc.branch = after.branch;
  await doc.save();
  pokeApp(doc.workspaceId, null, "checkout", doc.userId);
  logger.info("Apps branch switched", { branch: after.branch });
  return { branch: after.branch, head: after.head };
}

/** Throw away uncommitted work — `git reset --hard && git clean -fd`. */
export async function discardWorktree(
  handle: WorktreeHandle,
): Promise<{ baseSha: string }> {
  const ctx = await ensureBox(handle);
  await boxDiscard(ctx);
  const after = await boxHead(ctx);
  pokeApp(handle.doc.workspaceId, null, "discard", handle.doc.userId);
  return { baseSha: after.head };
}
