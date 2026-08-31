/**
 * Apps durable mirrors — where a workspace repo's history is replicated.
 *
 * Two tiers, ONE mirror per workspace (§13.17):
 *
 *  - CONNECTED: the workspace linked its own GitHub repo (Settings → GitHub,
 *    `workspaceRepos[]`). That repo IS the durable mirror — commits push
 *    there, restores clone from there, and mako-cloud is not used at all.
 *    A customer remote is never force-pushed: heads and tags go without
 *    force (a direct GitHub-side push stalls our mirror with a logged
 *    non-fast-forward error instead of being clobbered), and only Mako's own
 *    `refs/mako/*` WIP namespace is forced.
 *  - MAKO-CLOUD: workspaces that never connected a repo fall back to a
 *    Mako-owned private repo under MAKO_CLOUD_GITHUB_ORG
 *    (`<MAKO_CLOUD_REPO_PREFIX>-<workspaceId>` — the prefix namespaces per
 *    backing database: prod "ws", previews/staging "staging", local "dev").
 *    This is OUR remote, so it is mirror-pushed verbatim (--mirror: all
 *    refs, pruned).
 *
 * The connected tier only engages on production (prefix "ws") or under the
 * explicit APPS_CONNECTED_REPO_PUSH=allow opt-in. Previews and dev run on
 * prod-cloned databases that carry REAL customer bindings, and a test commit
 * must never land in a customer repo — gated environments treat the binding
 * as inert metadata and keep using their own mako-cloud tier.
 *
 * The local bare repo remains the working store the API reads from; the
 * mirror is the durable replica. Mirror pushes run after commits/merges
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
import { resolveRepoToken } from "../integrations/github/app-auth";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git";
import { appsConnectedRepoPushEnv } from "./config";
import { DEFAULT_BRANCH, repoDirFor, repoExists } from "./repository.service";
import { loggers } from "../logging";

const logger = loggers.api("apps");

const GITHUB_API = "https://api.github.com";

/** Overridable so tests can point mirrors at file:// remotes. */
function remoteBase(): string {
  return process.env.APPS_GITHUB_REMOTE_BASE || "https://github.com";
}

function remoteUrl(owner: string, repo: string): string {
  return `${remoteBase()}/${owner}/${repo}.git`;
}

/**
 * Whether connected customer repos participate as mirrors in THIS
 * environment. Prod only (prefix "ws"), plus an explicit dev opt-in —
 * see the module doc for why previews must stay out.
 */
export function connectedTierEnabled(): boolean {
  return (
    getMakoCloudRepoPrefix() === "ws" || appsConnectedRepoPushEnv() === "allow"
  );
}

export type MirrorTarget =
  | { kind: "connected"; owner: string; repo: string; installationId?: number }
  | { kind: "mako-cloud"; owner: string; repo: string };

export function cloudRepoNameFor(workspaceId: string): string {
  return `${getMakoCloudRepoPrefix()}-${workspaceId}`;
}

async function findCloudRepoPointer(
  workspaceId: string,
): Promise<{ owner: string; repo: string } | null> {
  const ws = await Workspace.findById(new Types.ObjectId(workspaceId))
    .select("appsCloudRepo")
    .lean();
  return ws?.appsCloudRepo ?? null;
}

/**
 * The workspace's durable mirror: the connected repo when one is bound (and
 * the tier is enabled here), else the mako-cloud pointer, else null.
 */
export async function resolveMirrorTarget(
  workspaceId: string,
): Promise<MirrorTarget | null> {
  if (connectedTierEnabled()) {
    const binding = await getWorkspaceRepo(workspaceId).catch(() => null);
    if (binding) {
      return {
        kind: "connected",
        owner: binding.owner,
        repo: binding.repo,
        installationId: binding.installationId,
      };
    }
  }
  const pointer = await findCloudRepoPointer(workspaceId);
  return pointer ? { kind: "mako-cloud", ...pointer } : null;
}

async function tokenFor(target: MirrorTarget): Promise<string | undefined> {
  if (target.kind === "connected") {
    return resolveRepoToken(target.installationId);
  }
  return getMakoCloudToken();
}

/** Auth via header keeps the token out of the remote URL (and thus out of
 *  git's error messages). No token (dev fallback unset) = no header. */
