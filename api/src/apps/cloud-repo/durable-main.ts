/**
 * Commit onto `main` and land it on the mirror before returning.
 *
 * `commitBlobsOnBranch` + `queueMirrorPush` commits to this instance's local
 * cache and pushes later, best-effort. That is fine for an app file. It is
 * not fine for a definition the database is about to follow (a flow's
 * `flows/<slug>.yml`): when the push is rejected — another instance or a
 * merged PR moved GitHub's main first — the next freshen parks the local
 * commit under `refs/mako/diverged/*` and resets main to the mirror. The
 * caller already saved the row, the next push to main reconciles the row
 * from the file, and the change is silently undone. On 2026-11-18 that
 * reverted a paused Stripe PL flow (parked commit 726fca1cc, 05:39 UTC) and
 * an FR Close resync switched off (5af5315ac, 01:35 UTC).
 *
 * So this write is durable or it fails:
 *  - one writer per workspace on this instance at a time (an in-process
 *    queue), so two saves never race each other's CAS or push;
 *  - optimistic concurrency against other instances and GitHub: the commit
 *    is pushed without force; a rejected push undoes the local commit,
 *    fetches the mirror's main, re-applies the mutation on top and pushes
 *    again, up to {@link DURABLE_MAIN_ATTEMPTS} times;
 *  - any other failure undoes the local commit and throws, naming the cause.
 *
 * Without a mirror (dev, previews) the local commit is the store, as before.
 */
import { runGit, GitError } from "../git";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  repoDirFor,
  resolveCommit,
  updateRefCas,
  type BlobMutation,
  type GitAuthor,
} from "../repository.service";
import { loggers } from "../../logging";
import { authArgs, remoteUrl, resolveMirrorTarget, tokenFor } from "./target";
import { fetchFromCloud, freshenBeforeMainWrite } from "./fetch";
import { MIRROR_TRACKING_PREFIX } from "./reconcile";

const logger = loggers.api("apps");

/** Push attempts before a write against a moving main gives up. */
export const DURABLE_MAIN_ATTEMPTS = 5;

export interface DurableMainCommit {
  /** The commit now at main (on the mirror when one is bound). */
  commitOid: string;
  /** False when the mutation left main's tree as it was (no commit made). */
  changed: boolean;
  /** True when the commit reached the mirror; false for a local-only repo. */
  mirrored: boolean;
}

export class DurableMainWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableMainWriteError";
  }
}

/**
 * A per-key FIFO: `run(key, fn)` starts `fn` once every earlier call for
 * `key` has settled. One process only; across instances the push itself is
 * the arbiter (see the module doc).
 */
export function keyedSerial(): <T>(
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** One main write per workspace at a time on this instance. */
export const withMainWriteLock = keyedSerial();

/**
 * What to write, or a function that decides it against the head about to be
 * committed on (called again on every retry, after the fetch). Returning
 * null writes nothing; the head is still confirmed on the mirror. Throwing
 * aborts the write.
 */
export type MainMutation =
  | BlobMutation
  | ((ctx: { repoDir: string; head: string }) => Promise<BlobMutation | null>);

function isRejectedPush(error: unknown): boolean {
  const text =
    error instanceof GitError
      ? `${error.stderr}\n${error.stdout}\n${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return /non-fast-forward|\[rejected\]|fetch first|stale info|cannot lock ref|failed to update ref/i.test(
    text,
  );
}

function messageOf(error: unknown): string {
  if (error instanceof GitError) {
    const detail = (error.stderr || error.stdout || "").trim();
    return detail ? `${error.message}: ${detail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Move local main back off a commit that did not land. Best-effort. */
async function undoLocal(
  repoDir: string,
  commitOid: string,
  previousHead: string,
): Promise<void> {
  const undone = await updateRefCas(
    repoDir,
    `refs/heads/${DEFAULT_BRANCH}`,
    previousHead,
    commitOid,
  ).catch(() => false);
  if (!undone) {
    // Something else committed on top meanwhile. The next freshen sees the
    // divergence and parks the whole local tip, so this commit cannot reach
    // the mirror by a later push either.
    logger.warn("Could not undo a local main commit that did not land", {
      repoDir,
      commitOid,
    });
  }
}

/**
 * Commit `mutation` onto main and push it to the mirror before returning.
 * Throws {@link DurableMainWriteError} when it did not land; local main is
 * then back where it was.
 */
export function commitToMainDurably(
  workspaceId: string,
  mutation: MainMutation,
  options: { message: string; author?: GitAuthor },
): Promise<DurableMainCommit> {
  return withMainWriteLock(workspaceId, async () => {
    const repoDir = repoDirFor(workspaceId);
    /** Commit locally; null head/mutation = nothing to write. */
    const commitLocally = async () => {
      const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
      if (!head) {
        throw new DurableMainWriteError(`${DEFAULT_BRANCH} is missing`);
      }
      const resolved =
        typeof mutation === "function"
          ? await mutation({ repoDir, head })
          : mutation;
      if (!resolved) {
        return { commitOid: head, previousHead: head, unchanged: true };
      }
      return commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, resolved, options);
    };
    const target = await resolveMirrorTarget(workspaceId);
    if (!target) {
      const local = await commitLocally();
      return {
        commitOid: local.commitOid,
        changed: !local.unchanged,
        mirrored: false,
      };
    }
    const url = remoteUrl(target.owner, target.repo);
    let lastError: unknown;
    for (let attempt = 1; attempt <= DURABLE_MAIN_ATTEMPTS; attempt++) {
      // First attempt: the shared, coalesced freshen. After a rejection: a
      // fetch of our own, which throws — a mirror we cannot read is a write
      // we cannot judge.
      if (attempt === 1) {
        await freshenBeforeMainWrite(workspaceId);
      } else {
        try {
          await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
        } catch (error) {
          throw new DurableMainWriteError(
            `could not fetch main from ${target.owner}/${target.repo} after a rejected push: ${messageOf(error)}`,
          );
        }
      }
      const local = await commitLocally();
      const token = await tokenFor(target);
      try {
        // No force: a commit made on GitHub meanwhile rejects this push.
        // Pushed even when unchanged, so a local main that is ahead of the
        // mirror (an earlier queued push still pending) is not reported as
        // durable before it is.
        await runGit([
          "-C",
          repoDir,
          ...authArgs(token),
          "push",
          "--quiet",
          url,
          `${local.commitOid}:refs/heads/${DEFAULT_BRANCH}`,
        ]);
        await runGit([
          "-C",
          repoDir,
          "update-ref",
          `${MIRROR_TRACKING_PREFIX}${DEFAULT_BRANCH}`,
          local.commitOid,
        ]).catch(() => undefined);
        return {
          commitOid: local.commitOid,
          changed: !local.unchanged,
          mirrored: true,
        };
      } catch (error) {
        lastError = error;
        if (!local.unchanged) {
          await undoLocal(repoDir, local.commitOid, local.previousHead);
        }
        if (!isRejectedPush(error)) {
          throw new DurableMainWriteError(
            `push to ${target.owner}/${target.repo} main failed: ${messageOf(error)}`,
          );
        }
        logger.info("Main moved on the mirror during a write; retrying", {
          workspaceId,
          attempt,
        });
      }
    }
    throw new DurableMainWriteError(
      `main on ${target.owner}/${target.repo} kept moving; ${DURABLE_MAIN_ATTEMPTS} pushes were rejected (last: ${messageOf(lastError)})`,
    );
  });
}
