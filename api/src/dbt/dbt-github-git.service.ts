/**
 * Git write operations for repo-bound dbt projects: per-user working-tree
 * status, commit & push, branch create/switch, and pull requests — the in-IDE
 * git surface that mirrors dbt Cloud.
 *
 * The working tree is per user AND per branch: DbtFile rows are the COMMITTED
 * base tree of a branch, DbtFileDraft rows are the caller's uncommitted
 * overlay keyed to the branch they were made on, and DbtCheckout points each
 * user at their own branch. Status/commit therefore only ever see the acting
 * user's drafts for their checked-out branch — switching branches leaves each
 * branch's dirty state in place (git-worktree semantics). Pushing builds a
 * single commit via the Git Data API, updates the branch's base tree, and
 * clears the committed drafts.
 *
 * Branch protection: branches listed in `project.protectedBranches` refuse
 * direct commits — changes reach them only through a PR (commit-to-branch →
 * open PR → merge).
 */
import {
  DbtCheckout,
  DbtFile,
  DbtFileDraft,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { gitBlobSha } from "../integrations/github/git-blob";
import {
  commitChanges,
  compareRefs,
  createBranch,
  createPullRequest,
  deleteBranch,
  getPullRequest,
  getRefCommit,
  getRepoInfo,
  getRepoTree,
  listBranches,
  listPullRequests,
  mergePullRequest,
  tryDeleteBranch,
  updatePullRequest,
  type CompareRefsResult,
  type MergeMethod,
  type PullRequestSummary,
  type TreeChange,
} from "../integrations/github/github-api";
import { syncProjectBranchFromRepo } from "./dbt-github-sync.service";
import {
  baseTreeFilter,
  cloneBranchBaseTree,
  deleteBranchBaseTree,
  deleteBranchDrafts,
  discardUserDrafts,
  getCheckoutBranch,
  moveBranchDrafts,
  moveUserDrafts,
  setCheckoutBranch,
} from "./dbt-working-tree.service";

/**
 * Per-project promise-chain lock. Every git mutation (commit, branch create,
 * branch switch, atomic promote) runs through this so they can't interleave on
 * stale in-memory copies of checkout/branch state. Mirrors the warm-dir lock
 * in workspace-dir.service.ts: each acquirer waits on the previous holder.
 */
const gitLocks = new Map<string, Promise<void>>();

async function withProjectGitLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = gitLocks.get(projectId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  gitLocks.set(projectId, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (gitLocks.get(projectId) === chained) gitLocks.delete(projectId);
  }
}

/**
 * Re-load the project document fresh from Mongo inside a locked section so we
 * act on current state, not a stale copy the caller loaded before the lock.
 */
type RepoBoundProject = IDbtProject & {
  repo: NonNullable<IDbtProject["repo"]>;
};

async function reloadRepoProject(
  project: IDbtProject,
): Promise<RepoBoundProject> {
  const fresh = await DbtProject.findById(project._id);
  if (!fresh?.repo) {
    throw new Error("Project is not connected to a repository");
  }
  return fresh as RepoBoundProject;
}

/** True when direct commits to `branch` are refused (PR-only). */
export function isProtectedBranch(
  project: IDbtProject,
  branch: string,
): boolean {
  return (project.protectedBranches ?? []).includes(branch);
}

/** Thrown when a direct commit targets a protected branch (HTTP 400). */
export class ProtectedBranchError extends Error {
  constructor(branch: string) {
    super(
      `Branch "${branch}" is protected — direct commits are not allowed. ` +
        "Commit to a new branch instead (commit-to-branch) and open a pull " +
        "request to merge into it.",
    );
    this.name = "ProtectedBranchError";
  }
}

function assertNotProtected(project: IDbtProject, branch: string): void {
  if (isProtectedBranch(project, branch)) {
    throw new ProtectedBranchError(branch);
  }
}

export interface GitFileStatus {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface GitStatus {
  branch: string;
  changes: GitFileStatus[];
  added: number;
  modified: number;
  deleted: number;
  hasChanges: boolean;
}

export interface GitStatusOptions {
  /** Project-relative paths to include; omitted means the full working tree. */
  paths?: string[];
}

function repoPath(project: IDbtProject, path: string): string {
  const subdir = project.repo?.subdirectory?.replace(/^\/+|\/+$/g, "");
  return subdir ? `${subdir}/${path}` : path;
}

function normalizeCommitPaths(paths?: string[]): string[] | undefined {
  if (!paths) return undefined;
  const normalized = [
    ...new Set(
      paths.map(path =>
        path
          .trim()
          .replace(/^\.\/+/, "")
          .replace(/^\/+/, ""),
      ),
    ),
  ].filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("At least one project-relative path is required.");
  }
  return normalized;
}

function summarizeChanges(branch: string, changes: GitFileStatus[]): GitStatus {
  const added = changes.filter(c => c.status === "added").length;
  const modified = changes.filter(c => c.status === "modified").length;
  const deleted = changes.filter(c => c.status === "deleted").length;
  return {
    branch,
    changes,
    added,
    modified,
    deleted,
    hasChanges: changes.length > 0,
  };
}

function filterGitStatus(status: GitStatus, paths?: string[]): GitStatus {
  const normalized = normalizeCommitPaths(paths);
  if (!normalized) return status;

  const changesByPath = new Map(
    status.changes.map(change => [change.path, change]),
  );
  const selectedChanges = normalized
    .map(path => changesByPath.get(path))
    .filter((change): change is GitFileStatus => change !== undefined);
  const missing = normalized.filter(path => !changesByPath.has(path));

  if (missing.length > 0) {
    const available = status.changes.map(change => change.path).join(", ");
    throw new Error(
      `Selected path(s) have no pending changes: ${missing.join(", ")}.` +
        (available
          ? ` Pending changed paths are: ${available}.`
          : " The working tree is clean."),
    );
  }

  return summarizeChanges(status.branch, selectedChanges);
}

interface DraftForStatus {
  path: string;
  content?: string;
  is_deleted?: boolean;
}

interface BaseForStatus {
  path: string;
  content?: string;
  repoBlobSha?: string;
}

/** Pure status computation: the caller's drafts vs a branch's base tree. */
export function computeDraftStatus(
  branch: string,
  drafts: DraftForStatus[],
  baseByPath: Map<string, BaseForStatus>,
): GitStatus {
  const changes: GitFileStatus[] = [];
  for (const draft of drafts) {
    const base = baseByPath.get(draft.path);
    if (draft.is_deleted) {
      // Only counts as a deletion if the file exists on the branch.
      if (base) changes.push({ path: draft.path, status: "deleted" });
      continue;
    }
    if (!base) {
      changes.push({ path: draft.path, status: "added" });
      continue;
    }
    const baseSha = base.repoBlobSha ?? gitBlobSha(base.content ?? "");
    if (gitBlobSha(draft.content ?? "") !== baseSha) {
      changes.push({ path: draft.path, status: "modified" });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return summarizeChanges(branch, changes);
}

async function loadStatusInputs(
  project: IDbtProject,
  userId: string,
): Promise<{
  branch: string;
  drafts: DraftForStatus[];
  baseByPath: Map<string, BaseForStatus>;
}> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const branch = (await getCheckoutBranch(project, userId)) as string;
  const [drafts, baseRows] = await Promise.all([
    DbtFileDraft.find({ projectId: project._id, userId, branch })
      .select("path content is_deleted")
      .lean(),
    DbtFile.find({
      ...baseTreeFilter(project, branch),
      is_deleted: { $ne: true },
    })
      .select("path content repoBlobSha")
      .lean(),
  ]);
  return {
    branch,
    drafts,
    baseByPath: new Map(baseRows.map(row => [row.path, row])),
  };
}

/**
 * Compute the caller's working-tree status: their drafts vs the committed
 * base tree of their checked-out branch. Other users' drafts never appear.
 */
export async function getGitStatus(
  project: IDbtProject,
  userId: string,
  options: GitStatusOptions = {},
): Promise<GitStatus> {
  const { branch, drafts, baseByPath } = await loadStatusInputs(
    project,
    userId,
  );
  return filterGitStatus(
    computeDraftStatus(branch, drafts, baseByPath),
    options.paths,
  );
}

export interface GitFileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  /** Committed content at the checkout branch head (empty for added files). */
  base: string;
  /** The caller's working-tree content (empty for deleted files). */
  working: string;
}

/**
 * Side-by-side diff for one changed file: the committed base content (from
 * the branch's base tree in Mongo — no GitHub round-trip) vs the caller's
 * draft content.
 */
export async function getProjectFileDiff(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<GitFileDiff> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const branch = await getCheckoutBranch(project, userId);
  const [draft, baseRow] = await Promise.all([
    DbtFileDraft.findOne({ projectId: project._id, userId, branch, path })
      .select("content is_deleted")
      .lean(),
    DbtFile.findOne({
      ...baseTreeFilter(project, branch),
      path,
      is_deleted: { $ne: true },
    })
      .select("content")
      .lean(),
  ]);
  if (!draft) throw new Error(`No pending change for file: ${path}`);

  const base = baseRow?.content ?? "";
  const working = draft.is_deleted ? "" : (draft.content ?? "");
  const status: GitFileStatus["status"] = draft.is_deleted
    ? "deleted"
    : baseRow
      ? "modified"
      : "added";

  return { path, status, base, working };
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  branch: string;
  pushed: { added: number; modified: number; deleted: number };
}

/**
 * Commit the caller's draft changes and push them to their checked-out branch
 * in a single commit. Updates the branch's base tree (so every user on that
 * branch sees the committed state) and clears the committed drafts.
 *
 * Refuses when the checkout branch is protected (PR-only).
 */
export async function commitAndPush(
  project: IDbtProject,
  params: {
    userId: string;
    message: string;
    updatedBy: string;
    paths?: string[];
  },
): Promise<CommitResult> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const branch = (await getCheckoutBranch(fresh, params.userId)) as string;
    assertNotProtected(fresh, branch);
    const status = await getGitStatus(fresh, params.userId, {
      paths: params.paths,
    });
    if (!status.hasChanges) {
      return {
        committed: false,
        branch,
        pushed: { added: 0, modified: 0, deleted: 0 },
      };
    }
    return pushWorkingTree(fresh, params.userId, branch, status, {
      message: params.message,
      updatedBy: params.updatedBy,
    });
  });
}

