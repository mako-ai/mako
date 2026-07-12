/**
 * Apps v2 worktree service — durable per-actor working state (apps-v2.md §4.4).
 *
 * Invariants this module owns:
 *
 * 1. Git is the only durable store. Uncommitted work is a shadow commit on a
 *    private WIP ref (`refs/mako/worktrees/<worktreeId>`), advanced ONLY via
 *    compare-and-swap. The Mongo `AppWorktreeV2` doc mirrors the ref for
 *    indexing; on divergence the ref wins.
 * 2. Readers (file explorer, agent read tools, external clients) resolve
 *    through `listFiles`/`readFile`, which read the bare repo — never a
 *    session directory. A dead session changes nothing for readers.
 * 3. Session working trees are disposable caches. `ensureWorktree` can always
 *    rebuild one from `baseSha` + the WIP ref; a lost session loses at most
 *    the work since the last flush.
 * 4. The sandbox never holds git credentials: this module (the "broker") does
 *    all ref reads/writes itself, and the session clone's origin is pointed
 *    at an unreachable URL so in-sandbox `git push` cannot bypass CAS/ACLs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Types } from "mongoose";
import {
  AppProjectV2,
  AppWorktreeV2,
  type IAppProjectV2,
  type IAppWorktreeV2,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { appsV2SessionsRoot, APPS_V2_MAX_FILE_BYTES } from "./config";
import { assertSafeRelPath, runGit, ZERO_OID } from "./git";
import {
  CONFLICT_REF_PREFIX,
  DEFAULT_BRANCH,
  WIP_REF_PREFIX,
  commitTree,
  deleteRefCas,
  diffNameStatus,
  initRepo,
  listTree,
  log as repoLog,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
  snapshotDirToTree,
  treeOfCommit,
  updateRefCas,
  type ChangedFile,
  type GitAuthor,
  type TreeEntry,
} from "./repository.service";
import { createAppsV2Scaffold } from "./scaffold";
import {
  getSandboxProvider,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./sandbox/provider";

const logger = loggers.api("apps-v2");

/** Origin URL planted in session clones — deliberately unreachable so tenant
 * commands cannot push to the bare repo directly (the broker does refs). */
const BLOCKED_ORIGIN_URL = "https://apps-v2.mako.invalid/blocked.git";

// ---------------------------------------------------------------------------
// Per-worktree async mutex: flush/exec/commit on one worktree are serialized
// (same spirit as dbt's withProjectGitLock).
// ---------------------------------------------------------------------------
const locks = new Map<string, Promise<unknown>>();

