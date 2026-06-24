/**
 * Git write operations for repo-bound dbt projects: working-tree status,
 * commit & push, branch create/switch, and pull requests — the in-IDE git
 * surface that mirrors dbt Cloud.
 *
 * Mongo (DbtFile) is the working tree. `repoBlobSha` on each file records the
 * blob SHA at the last import/sync/push, so the diff against the branch is a
 * pure local computation. Pushing builds a single commit via the Git Data API.
 */
import { DbtFile, type IDbtProject } from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { gitBlobSha } from "../integrations/github/git-blob";
import {
  commitChanges,
  createBranch,
  createPullRequest,
  getBlobContent,
  getRefCommit,
  getRepoInfo,
  getRepoTree,
  listBranches,
  type TreeChange,
} from "../integrations/github/github-api";
import { syncProjectFromRepo } from "./dbt-github-sync.service";

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

function repoPath(project: IDbtProject, path: string): string {
  const subdir = project.repo?.subdirectory?.replace(/^\/+|\/+$/g, "");
  return subdir ? `${subdir}/${path}` : path;
}

/** Compute the working-tree status of a repo-bound project. */
export async function getGitStatus(project: IDbtProject): Promise<GitStatus> {
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
  const added = changes.filter(c => c.status === "added").length;
  const modified = changes.filter(c => c.status === "modified").length;
  const deleted = changes.filter(c => c.status === "deleted").length;
  return {
    branch: project.repo.branch,
    changes,
    added,
    modified,
    deleted,
    hasChanges: changes.length > 0,
  };
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
 */
export async function commitAndPush(
  project: IDbtProject,
  params: { message: string; updatedBy: string },
): Promise<CommitResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const status = await getGitStatus(project);
  if (!status.hasChanges) {
    return {
      committed: false,
      branch: status.branch,
      pushed: { added: 0, modified: 0, deleted: 0 },
    };
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
      message: params.message,
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
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo } = project.repo;
  const { commitSha } = await getRefCommit(
    owner,
    repo,
    project.repo.branch,
    token,
  );
  await createBranch(owner, repo, branchName, commitSha, token);
  project.repo.branch = branchName;
  project.markModified("repo");
  await project.save();
  return { branch: branchName };
}

/** Switch the tracked branch and pull its contents into the working tree. */
export async function switchProjectBranch(
  project: IDbtProject,
  branchName: string,
  updatedBy: string,
): Promise<{ branch: string }> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  project.repo.branch = branchName;
  project.markModified("repo");
  await project.save();
  await syncProjectFromRepo(project, updatedBy);
  return { branch: branchName };
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