/**
 * Build a single commit from the caller's drafts and push it to `branch`.
 * Updates base rows, clears the committed drafts, and stamps sync SHAs. The
 * caller MUST hold the project git lock.
 */
async function pushWorkingTree(
  project: RepoBoundProject,
  userId: string,
  branch: string,
  status: GitStatus,
  params: { message: string; updatedBy: string },
): Promise<CommitResult> {
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo } = project.repo;

  const drafts = await DbtFileDraft.find({
    projectId: project._id,
    userId,
    branch,
  })
    .select("path content is_deleted")
    .lean();
  const draftByPath = new Map(drafts.map(d => [d.path, d]));

  const { commitSha, treeSha } = await getRefCommit(owner, repo, branch, token);

  // GitHub returns 422 GitRPC::BadObject if a tree entry deletes (sha:null) a
  // path that isn't in base_tree. Phantom deletions (files removed upstream
  // but still draft-deleted locally) would trip this, so drop any deletion
  // whose path no longer exists on the branch and just reconcile it locally.
  const baseTree = await getRepoTree(owner, repo, treeSha, token);
  const baseTreePaths = new Set(
    baseTree.entries.filter(e => e.type === "blob").map(e => e.path),
  );

  const treeChanges: TreeChange[] = [];
  const phantomDeletions: string[] = [];
  for (const change of status.changes) {
    const path = repoPath(project, change.path);
    if (change.status === "deleted") {
      if (!baseTreePaths.has(path)) {
        phantomDeletions.push(change.path);
        continue;
      }
      treeChanges.push({ path, content: null });
    } else {
      treeChanges.push({
        path,
        content: draftByPath.get(change.path)?.content ?? "",
      });
    }
  }

  // Reconcile local state: base rows advance to the committed content and the
  // committed drafts disappear. Phantom deletions never reach GitHub but must
  // still be cleaned up so they stop showing as pending changes.
  const ops: Array<Promise<unknown>> = [];
  for (const change of status.changes) {
    ops.push(
      DbtFileDraft.deleteOne({
        projectId: project._id,
        userId,
        branch,
        path: change.path,
      }).exec(),
    );
    if (change.status === "deleted") {
      ops.push(
        DbtFile.deleteOne({
          projectId: project._id,
          branch,
          path: change.path,
        }).exec(),
      );
    } else {
      const content = draftByPath.get(change.path)?.content ?? "";
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, branch, path: change.path },
          {
            $set: {
              content,
              updatedBy: params.updatedBy,
              is_deleted: false,
              workspaceId: project.workspaceId,
              repoBlobSha: gitBlobSha(content),
            },
          },
          { upsert: true, setDefaultsOnInsert: true },
        ).exec(),
      );
    }
  }

  // Nothing real to push (every change was a phantom deletion): heal local
  // state without creating an empty commit.
  if (treeChanges.length === 0) {
    await Promise.all(ops);
    return {
      committed: false,
      branch,
      pushed: { added: 0, modified: 0, deleted: 0 },
    };
  }

  const newSha = await commitChanges(
    owner,
    repo,
    {
      branch,
      parentSha: commitSha,
      baseTreeSha: treeSha,
      message: params.message,
      changes: treeChanges,
    },
    token,
  );

  await Promise.all(ops);

  await setCheckoutBranch(project, userId, branch, { lastSyncedSha: newSha });
  if (branch === project.repo.branch) {
    project.repo.lastSyncedSha = newSha;
    project.repo.lastSyncedAt = new Date();
    project.markModified("repo");
    await project.save();
  }

  return {
    committed: true,
    sha: newSha,
    branch,
    pushed: {
      added: status.added,
      modified: status.modified,
      deleted: status.deleted - phantomDeletions.length,
    },
  };
}

