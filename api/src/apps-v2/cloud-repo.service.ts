/**
 * Apps v2 cloud repos — Mako-hosted GitHub storage (the instant-start tier).
 *
 * §10 monorepo: ONE private repo per WORKSPACE under MAKO_CLOUD_GITHUB_ORG
 * (`<MAKO_CLOUD_REPO_PREFIX>-<workspaceId>` — the prefix namespaces per
 * backing database: prod "ws", previews/staging "staging", local "dev").
 * Apps are `apps/<slug>` folders inside it; deleting an app is a commit,
 * never a repo deletion. Users never see a GitHub install flow: Mako's own
 * app (cloud-app-auth.ts) is installed once on Mako's own org.
 *
 * The local bare repo remains the working store the API reads from; the
 * cloud repo is the durable replica. Mirror pushes run after commits/merges
 * (not per WIP flush — too chatty), serialized per workspace and coalesced
 * so concurrent commits produce one trailing push, never an interleaving.
 */
import { Types } from "mongoose";
import { Workspace } from "../database/workspace-schema";
import {
  getMakoCloudOrg,
  getMakoCloudRepoPrefix,
  getMakoCloudToken,
  isMakoCloudConfigured,
} from "../integrations/github/cloud-app-auth";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git";
import { repoDirFor, repoExists } from "./repository.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2");

const GITHUB_API = "https://api.github.com";

export function cloudRepoNameFor(workspaceId: string): string {
  return `${getMakoCloudRepoPrefix()}-${workspaceId}`;
}

async function findCloudRepoPointer(
  workspaceId: string,
): Promise<{ owner: string; repo: string } | null> {
  const ws = await Workspace.findById(new Types.ObjectId(workspaceId))
    .select("appsV2CloudRepo")
    .lean();
  return ws?.appsV2CloudRepo ?? null;
}

/**
 * Create (idempotently) the workspace's cloud repo and persist the pointer
 * on the workspace doc. Returns null when the cloud app is not configured —
 * callers degrade to local-only storage rather than failing app creation.
 */
export async function ensureCloudRepo(
  workspaceId: string,
): Promise<{ owner: string; repo: string } | null> {
  const existing = await findCloudRepoPointer(workspaceId);
  if (existing) return existing;
  if (!isMakoCloudConfigured()) return null;
  const org = getMakoCloudOrg();
  if (!org) return null;

  const name = cloudRepoNameFor(workspaceId);
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
      description: `Mako workspace repo (workspace ${workspaceId})`,
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
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    { $set: { appsV2CloudRepo: cloudRepo } },
  );
  logger.info("Apps v2 workspace cloud repo ready", {
    workspaceId,
    repo: `${org}/${name}`,
  });
  return cloudRepo;
}

/**
 * Recover-on-miss: rebuild the local bare repo from its cloud mirror.
 *
 * On serverless hosts (Cloud Run: tmpfs, min-instances=0) the local repos
 * under APPS_V2_GIT_ROOT are a CACHE, not a store — any fresh instance
 * starts without them. Since every commit/merge mirror-pushes ALL refs
 * (including refs/mako/* WIP snapshots) to the workspace's cloud repo,
 * `git clone --mirror` restores the full state on demand. Workspaces
 * without a cloud pointer (cloud-unconfigured hosts) are left alone — on a
 * stateful host their local repo simply still exists.
 *
 * Serialized per workspace so concurrent requests don't race the clone.
 */
const cloneInFlight = new Map<string, Promise<void>>();

export async function ensureLocalRepo(workspaceId: string): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  if (await repoExists(repoDir)) return;
  const existing = cloneInFlight.get(workspaceId);
  if (existing) return existing;
  const run = (async () => {
    const cloudRepo = await findCloudRepoPointer(workspaceId);
    if (!cloudRepo || !isMakoCloudConfigured()) return;
    const token = await getMakoCloudToken();
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    await fs.mkdir(path.dirname(repoDir), { recursive: true });
    const tmp = `${repoDir}.cloning-${process.pid}`;
    try {
      await runGit([
        "-c",
        `http.extraheader=Authorization: Basic ${basic}`,
        "clone",
        "--mirror",
        "--quiet",
        `https://github.com/${cloudRepo.owner}/${cloudRepo.repo}.git`,
        tmp,
      ]);
      // Same serving config initRepo applies to freshly-created repos.
      await runGit(["-C", tmp, "config", "transfer.hideRefs", "refs/mako/"]);
      await runGit([
        "-C",
        tmp,
        "config",
        "uploadpack.allowAnySHA1InWant",
        "true",
      ]);
      await fs.rename(tmp, repoDir);
      logger.info("Apps v2 local repo restored from cloud mirror", {
        workspaceId,
        repo: `${cloudRepo.owner}/${cloudRepo.repo}`,
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  })().finally(() => cloneInFlight.delete(workspaceId));
  cloneInFlight.set(workspaceId, run);
  return run;
}

// Per-workspace push serialization: `pending` coalesces bursts (N commits
// while a push is in flight -> exactly one trailing push).
const inFlight = new Map<string, Promise<void>>();
const pending = new Set<string>();

async function pushMirror(
  workspaceId: string,
  cloudRepo: { owner: string; repo: string },
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
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
 * the pointer itself so callers holding only ids (commit paths) can use it,
 * and so a pointer attached after their doc snapshot is still seen.
 */
export function queueMirrorPush(workspaceId: string): void {
  if (!isMakoCloudConfigured()) return;
  const key = workspaceId;
  if (inFlight.has(key)) {
    pending.add(key);
    return;
  }
  const run = (async () => {
    try {
      const cloudRepo = await findCloudRepoPointer(workspaceId);
      if (cloudRepo) {
        await pushMirror(workspaceId, cloudRepo);
      }
    } catch (error) {
      logger.warn("Apps v2 cloud mirror push failed", {
        workspaceId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.delete(key);
      if (pending.delete(key)) queueMirrorPush(workspaceId);
    }
  })();
  inFlight.set(key, run);
}

/** Awaitable variant for the initial push right after repo/app creation. */
export async function mirrorPushNow(workspaceId: string): Promise<void> {
  const cloudRepo = await findCloudRepoPointer(workspaceId);
  if (!cloudRepo) return;
  await pushMirror(workspaceId, cloudRepo);
}

/**
 * Pull the cloud repo's default branch into the local bare repo.
 *
 * A push from someone's checkout lands on GitHub, not here — the bare repo is
 * a cache. Before anything can be built from that commit it has to arrive, so
 * a deploy triggered by a webhook fetches first.
 */
export async function fetchFromCloud(
  workspaceId: string,
  branch: string,
): Promise<void> {
  const cloudRepo = await findCloudRepoPointer(workspaceId);
  if (!cloudRepo) return;
  const repoDir = repoDirFor(workspaceId);
  const token = await getMakoCloudToken();
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  await runGit([
    "-C",
    repoDir,
    "-c",
    `http.extraheader=Authorization: Basic ${basic}`,
    "fetch",
    "--quiet",
    `https://github.com/${cloudRepo.owner}/${cloudRepo.repo}.git`,
    // Update the local branch to match the remote. Forced because the remote
    // is authoritative for what was pushed there.
    `+refs/heads/${branch}:refs/heads/${branch}`,
  ]);
}