async function withWorktreeLock<T>(
  worktreeId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(worktreeId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Keep the chain alive (swallowing rejections) so later callers queue up;
  // the map stays small: one entry per active worktree per process.
  locks.set(
    worktreeId,
    next.catch(() => undefined),
  );
  return next;
}

export class WorktreeConflictError extends Error {
  constructor(
    message: string,
    public readonly conflictRef?: string,
  ) {
    super(message);
    this.name = "WorktreeConflictError";
  }
}

export interface WorktreeHandle {
  doc: IAppWorktreeV2;
  project: IAppProjectV2;
  repoDir: string;
  sessionDir: string;
}

function wipRefFor(worktreeId: string): string {
  return `${WIP_REF_PREFIX}${worktreeId}`;
}

function sessionDirFor(worktreeId: string): string {
  return path.join(appsV2SessionsRoot(), worktreeId);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export async function createProject(input: {
  workspaceId: string;
  title: string;
  description?: string;
  userId?: string;
  author?: GitAuthor;
}): Promise<IAppProjectV2> {
  const project = await AppProjectV2.create({
    workspaceId: new Types.ObjectId(input.workspaceId),
    title: input.title.trim() || "Untitled app",
    description: input.description,
    access: "private",
    owner_id: input.userId,
    createdBy: input.userId ?? "system",
    defaultBranch: DEFAULT_BRANCH,
  });

  const repoDir = repoDirFor(input.workspaceId, project._id.toString());
  try {
    await initRepo(
      repoDir,
      createAppsV2Scaffold({
        title: project.title,
        description: input.description,
      }),
      { author: input.author },
    );
  } catch (error) {
    // Don't leave a repo-less project behind.
    await AppProjectV2.deleteOne({ _id: project._id });
    throw error;
  }
  logger.info("Apps v2 project created", {
    projectId: project._id.toString(),
    workspaceId: input.workspaceId,
  });
  return project;
}

export async function deleteProject(project: IAppProjectV2): Promise<void> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  const worktrees = await AppWorktreeV2.find({ projectId: project._id });
  const provider = getSandboxProvider();
  for (const wt of worktrees) {
    await provider.destroySession?.(wt._id.toString()).catch(() => undefined);
    await fs.rm(sessionDirFor(wt._id.toString()), {
      recursive: true,
      force: true,
    });
  }
  await AppWorktreeV2.deleteMany({ projectId: project._id });
  await AppProjectV2.deleteOne({ _id: project._id });
  await fs.rm(repoDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Worktree + session materialization
// ---------------------------------------------------------------------------

/** Branch a chat conversation's worktree lives on (Cursor-cloud model). */
export function chatBranchFor(chatId: string): string {
  return `chat/${chatId}`;
}

/** Actor id for a chat conversation (worktree `userId` holds actor ids). */
export function chatActorFor(chatId: string): string {
  return `chat:${chatId}`;
}

/**
 * Find-or-create the actor's worktree doc and make sure its session working
 * tree exists on disk, restoring base + WIP state when rebuilding.
 *
 * `actorId` is a user id for UI/API actors, or `chat:<chatId>` for agent
 * conversations — each chat works on its own `chat/<chatId>` branch, created
 * off the default branch head on first touch (pass `options.branch`).
 *
 * Resume semantics ("pull latest"): when the worktree is CLEAN and its branch
 * head moved (e.g. another actor merged), the worktree fast-forwards to the
 * new head before work continues. Dirty worktrees keep their base — the
 * commit path surfaces the divergence instead of silently rebasing.
 */
export async function ensureWorktree(
  project: IAppProjectV2,
  actorId: string,
  options: { branch?: string } = {},
): Promise<WorktreeHandle> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  if (!(await repoExists(repoDir))) {
    throw new Error("Project repository is missing");
  }

  const mainHead = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!mainHead) throw new Error("Project branch is missing");

  const branch = options.branch ?? DEFAULT_BRANCH;
  let branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!branchHead) {
    // First touch of an actor branch: fork it off the default branch head.
    // CAS-create; a concurrent creator winning is fine (re-resolve).
    await updateRefCas(repoDir, `refs/heads/${branch}`, mainHead, ZERO_OID);
    branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!branchHead) throw new Error(`Failed to create branch ${branch}`);
    logger.info("Apps v2 actor branch created", {
      projectId: project._id.toString(),
      branch,
    });
  }

  // Atomic find-or-create: the agent routinely fires tool calls in parallel
  // right after app creation, so a findOne+create pair races itself into
  // E11000 on the (projectId, userId) unique index.
  const doc = await AppWorktreeV2.findOneAndUpdate(
    { projectId: project._id, userId: actorId },
    {
      $setOnInsert: {
        workspaceId: project.workspaceId,
        branch,
        baseSha: branchHead,
        revision: 0,
        leaseEpoch: 1,
      },
    },
    { new: true, upsert: true },
  );

  const worktreeId = doc._id.toString();
  return withWorktreeLock(worktreeId, async () => {
    // Reconcile the doc's WIP projection with the authoritative ref.
    const refOid = await resolveCommit(repoDir, wipRefFor(worktreeId));
    if ((refOid ?? undefined) !== (doc.wipOid ?? undefined)) {
      doc.wipOid = refOid ?? undefined;
      await doc.save();
    }

    // Fast-forward a clean worktree whose branch moved underneath it
    // (resume-after-merge / another device committed).
    const currentHead = await resolveCommit(
      repoDir,
      `refs/heads/${doc.branch}`,
    );
    let needsRematerialize = false;
    if (currentHead && currentHead !== doc.baseSha && !doc.wipOid) {
      doc.baseSha = currentHead;
      doc.revision += 1;
      await doc.save();
      needsRematerialize = true;
      logger.info("Apps v2 worktree fast-forwarded", {
        worktreeId,
        branch: doc.branch,
        head: currentHead,
      });
    }

    const sessionDir = sessionDirFor(worktreeId);
    const materialized =
      !needsRematerialize &&
      (await dirExists(path.join(sessionDir, ".git"))) &&
      (await resolveCommit(sessionDir, "HEAD")) !== null;

    if (!materialized) {
      await materializeSession(repoDir, sessionDir, doc);
      doc.leaseEpoch += 1;
      await doc.save();
      logger.info("Apps v2 session materialized", {
        worktreeId,
        leaseEpoch: doc.leaseEpoch,
        restoredWip: Boolean(doc.wipOid),
      });
    }

    return { doc, project, repoDir, sessionDir };
  });
}

