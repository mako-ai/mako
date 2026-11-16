/**
 * The client: a shell, a file system, and git — all of it in the sandbox,
 * with reads falling back to the last commit when the sandbox is down.
 */
import path from "node:path";
import { AppWorktree, type IAppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  boxGlob,
  boxGrep,
  boxHasRepo,
  boxListFiles,
  boxPull,
  boxPushIfAhead,
  boxReadFile,
  boxRoot,
  boxWriteFile,
  sh,
} from "../box";
import { APPS_EXEC_DEFAULT_TIMEOUT_MS, APPS_MAX_FILE_BYTES } from "../config";
import { noteBoxActivity } from "../box-activity";
import { assertSafeRelPath, runGit } from "../git";
import {
  DEFAULT_BRANCH,
  globTree,
  grepTree,
  listTree,
  readBlob,
  resolveCommit,
  type GrepMatch,
  type TreeEntry,
} from "../repository.service";
import { readIndexedAppsAt } from "../app-index.service";
import { APP_MANIFEST, parseAppManifest } from "../app-paths";

import { ensureCommitLocally } from "../cloud-repo.service";
import {
  getSandboxProvider,
  type SandboxExecContext,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "../sandbox/provider";
import {
  repoFor,
  appRootFor,
  appPath,
  scopedPath,
  WorktreeHandle,
} from "./repo";
import {
  boxCtx,
  lastPull,
  isMissingCwd,
  rehydrateBox,
  ensureBox,
} from "./box-session";
import { PUBLISH_ACTOR, syncBranchFromBox } from "./worktrees";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// The client: a shell, a file system, and git — all of it in the sandbox
// ---------------------------------------------------------------------------

export type ExecOutcome = SandboxExecResult;

/**
 * One push at a time per box, in this process. A shell push after a command
 * (execInWorktree) waits here, and the workspace shell (sandbox-tools.ts)
 * holds it from its command to the end of its main-settling step, so a
 * concurrent app_bash cannot push a commit that command left on main before
 * it is moved to a branch. Another API instance is not covered.
 */
const pushLocks = new Map<string, Promise<void>>();

/** How long a caller waits for the box push lock before giving up. */
export const BOX_PUSH_LOCK_WAIT_MS = 30_000;

/** The lock stayed held past the wait: the caller's work did not run. */
export class BoxPushLockTimeoutError extends Error {
  constructor(waitMs: number) {
    super(
      `The sandbox is busy with another command (waited ${Math.round(waitMs / 1000)} s).`,
    );
    this.name = "BoxPushLockTimeoutError";
  }
}

export async function withBoxPushLock<T>(
  sessionKey: string,
  fn: () => Promise<T>,
  { waitMs = BOX_PUSH_LOCK_WAIT_MS }: { waitMs?: number } = {},
): Promise<T> {
  const previous = pushLocks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => (release = resolve));
  const tail = previous.then(() => mine);
  pushLocks.set(sessionKey, tail);
  // The entry goes only when the whole queue up to and including this slot
  // has finished: `tail` settles after every earlier holder AND this slot
  // released. Deleting it at release time instead would let a waiter that
  // timed out, while the holder still runs, clear the lock for the next
  // caller.
  void tail.then(() => {
    if (pushLocks.get(sessionKey) === tail) pushLocks.delete(sessionKey);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    previous.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    // Only our own slot is released: whoever queued behind it still waits
    // for the holder (through `tail`), never for a caller that gave up.
    release();
    throw new BoxPushLockTimeoutError(waitMs);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function execInWorktree(
  handle: WorktreeHandle,
  command: string,
  {
    pushIfAhead = true,
    ...options
  }: SandboxExecOptions & {
    /**
     * Push commits the command left on the checkout's branch (default). The
     * workspace shell (sandbox-tools.ts) turns it off: it decides itself
     * where a commit made on main goes, which is never main.
     */
    pushIfAhead?: boolean;
  } = {},
): Promise<ExecOutcome> {
  // §10: the session is the whole workspace repo; commands are app-scoped by
  // default (caller cwd is app-relative). posix.join keeps it session-rooted.
  const cwd = path.posix.join(handle.appRoot, options.cwd ?? "");
  const ctx = await ensureBox(handle);
  // An agent command, a build, a workflow run: real use. Held for the
  // command's own deadline so a long build is never paused under itself.
  noteBoxActivity(ctx.sessionKey, "agent-exec", {
    holdMs: options.timeoutMs ?? APPS_EXEC_DEFAULT_TIMEOUT_MS,
  });
  let result: ExecOutcome;
  try {
    result = await getSandboxProvider().exec(ctx, command, {
      ...options,
      cwd,
    });
  } catch (error) {
    if (!isMissingCwd(error)) throw error;
    // The box under this exec is not the box ensureBox inspected — a
    // recycle or expiry swapped machines between calls, and the fresh one
    // has no clone yet. Hydrate THIS box and retry once; convention
    // (rebuild from the repo) beats tracing which cache went stale.
    await rehydrateBox(handle, ctx);
    result = await getSandboxProvider().exec(ctx, command, {
      ...options,
      cwd,
    });
  }
  // Idle is measured from when the command ENDED, not when it started.
  noteBoxActivity(ctx.sessionKey, "agent-exec");
  // A command can `git checkout`, and it can commit. Nothing needs
  // snapshotting — but the cached branch should follow, and a commit made in
  // the shell should not be left sitting only on a disposable machine.
  //
  // EXCEPT in the publish actor's box. That box sits on `main` holding the
  // trial-merge candidate — a commit that must reach main only through
  // promote's compare-and-swap, after the build has passed. Auto-pushing it
  // here shipped the candidate on the FIRST build command (npm install),
  // before anything had been built at all, and then promote failed its CAS
  // against the very merge it was promoting. A build machine reports its
  // result; it does not publish it.
  await syncBranchFromBox(handle);
  if (pushIfAhead && handle.doc.userId !== PUBLISH_ACTOR) {
    // A push that cannot get the lock in time is skipped, not waited on for
    // minutes: the commits stay in the box, and the next command pushes them.
    await withBoxPushLock(ctx.sessionKey, () => boxPushIfAhead(ctx)).catch(
      error =>
        logger.warn(
          error instanceof BoxPushLockTimeoutError
            ? "Apps skipped the push after a command: the box push lock is held"
            : "Apps could not push commits made in the shell",
          { error: error instanceof Error ? error.message : String(error) },
        ),
    );
  }
  return result;
}

/**
 * Write a file to the sandbox's scratch area — outside the working copy, so
 * it can never be committed — and return its absolute path in the sandbox.
 * Used to keep the full output of a command whose tool result was truncated,
 * where `grep`/`tail` in app_bash can reach it. Scratch lives as long as the
 * sandbox: a recycled box loses it.
 *
 * `keepNewest` bounds the file's directory to that many files (newest kept):
 * the box disk is small, and these files are regenerable by re-running the
 * command, so they must never be what fills it.
 */
export async function writeWorktreeScratchFile(
  handle: WorktreeHandle,
  relPath: string,
  contents: string,
  options: { keepNewest?: number } = {},
): Promise<string> {
  const ctx = await ensureBox(handle);
  const provider = getSandboxProvider();
  const remotePath = path.posix.join(
    provider.scratch(ctx),
    assertSafeRelPath(relPath),
  );
  // TextEncoder, not Buffer.from: a Buffer can be a view into Node's shared
  // pool, and the E2B provider uploads `bytes.buffer` — the whole pool.
  await provider.writeFile(ctx, remotePath, new TextEncoder().encode(contents));
  if (options.keepNewest && options.keepNewest > 0) {
    const dir = sh(path.posix.dirname(remotePath));
    await provider
      .exec(
        ctx,
        // cd first and delete bare names: nothing outside the directory can
        // match, and a failed cd stops the pipeline before any rm runs.
        // (A read loop, not xargs -d: that flag is GNU-only.)
        `cd ${dir} && ls -1t | tail -n +${options.keepNewest + 1} | ` +
          'while IFS= read -r f; do rm -f -- "$f"; done',
        { timeoutMs: 15_000 },
      )
      .catch(error =>
        logger.warn("Could not prune sandbox scratch files", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  return remotePath;
}

/**
 * Where a read comes from.
 *
 * If the sandbox is up, the working copy — that is what the person is
 * looking at, including everything they have not committed. If it is not, the
 * last commit on their branch, because that is the last thing anyone can
 * still see. Asking is deliberately a question that does not start a sandbox;
 * browsing a repository should not boot a microVM.
 */
async function readSource(
  project: IAppProject,
  userId: string | undefined,
  at?: string,
): Promise<
  | { kind: "box"; ctx: SandboxExecContext; handle: WorktreeHandle }
  | { kind: "repo"; repoDir: string; ref: string; appRoot?: string }
> {
  const repoDir = await repoFor(project);
  // A pinned commit reads exactly that commit — no box, no actor branch.
  // Published serving needs this: the deployed build was made from
  // `publishedSha`, and its data bindings must be the ones AT that commit,
  // not whatever main says today. Resolving them from main meant an edit to
  // a binding on main changed its content-addressed artifact key under the
  // live app, whose tables then 404'd until someone republished.
  //
  // The commit has to be HERE, though: only the instance that handled the
  // push has it, so on a multi-instance host a published app read binding
  // files at a sha its own cache had never seen (`fatal: not a tree object`,
  // a 500 per data request, roughly half of them). Fetch it on a miss.
  if (at) {
    await ensureCommitLocally(
      project.workspaceId.toString(),
      at,
      project.defaultBranch || DEFAULT_BRANCH,
    );
    // Most reads still use the same folder: avoid scanning the workspace
    // for every binding request. Resolve history only after a move.
    const manifest = await readBlob(
      repoDir,
      at,
      `${appRootFor(project)}/${APP_MANIFEST}`,
    ).catch(() => null);
    const declaredId = manifest
      ? parseAppManifest(manifest.contents, project.slug ?? "").id
      : undefined;
    if (manifest && (!declaredId || declaredId === project._id.toString())) {
      return { kind: "repo", repoDir, ref: at };
    }
    const apps = await readIndexedAppsAt(
      project.workspaceId.toString(),
      repoDir,
      at,
    );
    const historical = apps.find(a => a.appId === project._id.toString());
    return {
      kind: "repo",
      repoDir,
      ref: at,
      appRoot: historical?.path ?? appRootFor(project),
    };
  }
  const branchRef = `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`;
  if (!userId) return { kind: "repo", repoDir, ref: branchRef };

  const doc = await AppWorktree.findOne({
    workspaceId: project.workspaceId,
    userId,
  });
  if (!doc) return { kind: "repo", repoDir, ref: branchRef };

  const handle: WorktreeHandle = {
    doc,
    project,
    repoDir,
    appRoot: appRootFor(project),
  };
  const ctx = boxCtx(handle);
  const live = await getSandboxProvider()
    .hasSession(ctx)
    .catch(() => false);
  if (live && (await boxHasRepo(ctx).catch(() => false))) {
    await syncBranchFromBox(handle);
    // The box's checkout may predate a move of this app (or its creation
    // by another actor): its folder is not where the row now says. Pull
    // main once; if the folder is still missing, read the repo at main
    // rather than show an app with no files.
    if (!(await boxPathExists(ctx, handle.appRoot))) {
      await boxPull(ctx).catch(() => undefined);
      lastPull.set(ctx.sessionKey, Date.now());
      if (!(await boxPathExists(ctx, handle.appRoot))) {
        return { kind: "repo", repoDir, ref: branchRef };
      }
    }
    return { kind: "box", ctx, handle };
  }

  const actorRef = (await resolveCommit(repoDir, `refs/heads/${doc.branch}`))
    ? `refs/heads/${doc.branch}`
    : branchRef;
  // An actor branch that predates the app would make a listed app look empty,
  // which reads as data loss rather than as "your branch is behind".
  if (await pathExistsAtRef(repoDir, actorRef, appRootFor(project))) {
    return { kind: "repo", repoDir, ref: actorRef };
  }
  return { kind: "repo", repoDir, ref: branchRef };
}

/** Whether `relPath` exists in the box's working copy. */
async function boxPathExists(
  ctx: SandboxExecContext,
  relPath: string,
): Promise<boolean> {
  const result = await getSandboxProvider()
    .exec(
      ctx,
      `test -e ${sh(`${boxRoot(ctx)}/${relPath}`)} && echo yes || echo no`,
      {
        timeoutMs: 15_000,
      },
    )
    .catch(() => null);
  return result?.stdout.trim() === "yes";
}

/** Whether `path` exists at `ref` (a file or a directory). */
async function pathExistsAtRef(
  repoDir: string,
  ref: string,
  path: string,
): Promise<boolean> {
  try {
    await runGit(["-C", repoDir, "cat-file", "-e", `${ref}:${path}`], {
      timeoutMs: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Entries the listing returns before saying "and N more". Not a page — the
 * tree is not paginated — but the honest ceiling past which a UI stops being
 * a tree and becomes a memory leak. A 100k-file folder (a committed
 * node_modules, a data dump) lists its first files and reports the total,
 * instead of shipping a multi-megabyte response to a client that dies
 * building nodes for it.
 */
const LIST_ENTRY_LIMIT = 5000;

export interface FileListing {
  ref: string;
  entries: TreeEntry[];
  /** True when the tree holds more files than `entries` carries. */
  truncated: boolean;
  /** Total file count when known (always known unless counting failed). */
  total?: number;
}

export async function listFiles(
  project: IAppProject,
  userId?: string,
): Promise<FileListing> {
  const source = await readSource(project, userId);
  const root = appRootFor(project);
  if (source.kind === "box") {
    const listing = await boxListFiles(source.ctx, root, LIST_ENTRY_LIMIT);
    return {
      ref: source.handle.doc.branch,
      entries: listing.entries.map(e => ({
        ...e,
        path: e.path.slice(root.length + 1),
      })),
      truncated: listing.truncated,
      total: listing.total,
    };
  }
  const prefix = `${root}/`;
  const all = (await listTree(source.repoDir, source.ref))
    .filter(e => e.path.startsWith(prefix))
    .map(e => ({ ...e, path: e.path.slice(prefix.length) }));
  const truncated = all.length > LIST_ENTRY_LIMIT;
  return {
    ref: source.ref,
    entries: truncated ? all.slice(0, LIST_ENTRY_LIMIT) : all,
    truncated,
    total: all.length,
  };
}

export async function readFile(
  project: IAppProject,
  relPath: string,
  userId?: string,
  /** Read at this commit instead of the actor's view (see readSource). */
  at?: string,
): Promise<{
  path: string;
  contents: string;
  isBinary: boolean;
  size: number;
}> {
  const safe = assertSafeRelPath(relPath);
  const source = await readSource(project, userId, at);
  if (source.kind === "box") {
    const blob = await boxReadFile(source.ctx, appPath(project, safe));
    return { path: safe, ...blob };
  }
  const blob = await readBlob(
    source.repoDir,
    source.ref,
    `${source.appRoot ?? appRootFor(project)}/${safe}`,
  );
  return { path: safe, ...blob };
}

/** Search file contents at whatever the actor is actually looking at. */
export async function grepFiles(
  project: IAppProject,
  pattern: string,
  userId: string | undefined,
  options?: { ignoreCase?: boolean; pathspec?: string; maxMatches?: number },
): Promise<GrepMatch[]> {
  const source = await readSource(project, userId);
  const root = appRootFor(project);
  const pathspec = options?.pathspec ? `${root}/${options.pathspec}` : root;
  const matches =
    source.kind === "box"
      ? await boxGrep(source.ctx, pattern, { ...options, pathspec })
      : await grepTree(source.repoDir, source.ref, pattern, {
          ...options,
          pathspec,
        });
  return matches.map(m =>
    m.path.startsWith(`${root}/`)
      ? { ...m, path: m.path.slice(root.length + 1) }
      : m,
  );
}

/** List paths matching a glob at whatever the actor is actually looking at. */
export async function globFiles(
  project: IAppProject,
  glob: string,
  userId?: string,
  limit?: number,
  /** Read at this commit instead of the actor's view (see readSource). */
  at?: string,
): Promise<string[]> {
  const source = await readSource(project, userId, at);
  const root =
    source.kind === "repo"
      ? (source.appRoot ?? appRootFor(project))
      : appRootFor(project);
  const matched =
    source.kind === "box"
      ? await boxGlob(source.ctx, `${root}/${glob}`, limit)
      : await globTree(source.repoDir, source.ref, `${root}/${glob}`, limit);
  return matched
    .filter(p => p.startsWith(`${root}/`))
    .map(p => p.slice(root.length + 1));
}

/**
 * Write a file into the working copy.
 *
 * Just a write. It used to be a write plus a snapshot plus a verification that
 * the snapshot contained it — because a write to an ignored path was accepted,
 * reported as successful, and silently discarded. The check survives, because
 * that failure mode does not go away: `git add -A` still skips ignored paths,
 * so a file written to node_modules/ or dist/ would still vanish at commit
 * time, and an agent told the write worked would build on a file that is not
 * there.
 */
export async function writeFile(
  handle: WorktreeHandle,
  relPath: string,
  contents: string,
): Promise<void> {
  const safe = scopedPath(handle, relPath);
  if (Buffer.byteLength(contents, "utf8") > APPS_MAX_FILE_BYTES) {
    throw new Error("File exceeds the maximum size for a direct write");
  }
  const ctx = await ensureBox(handle);
  // Asked BEFORE the write: an ignored path (.env, node_modules/) refused
  // after writing would already hold the bytes on disk.
  const ignored = await getSandboxProvider().exec(
    ctx,
    `git -C ${sh(boxRoot(ctx))} check-ignore -q ${sh(safe)}`,
    { timeoutMs: 30_000 },
  );
  if (ignored.exitCode === 0) {
    throw new Error(
      `${relPath} is ignored by git (.gitignore or the sandbox's excludes), so it cannot be saved. Build output and installed dependencies live only in the sandbox by design — write somewhere tracked instead.`,
    );
  }
  await boxWriteFile(ctx, safe, contents);
  noteBoxActivity(ctx.sessionKey, "edit");
}

/** Read a file straight from the working copy (agents editing in place). */
export async function readSessionFile(
  handle: WorktreeHandle,
  relPath: string,
): Promise<string> {
  const ctx = await ensureBox(handle);
  const blob = await boxReadFile(ctx, scopedPath(handle, relPath));
  return blob.contents;
}
