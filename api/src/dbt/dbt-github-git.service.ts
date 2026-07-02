/**
 * Git write operations for repo-bound dbt projects: per-user working-tree
 * status, commit & push, branch create/switch, and pull requests — the in-IDE
 * git surface that mirrors dbt Cloud.
 *
 * File content lives exclusively in the project's local bare git repository
 * (dbt-git-store.service.ts): local branches mirror the GitHub remote, and a
 * user's uncommitted work is a draft overlay ref rebased onto their checkout
 * branch head. Commits are real git commits pushed with
 * `--force-with-lease`; branch create/delete are `git push` operations.
 * Pull-request metadata (open/list/merge/close) stays on the GitHub API.
 *
 * Branch protection: branches listed in `project.protectedBranches` refuse
 * direct commits — changes reach them only through a PR (commit-to-branch →
 * open PR → merge).
 */
import {
  DbtCheckout,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import {
  createPullRequest,
  getPullRequest,
  listPullRequests,
  mergePullRequest,
  updatePullRequest,
  type MergeMethod,
  type PullRequestSummary,
} from "../integrations/github/github-api";
import { resolveProjectRemote } from "./dbt-git-remote";
import {
  ZERO_SHA,
  authorFor,
  branchRef,
  commitTreeUpdate,
  deleteRef,
  draftRefsFor,
  fetchBranch,
  listDeletedFiles,
  listRemoteBranchNames,
  pushBranch,
  pushDeleteBranch,
  readBlobAt,
  remoteDefaultBranch,
  resolveCommit,
  treeShaOf,
  updateRef,
} from "./dbt-git-store.service";
import { toProjectPath, toRepoPath } from "./dbt-paths";
import { syncProjectBranchFromRepo } from "./dbt-github-sync.service";
import {
  discardUserDrafts,
  ensureProjectRepo,
  getCheckoutBranch,
  resolveWorkingState,
  setCheckoutBranch,
  workingTreeChanges,
  writeWorkingFile,
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

/**
 * Compute the caller's working-tree status: their draft overlay vs the head
 * of their checked-out branch. Other users' drafts never appear.
 */
export async function getGitStatus(
  project: IDbtProject,
  userId: string,
  options: GitStatusOptions = {},
): Promise<GitStatus> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const state = await resolveWorkingState(project, userId);
  const changes = await workingTreeChanges(project, state);
  return filterGitStatus(
    summarizeChanges(state.branch, changes),
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
 * Side-by-side diff for one changed file: the committed content at the
 * branch head vs the caller's working-tree content.
 */
export async function getProjectFileDiff(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<GitFileDiff> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const state = await resolveWorkingState(project, userId);
  const changes = await workingTreeChanges(project, state);
  const change = changes.find(c => c.path === path);
  if (!change) throw new Error(`No pending change for file: ${path}`);

  const repoPath = toRepoPath(project, path);
  const base = state.headSha
    ? ((await readBlobAt(state.repoDir, state.headSha, repoPath)) ?? "")
    : "";
  const working =
    change.status === "deleted" || !state.workingSha
      ? ""
      : ((await readBlobAt(state.repoDir, state.workingSha, repoPath)) ?? "");

  return { path, status: change.status, base, working };
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  branch: string;
  pushed: { added: number; modified: number; deleted: number };
}

/**
 * Commit the caller's pending changes and push them to their checked-out
 * branch in a single commit. Advances the local branch mirror (so every user
 * on that branch sees the committed state) and clears the committed overlay.
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
    const branch = await getCheckoutBranch(fresh, params.userId);
    assertNotProtected(fresh, branch);
    return pushWorkingTree(fresh, params.userId, branch, {
      message: params.message,
      paths: params.paths,
      allowEmpty: true,
    });
  });
}

/**
 * Build a single commit from the caller's overlay and push it to `branch`.
 * The caller MUST hold the project git lock.
 */
async function pushWorkingTree(
  project: RepoBoundProject,
  userId: string,
  branch: string,
  params: { message: string; paths?: string[]; allowEmpty?: boolean },
): Promise<CommitResult> {
  const repoDir = await ensureProjectRepo(project);
  const remote = await resolveProjectRemote(project.repo);

  // Refresh the branch from the remote first so the commit applies on the
  // true head (concurrent pushes from outside Mako).
  const headSha = await fetchBranch(repoDir, remote, branch);

  const state = await resolveWorkingState(project, userId);
  const allChanges = await workingTreeChanges(project, state);
  const status = filterGitStatus(
    summarizeChanges(branch, allChanges),
    params.paths,
  );
  if (!status.hasChanges) {
    if (params.allowEmpty) {
      return {
        committed: false,
        branch,
        pushed: { added: 0, modified: 0, deleted: 0 },
      };
    }
    throw new Error(
      "No working-tree changes to promote — nothing to put on a new branch. " +
        "The changes may already be committed (check dbt_git_status).",
    );
  }

  // Selected changes come out of the draft tip's tree.
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  for (const change of status.changes) {
    const repoPath = toRepoPath(project, change.path);
    if (change.status === "deleted") {
      deletes.push(repoPath);
    } else {
      const content = await readBlobAt(
        repoDir,
        state.workingSha as string,
        repoPath,
      );
      writes.push({ path: repoPath, content: content ?? "" });
    }
  }

  // Dangling commit first; the local branch mirror only advances after the
  // remote accepted the push, so it always mirrors the remote.
  const { sha, treeSha } = await commitTreeUpdate(repoDir, {
    baseTree: headSha,
    parents: [headSha],
    writes,
    deletes,
    message: params.message,
    author: authorFor(userId),
  });

  // Every selected change was a no-op against the fresh head (e.g. deletions
  // of files already removed upstream) — heal the overlay without pushing an
  // empty commit.
  if (treeSha === (await treeShaOf(repoDir, headSha))) {
    await clearCommittedOverlay(project, userId, repoDir, status, {
      newHead: headSha,
      allChanges,
    });
    return {
      committed: false,
      branch,
      pushed: { added: 0, modified: 0, deleted: 0 },
    };
  }

  await pushBranch(repoDir, remote, {
    localSha: sha,
    branch,
    expectedRemoteSha: headSha,
  });
  await updateRef(repoDir, branchRef(branch), sha, headSha);

  await clearCommittedOverlay(project, userId, repoDir, status, {
    newHead: sha,
    allChanges,
  });

  await setCheckoutBranch(project, userId, branch, { lastSyncedSha: sha });
  if (branch === project.repo.branch) {
    project.repo.lastSyncedSha = sha;
    project.repo.lastSyncedAt = new Date();
    project.markModified("repo");
    await project.save();
  }

  return {
    committed: true,
    sha,
    branch,
    pushed: {
      added: status.added,
      modified: status.modified,
      deleted: status.deleted,
    },
  };
}

/**
 * After a commit lands, drop the committed paths from the user's overlay.
 * A partial commit (`paths`) keeps the remaining changes as a fresh overlay
 * forked from the new head; a full commit deletes the overlay.
 */
async function clearCommittedOverlay(
  project: RepoBoundProject,
  userId: string,
  repoDir: string,
  status: GitStatus,
  opts: { newHead: string; allChanges: GitFileStatus[] },
): Promise<void> {
  const refs = draftRefsFor(userId);
  const committedPaths = new Set(status.changes.map(change => change.path));
  const remaining = opts.allChanges.filter(
    change => !committedPaths.has(change.path),
  );

  if (remaining.length === 0) {
    await deleteRef(repoDir, refs.tip);
    await deleteRef(repoDir, refs.base);
    return;
  }

  const tip = await resolveCommit(repoDir, refs.tip);
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  for (const change of remaining) {
    const repoPath = toRepoPath(project, change.path);
    if (change.status === "deleted") {
      deletes.push(repoPath);
    } else {
      const content = tip ? await readBlobAt(repoDir, tip, repoPath) : null;
      writes.push({ path: repoPath, content: content ?? "" });
    }
  }
  await commitTreeUpdate(repoDir, {
    ref: refs.tip,
    baseTree: opts.newHead,
    parents: [opts.newHead],
    writes,
    deletes,
    message: "Carry uncommitted changes",
    author: authorFor(userId),
  });
  await updateRef(repoDir, refs.base, opts.newHead);
}

export interface PromoteResult extends CommitResult {
  /** Branch the new branch was forked from (the user's previous checkout). */
  fromBranch: string;
}

/**
 * Atomic "promote": create a feature branch off the caller's checked-out
 * branch HEAD and commit their pending changes onto it — in one locked
 * critical section. This is the path around protected branches: work done on
 * a protected checkout moves to a feature branch for review.
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
    const fromBranch = await getCheckoutBranch(fresh, params.userId);

    // Fork the new branch from the branch the user currently tracks and
    // point their checkout at it BEFORE committing so pushWorkingTree
    // targets the new branch. Their overlay follows the checkout.
    const created = await createBranchFromCheckout(
      fresh,
      params.userId,
      params.branchName,
    );

    try {
      const result = await pushWorkingTree(
        fresh,
        params.userId,
        params.branchName,
        { message: params.message, paths: params.paths },
      );
      return { ...result, fromBranch };
    } catch (error) {
      // Restore the previous checkout so a failed promote leaves the user
      // where they started (the new remote branch may remain — harmless).
      await setCheckoutBranch(fresh, params.userId, fromBranch, {
        lastSyncedSha: created.fromSha,
      });
      throw error;
    }
  });
}

export async function listProjectBranches(
  project: IDbtProject,
): Promise<string[]> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const repoDir = await ensureProjectRepo(project);
  const remote = await resolveProjectRemote(project.repo);
  return listRemoteBranchNames(repoDir, remote);
}

/** Fork a new branch off the user's checkout head and check it out. */
async function createBranchFromCheckout(
  project: RepoBoundProject,
  userId: string,
  branchName: string,
): Promise<{ fromBranch: string; fromSha: string }> {
  const fromBranch = await getCheckoutBranch(project, userId);
  const repoDir = await ensureProjectRepo(project);
  const remote = await resolveProjectRemote(project.repo);
  const fromSha = await fetchBranch(repoDir, remote, fromBranch);

  const existing = await resolveCommit(repoDir, branchRef(branchName));
  if (existing) {
    throw new Error(`Branch "${branchName}" already exists`);
  }
  await pushBranch(repoDir, remote, {
    localSha: fromSha,
    branch: branchName,
    expectedRemoteSha: ZERO_SHA,
  });
  await updateRef(repoDir, branchRef(branchName), fromSha);
  await setCheckoutBranch(project, userId, branchName, {
    lastSyncedSha: fromSha,
  });
  return { fromBranch, fromSha };
}

/**
 * Create a new branch off the caller's checkout HEAD and check it out for
 * them (only their checkout moves — other users are unaffected).
 */
export async function createProjectBranch(
  project: IDbtProject,
  userId: string,
  branchName: string,
): Promise<{ branch: string; fromBranch: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const { fromBranch } = await createBranchFromCheckout(
      fresh,
      userId,
      branchName,
    );
    return { branch: branchName, fromBranch };
  });
}

/**
 * Switch the caller's checkout to another branch. Only their branch pointer
 * moves; their pending changes carry over as an overlay (like `git checkout`
 * with a dirty tree), so nothing is lost. Pass `discardLocalChanges` to drop
 * the caller's changes instead. The target branch is synced from the remote.
 */
export async function switchProjectBranch(
  project: IDbtProject,
  userId: string,
  branchName: string,
  updatedBy: string,
  options: { discardLocalChanges?: boolean } = {},
): Promise<{ branch: string; discarded?: GitStatus; carriedChanges: number }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);

    let discarded: GitStatus | undefined;
    if (options.discardLocalChanges) {
      const status = await getGitStatus(fresh, userId);
      if (status.hasChanges) discarded = status;
      await discardUserDrafts(fresh, userId);
    }

    // Materialize/refresh the target branch from the remote.
    const sync = await syncProjectBranchFromRepo(fresh, branchName, updatedBy);
    await setCheckoutBranch(fresh, userId, branchName, {
      lastSyncedSha: sync.sha,
    });

    const carried = discarded
      ? 0
      : (await getGitStatus(fresh, userId)).changes.length;
    return discarded?.hasChanges
      ? { branch: branchName, discarded, carriedChanges: carried }
      : { branch: branchName, carriedChanges: carried };
  });
}