/** Build (or rebuild) the session working tree: clone at base, apply WIP. */
async function materializeSession(
  repoDir: string,
  sessionDir: string,
  doc: IAppWorktreeV2,
): Promise<void> {
  await fs.rm(sessionDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(sessionDir), { recursive: true });

  await runGit(["clone", "--branch", doc.branch, repoDir, sessionDir], {
    timeoutMs: 120_000,
  });
  // The session must not be able to reach the bare repo on its own.
  await runGit([
    "-C",
    sessionDir,
    "remote",
    "set-url",
    "origin",
    BLOCKED_ORIGIN_URL,
  ]);
  await runGit(["-C", sessionDir, "config", "user.name", "Mako Session"]);
  await runGit(["-C", sessionDir, "config", "user.email", "session@mako.ai"]);

  // Pin the working tree to the worktree's base (branch may have moved).
  await runGit(["-C", sessionDir, "reset", "--hard", doc.baseSha]);

  if (doc.wipOid) {
    // Fetch the WIP snapshot by oid (allowed via allowAnySHA1InWant even
    // though refs/mako/* are hidden), then restore it as UNCOMMITTED state:
    // read-tree resets index+worktree to the WIP tree while HEAD stays at
    // base, so `git status` shows exactly the in-progress diff.
    await runGit(["-C", sessionDir, "fetch", repoDir, doc.wipOid], {
      timeoutMs: 120_000,
    });
    await runGit(["-C", sessionDir, "read-tree", "--reset", "-u", doc.wipOid]);
  }
}

// ---------------------------------------------------------------------------
// Flush: session working tree -> WIP ref (the durability watermark)
// ---------------------------------------------------------------------------

export interface FlushResult {
  flushed: boolean;
  wipOid?: string;
  revision: number;
}

