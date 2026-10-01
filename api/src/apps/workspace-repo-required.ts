/**
 * A connected GitHub repo is required for every migrated content write
 * (issue #956). Local git without a binding was the Cloud Storage skip:
 * createProject used to init a bare repo, after which consoles/dbt/prompt
 * passed this gate even though the workspace never linked GitHub.
 *
 * A bound repo that has not been cloned yet (empty remote, first write) is
 * initialized by `ensureWorkspaceRepo` so the first commit can seed the
 * mirror. A workspace with no binding is refused — leftover local git does
 * not count.
 */
import { RepoRequiredError } from "./config";
import { ensureLocalRepo, ensureWorkspaceRepo } from "./cloud-repo.service";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import { repoDirFor, repoExists } from "./repository.service";

/**
 * Ensure the workspace has a local git repo and return its directory.
 * Throws {@link RepoRequiredError} (412) when no GitHub repo is bound.
 */
export async function requireWorkspaceRepo(
  workspaceId: string,
): Promise<string> {
  if (!(await getWorkspaceRepo(workspaceId))) {
    throw new RepoRequiredError();
  }
  return ensureWorkspaceRepo(workspaceId);
}

/**
 * Local bare-repo directory only when a GitHub repo is bound.
 * Leftover Cloud Storage git without a binding is not a definition store
 * (issue #956) — history, prompt, and checkpoints must not read it.
 */
export async function boundRepoDirIfExists(
  workspaceId: string,
): Promise<string | null> {
  if (!(await getWorkspaceRepo(workspaceId))) return null;
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  return (await repoExists(repoDir)) ? repoDir : null;
}
