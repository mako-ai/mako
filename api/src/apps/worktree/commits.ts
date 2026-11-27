/**
 * Commits from the working copy, per-file git actions, file versions for
 * diffs, and restoring an app to an earlier version.
 */
import { loggers } from "../../logging";
import { appsMetadataRepo } from "../../repositories/apps-metadata";
import {
  boxCommitAll,
  boxCommitPathToBranch,
  boxHasRepo,
  boxGitPaths,
  boxFileVersions,
  boxPorcelain,
  type BoxFileVersions,
  boxRestoreTreeFrom,
} from "../box";
import { patchBoxState } from "../box-state.service";
import { noteBoxActivity } from "../box-activity";
import { assertSafeRelPath, EMPTY_TREE } from "../git";
import {
  log as repoLog,
  diffNameStatus,
  readBlob,
  resolveCommit,
  type ChangedFile,
  type GitAuthor,
} from "../repository.service";

import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import { repoForWorkspace, WorktreeHandle, RepoScope } from "./repo";
import {
  boxCtx,
  sessionKeyFor,
  resolveActorIdentity,
  ensureBox,
} from "./box-session";
import { syncBranchFromBox } from "./worktrees";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Commit (WIP -> branch) and discard
// ---------------------------------------------------------------------------

export interface CommitResult {
  committed: boolean;
  commitOid?: string;
  message?: string;
  reason?: string;
}

/**
 * Per-file git actions (stage / unstage / discard), then push the box's
 * fresh status so every open panel updates at once — the agent would report
 * it within a tick anyway, but a click deserves an immediate answer.
 */
