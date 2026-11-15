/**
 * Linking the GitHub repo a workspace's apps live in (POST /apps/link).
 */
import { resolveRepoToken } from "../integrations/github/app-auth";
import { getRepoInfo } from "../integrations/github/github-api";
import {
  connectWorkspaceRepo,
  disconnectWorkspaceRepo,
} from "../services/workspace-repos.service";
import {
  adoptConnectedRepo,
  type ConnectedRepoAdoption,
} from "./cloud-repo.service";
import { syncRepoBackedResources } from "./worktree.service";

export async function linkWorkspaceRepo(input: {
  workspaceId: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  subdirectory?: string;
  installationId?: number;
  linkedBy: string;
}): Promise<{
  repo: Awaited<ReturnType<typeof connectWorkspaceRepo>>;
  adoption: ConnectedRepoAdoption;
}> {
  const { workspaceId } = input;
  // Validate the repo is reachable + resolve its default branch when the
  // caller didn't pin one (reuses the dbt token resolver).
  const token = await resolveRepoToken(input.installationId);
  const info = await getRepoInfo(input.owner, input.repo, token);
  const binding = await connectWorkspaceRepo({
    workspaceId,
    owner: input.owner,
    repo: input.repo,
    defaultBranch: input.defaultBranch || info.defaultBranch || "main",
    subdirectory: input.subdirectory,
    installationId: input.installationId,
    linkedBy: input.linkedBy,
  });
  // §13.17: the connected repo IS the durable mirror. Reconcile it with
  // any existing workspace history now — import, seed, or refuse — and
  // roll the binding back if reconciliation refuses, so pushes never
  // target a repo we did not adopt.
  let adoption: ConnectedRepoAdoption;
  try {
    adoption = await adoptConnectedRepo(workspaceId, {
      owner: binding.owner,
      repo: binding.repo,
      installationId: binding.installationId,
    });
  } catch (error) {
    await disconnectWorkspaceRepo(workspaceId, binding.owner, binding.repo, {
      purge: false,
    }).catch(() => undefined);
    throw error;
  }
  if (adoption !== "deferred") {
    syncRepoBackedResources(workspaceId);
  }
  return { repo: binding, adoption };
}
