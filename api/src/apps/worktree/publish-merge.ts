/**
 * Publish's git half (§13.3): the trial merge in a scratch checkout, then
 * promoting the built commit to main.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../git";
import {
  DEFAULT_BRANCH,
  resolveCommit,
  updateRefCas,
  type GitAuthor,
} from "../repository.service";

import { WorktreeHandle } from "./repo";

/**
 * Where a publish parks the merge result while it is being built.
 *
 * It has to live in the repo rather than in a working directory: the scratch
 * clone that produced it is deleted immediately, and the sandbox has to be
 * moved onto exactly this commit so that what gets built is what would ship.
 */
const PUBLISH_CANDIDATE_REF = "refs/mako/publish-candidate";

/**
 * Run a git operation in a throwaway checkout of `ref`.
 *
 * Some server-side git genuinely needs a working directory — a merge does —
 * but that is not a reason to keep a long-lived one around. This one exists
 * for the length of the call and is deleted afterwards, so it can never drift,
 * be edited, or become a second opinion about the state of the app.
 */
async function scratchCheckout<T>(
  repoDir: string,
  ref: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mako-scratch-"));
  try {
    await runGit(["clone", "--quiet", "--branch", ref, repoDir, dir], {
      timeoutMs: 120_000,
    });
    await runGit(["-C", dir, "config", "user.name", "Mako"]);
    await runGit(["-C", dir, "config", "user.email", "publish@mako.ai"]);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Set a ref unconditionally (used for refs only this process writes). */
async function updateRef(
  repoDir: string,
  ref: string,
  oid: string,
): Promise<void> {
  await runGit(["-C", repoDir, "update-ref", ref, oid]);
}

// ---------------------------------------------------------------------------
// Publish: trial merge, then promote (§13.3)
// ---------------------------------------------------------------------------

export interface TrialMergeResult {
  /** Commit that was built and would become the new `main`. */
  sha: string;
  /** False when the merge itself could not be performed. */
  ok: boolean;
  reason?: string;
}

/**
 * Merge `branch` into the publish worktree WITHOUT touching the real `main`.
 *
 * Publishing used to merge into `main` first and build afterwards, so a build
 * failure left `main` carrying the broken merge: production kept serving the
 * previous deployment, but the branch everyone publishes from was poisoned and
 * the next publish failed too. Building the merge result before `main` ever
 * moves means a failed publish changes nothing at all.
 *
 * Building the *merge result* rather than the branch also matters: if `main`
 * advanced since the branch forked, what lands is the merge, not the branch.
 */
export async function trialMerge(
  handle: WorktreeHandle,
  branch: string,
  author?: GitAuthor,
): Promise<TrialMergeResult> {
  const repoDir = handle.repoDir;
  const mainBranch = handle.project?.defaultBranch || DEFAULT_BRANCH;

  // A DISPOSABLE checkout, not a session. A merge needs a working directory,
  // but it does not need the actor's working copy and it certainly does not
  // need a sandbox — this is server-side git, run on a scratch clone that is
  // deleted when it is done. Nothing edits it, so it is not a second state.
  return scratchCheckout(repoDir, mainBranch, async dir => {
    if (branch !== mainBranch) {
      // No such branch means the caller has made no edits yet. Publishing then
      // is not an error — it deploys what `main` already holds. Distinguishing
      // this from a conflict matters: telling someone who has not changed
      // anything that their work "could not be merged" is simply a lie.
      const branchExists = await resolveCommit(repoDir, `refs/heads/${branch}`);
      if (!branchExists) {
        const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
        return { sha: head.stdout.trim(), ok: true };
      }
      try {
        await runGit(["-C", dir, "fetch", repoDir, branch], {
          timeoutMs: 60_000,
        });
        // Attribute the merge to whoever published it, not to the broker.
        const authorEnv = author
          ? {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_COMMITTER_NAME: author.name,
              GIT_COMMITTER_EMAIL: author.email,
            }
          : undefined;
        await runGit(["-C", dir, "merge", "--no-edit", "FETCH_HEAD"], {
          timeoutMs: 60_000,
          env: authorEnv,
        });
      } catch (error) {
        // Ask git whether this is a CONFLICT rather than pattern-matching a
        // message: it reports conflicts on stdout, so an error built from
        // stderr alone looks like any other failure — which is why the
        // actionable message below never fired. Unmerged index entries are
        // the authoritative signal.
        const unmerged = await runGit(["-C", dir, "ls-files", "-u"], {
          timeoutMs: 30_000,
        }).catch(() => ({ stdout: "" }));
        const conflicted = unmerged.stdout.trim().length > 0;
        return {
          sha: "",
          ok: false,
          reason: conflicted
            ? `Cannot publish: ${branch} conflicts with ${mainBranch}. Merge ${mainBranch} into it and resolve the conflicts first.`
            : `Could not merge ${branch} into ${mainBranch}: ${
                error instanceof Error ? error.message : String(error)
              }`,
        };
      }
    }

    const { stdout } = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    // Park the merge result in the repo so it survives the scratch dir, and so
    // the sandbox can be moved onto it to build exactly what would ship.
    //
    // FETCH the objects home first: the merge commit was born in this
    // scratch clone and the bare repo has never seen it. Writing the ref
    // directly failed with "nonexistent object" — but only for a TRUE merge,
    // which is why it survived so long: with main unmoved the merge
    // fast-forwards, the sha is a branch head the repo already has, and every
    // test and every manual publish happened to be that case.
    //
    // A fetch and not a push, because every repo's own config hides
    // refs/mako/* from transfer (initRepo) — receive-pack would refuse the
    // ref that this mechanism exists to write. Fetch runs no receive-pack and
    // no hooks; it just brings the objects, and the ref write stays the same
    // plain update it always was.
    await runGit(["-C", repoDir, "fetch", "-q", dir, "HEAD"], {
      timeoutMs: 60_000,
    });
    await updateRef(repoDir, PUBLISH_CANDIDATE_REF, sha);
    return { sha, ok: true };
  });
}

/**
 * Make the built candidate the new `main`.
 *
 * A compare-and-swap against the `main` the build started from, not a push
 * from a working copy: if someone else published while this build was running,
 * the artifact no longer corresponds to what `main` holds, and refusing is
 * correct. Doing it as a ref update also means the sandbox never needs
 * credentials for the repository — it built the tree, it does not publish it.
 */
export async function promoteToMain(
  handle: WorktreeHandle,
  input: { sha: string; expectedMain: string },
): Promise<void> {
  const mainBranch = handle.project?.defaultBranch || DEFAULT_BRANCH;
  const swapped = await updateRefCas(
    handle.repoDir,
    `refs/heads/${mainBranch}`,
    input.sha,
    input.expectedMain,
  );
  if (!swapped) {
    throw new Error(
      `${mainBranch} moved while the build was running; nothing was published. Try again.`,
    );
  }
}
