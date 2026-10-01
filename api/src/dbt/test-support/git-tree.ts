/**
 * Test seeding for the git-backed dbt working tree (apps.md §20): a real
 * bare workspace repo under a temp APPS_GIT_ROOT with files under `dbt/`.
 * Mirrors the rig the apps/consoles suites use.
 */
import { Types } from "mongoose";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  repoExists,
  resolveCommit,
  updateRefCas,
} from "../../apps/repository.service";
import { ZERO_OID } from "../../apps/git";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";

/** Ensure the workspace repo exists and commit dbt/<path> files on a branch. */
export async function seedDbtGitTree(
  workspaceId: Types.ObjectId | string,
  files: Record<string, string>,
  options: { branch?: string } = {},
): Promise<void> {
  const repoDir = repoDirFor(workspaceId.toString());
  if (!(await repoExists(repoDir))) {
    await initRepo(repoDir, { "README.md": "workspace\n" });
  }
  await bindTestWorkspaceRepo(workspaceId.toString());
  const branch = options.branch ?? DEFAULT_BRANCH;
  if (branch !== DEFAULT_BRANCH) {
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!head) {
      const mainHead = await resolveCommit(
        repoDir,
        `refs/heads/${DEFAULT_BRANCH}`,
      );
      await updateRefCas(repoDir, `refs/heads/${branch}`, mainHead!, ZERO_OID);
    }
  }
  await commitBlobsOnBranch(
    repoDir,
    branch,
    {
      writes: Object.fromEntries(
        Object.entries(files).map(([p, c]) => [`dbt/${p}`, c]),
      ),
    },
    { message: "test: seed dbt tree" },
  );
}

/** Delete dbt/<paths> on a branch. */
export async function deleteFromDbtGitTree(
  workspaceId: Types.ObjectId | string,
  paths: string[],
  options: { branch?: string } = {},
): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(workspaceId.toString()),
    options.branch ?? DEFAULT_BRANCH,
    { deletes: paths.map(p => `dbt/${p}`) },
    { message: "test: delete dbt files" },
  );
}
