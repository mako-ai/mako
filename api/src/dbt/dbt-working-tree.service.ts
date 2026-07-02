/**
 * Per-user dbt working trees — backed entirely by git (no file content in
 * Mongo).
 *
 * Every project owns a bare git repository (see dbt-git-store.service.ts).
 *
 *  - Blank (non-repo) projects: refs/heads/main is the single shared working
 *    tree every member edits directly; each save is a commit.
 *  - Repo-bound projects: local branches mirror the GitHub remote and are the
 *    COMMITTED base trees. A user's uncommitted work is an overlay commit
 *    chain at refs/mako/drafts/<user> forked from refs/mako/drafts-base/<user>.
 *    Reads/writes lazily REBASE the overlay onto the head of the user's
 *    checked-out branch, so uncommitted work follows the user across branch
 *    switches and a base sync can never clobber it — the same collaboration
 *    semantics as separate git clones.
 *
 * Mongo keeps only pointers/metadata: DbtCheckout (per-user branch pointer)
 * and the legacy DbtFile/DbtFileDraft collections, which are read exactly
 * once per project to materialize the git repo (lazy migration) and never
 * written again.
 */

import {
  DbtCheckout,
  DbtFile,
  DbtFileDraft,
  type IDbtProject,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  BLANK_PROJECT_BRANCH,
  MAX_DBT_FILE_BYTES,
  ZERO_SHA,
  authorFor,
  branchRef,
  commitTreeUpdate,
  deleteRef,
  deleteRepoDir,
  diffTrees,
  draftRefsFor,
  ensureBareRepo,
  fetchBranch,
  listTree,
  readBlobAt,
  readBlobs,
  repoDirFor,
  repoExists,
  resolveCommit,
  treeShaOf,
  updateRef,
  withCasRetry,
  type GitAuthor,
  type TreeFileChange,
} from "./dbt-git-store.service";
import { resolveProjectRemote } from "./dbt-git-remote";
import { toProjectPath, toRepoPath } from "./dbt-paths";

const logger = loggers.api("dbt-working-tree");

