/**
 * Bringing the mirror's commits in: a missing commit, a throttled freshen
 * before serving, a full fetch that parks diverged tips, and the un-throttled
 * freshen before a write onto main.
 */
import { runGit } from "../git";
import { DEFAULT_BRANCH, repoDirFor } from "../repository.service";
import { loggers } from "../../logging";
import { BoundedMap } from "../../utils/bounded-map";
import {
  remoteUrl,
  resolveReadableMirrorTarget,
  tokenFor,
  authArgs,
  ensureLocalRepo,
} from "./target";
import { queueMirrorPush } from "./push";

const logger = loggers.api("apps");

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
 * A missing commit is recoverable — usually it is on the mirror's default
 * branch, since publishing promotes it to main before deploying — so fetch
 * the branch and look again. A commit can also be off the branch: an index
 * row (a connector's `sha`) recorded at an instance's local main that then
 * lost the race to the mirror. fetchFromCloud parks that tip under
 * refs/mako/diverged/* and pushes it there, so it stays on the mirror, just
 * not on main. On 17 Nov 2026 two instances indexed main at such commits
 * (6a442aff, 1852f545), and for 3 min syncs on other instances failed
 * `git ls-tree` with `fatal: not a tree object`. So when the branch does not
 * carry the commit, fetch it by its sha.
 *
 * Coalesced per (workspace, sha) so a page asking for sixteen bindings at
 * once triggers one fetch, not sixteen. Returns false when the branch fetch
 * failed and the sha fetch did not make up for it.
 */
const commitFetchInFlight = new Map<string, Promise<boolean>>();

const FULL_SHA = /^[0-9a-f]{40}$/;

async function commitPresent(repoDir: string, sha: string): Promise<boolean> {
  return runGit(["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
}

/** Fetch one commit by its sha from the mirror, whatever ref holds it. */
async function fetchCommitFromCloud(
  workspaceId: string,
  sha: string,
): Promise<void> {
  const target = await resolveReadableMirrorTarget(workspaceId);
  if (!target) return;
  const token = await tokenFor(target);
  await runGit([
    "-C",
    repoDirFor(workspaceId),
    ...authArgs(token),
    "fetch",
    "--quiet",
    // Never touch the shared FETCH_HEAD: fetchFromCloud reads it as the
    // mirror's main, and a concurrent sha fetch would hand it this commit.
    "--no-write-fetch-head",
    remoteUrl(target.owner, target.repo),
    sha,
  ]);
}

const currentReadInFlight = new Map<string, Promise<string>>();

/** Pin a current read to the mirror's main. A cache miss fetches only the
 * observed commit, without moving local main or touching FETCH_HEAD. */
export function readMirrorMainForCurrentRead(
  workspaceId: string,
): Promise<string> {
  const pending = currentReadInFlight.get(workspaceId);
  if (pending) return pending;
  const run = (async () => {
    const target = await resolveReadableMirrorTarget(workspaceId);
    if (!target) throw new Error("Workspace repository is unavailable");
    const token = await tokenFor(target);
    const { stdout } = await runGit([
      ...authArgs(token),
      "ls-remote",
      remoteUrl(target.owner, target.repo),
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    const sha = stdout.trim().split(/\s+/)[0] ?? "";
    if (!FULL_SHA.test(sha)) throw new Error("Workspace main is unavailable");
    const repoDir = repoDirFor(workspaceId);
    if (!(await commitPresent(repoDir, sha))) {
      await fetchCommitFromCloud(workspaceId, sha);
      if (!(await commitPresent(repoDir, sha))) {
        throw new Error("Workspace main commit is unavailable");
      }
    }
    return sha;
  })().finally(() => currentReadInFlight.delete(workspaceId));
  currentReadInFlight.set(workspaceId, run);
  return run;
}

export async function ensureCommitLocally(
  workspaceId: string,
  sha: string,
  branch: string = DEFAULT_BRANCH,
): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return true;
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (await commitPresent(repoDir, sha)) return true;
  const key = `${workspaceId}#${sha}`;
  const existing = commitFetchInFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    let fetched = true;
    try {
      await fetchFromCloud(workspaceId, branch);
    } catch (error) {
      // Not fatal here: the caller's git command produces the real, specific
      // error if the commit is still missing after this.
      fetched = false;
      logger.warn("Fetch for a missing commit failed", {
        workspaceId,
        sha,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (FULL_SHA.test(sha) && !(await commitPresent(repoDir, sha))) {
      try {
        await fetchCommitFromCloud(workspaceId, sha);
        fetched = true;
      } catch (error) {
        logger.warn("Fetch of a missing commit by its sha failed", {
          workspaceId,
          sha,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return fetched;
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
// Throttle stamps; callers pass intervals of seconds, so an hour-old stamp
// throttles nothing and can go.
const lastFreshenAt = new BoundedMap<string, number>({
  maxEntries: 5_000,
  ttlMs: 60 * 60_000,
});
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
  const target = await resolveReadableMirrorTarget(workspaceId);
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
