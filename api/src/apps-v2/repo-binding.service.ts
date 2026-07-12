/**
 * Apps v2 repo binding — the workspace ↔ GitHub-repo link.
 *
 * Apps v2 keeps NO app content in Mongo: the linked GitHub repo is the durable
 * store (files/history/branches in GitHub, working copies in E2B sandboxes).
 * The only thing persisted is this small binding, stored on the Workspace doc
 * (same category as the existing GitHub installation mapping — a link, not app
 * state), mirroring `DbtProject.repo` and reusing the same GitHub App.
 *
 * Layout convention: each app is a subdirectory `<subdirectory>/<slug>/` in the
 * linked repo (default subdirectory "apps"). Conversations branch off the
 * default branch; publish merges back into it.
 */
import { Types } from "mongoose";
import {
  GitHubInstallation,
  Workspace,
  type IAppsV2RepoBinding,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2");

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isValidRepoSegment(value: string): boolean {
  return SEGMENT_RE.test(value) && !value.includes("..");
}

export async function getAppsRepoBinding(
  workspaceId: string,
): Promise<IAppsV2RepoBinding | null> {
  const ws = await Workspace.findById(workspaceId).select("appsV2Repo").lean();
  return (ws?.appsV2Repo as IAppsV2RepoBinding | undefined) ?? null;
}

export interface LinkAppsRepoInput {
  workspaceId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  subdirectory?: string;
  installationId?: number;
  linkedBy: string;
}

export async function linkAppsRepo(
  input: LinkAppsRepoInput,
): Promise<IAppsV2RepoBinding> {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const defaultBranch = input.defaultBranch.trim() || "main";
  const subdirectory =
    (input.subdirectory ?? "apps").trim().replace(/^\/+|\/+$/g, "") || "apps";

  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    throw new Error("Invalid owner or repo name");
  }

  // If an installation id is supplied it MUST belong to this workspace — the
  // same cross-tenant guard dbt applies before touching a repo.
  if (input.installationId !== undefined) {
    const installation = await GitHubInstallation.findOne({
      workspaceId: new Types.ObjectId(input.workspaceId),
      installationId: input.installationId,
    });
    if (!installation) {
      throw new Error("GitHub installation not found for this workspace");
    }
  }

  const binding: IAppsV2RepoBinding = {
    provider: "github",
    installationId: input.installationId,
    owner,
    repo,
    defaultBranch,
    subdirectory,
    linkedBy: input.linkedBy,
    linkedAt: new Date(),
  };

  await Workspace.updateOne(
    { _id: new Types.ObjectId(input.workspaceId) },
    { $set: { appsV2Repo: binding } },
  );
  logger.info("Apps v2 repo linked", {
    workspaceId: input.workspaceId,
    owner,
    repo,
    defaultBranch,
    subdirectory,
  });
  return binding;
}

export async function unlinkAppsRepo(workspaceId: string): Promise<void> {
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    { $unset: { appsV2Repo: "" } },
  );
  logger.info("Apps v2 repo unlinked", { workspaceId });
}
