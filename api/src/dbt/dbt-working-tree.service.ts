/**
 * Per-user dbt working trees.
 *
 * Repo-bound projects keep one COMMITTED base tree per checked-out branch in
 * DbtFile (content mirrors the branch head) and a per-user draft overlay in
 * DbtFileDraft. A user's working tree is draft-over-base for the branch their
 * DbtCheckout points at, so uncommitted work is only ever visible to its
 * author — collaborators see changes when they are committed, like separate
 * git clones.
 *
 * Blank (non-repo) projects keep the original shared model: DbtFile rows with
 * no `branch` are the single working tree every member edits directly.
 */

import { Types } from "mongoose";
import {
  DbtCheckout,
  DbtFile,
  DbtFileDraft,
  type IDbtProject,
} from "../database/workspace-schema";
import { gitBlobSha } from "../integrations/github/git-blob";

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

/**
 * Branch the user's checkout points at. Falls back to the project default
 * branch when the user never switched (implicit checkout). Undefined for
 * blank projects (no git surface).
 */
export async function getCheckoutBranch(
  project: IDbtProject,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!project.repo) return undefined;
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

/** Base-tree filter for a repo project branch (blank projects: branch null). */
export function baseTreeFilter(
  project: IDbtProject,
  branch: string | undefined,
): Record<string, unknown> {
  return branch
    ? { projectId: project._id, branch }
    : { projectId: project._id, branch: { $in: [null, undefined] } };
}

/** True when the base tree for a branch has been materialized into Mongo. */
export async function branchBaseTreeExists(
  project: IDbtProject,
  branch: string,
): Promise<boolean> {
  const row = await DbtFile.exists({ projectId: project._id, branch });
  return Boolean(row);
}

/**
 * Clone the committed base tree of one branch to another (branch create /
 * atomic promote fork point — content is identical, so no GitHub round-trip).
 * No-op when the target branch already has a base tree.
 */
export async function cloneBranchBaseTree(
  project: IDbtProject,
  fromBranch: string,
  toBranch: string,
): Promise<void> {
  if (await branchBaseTreeExists(project, toBranch)) return;
  const rows = await DbtFile.find({
    projectId: project._id,
    branch: fromBranch,
    is_deleted: { $ne: true },
  })
    .select("path content updatedBy repoBlobSha")
    .lean();
  if (rows.length === 0) return;
  await DbtFile.insertMany(
    rows.map(row => ({
      workspaceId: project.workspaceId,
      projectId: project._id,
      branch: toBranch,
      path: row.path,
      content: row.content ?? "",
      updatedBy: row.updatedBy,
      repoBlobSha: row.repoBlobSha,
    })),
    { ordered: false },
  );
}

/** Drop a branch's base tree (after the remote branch was deleted). */
export async function deleteBranchBaseTree(
  project: IDbtProject,
  branch: string,
): Promise<void> {
  await DbtFile.deleteMany({ projectId: project._id, branch }).exec();
}

interface BaseRowLean {
  path: string;
  content?: string;
  is_deleted?: boolean;
  repoBlobSha?: string;
  updatedAt?: Date;
  updatedBy?: string;
}

interface DraftLean {
  path: string;
  content?: string;
  is_deleted?: boolean;
  updatedAt?: Date;
}

async function loadBaseRows(
  project: IDbtProject,
  branch: string | undefined,
): Promise<BaseRowLean[]> {
  return DbtFile.find({
    ...baseTreeFilter(project, branch),
    is_deleted: { $ne: true },
  })
    .select("path content repoBlobSha updatedAt updatedBy")
    .lean();
}

async function loadDrafts(
  project: IDbtProject,
  userId: string,
): Promise<DraftLean[]> {
  return DbtFileDraft.find({ projectId: project._id, userId })
    .select("path content is_deleted updatedAt")
    .lean();
}

/**
 * List the paths of a user's working tree: committed base of their checkout
 * branch, overlaid with their drafts (added files appear, draft-deleted files
 * disappear). Blank projects list the shared tree.
 */