export async function flushWorktree(
  handle: WorktreeHandle,
): Promise<FlushResult> {
  const { doc, repoDir, sessionDir } = handle;
  const worktreeId = doc._id.toString();

  return withWorktreeLock(worktreeId, async () => {
    const treeOid = await snapshotDirToTree(repoDir, sessionDir);
    const baseTree = await treeOfCommit(repoDir, doc.baseSha);

    const expectedOld = doc.wipOid ?? ZERO_OID;

    if (treeOid === baseTree) {
      // Clean tree: drop any WIP ref and clear the projection.
      if (doc.wipOid) {
        await deleteRefCas(repoDir, wipRefFor(worktreeId), doc.wipOid);
        doc.wipOid = undefined;
        doc.revision += 1;
        doc.lastFlushAt = new Date();
        await doc.save();
        return { flushed: true, revision: doc.revision };
      }
      return { flushed: false, revision: doc.revision };
    }

    if (doc.wipOid) {
      const currentWipTree = await treeOfCommit(repoDir, doc.wipOid);
      if (currentWipTree === treeOid) {
        return { flushed: false, wipOid: doc.wipOid, revision: doc.revision };
      }
    }

    const snapshot = await commitTree(repoDir, {
      treeOid,
      parents: [doc.baseSha],
      message: `mako wip snapshot (worktree ${worktreeId}, epoch ${doc.leaseEpoch})`,
    });

    const swapped = await updateRefCas(
      repoDir,
      wipRefFor(worktreeId),
      snapshot,
      expectedOld,
    );
    if (!swapped) {
      // Someone advanced the ref under us (stale lease / concurrent writer).
      // Preserve this snapshot for recovery instead of overwriting.
      const conflictRef = `${CONFLICT_REF_PREFIX}${worktreeId}-${Date.now()}`;
      await updateRefCas(repoDir, conflictRef, snapshot, ZERO_OID);
      logger.warn("Apps v2 WIP flush conflict", { worktreeId, conflictRef });
      throw new WorktreeConflictError(
        "Worktree state advanced concurrently; snapshot preserved on a conflict ref. Re-open the app to continue from the latest state.",
        conflictRef,
      );
    }

    doc.wipOid = snapshot;
    doc.revision += 1;
    doc.lastFlushAt = new Date();
    await doc.save();
    return { flushed: true, wipOid: snapshot, revision: doc.revision };
  });
}

// ---------------------------------------------------------------------------
// Shell execution (sandbox provider) + implicit flush
// ---------------------------------------------------------------------------

export interface ExecOutcome extends SandboxExecResult {
  flush: FlushResult;
}

export async function execInWorktree(
  handle: WorktreeHandle,
  command: string,
  options: SandboxExecOptions = {},
): Promise<ExecOutcome> {
  const provider = getSandboxProvider();
  const result = await provider.exec(
    { hostDir: handle.sessionDir, sessionKey: handle.doc._id.toString() },
    command,
    options,
  );
  const flush = await flushWorktree(handle);
  return { ...result, flush };
}

// ---------------------------------------------------------------------------
// Reads — ALWAYS from the bare repo, never the session directory
// ---------------------------------------------------------------------------

/** Ref an actor's file reads resolve to: their WIP snapshot, else branch. */
async function readRefFor(
  project: IAppProjectV2,
  userId: string | undefined,
  repoDir: string,
): Promise<string> {
  if (userId) {
    const doc = await AppWorktreeV2.findOne({
      projectId: project._id,
      userId,
    });
    if (doc) {
      const refOid = await resolveCommit(
        repoDir,
        wipRefFor(doc._id.toString()),
      );
      if (refOid) return refOid;
      return doc.baseSha;
    }
  }
  return `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`;
}

export async function listFiles(
  project: IAppProjectV2,
  userId?: string,
): Promise<{ ref: string; entries: TreeEntry[] }> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  const ref = await readRefFor(project, userId, repoDir);
  return { ref, entries: await listTree(repoDir, ref) };
}

export async function readFile(
  project: IAppProjectV2,
  relPath: string,
  userId?: string,
): Promise<{
  path: string;
  contents: string;
  isBinary: boolean;
  size: number;
}> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  const safe = assertSafeRelPath(relPath);
  const ref = await readRefFor(project, userId, repoDir);
  const blob = await readBlob(repoDir, ref, safe);
  return { path: safe, ...blob };
}

// ---------------------------------------------------------------------------
// Writes through the worktree (explorer quick-edit / agent fast-path tools)
// ---------------------------------------------------------------------------

export async function writeFile(
  handle: WorktreeHandle,
  relPath: string,
  contents: string,
): Promise<FlushResult> {
  const safe = assertSafeRelPath(relPath);
  if (Buffer.byteLength(contents, "utf8") > APPS_V2_MAX_FILE_BYTES) {
    throw new Error("File exceeds the maximum size for a direct write");
  }
  const abs = path.join(handle.sessionDir, safe);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
  return flushWorktree(handle);
}

