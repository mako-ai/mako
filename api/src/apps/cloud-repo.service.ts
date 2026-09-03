/**
 * Apps durable mirror — where a workspace repo's history is replicated.
 *
 * ONE tier (apps.md §17): the workspace's CONNECTED GitHub repo (Settings →
 * GitHub, `workspaceRepos[]`). That repo IS the durable mirror — commits push
 * there, restores clone from there. A customer remote is never force-pushed:
 * heads and tags go without force (a direct GitHub-side push is never
 * clobbered), and only Mako's own `refs/mako/*` WIP namespace is forced.
 * The mirror is the source of truth and the local repo its cache: every
 * write onto `main` here freshens from the mirror first
 * (`freshenBeforeMainWrite`), and a local branch found diverged from the
 * mirror is reset to it with its commits parked under `refs/mako/diverged/*`
 * (`fetchFromCloud`).
 *
 * The connected tier only engages on production (APPS_REQUIRE_CONNECTED_REPO)
 * or under the explicit APPS_CONNECTED_REPO_PUSH=allow opt-in. Previews and
 * dev run on prod-cloned databases that carry REAL customer bindings, and a
 * test commit must never land in a customer repo — gated environments treat
 * the binding as inert metadata and keep local-only bare repos.
 *
 * The local bare repo remains the working store the API reads from; the
 * mirror is the durable replica. Mirror pushes run after commits/merges
 * (not per WIP flush — too chatty), serialized per workspace and coalesced
 * so concurrent commits produce one trailing push, never an interleaving.
 */
import { resolveRepoToken } from "../integrations/github/app-auth";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git";
import { appsConnectedRepoPushEnv, appsRequireConnectedRepo } from "./config";
import {
  DEFAULT_BRANCH,
  initRepo,
  repoDirFor,
  repoExists,
  resolveCommit,
  type GitAuthor,
} from "./repository.service";
import { initialWorkspaceFiles } from "./workspace-template";
import { loggers } from "../logging";

const logger = loggers.api("apps");

/** Overridable so tests can point mirrors at file:// remotes. */
function remoteBase(): string {
  return process.env.APPS_GITHUB_REMOTE_BASE || "https://github.com";
}