export interface PromoteResult extends CommitResult {
  /** Branch the new branch was forked from (the user's previous checkout). */
  fromBranch: string;
}

/**
 * Atomic "promote": create a feature branch off the caller's checked-out
 * branch HEAD and commit their drafts onto it — in one locked critical
 * section. This is the path around protected branches: work done on a
 * protected checkout moves to a feature branch for review.
 *
 * Afterwards the caller's checkout tracks the new branch with a clean
 * overlay; open a PR with `openProjectPullRequest`.
 */
export async function commitToNewBranch(
  project: IDbtProject,
  params: {
    userId: string;
    branchName: string;
    message: string;
    updatedBy: string;
    paths?: string[];
  },
): Promise<PromoteResult> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    assertNotProtected(fresh, params.branchName);
    const fromBranch = (await getCheckoutBranch(
      fresh,
      params.userId,
    )) as string;
    const status = await getGitStatus(fresh, params.userId, {
      paths: params.paths,
    });
    if (!status.hasChanges) {
      throw new Error(
        "No working-tree changes to promote — nothing to put on a new branch. " +
          "The changes may already be committed (check dbt_git_status).",
      );
    }

    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;

    // Fork the new branch from the branch the user currently tracks, clone
    // its committed base tree, move the user's drafts onto the new branch
    // (the promote takes their dirty tree with it), and point their checkout
    // at it BEFORE committing so pushWorkingTree targets the new branch.
    const { commitSha } = await getRefCommit(owner, repo, fromBranch, token);
    await createBranch(owner, repo, params.branchName, commitSha, token);
    await cloneBranchBaseTree(fresh, fromBranch, params.branchName);
    await moveUserDrafts(fresh, params.userId, fromBranch, params.branchName);
    await setCheckoutBranch(fresh, params.userId, params.branchName);

    const result = await pushWorkingTree(
      fresh,
      params.userId,
      params.branchName,
      status,
      { message: params.message, updatedBy: params.updatedBy },
    );
    return { ...result, fromBranch };
  });
}