export interface WorkingFileMeta {
  path: string;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface WorkingFile extends WorkingFileMeta {
  content: string;
}

export function isRepoProject(project: IDbtProject): boolean {
  return Boolean(project.repo);
}

// ---------------------------------------------------------------------------
// Checkouts (Mongo branch pointers — metadata, not content)
// ---------------------------------------------------------------------------

/**
 * Branch the user's checkout points at. Falls back to the project default
 * branch when the user never switched (implicit checkout). Blank projects
 * always use the local shared branch.
 */
export async function getCheckoutBranch(
  project: IDbtProject,
  userId: string | undefined,
): Promise<string> {
  if (!project.repo) return BLANK_PROJECT_BRANCH;
  if (!userId) return project.repo.branch;
  const checkout = await DbtCheckout.findOne({
    projectId: project._id,
    userId,
  })
    .select("branch")
    .lean();
  return checkout?.branch ?? project.repo.branch;
}

/** Point the user's checkout at a branch (upsert). */
export async function setCheckoutBranch(
  project: IDbtProject,
  userId: string,
  branch: string,
  sync?: { lastSyncedSha?: string },
): Promise<void> {
  await DbtCheckout.updateOne(
    { projectId: project._id, userId },
    {
      $set: {
        workspaceId: project.workspaceId,
        branch,
        ...(sync?.lastSyncedSha
          ? { lastSyncedSha: sync.lastSyncedSha, lastSyncedAt: new Date() }
          : {}),
      },
    },
    { upsert: true },
  ).exec();
}

// ---------------------------------------------------------------------------
// Repo lifecycle + legacy Mongo import
// ---------------------------------------------------------------------------

const MIGRATION_AUTHOR: GitAuthor = {
  name: "mako-migration",
  email: "migration@mako.dev",
};

/**
 * Ensure the project's bare repository exists. On first touch of a legacy
 * project, its Mongo file rows (dbt_files base trees + dbt_file_drafts
 * overlays) are materialized into git — after that the collections are never
 * read again for this project.
 */
export async function ensureProjectRepo(project: IDbtProject): Promise<string> {
  const repoDir = repoDirFor(
    project.workspaceId.toString(),
    project._id.toString(),
  );
  if (repoExists(repoDir)) return repoDir;
  await ensureBareRepo(repoDir);
  try {
    await importLegacyMongoTrees(project, repoDir);
  } catch (error) {
    // Leave a clean slate so the next call retries the import.
    await deleteRepoDir(repoDir).catch(() => {});
    throw error;
  }
  return repoDir;
}

interface LegacyFileRow {
  branch?: string;
  path: string;
  content?: string;
  is_deleted?: boolean;
  updatedBy?: string;
}

async function importLegacyMongoTrees(
  project: IDbtProject,
  repoDir: string,
): Promise<void> {
  const rows = (await DbtFile.find({ projectId: project._id })
    .select("branch path content is_deleted updatedBy")
    .lean()) as LegacyFileRow[];
  if (rows.length === 0 && !project.repo) return;

  // Group base rows per branch (blank projects → the shared local branch).
  const byBranch = new Map<string, LegacyFileRow[]>();
  for (const row of rows) {
    const branch = project.repo
      ? (row.branch ?? project.repo.branch)
      : BLANK_PROJECT_BRANCH;
    const list = byBranch.get(branch) ?? [];
    list.push(row);
    byBranch.set(branch, list);
  }

  for (const [branch, branchRows] of byBranch) {
    const live = branchRows.filter(row => !row.is_deleted);
    // Soft-deleted rows with retained content stay recoverable: commit them
    // first, then delete them in a second commit (git history keeps them).
    const recoverable = branchRows.filter(
      row => row.is_deleted && (row.content ?? "").length > 0,
    );
    const initialWrites = [...live, ...recoverable].map(row => ({
      path: toRepoPath(project, row.path),
      content: row.content ?? "",
    }));
    if (initialWrites.length === 0) continue;
    const { sha } = await commitTreeUpdate(repoDir, {
      ref: branchRef(branch),
      expectedOldSha: ZERO_SHA,
      parents: [],
      writes: initialWrites,
      deletes: [],
      message: "Import project files from Mako",
      author: MIGRATION_AUTHOR,
    });
    if (recoverable.length > 0) {
      await commitTreeUpdate(repoDir, {
        ref: branchRef(branch),
        expectedOldSha: sha,
        baseTree: sha,
        parents: [sha],
        writes: [],
        deletes: recoverable.map(row => toRepoPath(project, row.path)),
        message: "Remove deleted files (recoverable via history)",
        author: MIGRATION_AUTHOR,
      });
    }
    logger.info("Imported legacy dbt tree into git", {
      projectId: project._id.toString(),
      branch,
      files: live.length,
      recoverable: recoverable.length,
    });
  }

  // Per-user draft overlays (repo projects only — blank projects had none).
  if (!project.repo) return;
  const drafts = await DbtFileDraft.find({ projectId: project._id })
    .select("userId path content is_deleted")
    .lean();
  const byUser = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const list = byUser.get(draft.userId) ?? [];
    list.push(draft);
    byUser.set(draft.userId, list);
  }
  for (const [userId, userDrafts] of byUser) {
    const branch = await getCheckoutBranch(project, userId);
    const head = await resolveCommit(repoDir, branchRef(branch));
    if (!head) continue;
    const refs = draftRefsFor(userId);
    const writes = userDrafts
      .filter(draft => !draft.is_deleted)
      .map(draft => ({
        path: toRepoPath(project, draft.path),
        content: draft.content ?? "",
      }));
    const deletes = userDrafts
      .filter(draft => draft.is_deleted)
      .map(draft => toRepoPath(project, draft.path));
    const { sha, treeSha } = await commitTreeUpdate(repoDir, {
      ref: refs.tip,
      expectedOldSha: ZERO_SHA,
      baseTree: head,
      parents: [head],
      writes,
      deletes,
      message: "Import uncommitted drafts from Mako",
      author: authorFor(userId),
    });
    if (treeSha === (await treeShaOf(repoDir, head))) {
      await deleteRef(repoDir, refs.tip);
      continue;
    }
    await updateRef(repoDir, refs.base, head);
    logger.info("Imported legacy dbt drafts into git", {
      projectId: project._id.toString(),
      userId,
      changes: writes.length + deletes.length,
      sha,
    });
  }
}

