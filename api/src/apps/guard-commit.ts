/**
 * Commit a mutation onto a guard branch (default-branch-guard.ts) instead of
 * the default branch.
 *
 * The counterpart of `commitToMainDurably` for guarded callers: the same
 * mutation shape (`MainMutation`), judged against the default branch's head
 * (the definitions a row follows live there), but written onto
 * `mcp/<person>/<kind>`. The branch forks off the default branch when it does
 * not exist, and a mirror push carries it to GitHub in the background. A
 * branch is no durable main, so the push is not awaited.
 */
import { ZERO_OID } from "./git";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  resolveCommit,
  updateRefCas,
  type GitAuthor,
} from "./repository.service";
import { freshenBeforeMainWrite, queueMirrorPush } from "./cloud-repo.service";
import type { MainMutation } from "./cloud-repo/durable-main";
import { repoForWorkspace } from "./worktree.service";

export interface GuardCommit {
  changed: boolean;
  commitOid?: string;
}

export async function commitOnGuardBranch(
  workspaceId: string,
  branch: string,
  mutation: MainMutation,
  options: { message: string; author?: GitAuthor },
): Promise<GuardCommit> {
  if (branch === DEFAULT_BRANCH) {
    throw new Error("commitOnGuardBranch never writes to the default branch");
  }
  const repoDir = await repoForWorkspace(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const mainHead = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!mainHead) throw new Error(`${DEFAULT_BRANCH} has no commits`);
  const blobs =
    typeof mutation === "function"
      ? await mutation({ repoDir, head: mainHead })
      : mutation;
  if (!blobs) return { changed: false };

  const ref = `refs/heads/${branch}`;
  if (!(await resolveCommit(repoDir, ref))) {
    await updateRefCas(repoDir, ref, mainHead, ZERO_OID);
  }
  const result = await commitBlobsOnBranch(repoDir, branch, blobs, options);
  if (result.unchanged) return { changed: false };
  queueMirrorPush(workspaceId);
  return { changed: true, commitOid: result.commitOid };
}
