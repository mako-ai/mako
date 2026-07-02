/**
 * Import / sync a repo-bound dbt project's branches from its GitHub remote
 * into the project's local bare git repository (the canonical file store —
 * see dbt-git-store.service.ts). A sync is a forced `git fetch` of one
 * branch: the remote is authoritative for committed base trees.
 *
 * Always safe for collaborators: uncommitted work lives in per-user draft
 * overlay refs that rebase onto the new head lazily — a pull can never
 * clobber anyone's drafts.
 */
import {
  DbtCheckout,
  type IDbtProject,
} from "../database/workspace-schema";
import { resolveProjectRemote } from "./dbt-git-remote";
import {
  branchRef,
  diffTrees,
  fetchBranch,
  listTree,
  readBlobAt,
  resolveCommit,
} from "./dbt-git-store.service";
import { ensureProjectRepo } from "./dbt-working-tree.service";
import { toProjectPath, toRepoPath } from "./dbt-paths";

export { isImportable, normalizeSubdir } from "./dbt-paths";

export interface SyncResult {
  sha: string;
  added: number;
  updated: number;
  deleted: number;
  skippedLarge: string[];
}

/**
 * Pull the latest state of `branch` from the remote into the project's git
 * store and stamp sync SHAs (the project binding when it is the default
 * branch, plus every checkout pointing at the branch).
 */
export async function syncProjectBranchFromRepo(
  project: IDbtProject,
  branch: string,
  _updatedBy: string,
): Promise<SyncResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const repoDir = await ensureProjectRepo(project);
  const remote = await resolveProjectRemote(project.repo);

  const oldHead = await resolveCommit(repoDir, branchRef(branch));
  const sha = await fetchBranch(repoDir, remote, branch);

  let added = 0;
  let updated = 0;
  let deleted = 0;
  if (oldHead && oldHead !== sha) {
    for (const change of await diffTrees(repoDir, oldHead, sha)) {
      if (!toProjectPath(project, change.path)) continue;
      if (change.status === "added") added++;
      else if (change.status === "deleted") deleted++;
      else updated++;
    }
  } else if (!oldHead) {
    added = (await listTree(repoDir, sha)).filter(entry =>
      toProjectPath(project, entry.path),
    ).length;
  }

  if (branch === project.repo.branch) {
    project.repo.lastSyncedSha = sha;
    project.repo.lastSyncedAt = new Date();
    project.markModified("repo");
    await project.save();
  }
  await DbtCheckout.updateMany(
    { projectId: project._id, branch },
    { $set: { lastSyncedSha: sha, lastSyncedAt: new Date() } },
  ).exec();

  return { sha, added, updated, deleted, skippedLarge: [] };
}

/** Sync the project's default branch (backwards-compatible entry point). */
export async function syncProjectFromRepo(
  project: IDbtProject,
  updatedBy: string,
): Promise<SyncResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  return syncProjectBranchFromRepo(project, project.repo.branch, updatedBy);
}

export interface ImportResult {
  sha: string;
  imported: number;
}

/**
 * First import of a repo-bound project: fetch the tracked branch and verify
 * a dbt_project.yml exists at the project root (subdirectory-aware). Throws
 * a user-presentable error when the repo/branch/subdirectory is not a dbt
 * project.
 */
export async function importProjectFromRepo(
  project: IDbtProject,
): Promise<ImportResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const repoDir = await ensureProjectRepo(project);
  const remote = await resolveProjectRemote(project.repo);
  const sha = await fetchBranch(repoDir, remote, project.repo.branch);

  const files = (await listTree(repoDir, sha)).filter(entry =>
    toProjectPath(project, entry.path),
  );
  if (files.length === 0) {
    throw new Error("No dbt files found in that repo/branch/subdirectory");
  }
  const projectYml = await readBlobAt(
    repoDir,
    sha,
    toRepoPath(project, "dbt_project.yml"),
  );
  if (projectYml === null) {
    throw new Error(
      "dbt_project.yml not found at the project root — set the correct subdirectory",
    );
  }

  project.repo.lastSyncedSha = sha;
  project.repo.lastSyncedAt = new Date();
  project.markModified("repo");
  await project.save();

  return { sha, imported: files.length };
}