export async function listProjectBranches(
  project: IDbtProject,
): Promise<string[]> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  return listBranches(project.repo.owner, project.repo.repo, token);
}

/**
 * Create a new branch off the caller's checkout HEAD and check it out for
 * them (only their checkout moves — other users are unaffected). Content is
 * identical to the source branch, so the base tree is cloned locally. The
 * caller's uncommitted drafts move to the new branch (`git checkout -b`
 * takes the dirty tree with it — the "started on main, need a branch" flow);
 * the bases are identical so the diff is unchanged.
 */
export async function createProjectBranch(
  project: IDbtProject,
  userId: string,
  branchName: string,
): Promise<{ branch: string; fromBranch: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const fromBranch = (await getCheckoutBranch(fresh, userId)) as string;
    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;
    const { commitSha } = await getRefCommit(owner, repo, fromBranch, token);
    await createBranch(owner, repo, branchName, commitSha, token);
    await cloneBranchBaseTree(fresh, fromBranch, branchName);
    await moveUserDrafts(fresh, userId, fromBranch, branchName);
    await setCheckoutBranch(fresh, userId, branchName, {
      lastSyncedSha: commitSha,
    });
    return { branch: branchName, fromBranch };
  });
}

/**
 * Switch the caller's checkout to another branch. Only their branch pointer
 * moves; their drafts STAY WITH THE BRANCH they were made on (git-worktree
 * semantics), so uncommitted work on the old branch is waiting untouched
 * when they switch back, and never re-bases onto the target branch. Pass
 * `discardLocalChanges` to drop the caller's drafts on the branch they are
 * leaving. The target branch's committed base tree is synced from GitHub.
 *
 * `pendingChanges` reports the caller's uncommitted changes already stashed
 * on the TARGET branch (from a previous session there).
 */
