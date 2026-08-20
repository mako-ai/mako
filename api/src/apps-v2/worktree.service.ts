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
import { publishRealtimeEvent } from "../services/realtime.service";
import { appsV2SessionsRoot, APPS_V2_MAX_FILE_BYTES } from "./config";
import { assertSafeRelPath, runGit, ZERO_OID } from "./git";
import {
  CONFLICT_REF_PREFIX,
  DEFAULT_BRANCH,
  WIP_REF_PREFIX,
  commitMeta,
  commitTree,
  deleteRefCas,
  diffNameStatus,
  globTree,
  grepTree,
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
  type GrepMatch,
  type TreeEntry,
} from "./repository.service";
import { createAppsV2Scaffold } from "./scaffold";
import {
  ensureCloudRepo,
  ensureLocalRepo,
  mirrorPushNow,
  queueMirrorPush,
} from "./cloud-repo.service";

/**
 * Local repo dir for a project, restoring it from the cloud mirror first
 * when the cache is cold (serverless hosts start with an empty
 * APPS_V2_GIT_ROOT — see ensureLocalRepo).
 */
async function repoFor(project: IAppProjectV2): Promise<string> {
  return repoForWorkspace(project.workspaceId.toString());
}

/** §10 monorepo: the ONE bare repo per workspace (clone-on-miss). */
async function repoForWorkspace(workspaceId: string): Promise<string> {
  await ensureLocalRepo(workspaceId);
  return repoDirFor(workspaceId);
}

/** Repo-relative folder an app's content lives under (§10: apps/<slug>). */
export function appRootFor(project: IAppProjectV2): string {
  return `apps/${project.slug ?? project._id.toString()}`;
}

/** Prefix an app-relative path into its repo-relative form. */
function appPath(project: IAppProjectV2, relPath: string): string {
  return `${appRootFor(project)}/${assertSafeRelPath(relPath)}`;
}
import {
  getSandboxProvider,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "./sandbox/provider";

const logger = loggers.api("apps-v2");

/** Poke open windows to refetch this app's git-backed state. */
function pokeAppV2(
  workspaceId: { toString(): string },
  appId: { toString(): string } | null | undefined,
  origin: "flush" | "commit" | "merge" | "discard" | "lifecycle",
  updatedBy?: string,
): void {
  publishRealtimeEvent(workspaceId.toString(), {
    type: "app-v2.updated",
    // "" = workspace-wide (a workspace worktree changed; may span apps).
    appId: appId?.toString() ?? "",
    updatedBy,
    origin,
  });
}

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
  /** Repo-relative root of the app this handle was opened for. */
  appRoot: string;
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

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "app";
}

async function uniqueSlug(workspaceId: string, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (
      await AppProjectV2.find({
        workspaceId: new Types.ObjectId(workspaceId),
        slug: { $exists: true },
      })
        .select("slug")
        .lean()
    ).map(d => d.slug as string),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Commit a mutation (writes and/or prefix deletions) directly onto a branch
 * of the bare repo via a throwaway clone. Used for app lifecycle commits
 * (scaffold, delete) — actor worktrees are not involved.
 */
async function commitFilesOnBranch(
  repoDir: string,
  branch: string,
  mutation: { writes?: Record<string, string>; deletePrefixes?: string[] },
  options: { message: string; author?: GitAuthor },
): Promise<{ commitOid: string; previousHead: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!head) throw new Error(`Branch ${branch} is missing`);
    await fs.mkdir(appsV2SessionsRoot(), { recursive: true });
    const tmp = await fs.mkdtemp(path.join(appsV2SessionsRoot(), "lifecycle-"));
    try {
      await runGit(["clone", "--branch", branch, repoDir, tmp], {
        timeoutMs: 120_000,
      });
      for (const prefix of mutation.deletePrefixes ?? []) {
        await fs.rm(path.join(tmp, assertSafeRelPath(prefix)), {
          recursive: true,
          force: true,
        });
      }
      for (const [rel, contents] of Object.entries(mutation.writes ?? {})) {
        const abs = path.join(tmp, assertSafeRelPath(rel));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, contents, "utf8");
      }
      const treeOid = await snapshotDirToTree(repoDir, tmp);
      const commitOid = await commitTree(repoDir, {
        treeOid,
        parents: [head],
        message: options.message,
        author: options.author,
      });
      const swapped = await updateRefCas(
        repoDir,
        `refs/heads/${branch}`,
        commitOid,
        head,
      );
      if (swapped) return { commitOid, previousHead: head };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  throw new WorktreeConflictError(
    `Branch ${branch} kept advancing during a lifecycle commit; retry.`,
  );
}