export async function deleteFile(
  handle: WorktreeHandle,
  relPath: string,
): Promise<FlushResult> {
  const safe = assertSafeRelPath(relPath);
  await fs.rm(path.join(handle.sessionDir, safe), { force: true });
  return flushWorktree(handle);
}

export async function readSessionFile(
  handle: WorktreeHandle,
  relPath: string,
): Promise<string> {
  const safe = assertSafeRelPath(relPath);
  return fs.readFile(path.join(handle.sessionDir, safe), "utf8");
}

// ---------------------------------------------------------------------------
// Status / history
// ---------------------------------------------------------------------------

export interface WorktreeStatus {
  branch: string;
  baseSha: string;
  wipOid?: string;
  revision: number;
  branchHead: string | null;
  behindBranch: boolean;
  changes: ChangedFile[];
}

export async function worktreeStatus(
  project: IAppProjectV2,
  userId: string,
): Promise<WorktreeStatus | null> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  const doc = await AppWorktreeV2.findOne({ projectId: project._id, userId });
  if (!doc) return null;
  const branchHead = await resolveCommit(repoDir, `refs/heads/${doc.branch}`);
  const changes = doc.wipOid
    ? await diffNameStatus(repoDir, doc.baseSha, doc.wipOid)
    : [];
  return {
    branch: doc.branch,
    baseSha: doc.baseSha,
    wipOid: doc.wipOid ?? undefined,
    revision: doc.revision,
    branchHead,
    behindBranch: branchHead !== null && branchHead !== doc.baseSha,
    changes,
  };
}

export async function projectHistory(project: IAppProjectV2, limit = 20) {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  return repoLog(
    repoDir,
    `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`,
    limit,
  );
}

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
 * Commit a worktree's WIP snapshot onto its branch WITHOUT touching the
 * session directory. Safe to call for worktrees whose sandbox/session is
 * gone (end-of-turn commits, cleanup jobs): the WIP ref already holds the
 * durable state, so no filesystem is needed.
 */
async function commitFromWip(
  doc: IAppWorktreeV2,
  repoDir: string,
  message: string,
  author?: GitAuthor,
): Promise<CommitResult> {
  const worktreeId = doc._id.toString();
  return withWorktreeLock(worktreeId, async () => {
    if (!doc.wipOid) {
      return { committed: false, reason: "No changes to commit" };
    }

    const branchRef = `refs/heads/${doc.branch}`;
    const head = await resolveCommit(repoDir, branchRef);
    if (!head) throw new Error("Branch head missing");
    if (head !== doc.baseSha) {
      throw new WorktreeConflictError(
        `Branch ${doc.branch} moved since this worktree was based (base ${doc.baseSha.slice(0, 8)}, head ${head.slice(0, 8)}). Discard or rebase before committing.`,
      );
    }

    const treeOid = await treeOfCommit(repoDir, doc.wipOid);
    const commitOid = await commitTree(repoDir, {
      treeOid,
      parents: [head],
      message,
      author,
    });

    const swapped = await updateRefCas(repoDir, branchRef, commitOid, head);
    if (!swapped) {
      throw new WorktreeConflictError(
        "Branch advanced concurrently during commit; retry.",
      );
    }

    await deleteRefCas(repoDir, wipRefFor(worktreeId), doc.wipOid);
    doc.baseSha = commitOid;
    doc.wipOid = undefined;
    doc.revision += 1;
    await doc.save();

    logger.info("Apps v2 worktree committed", { worktreeId, commitOid });
    return { committed: true, commitOid, message };
  });
}

