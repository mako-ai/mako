/**
 * Workspace repo — the workspace ↔ GitHub-repo link.
 *
 * §10 (2026-07-16): ONE repo per workspace. The workspace IS a git repo;
 * `dbt/`, `apps/`, `consoles/`, `skills/` are folders at its root and
 * personal content lives under `users/<userId>/…`. The storage field is
 * still the `workspaceRepos` array for back-compat, but the service refuses
 * to hold more than one binding — `getWorkspaceRepo` is the read API.
 * (Legacy `appsV2Repo` read-time fallback kept until the 2026-07-15
 * migration has run everywhere.)
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

/** §10: the single workspace repo, or null when none is linked. */
export async function getWorkspaceRepo(
  workspaceId: string,
): Promise<IWorkspaceRepoBinding | null> {
  const repos = await listWorkspaceRepos(workspaceId);
  return repos[0] ?? null;
}

/** @deprecated §10 makes the repo singular — use getWorkspaceRepo. */
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

  // §10: one repo per workspace. Re-connecting the SAME repo updates the
  // binding in place; connecting a different repo while one exists is
  // refused (disconnect first — a silent swap would orphan every app).
  const existing = await listWorkspaceRepos(input.workspaceId);
  const other = existing.find(r => !(r.owner === owner && r.repo === repo));
  if (other) {
    throw new Error(
      `This workspace is already connected to ${other.owner}/${other.repo}. ` +
        "A workspace has exactly one repository — disconnect it first.",
    );
  }
  const next = [binding];
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
