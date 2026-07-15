/**
 * Workspace repos — the workspace ↔ GitHub-repos link (0..N, default 1).
 *
 * Repos are WORKSPACE infrastructure, not an apps-v2 detail: apps (and later
 * consoles and dbt projects) mount into them. Mako stores nothing in Mongo
 * except these links — the repos are the durable store. Layout convention
 * inside a repo: `subdirectory` is the MAKO ROOT ("" = repo root); workspace
 * apps live under `<root>/apps/<app>`, personal content under
 * `<root>/users/<userId>/apps/<app>`.
 *
 * Supersedes apps-v2's single `appsV2Repo` binding (read-time fallback kept
 * until the 2026-07-15 migration has run everywhere).
 */
import { Types } from "mongoose";
import {
  GitHubInstallation,
  Workspace,
  type IWorkspaceRepoBinding,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("workspace-repos");

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isValidRepoSegment(value: string): boolean {
  return SEGMENT_RE.test(value) && !value.includes("..");
}

export async function listWorkspaceRepos(
  workspaceId: string,
): Promise<IWorkspaceRepoBinding[]> {
  const ws = await Workspace.findById(workspaceId)
    .select("workspaceRepos appsV2Repo")
    .lean();
  if (ws?.workspaceRepos?.length) return ws.workspaceRepos;
  // Pre-migration fallback: the old single apps-v2 binding.
  const legacy = ws?.appsV2Repo as IWorkspaceRepoBinding | undefined;
  return legacy ? [legacy] : [];
}

export interface ConnectWorkspaceRepoInput {
  workspaceId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Mako root ("" or "/" = repo root). */
  subdirectory?: string;
  installationId?: number;
  linkedBy: string;
}

export async function connectWorkspaceRepo(
  input: ConnectWorkspaceRepoInput,
): Promise<IWorkspaceRepoBinding> {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const defaultBranch = input.defaultBranch.trim() || "main";
  const subdirectory = (input.subdirectory ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");

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

  const binding: IWorkspaceRepoBinding = {
    provider: "github",
    installationId: input.installationId,
    owner,
    repo,
    defaultBranch,
    subdirectory,
    linkedBy: input.linkedBy,
    linkedAt: new Date(),
  };

  // Upsert by (owner, repo): reconnecting updates branch/root in place.
  const existing = await listWorkspaceRepos(input.workspaceId);
  const next = [
    ...existing.filter(r => !(r.owner === owner && r.repo === repo)),
    binding,
  ];
  await Workspace.updateOne(
    { _id: new Types.ObjectId(input.workspaceId) },
    { $set: { workspaceRepos: next }, $unset: { appsV2Repo: "" } },
  );
  logger.info("Workspace repo connected", {
    workspaceId: input.workspaceId,
    owner,
    repo,
    defaultBranch,
    subdirectory,
  });
  return binding;
}

export async function disconnectWorkspaceRepo(
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<void> {
  const existing = await listWorkspaceRepos(workspaceId);
  const next = existing.filter(r => !(r.owner === owner && r.repo === repo));
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    { $set: { workspaceRepos: next }, $unset: { appsV2Repo: "" } },
  );
  logger.info("Workspace repo disconnected", { workspaceId, owner, repo });
}
