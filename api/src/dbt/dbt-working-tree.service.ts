/**
 * The dbt working tree IS the workspace repo (apps.md §20, Block D3).
 *
 * dbt project files live under `dbt/` in the ONE workspace repo, on the
 * actor's session branch — the same pointer the Source Control rail and
 * `git checkout` in an apps terminal move (branch-policy.ts). There is no
 * Mongo file mirror, no per-user draft overlay, and no per-project checkout
 * any more: a save is a commit on your branch (invisible to teammates on
 * other branches, exactly like separate clones), jobs and deploys build the
 * default branch, and history/diffs are ordinary git served by the shared
 * Source Control surface.
 *
 * Paths in and out of this module stay PROJECT-RELATIVE (`models/foo.sql`);
 * the `dbt/` prefix is applied here and only here.
 */

type WorkspaceProject = { workspaceId: { toString(): string } };
import { RepoRequiredError, appsRequireConnectedRepo } from "../apps/config";
import { ZERO_OID, runGit } from "../apps/git";
import { commitBranchFor } from "../apps/branch-policy";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  ensureCommitLocally,
  fetchFromCloud,
  freshenBeforeMainWrite,
  freshenForServe,
  mirrorPushDefaultBranchNow,
  queueMirrorPush,
  resolveMirrorTarget,
} from "../apps/cloud-repo.service";
import * as yaml from "js-yaml";
import { loggers } from "../logging";
import { repoForWorkspace } from "../apps/worktree.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  listTree,
  readBlob,
  readBlobsBatch,
  repoExists,
  resolveCommit,
  updateRefCas,
} from "../apps/repository.service";

/** Repo-relative root of the dbt project inside the workspace repo. */
export const DBT_ROOT = "dbt";

/**
 * Largest file the run loader hands to dbt. 100 MB is GitHub's hard per-file
 * limit, so the workspace mirror can never hold a bigger blob anyway.
 *
 * It used to be 1 MB, a value inherited from the Mongo file layer (one
 * document per file, under Mongo's 16 MB BSON cap) that #887 deleted. Since
 * then the tree is read from git and written to local disk, and
 * readBlobsBatch already buffers every blob whatever its size, so 1 MB saved
 * nothing. It silently dropped an 8 MB seed on 18 Nov 2026 and every prod
 * parse failed for four hours.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const logger = loggers.api("dbt-working-tree");

/** Thrown when a save committed here could not be pushed to the mirror. */
export class DbtSaveNotMirroredError extends Error {
  constructor(cause: unknown) {
    super(
      `The save could not be pushed to the workspace's GitHub repository (${
        cause instanceof Error ? cause.message : String(cause)
      }). It was not saved; retry.`,
    );
    this.name = "DbtSaveNotMirroredError";
  }
}

export interface WorkingFileMeta {
  path: string;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface WorkingFile extends WorkingFileMeta {
  content: string;
}

export interface WriteWorkingFileResult {
  /** Commit that recorded the write (undefined when content was identical). */
  commitOid?: string;
}

function repoPath(path: string): string {
  return `${DBT_ROOT}/${path}`;
}

function projectPathOf(repoRelative: string): string | null {
  return repoRelative.startsWith(`${DBT_ROOT}/`)
    ? repoRelative.slice(DBT_ROOT.length + 1)
    : null;
}

function assertSafeDbtPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some(seg => seg === ".." || seg === "" || seg === ".git")
  ) {
    throw new Error(`Unsafe dbt path: ${path}`);
  }
  return path;
}

/**
 * Branch this user's dbt reads and writes address: the actor's SESSION
 * branch (shared with apps/Source Control). No user → the default branch
 * (jobs, deploys, CI).
 */
export async function getCheckoutBranch(
  project: WorkspaceProject,
  userId: string | undefined,
): Promise<string> {
  if (!userId) return DEFAULT_BRANCH;
  return commitBranchFor("dbt", project.workspaceId.toString(), userId);
}

async function repoDirIfExists(
  project: WorkspaceProject,
): Promise<string | null> {
  const repoDir = await repoForWorkspace(project.workspaceId.toString());
  return (await repoExists(repoDir)) ? repoDir : null;
}

/**
 * Bring `branch` up to date with the mirror before a read.
 *
 * Every API instance has its own clone, and `ensureLocalRepo` never refreshes
 * one that exists, so without this a read shows whatever this instance last
 * fetched: a file another instance saved a moment ago is missing, and two
 * calls answered by two instances list different trees. Throttled like every
 * serve-side freshen; a failure serves local state.
 */