export async function gitPathsAction(
  handle: WorktreeHandle,
  action: "stage" | "unstage" | "discard",
  paths: string[],
): Promise<void> {
  const ctx = await ensureBox(handle);
  await boxGitPaths(ctx, action, paths);
  try {
    const { branch, changes } = await boxPorcelain(ctx);
    await patchBoxState({
      workspaceId: handle.doc.workspaceId.toString(),
      userId: handle.doc.userId,
      patch: { ...(branch ? { branch } : {}), changes },
      source: "api",
    });
  } catch (error) {
    logger.warn("Apps could not push status after a git action", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** HEAD / index / working-tree contents of one repo-relative path, for diffs. */
/**
 * What one commit changed INSIDE this app (paths app-relative), and its
 * parent — the unit the History panel's "View changes" works in. Read from
 * the bare repo: no sandbox, no working copy.
 */
export async function commitChanges(
  scope: RepoScope,
  sha: string,
  /** "repo": every file, repo-relative — the Source Control graph's view. */
  view: "app" | "repo" = "app",
): Promise<{ sha: string; parent: string | null; files: ChangedFile[] }> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  if (view === "repo" || scope.root == null) {
    return { sha: oid, parent, files: all };
  }
  const root = scope.root;
  const files = all
    .filter(f => f.path.startsWith(`${root}/`))
    .map(f => ({ ...f, path: f.path.slice(root.length + 1) }));
  return { sha: oid, parent, files };
}

/** One app file before and after a commit (null = absent on that side). */
export async function commitFileVersions(
  scope: RepoScope,
  sha: string,
  relPath: string,
): Promise<{ before: string | null; after: string | null; binary: boolean }> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const safe = assertSafeRelPath(relPath);
  const full = scope.root ? `${scope.root}/${safe}` : safe;
  const read = async (ref: string | null) => {
    if (!ref) return null;
    try {
      return await readBlob(repoDir, ref, full);
    } catch {
      return null;
    }
  };
  const [before, after] = await Promise.all([read(parent), read(oid)]);
  return {
    before: before?.isBinary ? null : (before?.contents ?? null),
    after: after?.isBinary ? null : (after?.contents ?? null),
    binary: Boolean(before?.isBinary || after?.isBinary),
  };
}

/**
 * "Restore this version": set the app's folder back to its content at `sha`
 * and commit that as a NEW commit on the actor's branch (then push, like
 * every commit). History is append-only — the versions in between stay in
 * the log, which is what makes this safe to offer from a list of commits.
 */
export async function restoreWorktreeTo(
  handle: WorktreeHandle,
  sha: string,
  author?: GitAuthor,
): Promise<CommitResult> {
  const repoDir = handle.repoDir;
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const [info] = await repoLog(repoDir, oid, 1);
  const ctx = await ensureBox(handle);
  await boxRestoreTreeFrom(ctx, oid, handle.appRoot);
  const subject = info?.subject ? ` "${info.subject}"` : "";
  return commitWorktree(
    handle,
    `Restore${subject} (${oid.slice(0, 7)})`,
    author,
  );
}

export async function fileVersions(
  handle: WorktreeHandle,
  relPath: string,
): Promise<BoxFileVersions> {
  // A read of the working copy: no configure, no pull, no hydration — the
  // box either has it or the diff cannot exist.
  const ctx = boxCtx(handle);
  if (!(await getSandboxProvider().hasSession(ctx))) {
    throw new Error(
      "The sandbox is not running; there is no working copy to diff.",
    );
  }
  return boxFileVersions(ctx, relPath);
}

/**
 * Commit the working copy and push it.
 *
 * `git commit && git push`, run in the sandbox, by the person or agent whose
 * box it is. The push is the durability guarantee — the job the WIP ref used
 * to do, done by the mechanism git already has for it.
 */
export async function commitWorktree(
  handle: WorktreeHandle,
  message: string,
  author?: GitAuthor,
  options: { stagedOnly?: boolean; paths?: string[] } = {},
): Promise<CommitResult> {
  const ctx = await ensureBox(handle);
  noteBoxActivity(ctx.sessionKey, "commit");
  const result = await boxCommitAll({
    ctx,
    message,
    author,
    stagedOnly: options.stagedOnly,
    paths: options.paths,
  });
  if (!result.committed) return result;
  await syncBranchFromBox(handle);
  // No mirror queue and no poke here: boxCommitAll PUSHED, the push went
  // through the git endpoint, and the endpoint reacts (notifyRepoPushed).
  logger.info("Apps worktree committed", {
    branch: handle.doc.branch,
    commitOid: result.commitOid,
  });
  return result;
}

/**
 * Commit one folder of the working copy onto `branch`, built on main, without
 * moving the checkout (boxCommitPathToBranch). For a workflow's preview
 * branch: the working copy is shared by the UI and every chat of this user,
 * so switching it would carry their work onto that branch.
 */
export async function commitPathToBranch(
  handle: WorktreeHandle,
  relPath: string,
  branch: string,
  { base, message }: { base: string; message: string },
): Promise<CommitResult> {
  const ctx = await ensureBox(handle);
  const result = await boxCommitPathToBranch({
    ctx,
    path: relPath,
    branch,
    base,
    message,
  });
  if (result.committed) {
    logger.info("Apps path committed to a branch", {
      branch,
      commitOid: result.commitOid,
    });
  }
  return result;
}

/**
 * Saving a file is a commit (apps.md §10 Block A).
 *
 * The squash-into-the-previous-save window that used to live here is gone. It
 * amended the branch head, which is fine while the branch exists only on the
 * server and is a force-push once the sandbox has the branch too — history
 * rewriting to save a line in a log. Consecutive saves now make consecutive
 * commits, which is what git does everywhere else.
 */
export async function autoCommitFileEdit(
  handle: WorktreeHandle,
  relPath: string,
  action: "edit" | "delete",
  author?: GitAuthor,
): Promise<CommitResult> {
  return commitWorktree(
    handle,
    `${action}: ${assertSafeRelPath(relPath)}`,
    author,
  );
}

/**
 * Commit whatever the agent left in the working copy at the end of a turn.
 *
 * One commit per turn is what makes a turn reviewable and revertable. Keyed by
 * ACTOR, not by chat: a conversation is not a line of work, so the agent
 * commits to the branch the person is on rather than one of its own.
 *
 * `touchedPaths` is what keeps concurrent chats out of each other's commits:
 * the sandbox is ONE working copy per (workspace, user), shared by every chat
 * that user runs, so an unscoped commit here swept whatever another chat had
 * in flight (apps.md §14.2 "commit only what it touched"). Callers pass the
 * repo-relative roots this turn's apps tools actually wrote to — empty means
 * the turn touched no app and there is nothing of OURS to commit, so we must
 * not commit at all. `undefined` keeps the old commit-everything behavior for
 * callers with no tracking (deliberate full sweeps).
 *
 * Never throws — finalization must not fail a turn. Nothing is lost by
 * failing: the work is in the working copy, exactly where it would be if a
 * person had written it and not committed yet.
 */
export async function commitAgentTurn(
  workspaceId: string,
  actorId: string,
  turnSummary?: string,
  touchedPaths?: string[],
): Promise<Array<{ commitOid?: string }>> {
  if (touchedPaths && touchedPaths.length === 0) return [];
  const doc = await appsMetadataRepo.findWorktree(workspaceId, actorId);
  if (!doc) return [];

  const ctx: SandboxExecContext = {
    sessionKey: sessionKeyFor(doc.workspaceId, doc.userId),
  };
  try {
    // No sandbox means no uncommitted work to commit.
    if (!(await getSandboxProvider().hasSession(ctx))) return [];
    if (!(await boxHasRepo(ctx))) return [];

    const message = turnSummary?.trim()
      ? `Agent turn: ${turnSummary.trim().slice(0, 120)}`
      : `Agent turn (${new Date().toISOString()})`;
    // Authored by the human the agent acted for — blame and the git endpoint's
    // authorship check must both see the accountable person, not a bot — but
    // COMMITTED by "Mako Agent", so `git log --format='%an / %cn'` still shows
    // the change came from an agent turn. Falling back to the box's configured
    // identity (also the human) if the lookup misses.
    const human = await resolveActorIdentity(actorId);
    const result = await boxCommitAll({
      ctx,
      message,
      author: human,
      committer: { name: "Mako Agent", email: "agent@mako.ai" },
      paths: touchedPaths,
    });
    if (!result.committed) return [];
    // Mirror queue and window poke happen in the git endpoint's push
    // reaction, which this commit's own push just triggered.
    logger.info("Apps agent turn committed", {
      actorId,
      commitOid: result.commitOid,
    });
    return [{ commitOid: result.commitOid }];
  } catch (error) {
    logger.warn("Apps agent turn commit failed", {
      actorId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [{}];
  }
}