export async function switchProjectBranch(
  project: IDbtProject,
  userId: string,
  branchName: string,
  updatedBy: string,
  options: { discardLocalChanges?: boolean } = {},
): Promise<{ branch: string; discarded?: GitStatus; pendingChanges: number }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);

    let discarded: GitStatus | undefined;
    if (options.discardLocalChanges) {
      const fromBranch = (await getCheckoutBranch(fresh, userId)) as string;
      const status = await getGitStatus(fresh, userId);
      if (status.hasChanges) discarded = status;
      await discardUserDrafts(fresh, userId, fromBranch);
    }

    // Materialize/refresh the target branch's committed base tree.
    const sync = await syncProjectBranchFromRepo(fresh, branchName, updatedBy);
    await setCheckoutBranch(fresh, userId, branchName, {
      lastSyncedSha: sync.sha,
    });

    const pendingChanges = (await getGitStatus(fresh, userId)).changes.length;
    return discarded?.hasChanges
      ? { branch: branchName, discarded, pendingChanges }
      : { branch: branchName, pendingChanges };
  });
}

/**
 * Delete a remote branch. Refuses to delete the caller's checked-out branch,
 * any branch another user has checked out, the project default branch, and
 * the repo default branch. Cleans up the branch's local base tree and any
 * drafts stashed on it (deleting a branch abandons its uncommitted work).
 */