const BRANCH_FRESHEN_INTERVAL_MS = 3_000;
const lastBranchFreshenAt = new Map<string, number>();

async function freshenBranchForRead(
  workspaceId: string,
  branch: string,
): Promise<void> {
  await freshenForServe(workspaceId);
  if (branch === DEFAULT_BRANCH) return;
  const key = `${workspaceId}#${branch}`;
  if (
    Date.now() - (lastBranchFreshenAt.get(key) ?? 0) <
    BRANCH_FRESHEN_INTERVAL_MS
  ) {
    return;
  }
  lastBranchFreshenAt.set(key, Date.now());
  // A session branch that was never pushed is absent on the mirror, and the
  // fetch fails: that is the normal case, not an error.
  await fetchFromCloud(workspaceId, branch).catch(() => undefined);
}

async function resolveBranchOrDefault(
  repoDir: string,
  branch: string,
): Promise<string> {
  // A session branch that only ever existed in a dead sandbox may be gone;
  // reads fall back to the default branch rather than showing nothing.
  const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  return head ? branch : DEFAULT_BRANCH;
}

/** List the dbt tree at the user's session branch. */
export async function listWorkingFiles(
  project: WorkspaceProject,
  userId: string,
): Promise<WorkingFileMeta[]> {
  const repoDir = await repoDirIfExists(project);
  if (repoDir == null) return [];
  const wanted = await getCheckoutBranch(project, userId);
  await freshenBranchForRead(project.workspaceId.toString(), wanted);
  const branch = await resolveBranchOrDefault(repoDir, wanted);
  const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!head) return [];
  const entries = await listTree(repoDir, head);
  return entries
    .map(e => projectPathOf(e.path))
    .filter((p): p is string => p !== null)
    .sort((a, b) => a.localeCompare(b))
    .map(path => ({ path }));
}

/** Read one file from the user's session branch. */
export async function readWorkingFile(
  project: WorkspaceProject,
  userId: string,
  path: string,
): Promise<WorkingFile | null> {
  assertSafeDbtPath(path);
  const repoDir = await repoDirIfExists(project);
  if (repoDir == null) return null;
  const wanted = await getCheckoutBranch(project, userId);
  await freshenBranchForRead(project.workspaceId.toString(), wanted);
  const branch = await resolveBranchOrDefault(repoDir, wanted);
  try {
    const blob = await readBlob(
      repoDir,
      `refs/heads/${branch}`,
      repoPath(path),
    );
    if (blob.isBinary) return null;
    return { path, content: blob.contents };
  } catch {
    return null;
  }
}

/**
 * Commit a mutation to the dbt tree on the actor's session branch and push it
 * to the mirror. The one write path for saves, deletes and renames.
 *
 * The branch is freshened from the mirror first: a commit onto a tip this
 * instance had not caught up with cannot be pushed (non-fast-forward), and
 * the next fetch parks it under refs/mako/diverged/* — a save that reported
 * success and then vanished. On the default branch the push is awaited, and
 * a rejection is retried once against the mirror's tip; a save that still
 * cannot reach the mirror fails rather than reporting success.
 */
