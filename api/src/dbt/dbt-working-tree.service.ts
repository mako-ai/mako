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

import type { IDbtProject } from "../database/workspace-schema";
import { RepoRequiredError, appsRequireConnectedRepo } from "../apps/config";
import { ZERO_OID } from "../apps/git";
import { commitBranchFor } from "../apps/branch-policy";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  commitToWorkspace,
  freshenBeforeMainWrite,
  freshenBranchForRead,
  resolveMirrorTarget,
} from "../apps/cloud-repo.service";
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

/** Per-file cap (matches the PUT /files content limit). */
const MAX_FILE_BYTES = 1_000_000;

/**
 * Thrown when a save committed here could not be pushed to the mirror. The
 * shared primitive's error, under the name dbt callers already catch.
 */
export { WorkspaceSaveNotPushedError as DbtSaveNotMirroredError } from "../apps/cloud-repo.service";

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
  project: Pick<IDbtProject, "workspaceId">,
  userId: string | undefined,
): Promise<string> {
  if (!userId) return DEFAULT_BRANCH;
  return commitBranchFor("dbt", project.workspaceId.toString(), userId);
}

async function repoDirIfExists(
  project: Pick<IDbtProject, "workspaceId">,
): Promise<string | null> {
  const repoDir = await repoForWorkspace(project.workspaceId.toString());
  return (await repoExists(repoDir)) ? repoDir : null;
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
  project: IDbtProject,
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
  project: IDbtProject,
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
 * Commit a mutation to the dbt tree on the actor's session branch through
 * `commitToWorkspace`: the save counts once GitHub has it, or it fails. The
 * one write path for saves, deletes and renames.
 */
async function commitDbtMutation(
  project: IDbtProject,
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

  const result = await commitToWorkspace(
    workspaceId,
    async () => {
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
    },
    { branch },
  );
  return { commitOid: result.unchanged ? undefined : result.commitOid };
}

/** Commit a batch of files in one commit (scaffold, imports). */
export async function commitDbtFiles(
  project: IDbtProject,
  userId: string,
  writes: Record<string, string>,
  message: string,
): Promise<WriteWorkingFileResult> {
  for (const path of Object.keys(writes)) assertSafeDbtPath(path);
  return commitDbtMutation(project, userId, { writes }, message);
}

/** Write a file: a commit on the session branch (no-op when identical). */
export async function writeWorkingFile(
  project: IDbtProject,
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
  project: IDbtProject,
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
  project: IDbtProject,
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
 * Binary files and files over the size cap are skipped — dbt trees are text.
 */
export async function loadWorkingTreeContents(
  project: IDbtProject,
  opts: { userId?: string; branch?: string; commit?: string } = {},
): Promise<Array<{ path: string; content: string }>> {
  const repoDir = await repoDirIfExists(project);
  if (repoDir == null) {
    if (opts.commit) throw new RepoRequiredError();
    return [];
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
  if (!head) return [];
  const entries = await listTree(repoDir, head);
  const paths = entries.map(e => e.path).filter(p => projectPathOf(p) !== null);
  const blobs = await readBlobsBatch(repoDir, head, paths);
  const files: Array<{ path: string; content: string }> = [];
  for (const [repoRelative, buf] of blobs) {
    if (buf.length > MAX_FILE_BYTES || buf.includes(0)) continue;
    const path = projectPathOf(repoRelative);
    if (path) files.push({ path, content: buf.toString("utf8") });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The commit a run triggered now should build, freshened from the mirror:
 * the same branch choice as {@link loadWorkingTreeContents}. Recorded on the
 * run so every command builds this one tree, whichever instance runs it and
 * whatever lands on the branch meanwhile. Null when there is no tree.
 */
export async function resolveWorkingTreeCommit(
  project: Pick<IDbtProject, "workspaceId">,
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