/**
 * Delete a remote branch. Refuses to delete the caller's checked-out branch,
 * any branch another user has checked out, the project default branch, and
 * the repo default branch. Cleans up the local mirror ref.
 */
export async function deleteProjectBranch(
  project: IDbtProject,
  userId: string,
  branchName: string,
): Promise<{ deleted: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const repoDir = await ensureProjectRepo(fresh);
    const remote = await resolveProjectRemote(fresh.repo);
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
    const defaultBranch = await remoteDefaultBranch(repoDir, remote);
    if (branchName === defaultBranch) {
      throw new Error(
        `Refusing to delete the repository's default branch "${branchName}".`,
      );
    }
    await pushDeleteBranch(repoDir, remote, branchName);
    await deleteRef(repoDir, branchRef(branchName));
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
 * Files deleted in recent commits of the project's tracked branch whose
 * content is still recoverable from git history. These don't appear in the
 * normal file tree.
 */
export async function listRecoverableFiles(
  project: IDbtProject,
): Promise<RecoverableFile[]> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const repoDir = await ensureProjectRepo(project);
  const records = await listDeletedFiles(
    repoDir,
    branchRef(project.repo.branch),
  );
  const files: RecoverableFile[] = [];
  for (const record of records) {
    const rel = toProjectPath(project, record.path);
    if (!rel) continue;
    const content = await readBlobAt(
      repoDir,
      `${record.commitSha}^`,
      record.path,
    );
    if (!content) continue;
    files.push({
      path: rel,
      content,
      updatedAt: record.deletedAt,
      updatedBy: record.deletedBy,
    });
  }
  return files;
}