async function commitDbtMutation(
  project: WorkspaceProject,
  userId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
): Promise<WriteWorkingFileResult> {
  const workspaceId = project.workspaceId.toString();
  // Production: the workspace's own repo is the only durable store (§17).
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
  const repoDir = await repoForWorkspace(workspaceId);
  if (!(await repoExists(repoDir))) throw new RepoRequiredError();
  const branch = await getCheckoutBranch(project, userId);
  const onDefault = branch === DEFAULT_BRANCH;
  const author = await authorForUser(userId);
  const files = {
    writes: Object.fromEntries(
      Object.entries(mutation.writes ?? {}).map(([p, c]) => [repoPath(p), c]),
    ),
    deletes: (mutation.deletes ?? []).map(repoPath),
  };

  const commit = async () => {
    if (onDefault) {
      await freshenBeforeMainWrite(workspaceId);
    } else {
      await fetchFromCloud(workspaceId, branch).catch(() => undefined);
    }
    // A remembered session branch whose ref is gone (deleted from another
    // checkout) forks back off the default branch head, like ensureWorktree.
    if (!(await resolveCommit(repoDir, `refs/heads/${branch}`))) {
      if (!onDefault) await freshenBeforeMainWrite(workspaceId);
      const mainHead = await resolveCommit(
        repoDir,
        `refs/heads/${DEFAULT_BRANCH}`,
      );
      if (!mainHead) throw new RepoRequiredError();
      await updateRefCas(repoDir, `refs/heads/${branch}`, mainHead, ZERO_OID);
    }
    return commitBlobsOnBranch(repoDir, branch, files, { message, author });
  };

  let result = await commit();
  if (result.unchanged) return { commitOid: undefined };
  if (!onDefault) {
    queueMirrorPush(workspaceId);
    return { commitOid: result.commitOid };
  }
  try {
    await mirrorPushDefaultBranchNow(workspaceId);
  } catch (firstError) {
    // Rejected: the mirror moved between the freshen and the push. The retry's
    // freshen parks the rejected commit and resets main to the mirror, so the
    // mutation is committed again on top of it.
    logger.warn("dbt save push rejected; retrying on the mirror's tip", {
      workspaceId,
      error: firstError instanceof Error ? firstError.message : firstError,
    });
    // When the mirror did not move, the first commit is still the tip and
    // this one is "unchanged": it still has to reach the mirror.
    const retried = await commit();
    if (!retried.unchanged) result = retried;
    try {
      await mirrorPushDefaultBranchNow(workspaceId);
    } catch (error) {
      throw new DbtSaveNotMirroredError(error);
    }
  }
  return { commitOid: result.commitOid };
}

/** Commit a batch of files in one commit (scaffold, imports). */
export async function commitDbtFiles(
  project: WorkspaceProject,
  userId: string,
  writes: Record<string, string>,
  message: string,
): Promise<WriteWorkingFileResult> {
  for (const path of Object.keys(writes)) assertSafeDbtPath(path);
  return commitDbtMutation(project, userId, { writes }, message);
}

/** Write a file: a commit on the session branch (no-op when identical). */
export async function writeWorkingFile(
  project: WorkspaceProject,
  userId: string,
  path: string,
  content: string,
): Promise<WriteWorkingFileResult> {
  assertSafeDbtPath(path);
  return commitDbtMutation(
    project,
    userId,
    { writes: { [path]: content } },
    `dbt: edit ${path}`,
  );
}

/** Delete a file: a commit on the session branch. False when absent. */
export async function deleteWorkingFile(
  project: WorkspaceProject,
  userId: string,
  path: string,
): Promise<boolean> {
  assertSafeDbtPath(path);
  const existing = await readWorkingFile(project, userId, path);
  if (!existing) return false;
  await commitDbtMutation(
    project,
    userId,
    { deletes: [path] },
    `dbt: delete ${path}`,
  );
  return true;
}

/** Rename: one commit carrying the delete and the add. */
export async function renameWorkingFile(
  project: WorkspaceProject,
  userId: string,
  from: string,
  to: string,
): Promise<string | null> {
  assertSafeDbtPath(from);
  assertSafeDbtPath(to);
  const [source, target] = await Promise.all([
    readWorkingFile(project, userId, from),
    readWorkingFile(project, userId, to),
  ]);
  if (!source) return "File not found";
  if (target) return `"${to}" already exists`;
  await commitDbtMutation(
    project,
    userId,
    { writes: { [to]: source.content }, deletes: [from] },
    `dbt: rename ${from} -> ${to}`,
  );
  return null;
}

/**
 * Full file contents of the dbt tree, for materializing runs:
 *  - `userId` set → that user's session branch (IDE/agent ad-hoc commands
 *    build exactly what the user sees — which is committed, because every
 *    save commits).
 *  - `branch` set → that branch (CI-style runs).
 *  - `commit` set → exactly that commit (a laptop run's base, which must
 *    never silently become another tree: a missing commit throws).
 *  - neither → the default branch (deploy jobs).
 * Binary files (NUL bytes) and files over MAX_FILE_BYTES are never silently
 * dropped: one dbt reads throws DbtTreeFilesSkippedError naming each file,
 * its size and the reason; the rest come back as `warnings` for the run.
 */
