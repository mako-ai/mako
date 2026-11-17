/**
 * Which repo is a workspace's mirror, the token to reach it, and restoring
 * the local bare repo (the cache) from it.
 */
import { resolveRepoToken } from "../../integrations/github/app-auth";
import { getWorkspaceRepo } from "../../services/workspace-repos.service";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "../git";
import { appsConnectedRepoPushEnv, appsRequireConnectedRepo } from "../config";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../repository.service";
import { loggers } from "../../logging";
import { freshenForServe } from "./fetch";
import { cloneInFlight } from "./clone-state";

const logger = loggers.api("apps");

/** Overridable so tests can point mirrors at file:// remotes. */
function remoteBase(): string {
  return process.env.APPS_GITHUB_REMOTE_BASE || "https://github.com";
}

export function remoteUrl(owner: string, repo: string): string {
  return `${remoteBase()}/${owner}/${repo}.git`;
}

/**
 * Whether connected customer repos participate as mirrors in THIS
 * environment. Prod (APPS_REQUIRE_CONNECTED_REPO=true), plus an explicit
 * dev opt-in — see the module doc for why previews must stay out.
 */
export function connectedTierEnabled(): boolean {
  return appsRequireConnectedRepo() || appsConnectedRepoPushEnv() === "allow";
}

export type MirrorTarget = {
  kind: "connected";
  owner: string;
  repo: string;
  installationId?: number;
};

/**
 * Resolve the bound repository for read-only clone/fetch operations.
 *
 * This deliberately ignores the push gate. Preview instances start with an
 * empty APPS_GIT_ROOT, so treating the binding as wholly inert also makes all
 * git-backed apps, consoles, and dbt files disappear.
 */
export async function resolveReadableMirrorTarget(
  workspaceId: string,
): Promise<MirrorTarget | null> {
  const binding = await getWorkspaceRepo(workspaceId).catch(() => null);
  if (!binding) return null;
  return {
    kind: "connected",
    owner: binding.owner,
    repo: binding.repo,
    installationId: binding.installationId,
  };
}

/**
 * The workspace's durable mirror: the connected repo when one is bound and
 * pushes are enabled here, else null (local-only writes).
 */
export async function resolveMirrorTarget(
  workspaceId: string,
): Promise<MirrorTarget | null> {
  if (!connectedTierEnabled()) return null;
  return resolveReadableMirrorTarget(workspaceId);
}

export async function tokenFor(
  target: MirrorTarget,
): Promise<string | undefined> {
  return resolveRepoToken(target.installationId);
}

/** Auth via header keeps the token out of the remote URL (and thus out of
 *  git's error messages). No token (dev fallback unset) = no header. */
export function authArgs(token: string | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: Basic ${basic}`];
}

/**
 * Longest one `git clone --mirror` may run. runGit's 30 s default killed
 * rollout clones: on 2026-11-17 at 10:52, about 10 fresh instances cloned
 * the same repo from GitHub at once, and 4 of them hit 30 s. A clone alone
 * takes 11 to 14 s.
 */
export const REPO_CLONE_TIMEOUT_MS = 120_000;
/** Clone attempts per restore before the error reaches the callers. */
export const REPO_CLONE_ATTEMPTS = 2;
/** A killed clone's git children can still write into its temp dir. */
const ORPHAN_SWEEP_DELAY_MS = 60_000;

function cloneTimeoutMs(): number {
  const raw = Number(process.env.APPS_REPO_CLONE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : REPO_CLONE_TIMEOUT_MS;
}

/**
 * A temp dir no other clone uses. `process.pid` alone is 1 in every Cloud
 * Run container, so `.cloning-1` was shared by every clone of the repo on
 * the instance, and a clone killed on timeout left it behind for the next.
 */
function cloneTempDir(repoDir: string): string {
  return `${repoDir}.cloning-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function isDestinationTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR";
}

async function removeTempDir(tmp: string, failed: boolean): Promise<void> {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  if (!failed) return;
  // After a timeout kill, git's helpers (remote-https, index-pack) may still
  // be writing here. Sweep once more after they have died.
  setTimeout(() => {
    void fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }, ORPHAN_SWEEP_DELAY_MS).unref();
}