const WORKSPACE_README = `# Mako workspace

Managed by Mako. Apps live under apps/<name>; consoles, skills and dbt
content will join as sibling folders (apps-v2.md §10).
`;

export async function createProject(input: {
  workspaceId: string;
  title: string;
  description?: string;
  userId?: string;
  author?: GitAuthor;
}): Promise<IAppProjectV2> {
  const title = input.title.trim() || "Untitled app";
  const slug = await uniqueSlug(input.workspaceId, title);
  const project = await AppProjectV2.create({
    workspaceId: new Types.ObjectId(input.workspaceId),
    title,
    slug,
    description: input.description,
    access: "private",
    owner_id: input.userId,
    createdBy: input.userId ?? "system",
    defaultBranch: DEFAULT_BRANCH,
  });

  // §10 monorepo: ensure the ONE workspace repo, then commit the scaffold
  // under apps/<slug>/ onto main.
  const repoDir = await repoForWorkspace(input.workspaceId);
  let scaffoldCommit: { commitOid: string; previousHead: string } | null = null;
  try {
    if (!(await repoExists(repoDir))) {
      await initRepo(
        repoDir,
        { "README.md": WORKSPACE_README },
        { message: "Initialize workspace repository", author: input.author },
      );
    }
    const scaffold = createAppsV2Scaffold({
      title: project.title,
      description: input.description,
    });
    const prefixed: Record<string, string> = {};
    for (const [rel, contents] of Object.entries(scaffold)) {
      prefixed[`apps/${slug}/${rel}`] = contents;
    }
    scaffoldCommit = await commitFilesOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: prefixed },
      { message: `Create app "${title}" (apps/${slug})`, author: input.author },
    );
  } catch (error) {
    // Don't leave a content-less project behind.
    await AppProjectV2.deleteOne({ _id: project._id });
    throw error;
  }
  // Cloud tier: mirror the workspace repo to Mako's org. When the cloud app
  // is configured, the durable push is REQUIRED — on serverless hosts the
  // local repo is an ephemeral cache. Hosts without cloud config (pure local
  // dev) keep working local-only.
  try {
    if (await ensureCloudRepo(input.workspaceId)) {
      await mirrorPushNow(input.workspaceId);
    }
  } catch (error) {
    await AppProjectV2.deleteOne({ _id: project._id });
    // Roll the scaffold commit back so the repo matches the docs.
    await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      scaffoldCommit.previousHead,
      scaffoldCommit.commitOid,
    ).catch(() => undefined);
    logger.error("Apps v2 creation aborted: durable push failed", {
      projectId: project._id.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Could not store the app durably (GitHub push failed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  logger.info("Apps v2 project created", {
    projectId: project._id.toString(),
    workspaceId: input.workspaceId,
    slug,
  });
  pokeAppV2(project.workspaceId, project._id, "lifecycle", input.userId);
  return project;
}

export async function deleteProject(project: IAppProjectV2): Promise<void> {
  // §10 monorepo: deleting an app is a COMMIT removing its folder — the
  // workspace repo (and other apps, worktrees, history) are untouched.
  const repoDir = await repoForWorkspace(project.workspaceId.toString());
  if (await repoExists(repoDir)) {
    await commitFilesOnBranch(
      repoDir,
      project.defaultBranch || DEFAULT_BRANCH,
      { deletePrefixes: [appRootFor(project)] },
      { message: `Delete app "${project.title}" (${appRootFor(project)})` },
    );
    queueMirrorPush(project.workspaceId.toString());
  }
  await AppProjectV2.deleteOne({ _id: project._id });
  pokeAppV2(project.workspaceId, project._id, "lifecycle");
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
 * Dedicated actor for publishing (§13.3).
 *
 * Publishing must build from `main` and nothing else, so it gets its own
 * worktree instead of borrowing whoever happened to trigger it. Two reasons:
 * a human's session sits on their own branch with uncommitted WIP, and
 * `ensureWorktree` only fast-forwards a CLEAN worktree — so a session with WIP
 * would build a stale tree that can predate the app being published. Keeping
 * this worktree write-free means it fast-forwards to the branch head every
 * time.
 */
export const PUBLISH_ACTOR = "publish";

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
  const repoDir = await repoFor(project);
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
  // E11000 on the (workspaceId, userId) unique index. §10: ONE worktree per
  // actor per workspace — a chat branch can span apps.
  const doc = await AppWorktreeV2.findOneAndUpdate(
    { workspaceId: project.workspaceId, userId: actorId },
    {
      $setOnInsert: {
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
    let needsCatchUp = false;
    if (currentHead && currentHead !== doc.baseSha) {
      if (!doc.wipOid) {
        doc.baseSha = currentHead;
        doc.revision += 1;
        await doc.save();
        needsRematerialize = true;
        logger.info("Apps v2 worktree fast-forwarded", {
          worktreeId,
          branch: doc.branch,
          head: currentHead,
        });
      } else {
        // The branch moved while this session has uncommitted work.
        //
        // This used to be skipped entirely, which silently stranded the
        // session on an old commit: creating an app (a commit on the branch)
        // and then previewing it failed with "cwd does not exist", because
        // the new apps/<slug>/ folder was never checked out. Anyone with a
        // dirty worktree — i.e. anyone mid-edit — hit it.
        //
        // Catch the session up with a merge instead. Git refuses to merge
        // over uncommitted changes, so this brings in new commits and leaves
        // the user's edits alone, rather than choosing between the two.
        needsCatchUp = true;
      }
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

    if (needsCatchUp && !needsRematerialize) {
      await catchUpSession(repoDir, sessionDir, doc, currentHead!, worktreeId);
    }

    return { doc, project, repoDir, sessionDir, appRoot: appRootFor(project) };
  });
}

/**
 * Merge new commits on the branch into a session that has uncommitted work.
 *
 * The session clone's origin is deliberately unreachable (tenant code must not
 * be able to reach the bare repo), so the fetch names the repo path explicitly
 * — this runs broker-side, not in the sandbox.
 *
 * A merge that would clobber local edits fails, and that is the right outcome:
 * the session stays where it was and the caller continues with what they had,
 * rather than losing work to an automatic update.
 */
async function catchUpSession(
  repoDir: string,
  sessionDir: string,
  doc: IAppWorktreeV2,
  head: string,
  worktreeId: string,
): Promise<void> {
  try {
    await runGit(["-C", sessionDir, "fetch", repoDir, doc.branch], {
      timeoutMs: 60_000,
    });
    await runGit(["-C", sessionDir, "merge", "--no-edit", "FETCH_HEAD"], {
      timeoutMs: 60_000,
    });
    doc.baseSha = head;
    doc.revision += 1;
    await doc.save();
    logger.info("Apps v2 session caught up with branch head", {
      worktreeId,
      branch: doc.branch,
      head,
    });
  } catch (error) {
    logger.warn(
      "Apps v2 session could not catch up (local changes would be overwritten); staying put",
      {
        worktreeId,
        branch: doc.branch,
        head,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
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
        pokeAppV2(doc.workspaceId, null, "flush", doc.userId);
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
    pokeAppV2(doc.workspaceId, null, "flush", doc.userId);
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
  // §10: the session is the whole workspace repo; commands are app-scoped by
  // default (caller cwd is app-relative). posix.join keeps it session-rooted.
  const cwd = path.posix.join(handle.appRoot, options.cwd ?? "");
  const result = await provider.exec(
    { hostDir: handle.sessionDir, sessionKey: handle.doc._id.toString() },
    command,
    { ...options, cwd },
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
      workspaceId: project.workspaceId,
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
  const repoDir = await repoFor(project);
  const ref = await readRefFor(project, userId, repoDir);
  const prefix = `${appRootFor(project)}/`;
  const entries = (await listTree(repoDir, ref))
    .filter(e => e.path.startsWith(prefix))
    .map(e => ({ ...e, path: e.path.slice(prefix.length) }));
  return { ref, entries };
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
  const repoDir = await repoFor(project);
  const safe = assertSafeRelPath(relPath);
  const ref = await readRefFor(project, userId, repoDir);
  const blob = await readBlob(repoDir, ref, appPath(project, safe));
  return { path: safe, ...blob };
}

/** Search file contents at an actor's latest state (sandbox-free). */
export async function grepFiles(
  project: IAppProjectV2,
  pattern: string,
  userId: string | undefined,
  options?: { ignoreCase?: boolean; pathspec?: string; maxMatches?: number },
): Promise<GrepMatch[]> {
  const repoDir = await repoFor(project);
  const ref = await readRefFor(project, userId, repoDir);
  const root = appRootFor(project);
  const scoped = await grepTree(repoDir, ref, pattern, {
    ...options,
    pathspec: options?.pathspec ? `${root}/${options.pathspec}` : root,
  });
  return scoped.map(m =>
    m.path.startsWith(`${root}/`)
      ? { ...m, path: m.path.slice(root.length + 1) }
      : m,
  );
}

/** List paths matching a glob at an actor's latest state (sandbox-free). */
export async function globFiles(
  project: IAppProjectV2,
  glob: string,
  userId?: string,
  limit?: number,
): Promise<string[]> {
  const repoDir = await repoFor(project);
  const ref = await readRefFor(project, userId, repoDir);
  const root = appRootFor(project);
  const matched = await globTree(repoDir, ref, `${root}/${glob}`, limit);
  return matched
    .filter(p => p.startsWith(`${root}/`))
    .map(p => p.slice(root.length + 1));
}

// ---------------------------------------------------------------------------
// Writes through the worktree (explorer quick-edit / agent fast-path tools)
// ---------------------------------------------------------------------------

export async function writeFile(
  handle: WorktreeHandle,
  relPath: string,
  contents: string,
): Promise<FlushResult> {
  const safe = appPath(handle.project, relPath);
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
  const safe = appPath(handle.project, relPath);
  await fs.rm(path.join(handle.sessionDir, safe), { force: true });
  return flushWorktree(handle);
}

export async function readSessionFile(
  handle: WorktreeHandle,
  relPath: string,
): Promise<string> {
  const safe = appPath(handle.project, relPath);
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
  const repoDir = await repoFor(project);
  const doc = await AppWorktreeV2.findOne({
    workspaceId: project.workspaceId,
    userId,
  });
  if (!doc) return null;
  const branchHead = await resolveCommit(repoDir, `refs/heads/${doc.branch}`);
  const prefix = `${appRootFor(project)}/`;
  const changes = (
    doc.wipOid ? await diffNameStatus(repoDir, doc.baseSha, doc.wipOid) : []
  )
    .filter(ch => ch.path.startsWith(prefix))
    .map(ch => ({ ...ch, path: ch.path.slice(prefix.length) }));
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

/**
 * Commit sha at the tip of the project's default branch — what a publish
 * deploys, and the identity an immutable deployment is keyed by (§13.3).
 */
export async function defaultBranchSha(
  project: IAppProjectV2,
): Promise<string> {
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

export async function projectHistory(project: IAppProjectV2, limit = 20) {
  const repoDir = await repoFor(project);
  return repoLog(
    repoDir,
    `refs/heads/${project.defaultBranch || DEFAULT_BRANCH}`,
    limit,
    appRootFor(project),
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
    pokeAppV2(doc.workspaceId, null, "commit", doc.userId);
    return { committed: true, commitOid, message };
  });
}

/**
 * Auto-commit window: a manual save amends the branch head instead of adding
 * a commit when the head is a save of the SAME file by the SAME author within
 * this window (keeps "commit per save" from turning history into noise).
 */
const AUTOCOMMIT_SQUASH_WINDOW_MS = 5 * 60_000;

/**
 * Block A of the workspace-monorepo plan (apps-v2.md §10): every manual save
 * IS a commit — no staged/uncommitted state survives a save. Consecutive
 * saves of one file by one author squash by amending the branch head (the
 * cloud mirror is a forced `push --mirror`, so rewriting the just-created
 * head is safe; BYO remotes receive turn/publish pushes, not per-save ones).
 */
export async function autoCommitFileEdit(
  handle: WorktreeHandle,
  relPath: string,
  action: "edit" | "delete",
  author?: GitAuthor,
): Promise<CommitResult> {
  const { doc, repoDir, sessionDir } = handle;
  const message = `${action}: ${assertSafeRelPath(relPath)}`;

  const squashed = await withWorktreeLock(doc._id.toString(), async () => {
    if (!doc.wipOid) return null;
    const branchRef = `refs/heads/${doc.branch}`;
    const head = await commitMeta(repoDir, branchRef);
    if (
      !head ||
      head.oid !== doc.baseSha ||
      head.subject !== message ||
      head.parents.length !== 1 ||
      (author?.email && head.authorEmail !== author.email) ||
      Date.now() - head.committerTimestamp > AUTOCOMMIT_SQUASH_WINDOW_MS
    ) {
      return null;
    }

    const treeOid = await treeOfCommit(repoDir, doc.wipOid);
    const amended = await commitTree(repoDir, {
      treeOid,
      parents: head.parents,
      message,
      author,
    });
    const swapped = await updateRefCas(repoDir, branchRef, amended, head.oid);
    if (!swapped) return null; // branch moved — fall through to a new commit

    await deleteRefCas(repoDir, wipRefFor(doc._id.toString()), doc.wipOid);
    doc.baseSha = amended;
    doc.wipOid = undefined;
    doc.revision += 1;
    await doc.save();
    pokeAppV2(doc.workspaceId, null, "commit", doc.userId);
    return { committed: true, commitOid: amended, message } as CommitResult;
  });

  if (squashed?.commitOid) {
    queueMirrorPush(doc.workspaceId.toString());
    try {
      await runGit(["-C", sessionDir, "fetch", repoDir, squashed.commitOid]);
      await runGit(["-C", sessionDir, "reset", "--mixed", squashed.commitOid]);
    } catch {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
    return squashed;
  }

  return commitWorktree(handle, message, author);
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
  queueMirrorPush(doc.workspaceId.toString());

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
): Promise<Array<{ commitOid?: string }>> {
  const results: Array<{ commitOid?: string }> = [];
  const actorId = chatActorFor(chatId);
  // §10: one workspace worktree per chat actor (a turn may span apps).
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
    try {
      const repoDir = await repoForWorkspace(workspaceId);
      const result = await commitFromWip(doc, repoDir, message, {
        name: "Mako Agent",
        email: "agent@mako.ai",
      });
      results.push({ commitOid: result.commitOid });
      if (result.commitOid) queueMirrorPush(workspaceId);
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
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({});
    }
  }
  logger.info("Apps v2 chat turn committed", {
    chatId,
    worktrees: results.length,
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
  const repoDir = await repoFor(project);
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
  const repoDir = await repoFor(project);
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
    queueMirrorPush(project.workspaceId.toString());
    pokeAppV2(project.workspaceId, project._id, "merge");
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
  queueMirrorPush(project.workspaceId.toString());
  pokeAppV2(project.workspaceId, project._id, "merge");
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
    pokeAppV2(doc.workspaceId, null, "discard", doc.userId);
    return { baseSha: head };
  });
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
  const dir = handle.sessionDir;
  const mainBranch = handle.project.defaultBranch || DEFAULT_BRANCH;

  // A previous publish leaves build output behind. Reset tracked files and
  // drop untracked ones, but NOT ignored ones — node_modules is expensive and
  // reinstalling it on every publish would dominate the wall clock.
  await runGit(["-C", dir, "reset", "--hard"], { timeoutMs: 60_000 });
  await runGit(["-C", dir, "clean", "-fd"], { timeoutMs: 60_000 });

  // Catch up with main first, so the trial merge is against current main.
  await runGit(["-C", dir, "fetch", repoDir, mainBranch], {
    timeoutMs: 60_000,
  });
  await runGit(["-C", dir, "reset", "--hard", "FETCH_HEAD"], {
    timeoutMs: 60_000,
  });

  if (branch !== mainBranch) {
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
      // Leave nothing half-merged behind for the next publish.
      await runGit(["-C", dir, "merge", "--abort"], {
        timeoutMs: 30_000,
      }).catch(() => undefined);
      return {
        sha: "",
        ok: false,
        reason:
          error instanceof Error && /conflict/i.test(error.message)
            ? `Cannot publish: ${branch} conflicts with ${mainBranch}. Merge ${mainBranch} into it and resolve the conflicts first.`
            : `Could not merge ${branch} into ${mainBranch}`,
      };
    }
  }

  const { stdout } = await runGit(["-C", dir, "rev-parse", "HEAD"], {
    cwd: dir,
  });
  return { sha: stdout.trim(), ok: true };
}

/**
 * Advance the real `main` to the commit that was just built.
 *
 * Only called after a successful build. A non-fast-forward push means `main`
 * moved while we were building, so the built artifact no longer corresponds to
 * what `main` holds — refusing is correct, and the caller retries.
 */
export async function promoteToMain(handle: WorktreeHandle): Promise<void> {
  const mainBranch = handle.project.defaultBranch || DEFAULT_BRANCH;
  await runGit(
    [
      "-C",
      handle.sessionDir,
      "push",
      handle.repoDir,
      `HEAD:refs/heads/${mainBranch}`,
    ],
    { timeoutMs: 120_000 },
  );
}