/**
 * Restore a deleted file (from git history) into the caller's working tree
 * as a pending "added" change, so they can review and commit it. Returns the
 * restored content for confirmation.
 */
export async function restoreDeletedFile(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<{ path: string; content: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const files = await listRecoverableFiles(project);
    const file = files.find(f => f.path === path);
    if (!file) {
      throw new Error(`No recoverable file at "${path}".`);
    }
    await writeWorkingFile(project, userId, path, file.content);
    return { path, content: file.content };
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
  const branch = await getCheckoutBranch(project, userId);
  let base = params.base;
  if (!base) {
    const repoDir = await ensureProjectRepo(project);
    const remote = await resolveProjectRemote(project.repo);
    base = (await remoteDefaultBranch(repoDir, remote)) ?? project.repo.branch;
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

/** Best-effort remote branch deletion with a user-facing warning on failure. */
async function tryDeleteRemoteBranch(
  project: RepoBoundProject,
  branch: string,
): Promise<{ deleted: boolean; warning?: string }> {
  try {
    const repoDir = await ensureProjectRepo(project);
    const remote = await resolveProjectRemote(project.repo);
    await pushDeleteBranch(repoDir, remote, branch);
    await deleteRef(repoDir, branchRef(branch));
    return { deleted: true };
  } catch (error) {
    return {
      deleted: false,
      warning: `Branch "${branch}" could not be deleted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Close a pull request WITHOUT merging it. Optionally delete its head branch
 * afterwards (default false — closing shouldn't destroy the work). Branch
 * deletion refuses when the branch is the project default or any user has it
 * checked out.
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
        const deleteResult = await tryDeleteRemoteBranch(fresh, headRef);
        branchDeleted = deleteResult.deleted;
        branchDeleteWarning = deleteResult.warning;
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
 * state. The caller's pending changes (if any) carry over as an overlay.
 * Users checked out on the deleted head branch are moved back to the default
 * branch.
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

    const repoDir = await ensureProjectRepo(fresh);
    const remote = await resolveProjectRemote(fresh.repo);
    const defaultBranch =
      (await remoteDefaultBranch(repoDir, remote)) ?? fresh.repo.branch;

    const { sha } = await mergePullRequest(
      owner,
      repo,
      params.prNumber,
      { mergeMethod: params.mergeMethod ?? "squash" },
      token,
    );

    // Pull the merged state into the local default branch mirror and move
    // the caller (plus anyone stranded on the head branch) onto it.
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
      const deleteResult = await tryDeleteRemoteBranch(fresh, pr.headRef);
      branchDeleted = deleteResult.deleted;
      branchDeleteWarning = deleteResult.warning;
      if (branchDeleted) {
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
