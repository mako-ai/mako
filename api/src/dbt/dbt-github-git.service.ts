/**
 * Git write operations for repo-bound dbt projects: working-tree status,
 * commit & push, branch create/switch, and pull requests — the in-IDE git
 * surface that mirrors dbt Cloud.
 *
 * Mongo (DbtFile) is the working tree. `repoBlobSha` on each file records the
 * blob SHA at the last import/sync/push, so the diff against the branch is a
 * pure local computation. Pushing builds a single commit via the Git Data API.
 */
import {
  DbtFile,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { gitBlobSha } from "../integrations/github/git-blob";
import {
  commitChanges,
  createBranch,
  createPullRequest,
  deleteBranch,
  getBlobContent,
  getPullRequest,
  getRefCommit,
  getRepoInfo,
  getRepoTree,
  listBranches,
  mergePullRequest,
  tryDeleteBranch,
  type MergeMethod,
  type TreeChange,
} from "../integrations/github/github-api";
import { syncProjectFromRepo } from "./dbt-github-sync.service";

/**
 * Per-project promise-chain lock. Every git mutation (commit, branch create,
 * branch switch, atomic promote) runs through this so they can't interleave on
 * stale in-memory copies of `project.repo.branch`. Mirrors the warm-dir lock in
 * workspace-dir.service.ts: each acquirer waits on the previous holder.
 *
 * This is what closes the race that committed working-tree changes to `main`
 * while a branch-create was mid-flight: concurrent callers are now serialized,
 * and each re-reads `repo.branch` from Mongo inside the critical section instead
 * of trusting whatever branch its caller loaded.
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
 * act on the current `repo.branch`/`lastSyncedSha`, not a stale copy the caller
 * loaded before the lock was acquired.
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

function dirtyBranchMoveMessage(params: {
  action: string;
  fromBranch: string;
  toBranch: string;
  status: GitStatus;
}): string {
  const summary = `${params.status.added} added, ${params.status.modified} modified, ${params.status.deleted} deleted`;
  return (
    `Refusing to ${params.action} from "${params.fromBranch}" to "${params.toBranch}": ` +
    `${params.status.changes.length} uncommitted working-tree change(s) (${summary}) ` +
    "would be lost. Commit them first (dbt_commit_and_push to push to the " +
    "current branch, or dbt_commit_to_branch to move them to a new branch), " +
    "or explicitly discard them only after the user confirms abandoning that work."
  );
}

/** Compute the working-tree status of a repo-bound project. */
export async function getGitStatus(
  project: IDbtProject,
  options: GitStatusOptions = {},
): Promise<GitStatus> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const files = await DbtFile.find({ projectId: project._id })
    .select("path content is_deleted repoBlobSha")
    .lean();

  const changes: GitFileStatus[] = [];
  for (const file of files) {
    if (file.is_deleted) {
      // Only counts as a deletion if it actually existed on the branch.
      if (file.repoBlobSha) {
        changes.push({ path: file.path, status: "deleted" });
      }
      continue;
    }
    const currentSha = gitBlobSha(file.content ?? "");
    if (!file.repoBlobSha) {
      changes.push({ path: file.path, status: "added" });
    } else if (file.repoBlobSha !== currentSha) {
      changes.push({ path: file.path, status: "modified" });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return filterGitStatus(
    summarizeChanges(project.repo.branch, changes),
    options.paths,
  );
}

export interface GitFileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  /** Content at the tracked branch HEAD (empty for added files). */
  base: string;
  /** Working-tree content (empty for deleted files). */
  working: string;
}

/**
 * Build a side-by-side diff for one changed file: the base (committed) content
 * from the blob recorded at last sync/push vs the current working-tree content
 * in Mongo. Mirrors dbt Cloud's Studio diff view (screenshot 52).
 */
export async function getProjectFileDiff(
  project: IDbtProject,
  path: string,
): Promise<GitFileDiff> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const file = await DbtFile.findOne({ projectId: project._id, path })
    .select("content is_deleted repoBlobSha")
    .lean();
  if (!file) throw new Error(`File not found: ${path}`);

  const working = file.is_deleted ? "" : (file.content ?? "");
  let base = "";
  if (file.repoBlobSha) {
    const token = await resolveRepoToken(project.repo.installationId);
    base = await getBlobContent(
      project.repo.owner,
      project.repo.repo,
      file.repoBlobSha,
      token,
    );
  }

  const status: GitFileStatus["status"] = file.is_deleted
    ? "deleted"
    : file.repoBlobSha
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
 * Commit all working-tree changes and push them to the tracked branch in a
 * single commit. Updates each file's recorded blob SHA and hard-deletes files
 * that were removed (so they don't linger as ghost deletions).
 *
 * Runs under the per-project git lock and re-reads the project inside it, so
 * the commit always targets the branch that is actually current in Mongo — not
 * a stale `repo.branch` from before a concurrent branch-create/switch.
 */
export async function commitAndPush(
  project: IDbtProject,
  params: { message: string; updatedBy: string; paths?: string[] },
): Promise<CommitResult> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const status = await getGitStatus(fresh, { paths: params.paths });
    if (!status.hasChanges) {
      return {
        committed: false,
        branch: fresh.repo.branch,
        pushed: { added: 0, modified: 0, deleted: 0 },
      };
    }
    return pushWorkingTree(fresh, status, params.message);
  });
}

