/**
 * Worktree status and history, and catching a running box up with main.
 */
import { Types } from "mongoose";
import { AppWorktree, type IAppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  boxHasRepo,
  boxHasValidCheckout,
  boxHead,
  boxPull,
  boxPushIfAhead,
  boxStatus,
} from "../box";
import { getBoxState, hasGitState } from "../box-state.service";
import { runGit } from "../git";
import {
  DEFAULT_BRANCH,
  log as repoLog,
  resolveCommit,
  type ChangedFile,
} from "../repository.service";

import {
  boxIsRunning,
  boxRunState,
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import { repoFor, repoForWorkspace, WorktreeHandle, RepoScope } from "./repo";
import { boxCtx, sessionKeyFor, lastPull } from "./box-session";
import { ensureWorktree, syncBranchFromBox } from "./worktrees";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Status / history
// ---------------------------------------------------------------------------

/**
 * Bring an actor's RUNNING sandbox level with the server, now.
 *
 * For the moment right after a server-side commit (app creation is one: the
 * scaffold lands on main with no sandbox involved). Reads are served from the
 * working copy whenever a sandbox is running, so a running-but-behind box
 * makes a just-created app read as empty — which is exactly how the agent saw
 * `files: []` from create_app and rebuilt the scaffold by hand on top of it.
 *
 * Never boots a sandbox: a sleeping box hydrates fresh on next use and needs
 * nothing from us.
 */
export async function catchUpLiveBox(
  project: IAppProject,
  actorId: string,
): Promise<void> {
  try {
    // ensureWorktree first: it is what merges main into the actor's branch
    // server-side, so the pull below has the new commit to bring over.
    const handle = await ensureWorktree(project, actorId);
    const ctx = boxCtx(handle);
    if (!(await getSandboxProvider().hasSession(ctx))) return;
    if (!(await boxHasRepo(ctx))) return;
    await boxPull(ctx);
    lastPull.set(ctx.sessionKey, Date.now());
  } catch (error) {
    logger.warn("Apps live-box catch-up failed", {
      actorId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Settle up after a terminal session ends.
 *
 * The terminal is a live PTY, so unlike execInWorktree nothing runs "after the
 * command" — a `git commit` typed there would otherwise sit on a disposable
 * machine until some unrelated API call happened to touch the box, and a
 * `git checkout` typed there would leave the cached branch pointing at the
 * old one. Called when the last client detaches (terminal-ws.ts).
 *
 * Best-effort by design: the work is committed in a real repository either
 * way, and failing a disconnect over bookkeeping helps nobody.
 */
export async function afterTerminalSession(
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    const doc = await AppWorktree.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      userId,
    });
    if (!doc) return;
    const ctx: SandboxExecContext = {
      sessionKey: sessionKeyFor(doc.workspaceId, doc.userId),
    };
    // A pty that died because the box paused must not resume it to settle.
    // Commits typed before the pause are pushed on the next real use, or by
    // the paused-box reaper before it deletes the box.
    if (!(await boxIsRunning(ctx))) return;
    if (!(await boxHasRepo(ctx))) return;

    const { branch } = await boxHead(ctx);
    if (branch && branch !== "HEAD" && branch !== doc.branch) {
      logger.info("Apps following a branch switch made in the terminal", {
        from: doc.branch,
        to: branch,
      });
      doc.branch = branch;
      await doc.save();
    }
    // Commits typed in the shell but never pushed: push them. The push runs
    // through the git endpoint, whose reaction handles mirror + refresh.
    await boxPushIfAhead(ctx);
  } catch (error) {
    logger.warn("Apps terminal settle-up failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface WorktreeStatus {
  branch: string;
  /** Commit the working copy is on. */
  baseSha: string;
  branchHead: string | null;
  /** Commits this branch has that the server does not. */
  ahead: number;
  /** Uncommitted changes inside THIS app's folder. */
  changes: ChangedFile[];
  /**
   * Uncommitted changes anywhere in the repo.
   *
   * One working copy serves the whole monorepo, so what a branch switch has to
   * get past — and what Discard throws away — is the repo-wide set, not this
   * app's slice. Reporting only the slice once made an app look clean while a
   * lock file another app's build had written kept `git checkout` refusing,
   * with nothing on screen naming it.
   */
  repoChanges: ChangedFile[];
  /** True while the sandbox is asleep: this is the last committed state. */
  offline: boolean;
}

/**
 * What `git status` says.
 *
 * With no sandbox running there is nothing to have uncommitted work IN, so the
 * answer is the branch head and an empty change set, flagged as such rather
 * than presented as a clean tree.
 */
export async function worktreeStatus(
  scope: RepoScope,
  userId: string,
): Promise<WorktreeStatus | null> {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  const doc = await AppWorktree.findOne({
    workspaceId: new Types.ObjectId(scope.workspaceId),
    userId,
  });
  if (!doc) return null;

  const handle: WorktreeHandle = {
    doc,
    repoDir,
    appRoot: scope.root ?? "",
  };
  const ctx = boxCtx(handle);
  const prefix = scope.root ? `${scope.root}/` : null;
  const narrow = (changes: WorktreeStatus["repoChanges"]) =>
    prefix
      ? changes
          .filter(ch => ch.path.startsWith(prefix))
          .map(ch => ({ ...ch, path: ch.path.slice(prefix.length) }))
      : changes;

  // Snapshot first: what the box's own agent pushed moments ago answers this
  // without three execs into the machine (~2s). The snapshot expires unless
  // the agent keeps refreshing it, so a hit is by construction recent; a
  // miss (agent not up yet, API just restarted in memory mode, box gone)
  // falls through to discovery exactly as before.
  const snapshot = await getBoxState(ctx.sessionKey);
  if (hasGitState(snapshot)) {
    if (
      snapshot.branch !== "HEAD" &&
      snapshot.branch !== doc.branch &&
      !snapshot.branch.startsWith("No ")
    ) {
      logger.info("Apps following a branch switch reported by the box", {
        from: doc.branch,
        to: snapshot.branch,
      });
      doc.branch = snapshot.branch;
      await doc.save();
    }
    const branchHead = await resolveCommit(
      repoDir,
      `refs/heads/${snapshot.branch}`,
    );
    return {
      branch: snapshot.branch,
      baseSha: snapshot.head ?? branchHead ?? "",
      branchHead,
      ahead: snapshot.ahead ?? 0,
      changes: narrow(snapshot.changes),
      repoChanges: snapshot.changes,
      offline: false,
    };
  }

  // Running, not present: the sidebar polls this every 30 s, and reading a
  // paused box resumes it. A sleeping box reads as offline (last commit).
  // Tri-state: a failed lookup is not "asleep". It answers the old way
  // (present = live) rather than blank the sidebar's changes for one poll.
  const state = await boxRunState(ctx, { fresh: true }).catch(
    () => "unknown" as const,
  );
  const running =
    state === "unknown"
      ? await getSandboxProvider()
          .hasSession(ctx)
          .catch(() => false)
      : state === "running";
  const live = running && (await boxHasValidCheckout(ctx).catch(() => false));

  if (!live) {
    const branchHead = await resolveCommit(repoDir, `refs/heads/${doc.branch}`);
    return {
      branch: doc.branch,
      baseSha: branchHead ?? "",
      branchHead,
      ahead: 0,
      changes: [],
      repoChanges: [],
      offline: true,
    };
  }

  await syncBranchFromBox(handle);
  const status = await boxStatus(ctx);
  const branchHead = await resolveCommit(
    repoDir,
    `refs/heads/${status.branch}`,
  );
  return {
    branch: status.branch,
    baseSha: status.head,
    branchHead,
    ahead: status.ahead,
    changes: narrow(status.changes),
    repoChanges: status.changes,
    offline: false,
  };
}

/**
 * Commit sha at the tip of the project's default branch — what a publish
 * deploys, and the identity an immutable deployment is keyed by (§13.3).
 */
export async function defaultBranchSha(project: IAppProject): Promise<string> {
  const repoDir = await repoFor(project);
  const branch = project.defaultBranch || DEFAULT_BRANCH;
  const { stdout } = await runGit(["rev-parse", `refs/heads/${branch}`], {
    cwd: repoDir,
  });
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `Could not resolve ${branch} to a commit (got ${JSON.stringify(sha)})`,
    );
  }
  return sha;
}

export async function projectHistory(
  scope: RepoScope,
  limit = 20,
  ref?: string,
  view: "app" | "repo" = "app",
) {
  const repoDir = await repoForWorkspace(scope.workspaceId);
  // History follows the branch the caller is actually on (VS Code semantics),
  // falling back to the default branch when the ref is absent or bogus. The
  // shape check keeps user input out of argv option position; show-ref
  // verifies existence without ever resolving arbitrary expressions.
  let target = `refs/heads/${scope.defaultBranch}`;
  if (ref && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..")) {
    const exists = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`],
      { cwd: repoDir },
    ).then(
      () => true,
      () => false,
    );
    if (exists) target = `refs/heads/${ref}`;
  }
  return repoLog(
    repoDir,
    target,
    limit,
    view === "repo" ? undefined : (scope.root ?? undefined),
  );
}
