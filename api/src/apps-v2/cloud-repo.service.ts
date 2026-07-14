/**
 * Apps v2 cloud repos — Mako-hosted GitHub storage (the instant-start tier).
 *
 * When a workspace has no BYO repo linked, each app project gets its own
 * private repo under MAKO_CLOUD_GITHUB_ORG (one repo per project — mirrors
 * the local one-bare-repo-per-project layout 1:1, so durability is a plain
 * `git push --mirror`). Users never see a GitHub install flow: Mako's own
 * app (cloud-app-auth.ts) is installed once on Mako's own org.
 *
 * The local bare repo remains the working store the API reads from; the
 * cloud repo is the durable replica. Mirror pushes run after commits/merges
 * (not per WIP flush — too chatty), serialized per project and coalesced so
 * concurrent commits produce one trailing push, never an interleaving.
 *
 * Repo naming: `<MAKO_CLOUD_REPO_PREFIX>-<workspaceId>-<projectId>` — the
 * prefix namespaces per backing database (prod "ws", previews/staging
 * "staging", local "dev") since all environments share the single org.
 */
import { Types } from "mongoose";
import { AppProjectV2, type IAppProjectV2 } from "../database/workspace-schema";
import {
  getMakoCloudOrg,
  getMakoCloudRepoPrefix,
  getMakoCloudToken,
  isMakoCloudConfigured,
} from "../integrations/github/cloud-app-auth";
import { runGit } from "./git";
import { repoDirFor } from "./repository.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2");

const GITHUB_API = "https://api.github.com";

export function cloudRepoNameFor(project: IAppProjectV2): string {
  return `${getMakoCloudRepoPrefix()}-${project.workspaceId.toString()}-${project._id.toString()}`;
}

/**
 * Create (idempotently) the project's cloud repo and persist the pointer on
 * the project doc. Returns null when the cloud app is not configured —
 * callers degrade to local-only storage rather than failing app creation.
 */
export async function ensureCloudRepo(
  project: IAppProjectV2,
): Promise<{ owner: string; repo: string } | null> {
  if (project.cloudRepo) return project.cloudRepo;
  if (!isMakoCloudConfigured()) return null;
  const org = getMakoCloudOrg();
  if (!org) return null;

  const name = cloudRepoNameFor(project);
  const token = await getMakoCloudToken();
  const res = await fetch(`${GITHUB_API}/orgs/${org}/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name,
      private: true,
      auto_init: false,
      description: `Mako app "${project.title}" (workspace ${project.workspaceId.toString()})`,
    }),
  });
  // 422 "name already exists" = an earlier attempt got the repo but died
  // before persisting the pointer — adopting it is the idempotent outcome.
  if (!res.ok && res.status !== 422) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to create cloud repo ${org}/${name} (${res.status}): ${body.slice(0, 300)}`,
    );
  }

  const cloudRepo = { owner: org, repo: name };
  await AppProjectV2.updateOne(
    { _id: new Types.ObjectId(project._id.toString()) },
    { $set: { cloudRepo } },
  );
  project.cloudRepo = cloudRepo;
  logger.info("Apps v2 cloud repo ready", {
    projectId: project._id.toString(),
    repo: `${org}/${name}`,
  });
  return cloudRepo;
}

/** Best-effort delete of the cloud repo when the project is deleted. */
export async function deleteCloudRepo(project: IAppProjectV2): Promise<void> {
  const cloudRepo = project.cloudRepo;
  if (!cloudRepo || !isMakoCloudConfigured()) return;
  try {
    const token = await getMakoCloudToken();
    const res = await fetch(
      `${GITHUB_API}/repos/${cloudRepo.owner}/${cloudRepo.repo}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok && res.status !== 404) {
      logger.warn("Failed to delete cloud repo", {
        repo: `${cloudRepo.owner}/${cloudRepo.repo}`,
        status: res.status,
      });
    }
  } catch (error) {
    logger.warn("Failed to delete cloud repo", {
      repo: `${cloudRepo.owner}/${cloudRepo.repo}`,
      error,
    });
  }
}

// Per-project push serialization: `pending` coalesces bursts (N commits
// while a push is in flight -> exactly one trailing push).
const inFlight = new Map<string, Promise<void>>();
const pending = new Set<string>();

async function pushMirror(
  workspaceId: string,
  projectId: string,
  cloudRepo: { owner: string; repo: string },
): Promise<void> {
  const repoDir = repoDirFor(workspaceId, projectId);
  const token = await getMakoCloudToken();
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  // --mirror: all refs incl. refs/mako/* WIP snapshots (this is OUR remote,
  // so the never-push-WIP-to-customer-remotes rule doesn't apply), pruning
  // remote refs deleted locally. Auth via header keeps the token out of the
  // remote URL (and thus out of git's error messages).
  await runGit([
    "-C",
    repoDir,
    "-c",
    `http.extraheader=Authorization: Basic ${basic}`,
    "push",
    "--mirror",
    "--quiet",
    `https://github.com/${cloudRepo.owner}/${cloudRepo.repo}.git`,
  ]);
}

/**
 * Queue a fire-and-forget mirror push. Never throws — cloud durability is
 * best-effort on top of the local store, and a failed push must not fail the
 * user's commit. Failures are logged for a future reconciler to sweep. Loads
 * the project doc itself so callers holding only ids (commit paths) can use
 * it, and so a cloudRepo attached after their doc snapshot is still seen.
 */
export function queueMirrorPush(workspaceId: string, projectId: string): void {
  if (!isMakoCloudConfigured()) return;
  const key = projectId;
  if (inFlight.has(key)) {
    pending.add(key);
    return;
  }
  const run = (async () => {
    try {
      const project = await AppProjectV2.findById(new Types.ObjectId(projectId))
        .select("cloudRepo workspaceId")
        .lean();
      if (project?.cloudRepo) {
        await pushMirror(workspaceId, projectId, project.cloudRepo);
      }
    } catch (error) {
      logger.warn("Apps v2 cloud mirror push failed", {
        projectId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.delete(key);
      if (pending.delete(key)) queueMirrorPush(workspaceId, projectId);
    }
  })();
  inFlight.set(key, run);
}

/** Awaitable variant for the initial push right after project creation. */
export async function mirrorPushNow(project: IAppProjectV2): Promise<void> {
  if (!project.cloudRepo) return;
  await pushMirror(
    project.workspaceId.toString(),
    project._id.toString(),
    project.cloudRepo,
  );
}