export async function commitWorktree(
  handle: WorktreeHandle,
  message: string,
  author?: GitAuthor,
): Promise<CommitResult> {
  const { doc, repoDir, sessionDir } = handle;
  const worktreeId = doc._id.toString();

  await flushWorktree(handle);
  const result = await commitFromWip(doc, repoDir, message, author);
  if (!result.committed || !result.commitOid) return result;

  // Fast-forward the session clone so subsequent status is clean.
  try {
    await runGit(["-C", sessionDir, "fetch", repoDir, result.commitOid], {
      timeoutMs: 60_000,
    });
    await runGit(["-C", sessionDir, "reset", "--mixed", result.commitOid]);
  } catch (error) {
    // Non-fatal: the session will be re-materialized on next use.
    logger.warn("Apps v2 session fast-forward failed", {
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Chat turn commits (Cursor-cloud model: one branch per conversation, one
// commit per turn)
// ---------------------------------------------------------------------------

/**
 * Commit every dirty worktree owned by a chat conversation. Called from chat
 * finalization at the end of each agent turn — the app2_* tools flushed after
 * every mutation, so this only turns the accumulated WIP into a commit on the
 * conversation's `chat/<chatId>` branch. Never throws (finalization must not
 * fail a turn); conflicts are logged and left as WIP for the next turn.
 */
export async function commitChatTurn(
  workspaceId: string,
  chatId: string,
  turnSummary?: string,
): Promise<Array<{ projectId: string; commitOid?: string }>> {
  const results: Array<{ projectId: string; commitOid?: string }> = [];
  const actorId = chatActorFor(chatId);
  const worktrees = await AppWorktreeV2.find({
    workspaceId: new Types.ObjectId(workspaceId),
    userId: actorId,
    wipOid: { $exists: true, $ne: null },
  });
  if (worktrees.length === 0) return results;

  const message = turnSummary?.trim()
    ? `Agent turn: ${turnSummary.trim().slice(0, 120)}`
    : `Agent turn (${new Date().toISOString()})`;

  for (const doc of worktrees) {
    const projectId = doc.projectId.toString();
    try {
      const repoDir = repoDirFor(workspaceId, projectId);
      const result = await commitFromWip(doc, repoDir, message, {
        name: "Mako Agent",
        email: "agent@mako.ai",
      });
      results.push({ projectId, commitOid: result.commitOid });
      // Best-effort session fast-forward so the next turn starts clean.
      if (result.commitOid) {
        const sessionDir = sessionDirFor(doc._id.toString());
        try {
          await runGit(["-C", sessionDir, "fetch", repoDir, result.commitOid]);
          await runGit([
            "-C",
            sessionDir,
            "reset",
            "--mixed",
            result.commitOid,
          ]);
        } catch {
          await fs.rm(sessionDir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      logger.warn("Apps v2 chat turn commit failed", {
        chatId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ projectId });
    }
  }
  logger.info("Apps v2 chat turn committed", {
    chatId,
    projects: results.length,
  });
  return results;
}

// ---------------------------------------------------------------------------
// Branches (list + merge to main)
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  head: string;
  isDefault: boolean;
  /** Commits ahead of the default branch (0 for the default itself). */
  aheadOfMain: number;
  lastCommit?: { subject: string; author: string; timestamp: number };
}

export async function listBranches(
  project: IAppProjectV2,
): Promise<BranchInfo[]> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(authordate:unix)",
    "refs/heads/",
  ]);
  const defaultBranch = project.defaultBranch || DEFAULT_BRANCH;
  const branches: BranchInfo[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [name, head, subject, author, at] = line.split("\0");
    let aheadOfMain = 0;
    if (name !== defaultBranch) {
      try {
        const { stdout: count } = await runGit([
          "-C",
          repoDir,
          "rev-list",
          "--count",
          `refs/heads/${defaultBranch}..refs/heads/${name}`,
        ]);
        aheadOfMain = Number(count.trim()) || 0;
      } catch {
        aheadOfMain = 0;
      }
    }
    branches.push({
      name,
      head,
      isDefault: name === defaultBranch,
      aheadOfMain,
      lastCommit: subject
        ? { subject, author, timestamp: Number(at) * 1000 }
        : undefined,
    });
  }
  // Default branch first, then most recently committed.
  branches.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (b.lastCommit?.timestamp ?? 0) - (a.lastCommit?.timestamp ?? 0);
  });
  return branches;
}

export interface MergeResult {
  merged: boolean;
  commitOid?: string;
  fastForward?: boolean;
  reason?: string;
}

/**
 * Merge a branch into the default branch, broker-side. Fast-forwards when
 * possible; otherwise builds a real merge commit with `git merge-tree`
 * (content-level three-way merge, no working tree needed). Conflicts abort
 * with a structured error — v0 has no in-product conflict resolution.
 */
export async function mergeBranchToMain(
  project: IAppProjectV2,
  branch: string,
  author?: GitAuthor,
): Promise<MergeResult> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  const defaultBranch = project.defaultBranch || DEFAULT_BRANCH;
  if (branch === defaultBranch) {
    return {
      merged: false,
      reason: "Cannot merge the default branch into itself",
    };
  }
  const mainRef = `refs/heads/${defaultBranch}`;
  const branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
  const mainHead = await resolveCommit(repoDir, mainRef);
  if (!branchHead || !mainHead) {
    return { merged: false, reason: "Branch not found" };
  }
  if (branchHead === mainHead) {
    return { merged: false, reason: "Already up to date" };
  }

  // Fast-forward when main is an ancestor of the branch.
  try {
    await runGit([
      "-C",
      repoDir,
      "merge-base",
      "--is-ancestor",
      mainHead,
      branchHead,
    ]);
    const swapped = await updateRefCas(repoDir, mainRef, branchHead, mainHead);
    if (!swapped) {
      throw new WorktreeConflictError("Main advanced concurrently; retry.");
    }
    return { merged: true, commitOid: branchHead, fastForward: true };
  } catch (error) {
    if (error instanceof WorktreeConflictError) throw error;
    // Not an ancestor — fall through to a real merge.
  }

  const { stdout: mergeOut } = await runGit(
    ["-C", repoDir, "merge-tree", "--write-tree", mainHead, branchHead],
    // merge-tree exits 1 on conflicts; treat that as a structured failure.
  ).catch((e: unknown) => {
    throw new WorktreeConflictError(
      `Merge of ${branch} into ${defaultBranch} has conflicts — resolve them locally (clone the repo) or discard one side. ${e instanceof Error ? "" : ""}`.trim(),
    );
  });
  const mergedTree = mergeOut.trim().split("\n")[0];
  const commitOid = await commitTree(repoDir, {
    treeOid: mergedTree,
    parents: [mainHead, branchHead],
    message: `Merge ${branch} into ${defaultBranch}`,
    author,
  });
  const swapped = await updateRefCas(repoDir, mainRef, commitOid, mainHead);
  if (!swapped) {
    throw new WorktreeConflictError("Main advanced concurrently; retry.");
  }
  logger.info("Apps v2 branch merged", {
    projectId: project._id.toString(),
    branch,
    commitOid,
  });
  return { merged: true, commitOid, fastForward: false };
}

/** Throw away all uncommitted work and re-base the worktree on branch head. */
export async function discardWorktree(
  handle: WorktreeHandle,
): Promise<{ baseSha: string }> {
  const { doc, repoDir, sessionDir } = handle;
  const worktreeId = doc._id.toString();

  return withWorktreeLock(worktreeId, async () => {
    if (doc.wipOid) {
      await deleteRefCas(repoDir, wipRefFor(worktreeId), doc.wipOid);
    }
    const head = await resolveCommit(repoDir, `refs/heads/${doc.branch}`);
    if (!head) throw new Error("Branch head missing");
    doc.baseSha = head;
    doc.wipOid = undefined;
    doc.revision += 1;
    doc.leaseEpoch += 1;
    await doc.save();
    await fs.rm(sessionDir, { recursive: true, force: true });
    await materializeSession(repoDir, sessionDir, doc);
    return { baseSha: head };
  });
}