/**
 * Build a single commit from the working tree and push it to the project's
 * currently tracked branch (`project.repo.branch`). Updates each file's blob
 * SHA and hard-deletes removed files. The caller MUST hold the project git lock
 * and pass a freshly loaded `project` plus its computed `status`.
 */
async function pushWorkingTree(
  project: IDbtProject,
  status: GitStatus,
  message: string,
): Promise<CommitResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo, branch } = project.repo;

  const files = await DbtFile.find({ projectId: project._id })
    .select("path content is_deleted")
    .lean();
  const byPath = new Map(files.map(f => [f.path, f]));

  const { commitSha, treeSha } = await getRefCommit(owner, repo, branch, token);

  // GitHub returns 422 GitRPC::BadObject if a tree entry deletes (sha:null) a
  // path that isn't in base_tree. Phantom deletions (files removed upstream but
  // still flagged is_deleted locally) would trip this, so drop any deletion
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
        content: byPath.get(change.path)?.content ?? "",
      });
    }
  }

  // Reconcile local state. Phantom deletions never reach GitHub but must still
  // be cleaned up so they stop showing as pending changes.
  const ops: Array<Promise<unknown>> = [];
  for (const change of status.changes) {
    if (change.status === "deleted") {
      ops.push(
        DbtFile.deleteOne({ projectId: project._id, path: change.path }).exec(),
      );
    } else {
      const content = byPath.get(change.path)?.content ?? "";
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, path: change.path },
          { $set: { repoBlobSha: gitBlobSha(content) } },
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
      message,
      changes: treeChanges,
    },
    token,
  );

  await Promise.all(ops);

  project.repo.lastSyncedSha = newSha;
  project.repo.lastSyncedAt = new Date();
  project.markModified("repo");
  await project.save();

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
  /** Branch the new branch was forked from (the previously tracked branch). */
  fromBranch: string;
}

/**
 * Atomic "promote": create a feature branch off the currently tracked branch's
 * HEAD and commit the working tree onto it — in one locked critical section, so
 * no concurrent commit can land the changes on the wrong branch (e.g. main).
 *
 * This replaces the racy three-step branch → commit → PR dance: the branch and
 * its commit are now inseparable. After this, the project tracks the new branch
 * with a clean working tree; open a PR with `openProjectPullRequest`.
 */
export async function commitToNewBranch(
  project: IDbtProject,
  params: {
    branchName: string;
    message: string;
    updatedBy: string;
    paths?: string[];
  },
): Promise<PromoteResult> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const status = await getGitStatus(fresh, { paths: params.paths });
    if (!status.hasChanges) {
      throw new Error(
        "No working-tree changes to promote — nothing to put on a new branch. " +
          "The changes may already be committed (check dbt_git_status).",
      );
    }

    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;
    const fromBranch = fresh.repo.branch;

    // Fork the new branch from the branch we're currently tracking, then point
    // the project at it BEFORE committing so pushWorkingTree targets the new
    // branch. The commit's parent is the fork point, so the branch contains
    // exactly the working-tree delta.
    const { commitSha } = await getRefCommit(owner, repo, fromBranch, token);
    await createBranch(owner, repo, params.branchName, commitSha, token);
    fresh.repo.branch = params.branchName;
    fresh.markModified("repo");
    await fresh.save();

    const result = await pushWorkingTree(fresh, status, params.message);
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
 * Create a new branch off the current branch head and check it out (track it).
 * Content is identical to the current branch, so no re-sync is needed.
 */
export async function createProjectBranch(
  project: IDbtProject,
  branchName: string,
): Promise<{ branch: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;
    const { commitSha } = await getRefCommit(
      owner,
      repo,
      fresh.repo.branch,
      token,
    );
    await createBranch(owner, repo, branchName, commitSha, token);
    fresh.repo.branch = branchName;
    fresh.markModified("repo");
    await fresh.save();
    return { branch: branchName };
  });
}

/**
 * Switch the tracked branch and pull its contents into the working tree.
 *
 * This OVERWRITES the working tree with the target branch. To prevent silent
 * data loss it REFUSES when there are uncommitted working-tree changes, unless
 * the caller explicitly passes `discardLocalChanges`. (This is the guard that
 * stops a branch move from eating un-pushed models, as happened before.)
 */