function authArgs(token: string | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: Basic ${basic}`];
}

/**
 * Create (idempotently) the workspace's mako-cloud repo and persist the
 * pointer on the workspace doc. Returns null when the cloud app is not
 * configured — callers degrade to local-only storage rather than failing app
 * creation. Workspaces with a connected repo never get one (§13.17): their
 * own repo is the durable tier.
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
    { $set: { appsCloudRepo: cloudRepo } },
  );
  logger.info("Apps workspace cloud repo ready", {
    workspaceId,
    repo: `${org}/${name}`,
  });
  return cloudRepo;
}

/**
 * Make sure the workspace HAS a durable mirror before content is committed:
 * the connected repo when one is bound (nothing to create — it already
 * exists on GitHub), else the mako-cloud repo (created on demand). Null =
 * no durable tier is configured (pure-local dev) and creation proceeds
 * local-only.
 */
export async function ensureDurableRepo(
  workspaceId: string,
): Promise<MirrorTarget | null> {
  if (connectedTierEnabled()) {
    const binding = await getWorkspaceRepo(workspaceId).catch(() => null);
    if (binding) {
      return {
        kind: "connected",
        owner: binding.owner,
        repo: binding.repo,
        installationId: binding.installationId,
      };
    }
  }
  if (!isMakoCloudConfigured()) return null;
  const made = await ensureCloudRepo(workspaceId);
  return made ? { kind: "mako-cloud", ...made } : null;
}

/** `git clone --mirror` into the workspace's repo slot + serving config. */
async function cloneMirrorInto(
  workspaceId: string,
  url: string,
  token: string | undefined,
  label: string,
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  const tmp = `${repoDir}.cloning-${process.pid}`;
  try {
    await runGit([
      ...authArgs(token),
      "clone",
      "--mirror",
      "--quiet",
      url,
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
    logger.info("Apps local repo restored from its mirror", {
      workspaceId,
      repo: label,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
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
 * Serialized per workspace so concurrent requests don't race the clone.
 */
const cloneInFlight = new Map<string, Promise<void>>();

export async function ensureLocalRepo(workspaceId: string): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  if (await repoExists(repoDir)) return;
  const existing = cloneInFlight.get(workspaceId);
  if (existing) return existing;
  const run = (async () => {
    const target = await resolveMirrorTarget(workspaceId);
    if (!target) return;
    if (target.kind === "mako-cloud" && !isMakoCloudConfigured()) return;
    const token = await tokenFor(target);
    await cloneMirrorInto(
      workspaceId,
      remoteUrl(target.owner, target.repo),
      token,
      `${target.owner}/${target.repo}`,
    );
  })().finally(() => cloneInFlight.delete(workspaceId));
  cloneInFlight.set(workspaceId, run);
  return run;
}

// Per-workspace push serialization. Two pushes to the SAME remote at once
// lose a ref-lock race ("cannot lock ref … is at X but expected Y"), so
// pushes for one workspace must never overlap — not the fire-and-forget
// commit path (`queueMirrorPush`) against the awaited create path
// (`mirrorPushNow`), nor two of either. A push captures the repo's ref state
// when it RUNS, so a caller that needs its just-made commit mirrored must
// wait for a push that STARTS after that commit; that is exactly what
// `schedulePush` guarantees.
const inFlight = new Map<string, Promise<void>>();
// The single trailing push per workspace: every request that arrives while a
// push is in flight collapses into one more push, which starts only after the
// current one ends (so it sees all their commits). Awaiters share its promise.
const trailing = new Map<string, Promise<void>>();

async function runPush(workspaceId: string): Promise<void> {
  const target = await resolveMirrorTarget(workspaceId);
  if (target) await pushMirror(workspaceId, target);
}

/**
 * Schedule a mirror push that is guaranteed to START after this call, and
 * return a promise for its completion. Never runs two pushes for one workspace
 * at once; coalesces every request made during an in-flight push into a single
 * trailing push.
 */
function schedulePush(workspaceId: string): Promise<void> {
  const running = inFlight.get(workspaceId);
  if (!running) {
    const p = runPush(workspaceId).finally(() => {
      if (inFlight.get(workspaceId) === p) inFlight.delete(workspaceId);
    });
    inFlight.set(workspaceId, p);
    return p;
  }
  // A push is already running and may predate our commit — ride the single
  // trailing push, which begins only once the current one finishes.
  let t = trailing.get(workspaceId);
  if (!t) {
    t = running
      .catch(() => undefined)
      .then(() => {
        trailing.delete(workspaceId);
        return schedulePush(workspaceId);
      });
    trailing.set(workspaceId, t);
  }
  return t;
}

async function pushMirror(
  workspaceId: string,
  target: MirrorTarget,
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  const token = await tokenFor(target);
  const url = remoteUrl(target.owner, target.repo);
  if (target.kind === "mako-cloud") {
    // --mirror: all refs incl. refs/mako/* WIP snapshots (this is OUR
    // remote, so the never-force-a-customer-remote rule doesn't apply),
    // pruning remote refs deleted locally.
    await runGit([
      "-C",
      repoDir,
      ...authArgs(token),
      "push",
      "--mirror",
      "--quiet",
      url,
    ]);
    return;
  }
  // Connected repo = a CUSTOMER remote. Heads and tags go WITHOUT force: if
  // someone pushed to GitHub directly, our push fails non-fast-forward and is
  // logged — never clobbered (the webhook fetch path reconciles when the
  // remote is simply ahead). Only Mako's own refs/mako/* WIP namespace is
  // forced, and nothing is pruned.
  await runGit([
    "-C",
    repoDir,
    ...authArgs(token),
    "push",
    "--quiet",
    url,
    "refs/heads/*:refs/heads/*",
    "refs/tags/*:refs/tags/*",
    "+refs/mako/*:refs/mako/*",
  ]);
}

/**
 * Queue a fire-and-forget mirror push. Never throws — durability is
 * best-effort on top of the local store, and a failed push must not fail the
 * user's commit. Failures are logged for a future reconciler to sweep. Loads
 * the target itself so callers holding only ids (commit paths) can use it,
 * and so a binding or pointer attached after their doc snapshot is still
 * seen.
 */
export function queueMirrorPush(workspaceId: string): void {
  if (!isMakoCloudConfigured() && !connectedTierEnabled()) return;
  void schedulePush(workspaceId).catch(error => {
    logger.warn("Apps mirror push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Awaitable variant for the initial push right after repo/app creation. Shares
 * the same per-workspace serialization as `queueMirrorPush`, so it never races
 * a fire-and-forget push already in flight — and the push it awaits is
 * guaranteed to start after the caller's commit.
 */
export async function mirrorPushNow(workspaceId: string): Promise<void> {
  if (!isMakoCloudConfigured() && !connectedTierEnabled()) return;
  await schedulePush(workspaceId);
}

/**
 * Pull the mirror's branch into the local bare repo.
 *
 * A push from someone's checkout lands on GitHub, not here — the bare repo is
 * a cache. Before anything can be built from that commit it has to arrive, so
 * a deploy triggered by a webhook fetches first. For mako-cloud repos the
 * remote is authoritative (forced update). For connected repos the local
 * branch advances only when it fast-forwards: on divergence (Mako-side
 * commits that failed to push, plus direct GitHub commits) we log and stand
 * still rather than silently drop either side.
 */
/**
 * Make sure `sha` exists in this instance's local repo, fetching it if not.
 *
 * Publishing moves `main` and deploys, but only the instance that HANDLED the
 * push (or the webhook) has the commit in its cache. Every other instance —
 * and on Cloud Run there are several, each with its own tmpfs — has a clone
 * that predates it, and `ensureLocalRepo` returns early because a repo dir is
 * there. Serving a published app then reads binding files AT the published
 * sha, and git answers `fatal: not a tree object`: measured on a freshly
 * published app, half of its `__data/<name>.parquet` requests 500'd, the
 * other half succeeded, purely by which instance answered.
 *
 * A missing commit is recoverable — it is on the mirror's default branch,
 * since publishing promotes it to main before deploying — so fetch once and
 * look again. Coalesced per (workspace, sha) so a page asking for sixteen
 * bindings at once triggers one fetch, not sixteen.
 */
const commitFetchInFlight = new Map<string, Promise<void>>();

async function commitPresent(repoDir: string, sha: string): Promise<boolean> {
  return runGit(["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
}

export async function ensureCommitLocally(
  workspaceId: string,
  sha: string,
  branch: string = DEFAULT_BRANCH,
): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return;
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (await commitPresent(repoDir, sha)) return;
  const key = `${workspaceId}#${sha}`;
  const existing = commitFetchInFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    try {
      await fetchFromCloud(workspaceId, branch);
    } catch (error) {
      // Not fatal here: the caller's git command produces the real, specific
      // error if the commit is still missing after this.
      logger.warn("Fetch for a missing commit failed", {
        workspaceId,
        sha,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().finally(() => commitFetchInFlight.delete(key));
  commitFetchInFlight.set(key, run);
  return run;
}

export async function fetchFromCloud(
  workspaceId: string,
  branch: string,
): Promise<void> {
  const target = await resolveMirrorTarget(workspaceId);
  if (!target) return;
  const repoDir = repoDirFor(workspaceId);
  const token = await tokenFor(target);
  const url = remoteUrl(target.owner, target.repo);
  if (target.kind === "mako-cloud") {
    await runGit([
      "-C",
      repoDir,
      ...authArgs(token),
      "fetch",
      "--quiet",
      url,
      // Update the local branch to match the remote. Forced because the
      // remote is authoritative for what was pushed there.
      `+refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    return;
  }
  await runGit([
    "-C",
    repoDir,
    ...authArgs(token),
    "fetch",
    "--quiet",
    url,
    `refs/heads/${branch}`,
  ]);
  const remoteOid = (
    await runGit(["-C", repoDir, "rev-parse", "FETCH_HEAD"])
  ).stdout.trim();
  const localOid = await runGit([
    "-C",
    repoDir,
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ])
    .then(r => r.stdout.trim())
    .catch(() => null);
  if (!localOid) {
    await runGit([
      "-C",
      repoDir,
      "update-ref",
      `refs/heads/${branch}`,
      remoteOid,
    ]);
    return;
  }
  if (localOid === remoteOid) return;
  const fastForwards = await runGit([
    "-C",
    repoDir,
    "merge-base",
    "--is-ancestor",
    localOid,
    remoteOid,
  ])
    .then(() => true)
    .catch(() => false);
  if (fastForwards) {
    await runGit([
      "-C",
      repoDir,
      "update-ref",
      `refs/heads/${branch}`,
      remoteOid,
      localOid,
    ]);
  } else {
    logger.warn(
      "Apps connected-repo fetch skipped: local branch has diverged from the remote",
      { workspaceId, branch, localOid, remoteOid },
    );
  }
}

export type ConnectedRepoAdoption =
  | "imported"
  | "seeded"
  | "fresh"
  | "deferred";

/**
 * Connect-time reconciliation between the workspace's existing history and
 * the newly linked repo (§13.17). At most one side may have content:
 *
 *  - repo has content, workspace has none → IMPORT: the repo's history
 *    becomes the workspace repo, and its `apps/<slug>/mako.json` folders
 *    appear as apps with no registration step (§13 doctrine, now applied to
 *    customer repos).
 *  - workspace has content, repo is empty → SEED: the workspace history is
 *    pushed into the repo; it is the mirror from here on.
 *  - both empty → nothing to reconcile; the first commit seeds the repo.
 *  - both have content → refuse. Choosing whose history wins is not ours to
 *    guess; the caller rolls the binding back.
 *
 * Where the connected tier is gated off (previews/dev on prod-cloned DBs) the
 * binding is stored as inert metadata: "deferred".
 */
export async function adoptConnectedRepo(
  workspaceId: string,
  binding: { owner: string; repo: string; installationId?: number },
): Promise<ConnectedRepoAdoption> {
  if (!connectedTierEnabled()) return "deferred";
  const token = await resolveRepoToken(binding.installationId);
  const url = remoteUrl(binding.owner, binding.repo);
  const label = `${binding.owner}/${binding.repo}`;

  // Restore any pre-binding history from the LEGACY mako-cloud mirror
  // explicitly — the general restore path would now consult the very binding
  // being adopted.
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) {
    const pointer = await findCloudRepoPointer(workspaceId);
    if (pointer && isMakoCloudConfigured()) {
      await cloneMirrorInto(
        workspaceId,
        remoteUrl(pointer.owner, pointer.repo),
        await getMakoCloudToken(),
        `${pointer.owner}/${pointer.repo}`,
      ).catch(error => {
        logger.warn("Apps legacy mirror restore failed during adoption", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
  const hasHistory =
    (await repoExists(repoDir)) &&
    (await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      `refs/heads/${DEFAULT_BRANCH}`,
    ])
      .then(() => true)
      .catch(() => false));

  const lsRemote = await runGit([...authArgs(token), "ls-remote", url]);
  const remoteEmpty = lsRemote.stdout.trim() === "";

  if (!remoteEmpty && hasHistory) {
    throw new Error(
      `${label} already has content and this workspace already has apps. ` +
        "Connect an empty repository (the workspace's history will be pushed into it), " +
        "or import a non-empty repository into a workspace that has no apps yet.",
    );
  }
  if (!remoteEmpty) {
    // IMPORT: drop the (history-less) local slot and adopt the repo's history.
    await fs.rm(repoDir, { recursive: true, force: true });
    await cloneMirrorInto(workspaceId, url, token, label);
    logger.info("Apps workspace imported its connected repo", {
      workspaceId,
      repo: label,
    });
    return "imported";
  }
  if (hasHistory) {
    await mirrorPushNow(workspaceId);
    logger.info("Apps workspace history seeded into its connected repo", {
      workspaceId,
      repo: label,
    });
    return "seeded";
  }
  return "fresh";
}