export async function deleteProjectBranch(
  project: IDbtProject,
  userId: string,
  branchName: string,
): Promise<{ deleted: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;
    const userBranch = await getCheckoutBranch(fresh, userId);
    if (branchName === userBranch) {
      throw new Error(
        `Cannot delete "${branchName}" — it is your currently checked-out ` +
          "branch. Switch to another branch first (dbt_switch_branch).",
      );
    }
    if (branchName === fresh.repo.branch) {
      throw new Error(
        `Cannot delete "${branchName}" — it is the project's default branch.`,
      );
    }
    const otherCheckout = await DbtCheckout.findOne({
      projectId: fresh._id,
      branch: branchName,
      userId: { $ne: userId },
    })
      .select("userId")
      .lean();
    if (otherCheckout) {
      throw new Error(
        `Cannot delete "${branchName}" — another user has it checked out.`,
      );
    }
    const info = await getRepoInfo(owner, repo, token);
    if (branchName === info.defaultBranch) {
      throw new Error(
        `Refusing to delete the repository's default branch "${branchName}".`,
      );
    }
    await deleteBranch(owner, repo, branchName, token);
    await deleteBranchBaseTree(fresh, branchName);
    await deleteBranchDrafts(fresh, branchName);
    return { deleted: branchName };
  });
}

export interface RecoverableFile {
  path: string;
  content: string;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * Soft-deleted files whose content is still retained in Mongo and can be
 * restored — e.g. work hidden by a destructive branch switch/sync before the
 * non-destructive guards landed. These don't appear in the normal file tree.
 */
export async function listRecoverableFiles(
  project: IDbtProject,
): Promise<RecoverableFile[]> {
  const files = await DbtFile.find({
    projectId: project._id,
    is_deleted: true,
  })
    .select("path content updatedAt updatedBy")
    .sort({ updatedAt: -1 })
    .lean();
  return files
    .filter(f => (f.content ?? "").length > 0)
    .map(f => ({
      path: f.path,
      content: f.content ?? "",
      updatedAt: f.updatedAt,
      updatedBy: f.updatedBy,
    }));
}

/**
 * Restore a soft-deleted file into the caller's working tree as a pending
 * "added" draft, so they can review and commit it. Returns the restored
 * content for confirmation.
 */
export async function restoreDeletedFile(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<{ path: string; content: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const file = await DbtFile.findOne({
      projectId: project._id,
      path,
      is_deleted: true,
    })
      .select("content")
      .sort({ updatedAt: -1 })
      .lean();
    if (!file) {
      throw new Error(`No recoverable file at "${path}".`);
    }
    const branch = (await getCheckoutBranch(project, userId)) as string;
    await DbtFileDraft.updateOne(
      { projectId: project._id, userId, branch, path },
      {
        $set: {
          content: file.content ?? "",
          is_deleted: false,
          workspaceId: project.workspaceId,
        },
      },
      { upsert: true },
    ).exec();
    return { path, content: file.content ?? "" };
  });
}

export async function openProjectPullRequest(
  project: IDbtProject,
  userId: string,
  params: { title: string; body?: string; base?: string },
): Promise<{ number: number; htmlUrl: string }> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo } = project.repo;
  const branch = (await getCheckoutBranch(project, userId)) as string;
  let base = params.base;
  if (!base) {
    const info = await getRepoInfo(owner, repo, token);
    base = info.defaultBranch;
  }
  if (base === branch) {
    throw new Error(
      `Current branch "${branch}" is the base branch — create a feature branch first`,
    );
  }
  return createPullRequest(
    owner,
    repo,
    { title: params.title, head: branch, base, body: params.body },
    token,
  );
}

/**
 * List the repository's pull requests (newest first). Purely a GitHub read —
 * no git lock needed. `state` defaults to "open".
 */
export async function listProjectPullRequests(
  project: IDbtProject,
  params: { state?: "open" | "closed" | "all" } = {},
): Promise<PullRequestSummary[]> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  return listPullRequests(
    project.repo.owner,
    project.repo.repo,
    { state: params.state ?? "open" },
    token,
  );
}

export interface BranchComparison extends CompareRefsResult {
  base: string;
  head: string;
  /** PRs (any state) whose head is the compared branch. */
  pullRequests: PullRequestSummary[];
  /**
   * True when head's content is already in base: either every head commit is
   * on base (`aheadBy === 0`), or a PR from head into base was merged after
   * head's last commit (squash/rebase merges keep aheadBy > 0 even though the
   * content landed).
   */
  fullyMergedIntoBase: boolean;
}