export async function loadWorkingTreeContents(
  project: WorkspaceProject,
  opts: {
    userId?: string;
    branch?: string;
    commit?: string;
    /** Override of MAX_FILE_BYTES, for tests. */
    maxFileBytes?: number;
    /**
     * Return the skipped files unjudged (`skipped`), for a caller that
     * merges a local overlay first: the overlay can delete or replace a
     * skipped file, and its own dbt_project.yml decides the resource paths.
     */
    deferSkipped?: boolean;
  } = {},
): Promise<WorkingTreeContents> {
  const repoDir = await repoDirIfExists(project);
  if (repoDir == null) {
    if (opts.commit) throw new RepoRequiredError();
    return { files: [], warnings: [] };
  }
  let head: string | null;
  if (opts.commit) {
    head = await resolveCommit(repoDir, opts.commit);
    if (!head) {
      throw new Error(
        `Commit ${opts.commit.slice(0, 7)} is not in the workspace repo — push it (or fetch main) and retry`,
      );
    }
  } else {
    const wanted =
      opts.branch ??
      (opts.userId
        ? await getCheckoutBranch(project, opts.userId)
        : DEFAULT_BRANCH);
    await freshenBranchForRead(project.workspaceId.toString(), wanted);
    const branch = await resolveBranchOrDefault(repoDir, wanted);
    head = await resolveCommit(repoDir, `refs/heads/${branch}`);
  }
  if (!head) return { files: [], warnings: [] };
  const entries = await listTree(repoDir, head);
  const paths = entries.map(e => e.path).filter(p => projectPathOf(p) !== null);
  const blobs = await readBlobsBatch(repoDir, head, paths);
  const files: Array<{ path: string; content: string }> = [];
  const skipped: SkippedTreeFile[] = [];
  for (const [repoRelative, buf] of blobs) {
    const path = projectPathOf(repoRelative);
    if (!path) continue;
    const reason = unreadableReason(buf, opts.maxFileBytes ?? MAX_FILE_BYTES);
    if (reason) {
      skipped.push({ path, bytes: buf.length, reason });
      continue;
    }
    files.push({ path, content: buf.toString("utf8") });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (opts.deferSkipped) return { files, warnings: [], skipped };
  return classifySkippedFiles(
    files,
    skipped,
    opts.maxFileBytes ?? MAX_FILE_BYTES,
  );
}

/** A file of the dbt tree the loader could not hand to dbt as text. */
export interface SkippedTreeFile {
  /** Project-relative path (`seeds/big.csv`). */
  path: string;
  bytes: number;
  /** `too_large`: over MAX_FILE_BYTES. `binary`: contains NUL bytes. */
  reason: "too_large" | "binary";
}

export interface WorkingTreeContents {
  files: Array<{ path: string; content: string }>;
  /**
   * Skipped files dbt never reads (outside every resource path), one
   * sentence each. Callers put them on the run result: a skip is never silent.
   */
  warnings: string[];
  /** Unjudged skipped files, only with `deferSkipped`. */
  skipped?: SkippedTreeFile[];
}

/**
 * The tree holds files dbt reads but the loader could not load. The run must
 * stop here: dbt would otherwise fail later with an error that names a
 * missing node, far from the cause.
 */
export class DbtTreeFilesSkippedError extends Error {
  readonly files: SkippedTreeFile[];
  constructor(files: SkippedTreeFile[], maxFileBytes: number) {
    super(
      `${files.length} dbt file${files.length === 1 ? "" : "s"} could not be loaded, so dbt did not run: ` +
        files.map(f => describeSkippedFile(f, maxFileBytes)).join("; ") +
        ". Shrink the file, store it as UTF-8 text, or move it out of the dbt resource paths.",
    );
    this.name = "DbtTreeFilesSkippedError";
    this.files = files;
  }
}

function unreadableReason(
  buf: Buffer,
  maxFileBytes: number,
): SkippedTreeFile["reason"] | null {
  if (buf.length > maxFileBytes) return "too_large";
  if (buf.includes(0)) return "binary";
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeSkippedFile(
  file: SkippedTreeFile,
  maxFileBytes: number = MAX_FILE_BYTES,
): string {
  const where = `${DBT_ROOT}/${file.path} (${formatBytes(file.bytes)})`;
  return file.reason === "too_large"
    ? `${where} is over the ${formatBytes(maxFileBytes)} per-file limit`
    : `${where} is binary (it contains NUL bytes) and dbt reads text only`;
}

/** dbt's default resource folders, per dbt_project.yml key. */
const DBT_RESOURCE_PATH_KEYS: Record<string, string[]> = {
  "model-paths": ["models"],
  "seed-paths": ["seeds"],
  "macro-paths": ["macros"],
  "snapshot-paths": ["snapshots"],
  "test-paths": ["tests"],
  "analysis-paths": ["analyses"],
  "docs-paths": [],
};

/**
 * The folders dbt reads, from dbt_project.yml (its defaults when the file
 * does not set a key or cannot be parsed). `keys` narrows them to some
 * dbt_project.yml keys ("model-paths", "seed-paths", ...).
 */
export function dbtResourcePaths(
  projectYml: string | undefined,
  keys?: readonly string[],
): string[] {
  let config: Record<string, unknown> = {};
  if (projectYml) {
    try {
      const parsed = yaml.load(projectYml);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable: dbt fails on it with its own error; use the defaults.
    }
  }
  const out = new Set<string>();
  for (const [key, defaults] of Object.entries(DBT_RESOURCE_PATH_KEYS)) {
    if (keys && !keys.includes(key)) continue;
    const value = config[key];
    const list =
      Array.isArray(value) && value.every(v => typeof v === "string")
        ? (value as string[])
        : defaults;
    for (const entry of list) {
      const clean = entry.replace(/^\.\//, "").replace(/\/+$/, "");
      if (clean && clean !== ".") out.add(clean);
    }
  }
  return [...out];
}

/**
 * Whether dbt reads this project-relative path: anything under a resource
 * folder, and YAML at the project root (dbt_project.yml, packages.yml,
 * dependencies.yml, selectors.yml).
 */
export function dbtReadsPath(path: string, resourcePaths: string[]): boolean {
  if (!path.includes("/")) return /\.ya?ml$/i.test(path);
  // dbt only opens these extensions under a resource folder: a .DS_Store, a
  // diagram or a parquet next to the models is never read.
  if (!/\.(sql|py|ya?ml|md|csv)$/i.test(path)) return false;
  return resourcePaths.some(root => path.startsWith(`${root}/`));
}

/**
 * Fail on skipped files dbt reads; turn the rest into warnings. Exported for
 * tests.
 */
export function classifySkippedFiles(
  files: Array<{ path: string; content: string }>,
  skipped: SkippedTreeFile[],
  maxFileBytes: number = MAX_FILE_BYTES,
): WorkingTreeContents {
  if (skipped.length === 0) return { files, warnings: [] };
  const sorted = [...skipped].sort((a, b) => a.path.localeCompare(b.path));
  const resourcePaths = dbtResourcePaths(
    files.find(f => f.path === "dbt_project.yml")?.content,
  );
  const needed = sorted.filter(f => dbtReadsPath(f.path, resourcePaths));
  if (needed.length > 0) {
    throw new DbtTreeFilesSkippedError(needed, maxFileBytes);
  }
  const warnings = sorted.map(
    f =>
      `Skipped ${describeSkippedFile(f, maxFileBytes)}. dbt does not read this path, so the run went on without it.`,
  );
  logger.warn("dbt working tree skipped files dbt does not read", {
    skipped: sorted,
  });
  return { files, warnings };
}

/**
 * The commit a run triggered now should build, freshened from the mirror:
 * the same branch choice as {@link loadWorkingTreeContents}. Recorded on the
 * run so every command builds this one tree, whichever instance runs it and
 * whatever lands on the branch meanwhile. Null when there is no tree.
 */
export async function resolveWorkingTreeCommit(
  project: WorkspaceProject,
  opts: { userId?: string; branch?: string } = {},
): Promise<string | null> {
  // No bound repo: nothing to pin. The run fails when it loads its tree,
  // with the same error it always had.
  const repoDir = await repoDirIfExists(project).catch(error => {
    if (error instanceof RepoRequiredError) return null;
    throw error;
  });
  if (repoDir == null) return null;
  const wanted =
    opts.branch ??
    (opts.userId
      ? await getCheckoutBranch(project, opts.userId)
      : DEFAULT_BRANCH);
  await freshenBranchForRead(project.workspaceId.toString(), wanted);
  const branch = await resolveBranchOrDefault(repoDir, wanted);
  return resolveCommit(repoDir, `refs/heads/${branch}`);
}

/**
 * The committer time of `sha` in the workspace repo, fetched from the mirror
 * when this instance lacks it. Orders prod manifest promotion: runs pin their
 * commit at trigger time and Inngest does not finish them in order. Null when
 * there is no repo or the commit cannot be read.
 */
export async function commitTimeOf(
  project: WorkspaceProject,
  sha: string,
): Promise<Date | null> {
  try {
    const repoDir = await repoDirIfExists(project);
    if (repoDir == null) return null;
    await ensureCommitLocally(project.workspaceId.toString(), sha);
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "show",
      "-s",
      "--format=%ct",
      `${sha}^{commit}`,
    ]);
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000)
      : null;
  } catch {
    return null;
  }
}