function remoteUrl(owner: string, repo: string): string {
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
 * The workspace's durable mirror: the connected repo when one is bound and
 * the tier is enabled here, else null (local-only).
 */
export async function resolveMirrorTarget(
  workspaceId: string,
): Promise<MirrorTarget | null> {
  if (!connectedTierEnabled()) return null;
  const binding = await getWorkspaceRepo(workspaceId).catch(() => null);
  if (!binding) return null;
  return {
    kind: "connected",
    owner: binding.owner,
    repo: binding.repo,
    installationId: binding.installationId,
  };
}

async function tokenFor(target: MirrorTarget): Promise<string | undefined> {
  return resolveRepoToken(target.installationId);
}

/** Auth via header keeps the token out of the remote URL (and thus out of
 *  git's error messages). No token (dev fallback unset) = no header. */
function authArgs(token: string | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: Basic ${basic}`];
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
  if (!connectedTierEnabled()) return;
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
  if (!connectedTierEnabled()) return;
  await schedulePush(workspaceId);
}

/**
 * Pull the mirror's branch into the local bare repo.
 *
 * A push from someone's checkout lands on GitHub, not here — the bare repo is
 * a cache. Before anything can be built from that commit it has to arrive, so
 * a deploy triggered by a webhook fetches first. Remote ahead → fast-forward;
 * local ahead → leave it (a mirror push is pending); diverged → the mirror
 * wins and the local tip is parked under refs/mako/diverged/* (see below).
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

/**
 * Freshen the local bare repo from the cloud mirror before SERVING a fetch.
 *
 * ensureLocalRepo only restores a MISSING repo; an instance whose clone
 * predates a push happily serves stale refs, and a sandbox fetching a
 * just-pushed sha gets `upload-pack: not our ref` — seen in prod when
 * deploy-on-push raced the GitHub webhook across Cloud Run instances (the
 * webhook instance had the commit, the instance serving the sandbox's
 * fetch did not, and the deploy burned its retries inside the window).
 *
 * Throttled per workspace: bursts of fetches (a clone is several requests)
 * share one mirror pull. Failure is non-fatal — serve local state and let
 * the client's git command produce the specific error.
 */
const FRESHEN_INTERVAL_MS = 3_000;
const lastFreshenAt = new Map<string, number>();
const freshenInFlight = new Map<string, Promise<void>>();

export async function freshenForServe(
  workspaceId: string,
  intervalMs: number = FRESHEN_INTERVAL_MS,
  intent: "serve" | "write" = "serve",
): Promise<void> {
  if (Date.now() - (lastFreshenAt.get(workspaceId) ?? 0) < intervalMs) return;
  const existing = freshenInFlight.get(workspaceId);
  if (existing) return existing;
  const run = (async () => {
    try {
      await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    } catch (error) {
      const details = {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      };
      if (intent === "write") {
        // A failed freshen before a WRITE is not a degraded read — it means
        // the commit about to happen is being judged against a tip that may
        // already be behind the mirror, which is how a local repo diverges
        // and stops being able to push at all. Staying non-blocking is the
        // right trade (a brief mirror outage must not fail a user's save),
        // but it must not be silent: this exact failure went unnoticed in
        // dev because a local bare repo had no fetch remote configured, and
        // ten commits landed on a diverged main before anyone looked.
        logger.error(
          "Freshen before a main write FAILED; committing against a possibly stale tip",
          details,
        );
      } else {
        logger.warn(
          "Freshen before serve failed; serving local state",
          details,
        );
      }
    } finally {
      lastFreshenAt.set(workspaceId, Date.now());
    }
  })().finally(() => freshenInFlight.delete(workspaceId));
  freshenInFlight.set(workspaceId, run);
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
  const isAncestor = (ancestor: string, descendant: string) =>
    runGit(["-C", repoDir, "merge-base", "--is-ancestor", ancestor, descendant])
      .then(() => true)
      .catch(() => false);
  if (await isAncestor(localOid, remoteOid)) {
    // Remote is ahead: plain fast-forward.
    await runGit([
      "-C",
      repoDir,
      "update-ref",
      `refs/heads/${branch}`,
      remoteOid,
      localOid,
    ]);
    return;
  }
  if (await isAncestor(remoteOid, localOid)) {
    // Local is ahead: commits made here whose mirror push has not landed yet
    // (or is in flight). Nothing to reconcile — the push carries them up.
    return;
  }
  // DIVERGED: both sides have commits the other lacks. The local repo is a
  // cache of the mirror, and a cache that disagrees with its source is wrong
  // by definition — leaving it be is what made a whole instance's publishes
  // fail for hours in prod (every mirror push rejected non-fast-forward until
  // the instance was recycled, and its local-only commits died with the
  // tmpfs). So the mirror wins, and nothing is dropped: the local tip is
  // parked under refs/mako/diverged/* — Mako's own forced namespace, so the
  // next mirror push carries it to GitHub where it can be recovered — and the
  // branch is reset to the mirror. Whoever made those commits still has them
  // in their box/clone; their next push is judged against the real branch
  // and the pre-receive hook tells them to merge.
  const parkedRef = `refs/mako/diverged/${branch}/${localOid.slice(0, 12)}`;
  await runGit(["-C", repoDir, "update-ref", parkedRef, localOid]);
  const swapped = await runGit([
    "-C",
    repoDir,
    "update-ref",
    `refs/heads/${branch}`,
    remoteOid,
    localOid,
  ])
    .then(() => true)
    .catch(() => false);
  logger.warn(
    "Apps connected-repo branch had diverged from the mirror; reset to the mirror, local commits parked",
    { workspaceId, branch, localOid, remoteOid, parkedRef, swapped },
  );
  queueMirrorPush(workspaceId);
}

/**
 * Bring `main` up to date with the mirror BEFORE something is committed or
 * pushed onto it here. Un-throttled (coalesced only), because a write judged
 * against a stale main is exactly how divergence starts: a laptop pushes to
 * GitHub, and moments later a skill save, a branch merge, a publish or a
 * box's `git push` lands on an instance whose main predates it — accepted
 * locally (it fast-forwards the STALE tip), unmirrorable forever after.
 * Failures are logged and swallowed: a mirror that is briefly unreachable
 * must not block the user's write; the mirror push simply retries later.
 */
export function freshenBeforeMainWrite(workspaceId: string): Promise<void> {
  // "write" only raises the volume when it fails; the fetch is identical. A
  // serve-freshen already in flight is shared rather than duplicated, so a
  // write can occasionally inherit a serve's warn — acceptable, since the
  // failure is still reported and the next write logs it at full volume.
  return freshenForServe(workspaceId, 0, "write");
}

/**
 * Thrown when we cannot PROVE the local tree matches the mirror's main.
 *
 * Distinct from a freshen failure, which is survivable: this one means a
 * caller must not proceed with something destructive.
 */
export class TreeNotVerifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeNotVerifiedError";
  }
}

/**
 * Fail CLOSED: prove the tree a caller read is the mirror's current main, or
 * throw.
 *
 * `freshenBeforeMainWrite` is deliberately best-effort — a brief mirror outage
 * must not fail a user's save, so it logs and proceeds. That trade is right
 * for a commit and wrong for a deletion, and the asymmetry is not a matter of
 * degree. A dbt job row deleted from a stale read comes back on the next sync,
 * because the file recreates it. A CDC teardown DISPOSES CHECKPOINTS
 * (`CdcEntityState.lastIngestSeq`, `backfillCursor`): recreating the flow does
 * not recover the stream position, it re-backfills from scratch. One is churn;
 * the other is data loss.
 *
 * So the destructive path asks a different question — not "did we try to
 * refresh?" but "is this tree definitely current?" — and refuses when the
 * answer is unknown. `ls-remote` is asked rather than the local repo, because
 * the local repo is the very thing under suspicion.
 *
 * The consequence is deliberate and worth stating where it will be found: when
 * the mirror is unreachable, a genuinely deleted flow does NOT tear down on
 * this push. It tears down on the next one. Someone will eventually report
 * that as a bug; it is the cost of never tearing down a live stream because we
 * could not check.
 *
 * A workspace with no mirror (dev, previews — the connected tier gated off)
 * has nothing to diverge from: the local repo IS the store, so the check
 * passes.
 */
export async function assertTreeAtMirrorMain(
  workspaceId: string,
  treeSha: string,
): Promise<void> {
  const target = await resolveMirrorTarget(workspaceId);
  if (!target) return; // No mirror: the local repo is authoritative.
  if (!/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: "${treeSha}" is not a commit sha`,
    );
  }
  const url = remoteUrl(target.owner, target.repo);
  const token = await tokenFor(target);
  let remoteMain: string;
  try {
    const { stdout } = await runGit([
      ...authArgs(token),
      "ls-remote",
      url,
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    remoteMain = stdout.trim().split(/\s+/)[0] ?? "";
  } catch (error) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: could not read the mirror's ${DEFAULT_BRANCH} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(remoteMain)) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: the mirror reported no ${DEFAULT_BRANCH}`,
    );
  }
  if (remoteMain !== treeSha) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: read at ${treeSha.slice(0, 8)} but the mirror's ${DEFAULT_BRANCH} is ${remoteMain.slice(0, 8)}`,
    );
  }
}

