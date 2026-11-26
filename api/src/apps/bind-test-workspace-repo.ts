/**
 * Test-only: attach a GitHub binding so `requireWorkspaceRepo` will write.
 *
 * Production refuses writes without a connected repo (issue #956). Suites
 * that already `initRepo` a temp APPS_GIT_ROOT still need a Workspace
 * `workspaceRepos[]` row — local git alone is not a skip.
 */
import { workspaceRepo } from "../repositories/workspaces";

export async function bindTestWorkspaceRepo(
  workspaceId: string,
): Promise<void> {
  await workspaceRepo.upsertTestWorkspaceWithRepo(workspaceId, {
    provider: "github",
    owner: "test-owner",
    repo: "test-repo",
    defaultBranch: "main",
    subdirectory: "",
    linkedBy: "test",
    linkedAt: new Date(),
  });
}

export async function unbindTestWorkspaceRepo(
  workspaceId: string,
): Promise<void> {
  await workspaceRepo.setWorkspaceRepos(workspaceId, null);
}