/** Delete the project's git store (project deletion). */
export async function deleteProjectStore(project: IDbtProject): Promise<void> {
  await deleteRepoDir(
    repoDirFor(project.workspaceId.toString(), project._id.toString()),
  );
}

// ---------------------------------------------------------------------------
// Working-tree state resolution (overlay rebase)
// ---------------------------------------------------------------------------

export interface WorkingTreeState {
  repoDir: string;
  branch: string;
  /** Head commit of the checked-out branch (null: blank project, no commits). */
  headSha: string | null;
  /** Commit whose tree is the user's working tree (draft tip or head). */
  workingSha: string | null;
  /** Draft tip when the user has uncommitted changes. */
  draftTipSha: string | null;
}

/**
 * Resolve the user's working tree, lazily rebasing their draft overlay onto
 * the current head of their checked-out branch. An overlay whose rebase
 * produces no diff is dropped (a clean tree, like `git status`).
 */
export async function resolveWorkingState(
  project: IDbtProject,
  userId: string | undefined,
): Promise<WorkingTreeState> {
  const repoDir = await ensureProjectRepo(project);
  const branch = await getCheckoutBranch(project, userId);
  let headSha = await resolveCommit(repoDir, branchRef(branch));

  if (!headSha && project.repo) {
    // Local mirror doesn't have this branch yet (fresh instance) — fetch it.
    const remote = await resolveProjectRemote(project.repo);
    headSha = await fetchBranch(repoDir, remote, branch);
  }

  if (!project.repo || !userId) {
    return { repoDir, branch, headSha, workingSha: headSha, draftTipSha: null };
  }

  const draftTipSha = await rebaseDraftOntoHead(
    repoDir,
    userId,
    headSha as string,
  );
  return {
    repoDir,
    branch,
    headSha,
    workingSha: draftTipSha ?? headSha,
    draftTipSha,
  };
}

/**
 * Rebase a user's overlay onto `headSha` if it forked from an older base.
 * Returns the (possibly new) draft tip, or null when the user has no pending
 * changes.
 */
async function rebaseDraftOntoHead(
  repoDir: string,
  userId: string,
  headSha: string,
): Promise<string | null> {
  const refs = draftRefsFor(userId);
  return withCasRetry(async () => {
    const tip = await resolveCommit(repoDir, refs.tip);
    if (!tip) return null;
    const base = (await resolveCommit(repoDir, refs.base)) ?? headSha;
    if (base === headSha) return tip;

    const changes = await diffTrees(repoDir, base, tip);
    if (changes.length === 0) {
      await deleteRef(repoDir, refs.tip);
      await deleteRef(repoDir, refs.base);
      return null;
    }

    const writes: Array<{ path: string; content: string }> = [];
    const deletes: string[] = [];
    for (const change of changes) {
      if (change.status === "deleted") {
        deletes.push(change.path);
      } else {
        const content = await readBlobAt(repoDir, tip, change.path);
        writes.push({ path: change.path, content: content ?? "" });
      }
    }
    const { sha, treeSha } = await commitTreeUpdate(repoDir, {
      ref: refs.tip,
      expectedOldSha: tip,
      baseTree: headSha,
      parents: [headSha],
      writes,
      deletes,
      message: "Rebase uncommitted changes",
      author: authorFor(userId),
    });
    if (treeSha === (await treeShaOf(repoDir, headSha))) {
      // The branch already contains every overlay change — tree is clean.
      await deleteRef(repoDir, refs.tip);
      await deleteRef(repoDir, refs.base);
      return null;
    }
    await updateRef(repoDir, refs.base, headSha);
    return sha;
  });
}