/**
 * `git clone --mirror` into the workspace's repo slot + serving config.
 *
 * The clone lands in its own temp dir and the rename is the only commit
 * point. A repo slot that another clone filled meanwhile is a success: both
 * came from the same mirror.
 */
export async function cloneMirrorInto(
  workspaceId: string,
  url: string,
  token: string | undefined,
  label: string,
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  const tmp = cloneTempDir(repoDir);
  let failed = true;
  try {
    await runGit(
      [...authArgs(token), "clone", "--mirror", "--quiet", url, tmp],
      { timeoutMs: cloneTimeoutMs() },
    );
    // Same serving config initRepo applies to freshly-created repos.
    await runGit(["-C", tmp, "config", "transfer.hideRefs", "refs/mako/"]);
    await runGit([
      "-C",
      tmp,
      "config",
      "uploadpack.allowAnySHA1InWant",
      "true",
    ]);
    try {
      await fs.rename(tmp, repoDir);
    } catch (error) {
      if (!isDestinationTaken(error) || !(await repoExists(repoDir))) {
        throw error;
      }
      failed = false;
      logger.info("Apps local repo already restored by another clone", {
        workspaceId,
        repo: label,
      });
      return;
    }
    failed = false;
    logger.info("Apps local repo restored from its mirror", {
      workspaceId,
      repo: label,
    });
  } finally {
    await removeTempDir(tmp, failed);
  }
}

/**
 * Run `fn` as the workspace's only clone on this instance. A caller that
 * arrives while one runs awaits it instead of starting a second.
 */
export function singleFlightClone(
  workspaceId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const existing = cloneInFlight.get(workspaceId);
  if (existing) return existing;
  const run: Promise<void> = fn().finally(() => {
    if (cloneInFlight.get(workspaceId) === run) {
      cloneInFlight.delete(workspaceId);
    }
  });
  cloneInFlight.set(workspaceId, run);
  return run;
}

async function restoreFromMirror(workspaceId: string): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  for (let attempt = 1; ; attempt++) {
    // A clone that finished between the caller's check and this flight
    // starting already did the work.
    if (await repoExists(repoDir)) return;
    const target = await resolveReadableMirrorTarget(workspaceId);
    if (!target) return;
    const token = await tokenFor(target);
    try {
      await cloneMirrorInto(
        workspaceId,
        remoteUrl(target.owner, target.repo),
        token,
        `${target.owner}/${target.repo}`,
      );
      return;
    } catch (error) {
      if (attempt >= REPO_CLONE_ATTEMPTS) throw error;
      logger.warn("Apps local repo clone failed; retrying", {
        workspaceId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Recover-on-miss: rebuild the local bare repo from its mirror.
 *
 * On serverless hosts (Cloud Run: tmpfs, min-instances=0) the local repos
 * under APPS_GIT_ROOT are a CACHE, not a store — any fresh instance
 * starts without them. Since every commit/merge pushes all refs (including
 * refs/mako/* WIP snapshots) to the mirror, `git clone --mirror` restores
 * the full state on demand. Workspaces without any mirror are left alone —
 * on a stateful host their local repo simply still exists.
 *
 * Single-flight per workspace: a request that arrives during the boot warm
 * awaits the warm's clone. The storage is per instance (tmpfs, no shared
 * volume), so an in-process lock covers every clone of a repo slot.
 */
export async function ensureLocalRepo(workspaceId: string): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  if (await repoExists(repoDir)) {
    // A clone taken while the mirror was still empty has HEAD but no default
    // branch, and nothing else ever fetches into it: this instance answers
    // "no files" and "connect a repository first" for good, while a sibling
    // that seeded the mirror has main. Pull it (throttled; a still-empty
    // mirror simply leaves the clone as it is).
    if (!(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`))) {
      await freshenForServe(workspaceId);
    }
    return;
  }
  await singleFlightClone(workspaceId, () => restoreFromMirror(workspaceId));
}

// Per-workspace push serialization. Two pushes to the SAME remote at once
// lose a ref-lock race ("cannot lock ref … is at X but expected Y"), so
// pushes for one workspace must never overlap — not the fire-and-forget
// commit path (`queueMirrorPush`) against the awaited create path
// (`mirrorPushNow`), nor two of either. A push captures the repo's ref state
// when it RUNS, so a caller that needs its just-made commit mirrored must
// wait for a push that STARTS after that commit; that is exactly what
// `schedulePush` guarantees.
