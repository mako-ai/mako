/**
 * Local git is required for every migrated content write (issue #956).
 *
 * `APPS_REQUIRE_CONNECTED_REPO` means a connected GitHub *mirror* is
 * required (prod). That is a different question from "does this workspace
 * have a git repo at all?". Mixing them is how Mongo became a silent
 * fallback in dev and preview.
 *
 * A bound GitHub repo that has not been cloned yet (empty remote, first
 * write) is initialized here so the first commit can seed the mirror.
 * A workspace with neither a local repo nor a binding is refused.
 */
import { RepoRequiredError } from "./config";
import { ensureLocalRepo, ensureWorkspaceRepo } from "./cloud-repo.service";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "./repository.service";
import { getWorkspaceRepo } from "../services/workspace-repos.service";

/**
 * Ensure the workspace has a local git repo and return its directory.
 * Throws {@link RepoRequiredError} (412) when it does not and cannot.
 */
export async function requireWorkspaceRepo(
  workspaceId: string,
): Promise<string> {
  if (await getWorkspaceRepo(workspaceId)) {
    return ensureWorkspaceRepo(workspaceId);
  }
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (
    (await repoExists(repoDir)) &&
    (await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`))
  ) {
    return repoDir;
  }
  if (await repoExists(repoDir)) return repoDir;
  throw new RepoRequiredError();
}