/** The user's pending overlay changes (project-relative), post-rebase. */
export async function workingTreeChanges(
  project: IDbtProject,
  state: WorkingTreeState,
): Promise<Array<TreeFileChange & { path: string }>> {
  if (!state.draftTipSha || !state.headSha) return [];
  const changes = await diffTrees(
    state.repoDir,
    state.headSha,
    state.draftTipSha,
  );
  const visible: TreeFileChange[] = [];
  for (const change of changes) {
    const rel = toProjectPath(project, change.path);
    if (rel) visible.push({ ...change, path: rel });
  }
  return visible.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List the paths of a user's working tree: committed base of their checkout
 * branch, overlaid with their pending changes. Blank projects list the
 * shared tree.
 */
export async function listWorkingFiles(
  project: IDbtProject,
  userId: string,
): Promise<WorkingFileMeta[]> {
  const state = await resolveWorkingState(project, userId);
  if (!state.workingSha) return [];
  const entries = await listTree(state.repoDir, state.workingSha);
  const files: WorkingFileMeta[] = [];
  for (const entry of entries) {
    if (entry.size > MAX_DBT_FILE_BYTES) continue;
    const rel = toProjectPath(project, entry.path);
    if (rel) files.push({ path: rel });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one file from the user's working tree. */
export async function readWorkingFile(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<WorkingFile | null> {
  const state = await resolveWorkingState(project, userId);
  if (!state.workingSha) return null;
  const content = await readBlobAt(
    state.repoDir,
    state.workingSha,
    toRepoPath(project, path),
  );
  if (content === null) return null;
  return { path, content };
}

export interface WriteWorkingFileResult {
  /** Commit SHA of the save (draft tip or shared-branch head). */
  sha: string;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface TreeMutation {
  writes: Array<{ path: string; content: string }>;
  deletes: string[];
  message: string;
}

/**
 * Apply a mutation to the user's working tree:
 *  - blank projects commit straight onto the shared branch;
 *  - repo projects commit onto the user's draft overlay (creating it on
 *    demand); an overlay whose tree matches the branch head is dropped.
 */
async function mutateWorkingTree(
  project: IDbtProject,
  userId: string,
  mutation: TreeMutation,
): Promise<WriteWorkingFileResult> {
  const author = authorFor(userId);
  return withCasRetry(async () => {
    const state = await resolveWorkingState(project, userId);
    const repoPathWrites = mutation.writes.map(write => ({
      path: toRepoPath(project, write.path),
      content: write.content,
    }));
    const repoPathDeletes = mutation.deletes.map(path =>
      toRepoPath(project, path),
    );

    if (!project.repo) {
      const head = state.headSha;
      const { sha } = await commitTreeUpdate(state.repoDir, {
        ref: branchRef(state.branch),
        expectedOldSha: head ?? ZERO_SHA,
        baseTree: head ?? undefined,
        parents: head ? [head] : [],
        writes: repoPathWrites,
        deletes: repoPathDeletes,
        message: mutation.message,
        author,
      });
      return { sha };
    }

    const refs = draftRefsFor(userId);
    const parent = state.workingSha as string;
    const { sha, treeSha } = await commitTreeUpdate(state.repoDir, {
      ref: refs.tip,
      expectedOldSha: state.draftTipSha ?? ZERO_SHA,
      baseTree: parent,
      parents: [parent],
      writes: repoPathWrites,
      deletes: repoPathDeletes,
      message: mutation.message,
      author,
    });
    const headTree = await treeShaOf(state.repoDir, state.headSha as string);
    if (treeSha === headTree) {
      // Reverted to the committed content — no pending change to keep.
      await deleteRef(state.repoDir, refs.tip);
      await deleteRef(state.repoDir, refs.base);
      return { sha };
    }
    if (!state.draftTipSha) {
      await updateRef(state.repoDir, refs.base, state.headSha as string);
    }
    return { sha };
  });
}

/** Write to the user's working tree (drafts for repo projects). */
export async function writeWorkingFile(
  project: IDbtProject,
  userId: string,
  path: string,
  content: string,
): Promise<WriteWorkingFileResult> {
  return mutateWorkingTree(project, userId, {
    writes: [{ path, content }],
    deletes: [],
    message: `Save ${path}`,
  });
}

/**
 * Delete a file from the user's working tree. Returns false when the path
 * does not exist in it.
 */
export async function deleteWorkingFile(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<boolean> {
  const existing = await readWorkingFile(project, userId, path);
  if (existing === null) return false;
  await mutateWorkingTree(project, userId, {
    writes: [],
    deletes: [path],
    message: `Delete ${path}`,
  });
  return true;
}

/**
 * Rename within the user's working tree (one commit: add new + delete old).
 * Returns an error string on conflicts, null on success.
 */
export async function renameWorkingFile(
  project: IDbtProject,
  userId: string,
  from: string,
  to: string,
): Promise<string | null> {
  const [source, target] = await Promise.all([
    readWorkingFile(project, userId, from),
    readWorkingFile(project, userId, to),
  ]);
  if (!source) return "File not found";
  if (target) return `"${to}" already exists`;
  await mutateWorkingTree(project, userId, {
    writes: [{ path: to, content: source.content }],
    deletes: [from],
    message: `Rename ${from} → ${to}`,
  });
  return null;
}

/**
 * Discard all of a user's pending changes (`git checkout -- .`). Returns the
 * number of discarded file changes.
 */
export async function discardUserDrafts(
  project: IDbtProject,
  userId: string,
): Promise<number> {
  if (!project.repo) return 0;
  const state = await resolveWorkingState(project, userId);
  const changes = await workingTreeChanges(project, state);
  const refs = draftRefsFor(userId);
  await deleteRef(state.repoDir, refs.tip);
  await deleteRef(state.repoDir, refs.base);
  return changes.length;
}

/**
 * Seed multiple files into a project in one commit (project scaffold /
 * dev seeds). Blank projects only.
 */
export async function seedProjectFiles(
  project: IDbtProject,
  userId: string,
  files: Array<{ path: string; content: string }>,
): Promise<WriteWorkingFileResult> {
  return mutateWorkingTree(project, userId, {
    writes: files,
    deletes: [],
    message: "Scaffold dbt project",
  });
}

// ---------------------------------------------------------------------------
// Full-tree contents (runner materialization)
// ---------------------------------------------------------------------------

/**
 * Full file contents of a working tree, for materializing dbt runs:
 *  - `userId` set → that user's overlay on their checkout branch (IDE/agent
 *    ad-hoc commands see the caller's uncommitted work).
 *  - only `branch` set → the committed tree of that branch (deploy jobs and
 *    CI build exactly what is committed).
 *  - neither → the project default branch's committed tree (blank projects:
 *    the shared tree).
 */
export async function loadWorkingTreeContents(
  project: IDbtProject,
  opts: { userId?: string; branch?: string } = {},
): Promise<Array<{ path: string; content: string }>> {
  const repoDir = await ensureProjectRepo(project);

  let treeish: string | null;
  if (opts.branch) {
    treeish = await resolveCommit(repoDir, branchRef(opts.branch));
    if (!treeish && project.repo) {
      const remote = await resolveProjectRemote(project.repo);
      treeish = await fetchBranch(repoDir, remote, opts.branch);
    }
  } else {
    const state = await resolveWorkingState(project, opts.userId);
    treeish = state.workingSha;
  }
  if (!treeish) return [];

  const entries = (await listTree(repoDir, treeish)).filter(
    entry =>
      entry.size <= MAX_DBT_FILE_BYTES &&
      toProjectPath(project, entry.path) !== null,
  );
  const blobs = await readBlobs(
    repoDir,
    entries.map(entry => entry.blobSha),
  );
  return entries
    .map(entry => ({
      path: toProjectPath(project, entry.path) as string,
      content: blobs.get(entry.blobSha) ?? "",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