/**
 * Whether the remote's default branch and the local one descend from a common
 * commit. Fetching the remote tip into the local object store is harmless (a
 * fetch never moves a local ref) and is what the reconcile step needs anyway.
 * A remote with content but no default branch, or an unreachable remote,
 * answers "no": the caller then refuses, which is the safe side.
 */
async function sharesHistoryWith(
  repoDir: string,
  url: string,
  token: string | undefined,
): Promise<boolean> {
  try {
    await runGit([
      "-C",
      repoDir,
      ...authArgs(token),
      "fetch",
      "--quiet",
      url,
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    await runGit([
      "-C",
      repoDir,
      "merge-base",
      "FETCH_HEAD",
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export type ConnectedRepoAdoption =
  | "imported"
  | "seeded"
  | "reconnected"
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
 *  - both have content and share history → RECONNECT: this is the
 *    disconnect-then-connect-again case (the repo WAS this workspace's
 *    mirror; unlinking never touches the local repo, so both sides hold the
 *    same commits). The two tips are reconciled the way every later fetch
 *    reconciles them (`fetchFromCloud`: remote ahead → fast-forward, local
 *    ahead → push, diverged → the mirror wins with the local tip parked
 *    under refs/mako/diverged/*, nothing dropped), then pushed.
 *  - both have content and NO common ancestor → refuse. Choosing whose
 *    history wins is not ours to guess; the caller rolls the binding back.
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

  const repoDir = repoDirFor(workspaceId);
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
    if (!(await sharesHistoryWith(repoDir, url, token))) {
      throw new Error(
        `${label} already has content unrelated to this workspace's history, and this workspace already has apps. ` +
          "Reconnect the repository this workspace was previously connected to, " +
          "connect an empty repository (the workspace's history will be pushed into it), " +
          "or import a non-empty repository into a workspace that has no apps yet.",
      );
    }
    // RECONNECT: same lineage on both sides. Reconcile main exactly as a
    // webhook fetch would, then push so the mirror carries whatever the
    // local side has that it lacks (local-ahead commits, refs/mako/*, a
    // parked diverged tip).
    await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    await mirrorPushNow(workspaceId);
    logger.info("Apps workspace reconnected to a repo sharing its history", {
      workspaceId,
      repo: label,
    });
    return "reconnected";
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

/**
 * The workspace repo, restored from its mirror or initialized with the
 * starter template. Repos are provisioned lazily by whichever content type
 * arrives first — app creation, console saves and skill writes all converge
 * here (§10 monorepo).
 */
export async function ensureWorkspaceRepo(
  workspaceId: string,
  author?: GitAuthor,
): Promise<string> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  const hasMain =
    (await repoExists(repoDir)) &&
    Boolean(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`));
  if (!hasMain) {
    // `git clone --mirror` of an empty GitHub repo still creates a bare
    // directory with no refs. The first write needs `main` so it can seed
    // the mirror (issue #956).
    if (await repoExists(repoDir)) {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
    await initRepo(repoDir, initialWorkspaceFiles(workspaceId), {
      message: "Initialize workspace repository",
      author,
    });
  }
  return repoDir;
}