export async function switchProjectBranch(
  project: IDbtProject,
  branchName: string,
  updatedBy: string,
  options: { discardLocalChanges?: boolean } = {},
): Promise<{ branch: string; discarded?: GitStatus }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);

    let discarded: GitStatus | undefined;
    if (!options.discardLocalChanges) {
      const status = await getGitStatus(fresh);
      if (status.hasChanges) {
        throw new Error(
          dirtyBranchMoveMessage({
            action: "switch",
            fromBranch: fresh.repo.branch,
            toBranch: branchName,
            status,
          }),
        );
      }
    } else {
      // Record what we're discarding so the caller can surface/inspect it.
      discarded = await getGitStatus(fresh);
    }

    fresh.repo.branch = branchName;
    fresh.markModified("repo");
    await fresh.save();
    // Explicit, confirmed switch: remote is the source of truth.
    await syncProjectFromRepo(fresh, updatedBy);
    return discarded?.hasChanges
      ? { branch: branchName, discarded }
      : { branch: branchName };
  });
}

/**
 * Delete a remote branch. Refuses to delete the branch the project currently
 * tracks (switch away first) and the repo's default branch. Idempotent: a
 * branch that is already gone resolves successfully.
 */
export async function deleteProjectBranch(
  project: IDbtProject,
  branchName: string,
): Promise<{ deleted: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const fresh = await reloadRepoProject(project);
    const token = await resolveRepoToken(fresh.repo.installationId);
    const { owner, repo } = fresh.repo;
    if (branchName === fresh.repo.branch) {
      throw new Error(
        `Cannot delete "${branchName}" — it is the project's currently tracked ` +
          "branch. Switch to another branch first (dbt_switch_branch).",
      );
    }
    const info = await getRepoInfo(owner, repo, token);
    if (branchName === info.defaultBranch) {
      throw new Error(
        `Refusing to delete the repository's default branch "${branchName}".`,
      );
    }
    await deleteBranch(owner, repo, branchName, token);
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
 * Restore a soft-deleted file back into the working tree. It comes back as a
 * pending "added" change (no recorded blob), so the user can review and commit
 * it. Returns the restored content for confirmation.
 */
export async function restoreDeletedFile(
  project: IDbtProject,
  path: string,
  updatedBy: string,
): Promise<{ path: string; content: string }> {
  return withProjectGitLock(project._id.toString(), async () => {
    const file = await DbtFile.findOne({ projectId: project._id, path })
      .select("content is_deleted")
      .lean();
    if (!file) {
      throw new Error(`No file (recoverable or otherwise) at "${path}".`);
    }
    if (!file.is_deleted) {
      // Already present in the working tree — nothing to restore.
      return { path, content: file.content ?? "" };
    }
    await DbtFile.updateOne(
      { projectId: project._id, path },
      { $set: { is_deleted: false, updatedBy }, $unset: { repoBlobSha: "" } },
    ).exec();
    return { path, content: file.content ?? "" };
  });
}

export async function openProjectPullRequest(
  project: IDbtProject,
  params: { title: string; body?: string; base?: string },
): Promise<{ number: number; htmlUrl: string }> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo, branch } = project.repo;
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

export interface MergePullRequestResult {
  sha: string;
  branchDeleted: boolean;
  branchDeleteWarning?: string;
  branch: string;
  workingTreeClean: boolean;
  preservedLocal: string[];
}

/**
 * Merge a GitHub pull request, optionally delete its head branch, then switch
 * the project back to the repo default branch and sync the merged state into
 * the working tree.
 */
export async function mergeProjectPullRequest(
  project: IDbtProject,
  params: {
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
    const preMergeStatus = await getGitStatus(fresh);
    if (preMergeStatus.hasChanges) {
      throw new Error(
        dirtyBranchMoveMessage({
          action: "merge pull request and switch",
          fromBranch: fresh.repo.branch,
          toBranch: defaultBranch,
          status: preMergeStatus,
        }),
      );
    }

    const { sha } = await mergePullRequest(
      owner,
      repo,
      params.prNumber,
      { mergeMethod: params.mergeMethod ?? "squash" },
      token,
    );

    fresh.repo.branch = defaultBranch;
    fresh.markModified("repo");
    await fresh.save();
    const syncResult = await syncProjectFromRepo(fresh, params.updatedBy, {
      preserveLocalEdits: true,
    });

    let branchDeleted = false;
    let branchDeleteWarning: string | undefined;
    if (params.deleteBranch !== false) {
      const deleteResult = await tryDeleteBranch(
        owner,
        repo,
        pr.headRef,
        token,
      );
      branchDeleted = deleteResult.deleted;
      branchDeleteWarning = deleteResult.warning;
    }

    const status = await getGitStatus(fresh);
    return {
      sha,
      branchDeleted,
      branchDeleteWarning,
      branch: defaultBranch,
      workingTreeClean: !status.hasChanges,
      preservedLocal: syncResult.preservedLocal,
    };
  });
}