export async function listWorkingFiles(
  project: IDbtProject,
  userId: string,
): Promise<WorkingFileMeta[]> {
  if (!project.repo) {
    return loadBaseRows(project, undefined);
  }
  const branch = await getCheckoutBranch(project, userId);
  const [baseRows, drafts] = await Promise.all([
    loadBaseRows(project, branch),
    loadDrafts(project, userId),
  ]);
  const merged = new Map<string, WorkingFileMeta>();
  for (const row of baseRows) {
    merged.set(row.path, {
      path: row.path,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    });
  }
  for (const draft of drafts) {
    if (draft.is_deleted) {
      merged.delete(draft.path);
    } else {
      merged.set(draft.path, {
        path: draft.path,
        updatedAt: draft.updatedAt,
        updatedBy: userId,
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one file from the user's working tree (draft wins over base). */
export async function readWorkingFile(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<WorkingFile | null> {
  if (project.repo) {
    const draft = await DbtFileDraft.findOne({
      projectId: project._id,
      userId,
      path,
    }).lean();
    if (draft) {
      if (draft.is_deleted) return null;
      return {
        path,
        content: draft.content ?? "",
        updatedAt: draft.updatedAt,
        updatedBy: userId,
      };
    }
  }
  const branch = project.repo
    ? await getCheckoutBranch(project, userId)
    : undefined;
  const base = await DbtFile.findOne({
    ...baseTreeFilter(project, branch),
    path,
    is_deleted: { $ne: true },
  }).lean();
  if (!base) return null;
  return {
    path,
    content: base.content ?? "",
    updatedAt: base.updatedAt,
    updatedBy: base.updatedBy,
  };
}

export interface WriteWorkingFileResult {
  /** Id used for entity-version snapshots (draft or shared file doc). */
  versionEntityId: Types.ObjectId;
}

/**
 * Write to the user's working tree. Repo projects write a draft overlay
 * (invisible to other users); blank projects write the shared DbtFile row.
 * A draft whose content matches the committed base is dropped (a no-diff
 * buffer is not a pending change), mirroring `git status`.
 */
export async function writeWorkingFile(
  project: IDbtProject,
  userId: string,
  path: string,
  content: string,
): Promise<WriteWorkingFileResult> {
  if (!project.repo) {
    const file = await DbtFile.findOneAndUpdate(
      { projectId: project._id, path },
      {
        $set: {
          content,
          updatedBy: userId,
          is_deleted: false,
          workspaceId: project.workspaceId,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { versionEntityId: file._id };
  }

  const branch = await getCheckoutBranch(project, userId);
  const base = await DbtFile.findOne({
    ...baseTreeFilter(project, branch),
    path,
    is_deleted: { $ne: true },
  })
    .select("content repoBlobSha")
    .lean();

  if (base && (base.content ?? "") === content) {
    // Reverted to the committed content — no pending change to keep.
    const existing = await DbtFileDraft.findOneAndDelete({
      projectId: project._id,
      userId,
      path,
    });
    return { versionEntityId: existing?._id ?? new Types.ObjectId() };
  }

  const draft = await DbtFileDraft.findOneAndUpdate(
    { projectId: project._id, userId, path },
    {
      $set: {
        content,
        is_deleted: false,
        workspaceId: project.workspaceId,
      },
      $setOnInsert: {
        baseBlobSha: base?.repoBlobSha ?? gitBlobSha(base?.content ?? ""),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return { versionEntityId: draft._id };
}

/**
 * Delete a file from the user's working tree. For repo projects a base file
 * becomes a pending draft deletion (staged `git rm`); a draft-only file just
 * drops the draft. Returns false when the path does not exist.
 */
export async function deleteWorkingFile(
  project: IDbtProject,
  userId: string,
  path: string,
): Promise<boolean> {
  if (!project.repo) {
    const result = await DbtFile.updateOne(
      { projectId: project._id, path },
      { $set: { is_deleted: true, updatedBy: userId } },
    );
    return result.matchedCount > 0;
  }

  const branch = await getCheckoutBranch(project, userId);
  const [base, draft] = await Promise.all([
    DbtFile.exists({
      ...baseTreeFilter(project, branch),
      path,
      is_deleted: { $ne: true },
    }),
    DbtFileDraft.findOne({ projectId: project._id, userId, path })
      .select("is_deleted")
      .lean(),
  ]);

  if (base) {
    await DbtFileDraft.updateOne(
      { projectId: project._id, userId, path },
      {
        $set: {
          content: "",
          is_deleted: true,
          workspaceId: project.workspaceId,
        },
      },
      { upsert: true },
    ).exec();
    return true;
  }
  if (draft && !draft.is_deleted) {
    // Draft-only file (added, never committed): removing it needs no pending
    // deletion — just discard the draft.
    await DbtFileDraft.deleteOne({
      projectId: project._id,
      userId,
      path,
    }).exec();
    return true;
  }
  return false;
}

/**
 * Rename within the user's working tree. Repo projects express the rename as
 * draft ops (delete old path + add new path); blank projects move the shared
 * row. Returns an error string on conflicts, null on success.
 */
export async function renameWorkingFile(
  project: IDbtProject,
  userId: string,
  from: string,
  to: string,
): Promise<string | null> {
  if (!project.repo) {
    const existing = await DbtFile.findOne({
      projectId: project._id,
      path: to,
      is_deleted: { $ne: true },
    });
    if (existing) return `"${to}" already exists`;
    await DbtFile.deleteOne({ projectId: project._id, path: to });
    const result = await DbtFile.updateOne(
      { projectId: project._id, path: from, is_deleted: { $ne: true } },
      { $set: { path: to, updatedBy: userId } },
    );
    return result.matchedCount === 0 ? "File not found" : null;
  }

  const [source, target] = await Promise.all([
    readWorkingFile(project, userId, from),
    readWorkingFile(project, userId, to),
  ]);
  if (!source) return "File not found";
  if (target) return `"${to}" already exists`;
  await writeWorkingFile(project, userId, to, source.content);
  await deleteWorkingFile(project, userId, from);
  return null;
}

/** Discard all of a user's drafts for a project (`git checkout -- .`). */
export async function discardUserDrafts(
  project: IDbtProject,
  userId: string,
): Promise<number> {
  const result = await DbtFileDraft.deleteMany({
    projectId: project._id,
    userId,
  }).exec();
  return result.deletedCount ?? 0;
}

/**
 * Full file contents of a working tree, for materializing dbt runs:
 *  - `userId` set → that user's overlay on their checkout branch (IDE/agent
 *    ad-hoc commands see the caller's uncommitted work).
 *  - only `branch` set → the committed base tree of that branch (deploy jobs
 *    and CI build exactly what is committed).
 *  - neither → the project default branch's committed tree (blank projects:
 *    the shared tree).
 */
export async function loadWorkingTreeContents(
  project: IDbtProject,
  opts: { userId?: string; branch?: string } = {},
): Promise<Array<{ path: string; content: string }>> {
  if (!project.repo) {
    const rows = await loadBaseRows(project, undefined);
    return rows.map(row => ({ path: row.path, content: row.content ?? "" }));
  }
  const branch =
    opts.branch ??
    (opts.userId
      ? await getCheckoutBranch(project, opts.userId)
      : project.repo.branch);
  const baseRows = await loadBaseRows(project, branch);
  const files = new Map<string, string>(
    baseRows.map(row => [row.path, row.content ?? ""]),
  );
  if (opts.userId) {
    const drafts = await loadDrafts(project, opts.userId);
    for (const draft of drafts) {
      if (draft.is_deleted) files.delete(draft.path);
      else files.set(draft.path, draft.content ?? "");
    }
  }
  return [...files.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