/**
 * Compare a branch (or any ref) against a base ref — GitHub's
 * `base...head` three-dot compare (head vs the merge base, like a PR diff) —
 * plus the PRs opened from that branch. Purely a GitHub read — no git lock.
 * `base` defaults to the repo's default branch.
 */
export async function compareProjectRefs(
  project: IDbtProject,
  params: { head: string; base?: string },
): Promise<BranchComparison> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo } = project.repo;

  let base = params.base;
  if (!base) {
    const info = await getRepoInfo(owner, repo, token);
    base = info.defaultBranch;
  }

  const [compare, pullRequests] = await Promise.all([
    compareRefs(owner, repo, base, params.head, token),
    listPullRequests(
      owner,
      repo,
      { state: "all", head: `${owner}:${params.head}` },
      token,
    ),
  ]);

  // Squash/rebase merges never put head's SHAs on base, so aheadBy stays > 0.
  // A PR into base merged AFTER head's last commit proves the content landed.
  const lastCommitAt = compare.commits.reduce<string | undefined>(
    (latest, c) => (c.date && (!latest || c.date > latest) ? c.date : latest),
    undefined,
  );
  const mergedViaPr = pullRequests.some(
    pr =>
      pr.merged &&
      pr.baseRef === base &&
      lastCommitAt !== undefined &&
      pr.mergedAt !== undefined &&
      pr.mergedAt >= lastCommitAt,
  );

  return {
    ...compare,
    base,
    head: params.head,
    pullRequests,
    fullyMergedIntoBase: compare.aheadBy === 0 || mergedViaPr,
  };
}

/**
 * Update a pull request's title, body, and/or base branch. At least one field
 * must be provided. Works on open PRs only — closed/merged PRs are immutable
 * from Mako to avoid confusing GitHub history rewrites.
 */
export async function updateProjectPullRequest(
  project: IDbtProject,
  params: { prNumber: number; title?: string; body?: string; base?: string },
): Promise<PullRequestSummary> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  if (
    params.title === undefined &&
    params.body === undefined &&
    params.base === undefined
  ) {
    throw new Error(
      "Nothing to update — provide at least one of title, body, or base",
    );
  }
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo } = project.repo;
  const pr = await getPullRequest(owner, repo, params.prNumber, token);
  if (pr.state !== "open") {
    throw new Error(
      `Pull request #${params.prNumber} is ${pr.state} — only open PRs can be updated`,
    );
  }
  return updatePullRequest(
    owner,
    repo,
    params.prNumber,
    { title: params.title, body: params.body, base: params.base },
    token,
  );
}

export interface ClosePullRequestResult {
  pr: PullRequestSummary;
  branchDeleted: boolean;
  branchDeleteWarning?: string;
}

/**
 * Close a pull request WITHOUT merging it. Optionally delete its head branch
 * afterwards (default false — closing shouldn't destroy the work). Branch
 * deletion refuses when the branch is the project default or any user has it
 * checked out; a deleted branch's local base tree is cleaned up.
 */
export async function closeProjectPullRequest(
  project: IDbtProject,
  params: { prNumber: number; deleteBranch?: boolean },
): Promise<ClosePullRequestResult> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;

    const existing = await getPullRequest(owner, repo, params.prNumber, token);
    if (existing.state !== "open") {
      throw new Error(
        `Pull request #${params.prNumber} is already ${existing.state}`,
      );
    }

    const pr = await updatePullRequest(
      owner,
      repo,
      params.prNumber,
      { state: "closed" },
      token,
    );

    let branchDeleted = false;
    let branchDeleteWarning: string | undefined;
    if (params.deleteBranch) {
      const headRef = existing.headRef;
      const checkout = await DbtCheckout.findOne({
        projectId: fresh._id,
        branch: headRef,
      })
        .select("userId")
        .lean();
      if (headRef === fresh.repo.branch) {
        branchDeleteWarning =
          `Branch "${headRef}" was not deleted — it is the project's ` +
          "default branch.";
      } else if (checkout) {
        branchDeleteWarning =
          `Branch "${headRef}" was not deleted — a user has it checked out. ` +
          "Delete it with dbt_delete_branch after they switch away.";
      } else {
        const deleteResult = await tryDeleteBranch(owner, repo, headRef, token);
        branchDeleted = deleteResult.deleted;
        branchDeleteWarning = deleteResult.warning;
        if (branchDeleted) {
          await deleteBranchBaseTree(fresh, headRef);
          await deleteBranchDrafts(fresh, headRef);
        }
      }
    }

    return { pr, branchDeleted, branchDeleteWarning };
  });
}

export interface MergePullRequestResult {
  sha: string;
  branchDeleted: boolean;
  branchDeleteWarning?: string;
  branch: string;
  workingTreeClean: boolean;
}

/**
 * Merge a GitHub pull request, optionally delete its head branch, then switch
 * the caller's checkout back to the repo default branch and sync the merged
 * state into that branch's base tree. Users checked out on the deleted head
 * branch are moved back to the default branch, and uncommitted drafts on the
 * deleted branch move with them (they would otherwise be orphaned on a
 * branch that no longer exists).
 */
export async function mergeProjectPullRequest(
  project: IDbtProject,
  params: {
    userId: string;
    prNumber: number;
    mergeMethod?: MergeMethod;
    deleteBranch?: boolean;
    updatedBy: string;
  },
): Promise<MergePullRequestResult> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;

    const pr = await getPullRequest(owner, repo, params.prNumber, token);
    if (pr.state !== "open") {
      throw new Error(
        `Pull request #${params.prNumber} is ${pr.state} — only open PRs can be merged`,
      );
    }

    const info = await getRepoInfo(owner, repo, token);
    const defaultBranch = info.defaultBranch;

    const { sha } = await mergePullRequest(
      owner,
      repo,
      params.prNumber,
      { mergeMethod: params.mergeMethod ?? "squash" },
      token,
    );

    // Pull the merged state into the default branch's base tree and move the
    // caller (plus anyone stranded on the head branch) onto it.
    const syncResult = await syncProjectBranchFromRepo(
      fresh,
      defaultBranch,
      params.updatedBy,
    );
    await setCheckoutBranch(fresh, params.userId, defaultBranch, {
      lastSyncedSha: syncResult.sha,
    });

    let branchDeleted = false;
    let branchDeleteWarning: string | undefined;
    if (params.deleteBranch !== false) {
      if (pr.headRef === fresh.repo.branch) {
        // Never delete the project's tracked branch (or its base tree) — that
        // is what deploy/job runs build. A stale tracked pointer (left behind
        // by the pre-per-user-working-trees model) would otherwise take the
        // whole committed tree with it and break every scheduled run with
        // "No dbt_project.yml found". Mirrors closeProjectPullRequest.
        branchDeleteWarning =
          `Branch "${pr.headRef}" was not deleted — it is the project's ` +
          "tracked branch. Change the project's branch in settings first if " +
          "you want to remove it.";
      } else {
        const deleteResult = await tryDeleteBranch(
          owner,
          repo,
          pr.headRef,
          token,
        );
        branchDeleted = deleteResult.deleted;
        branchDeleteWarning = deleteResult.warning;
        if (branchDeleted) {
          await deleteBranchBaseTree(fresh, pr.headRef);
          await moveBranchDrafts(fresh, pr.headRef, defaultBranch);
          await DbtCheckout.updateMany(
            { projectId: fresh._id, branch: pr.headRef },
            {
              $set: {
                branch: defaultBranch,
                lastSyncedSha: syncResult.sha,
                lastSyncedAt: new Date(),
              },
            },
          ).exec();
        }
      }
    }

    const status = await getGitStatus(fresh, params.userId);
    return {
      sha,
      branchDeleted,
      branchDeleteWarning,
      branch: defaultBranch,
      workingTreeClean: !status.hasChanges,
    };
  });
}
