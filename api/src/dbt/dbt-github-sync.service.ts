/**
 * Import / sync dbt project files from a GitHub repository into Mongo
 * (DbtFile). Mongo stays the canonical source the runner materializes from;
 * this service is the bridge that pulls a repo's contents in.
 *
 * DbtFile rows are the COMMITTED base tree of a branch — uncommitted work
 * lives in per-user DbtFileDraft overlays — so a sync is always safe: the
 * remote is authoritative for the base tree and can never clobber anyone's
 * drafts. Files present on the branch are upserted, files no longer on the
 * branch are soft-deleted (a branch pull, like dbt Cloud).
 */
import { Types } from "mongoose";

import {
  DbtCheckout,
  DbtFile,
  type IDbtProject,
  type IDbtRepoBinding,
} from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import {
  getBlobContent,
  getBranchHeadSha,
  getRepoInfo,
  getRepoTree,
} from "../integrations/github/github-api";
import {
  getCheckoutBranch,
  loadWorkingTreeContents,
} from "./dbt-working-tree.service";
import { loggers } from "../logging";

const logger = loggers.app();

/** Per-file cap (matches the PUT /files content limit). */
const MAX_FILE_BYTES = 1_000_000;
/** Safety cap on number of imported files. */
const MAX_FILES = 3000;
/** Concurrent blob fetches. */
const BLOB_CONCURRENCY = 8;

/**
 * Text extensions we import. dbt projects are SQL/YAML/CSV/Markdown; we also
 * keep .gitkeep so empty model dirs survive. Generated/vendored output and
 * binary assets are skipped.
 */
const TEXT_EXTENSIONS = new Set([
  "sql",
  "yml",
  "yaml",
  "md",
  "csv",
  "json",
  "txt",
  "sh",
  "py",
]);

/** Directories that are generated, vendored, or irrelevant to a dbt build. */
const SKIP_DIR_PREFIXES = [
  "target/",
  "dbt_packages/",
  "dbt_internal_packages/",
  "logs/",
  ".git/",
];

export function normalizeSubdir(subdirectory?: string): string {
  if (!subdirectory) return "";
  return subdirectory.replace(/^\/+|\/+$/g, "");
}

function hasTextExtension(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (base === ".gitkeep") return true;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

export function isImportable(path: string): boolean {
  if (SKIP_DIR_PREFIXES.some(prefix => path.startsWith(prefix))) return false;
  // Mako renders profiles.yml itself; never import a committed one.
  if (path === "profiles.yml" || path.endsWith("/profiles.yml")) return false;
  return hasTextExtension(path);
}

export interface FetchedRepoFile {
  path: string;
  content: string;
  /** Git blob SHA of the file on the branch (for working-tree diffing). */
  blobSha: string;
}

export interface FetchedRepoFiles {
  /** Commit SHA at the branch head when the tree was read. */
  sha: string;
  files: FetchedRepoFile[];
  /** Files skipped because they exceeded MAX_FILE_BYTES. */
  skippedLarge: string[];
}

/**
 * Read all importable dbt files from a repo branch (relative to an optional
 * sub-directory). Used both for first import and for re-sync.
 */
export async function fetchRepoDbtFiles(
  binding: Pick<
    IDbtRepoBinding,
    "owner" | "repo" | "branch" | "subdirectory" | "installationId"
  >,
): Promise<FetchedRepoFiles> {
  const { owner, repo, branch } = binding;
  const subdir = normalizeSubdir(binding.subdirectory);
  const token = await resolveRepoToken(binding.installationId);

  const sha = await getBranchHeadSha(owner, repo, branch, token);
  const tree = await getRepoTree(owner, repo, sha, token);
  if (tree.truncated) {
    throw new Error(
      "Repository tree is too large to import (GitHub truncated the listing)",
    );
  }

  const prefix = subdir ? `${subdir}/` : "";
  const blobs = tree.entries.filter(
    e =>
      e.type === "blob" &&
      (prefix ? e.path.startsWith(prefix) : true) &&
      isImportable(prefix ? e.path.slice(prefix.length) : e.path),
  );

  if (blobs.length > MAX_FILES) {
    throw new Error(
      `Repository has ${blobs.length} importable files (limit ${MAX_FILES})`,
    );
  }

  const skippedLarge: string[] = [];
  const files: FetchedRepoFile[] = [];

  // Fetch blob contents with bounded concurrency.
  for (let i = 0; i < blobs.length; i += BLOB_CONCURRENCY) {
    const batch = blobs.slice(i, i + BLOB_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async entry => {
        const relPath = prefix ? entry.path.slice(prefix.length) : entry.path;
        if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
          return { path: relPath, content: null as string | null, blobSha: "" };
        }
        const content = await getBlobContent(owner, repo, entry.sha, token);
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          return { path: relPath, content: null as string | null, blobSha: "" };
        }
        return { path: relPath, content, blobSha: entry.sha };
      }),
    );
    for (const r of results) {
      if (r.content === null) skippedLarge.push(r.path);
      else files.push({ path: r.path, content: r.content, blobSha: r.blobSha });
    }
  }

  return { sha, files, skippedLarge };
}

export interface SyncResult {
  sha: string;
  added: number;
  updated: number;
  deleted: number;
  skippedLarge: string[];
}

/**
 * Pull the latest state of `branch` into the project's committed base tree
 * for that branch: upsert changed files, soft-delete files no longer on the
 * branch, and stamp sync SHAs (the project binding when it is the default
 * branch, plus every checkout pointing at the branch).
 *
 * Always safe: drafts (uncommitted per-user work) live in a separate overlay
 * and are never touched by a sync.
 */
export async function syncProjectBranchFromRepo(
  project: IDbtProject,
  branch: string,
  updatedBy: string,
): Promise<SyncResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  // Read fields explicitly: `repo` is a Mongoose subdocument on hydrated
  // docs, and spreading one drops its schema fields (they live on the
  // prototype), which would fetch from "undefined/undefined".
  const { sha, files, skippedLarge } = await fetchRepoDbtFiles({
    owner: project.repo.owner,
    repo: project.repo.repo,
    subdirectory: project.repo.subdirectory,
    installationId: project.repo.installationId,
    branch,
  });

  const existing = await DbtFile.find({ projectId: project._id, branch })
    .select("path content is_deleted repoBlobSha")
    .lean();
  const existingByPath = new Map(existing.map(f => [f.path, f]));
  const remotePaths = new Set(files.map(f => f.path));

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const ops: Array<Promise<unknown>> = [];
  for (const file of files) {
    const prev = existingByPath.get(file.path);

    if (!prev || prev.is_deleted) {
      added++;
    } else if (prev.content !== file.content) {
      updated++;
    } else {
      // Content unchanged, but still record the blob SHA so diffing works.
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, branch, path: file.path },
          { $set: { repoBlobSha: file.blobSha } },
        ).exec(),
      );
      continue;
    }
    ops.push(
      DbtFile.updateOne(
        { projectId: project._id, branch, path: file.path },
        {
          $set: {
            content: file.content,
            updatedBy,
            is_deleted: false,
            workspaceId: project.workspaceId,
            repoBlobSha: file.blobSha,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec(),
    );
  }

  // Reconcile files that are no longer on the branch. The remote is the source
  // of truth for the base tree, so a file absent upstream is soft-deleted and
  // must NOT keep a repoBlobSha (a stale one would surface phantom pending
  // deletions in per-user status).
  for (const prev of existing) {
    if (remotePaths.has(prev.path)) continue;

    if (!prev.is_deleted) {
      deleted++;
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, branch, path: prev.path },
          {
            $set: { is_deleted: true, updatedBy },
            $unset: { repoBlobSha: "" },
          },
        ).exec(),
      );
    } else if (prev.repoBlobSha) {
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, branch, path: prev.path },
          { $unset: { repoBlobSha: "" } },
        ).exec(),
      );
    }
  }

  await Promise.all(ops);

  if (branch === project.repo.branch) {
    project.repo.lastSyncedSha = sha;
    project.repo.lastSyncedAt = new Date();
    project.markModified("repo");
    await project.save();
  }
  await DbtCheckout.updateMany(
    { projectId: project._id, branch },
    { $set: { lastSyncedSha: sha, lastSyncedAt: new Date() } },
  ).exec();

  return { sha, added, updated, deleted, skippedLarge };
}

/** True when a file tree contains the root dbt_project.yml dbt requires. */
export function hasRootDbtProjectYml(files: Array<{ path: string }>): boolean {
  return files.some(file => file.path === "dbt_project.yml");
}

/**
 * The project's tracked branch no longer exists on the remote (a stale
 * pointer from the pre-per-user-working-trees model, deleted after its PR
 * merged): re-anchor `repo.branch` to the repository's default branch and
 * pull that branch's tree. Only fires when the branch is verifiably gone —
 * a transient sync failure must never rewrite project config.
 */
async function reanchorTrackedBranch(
  project: IDbtProject,
  branch: string,
  syncError: unknown,
  updatedBy: string,
): Promise<void> {
  if (!project.repo || branch !== project.repo.branch) throw syncError;
  const token = await resolveRepoToken(project.repo.installationId);
  const { owner, repo } = project.repo;
  const info = await getRepoInfo(owner, repo, token);
  if (info.defaultBranch === branch) throw syncError;
  const stillExists = await getBranchHeadSha(owner, repo, branch, token).then(
    () => true,
    () => false,
  );
  if (stillExists) throw syncError;

  logger.warn(
    "dbt tracked branch is gone on the remote; re-anchoring to repo default",
    {
      projectId: project._id.toString(),
      staleBranch: branch,
      defaultBranch: info.defaultBranch,
    },
  );
  project.repo.branch = info.defaultBranch;
  project.markModified("repo");
  await project.save();
  await syncProjectBranchFromRepo(project, info.defaultBranch, updatedBy);
}

/**
 * Load a project's working-tree contents for a dbt run, self-healing the two
 * states that would otherwise reach dbt as the confusing
 * "No dbt_project.yml found at expected path <dir>/dbt_project.yml" (and, in
 * a warm dir, reconcile the previously-good tree away):
 *
 *  1. the branch's committed base tree is missing/incomplete in Mongo (e.g.
 *     dropped when its branch was deleted) → re-pull the branch;
 *  2. the tracked branch itself no longer exists on the remote → re-anchor
 *     `repo.branch` to the repo default branch and pull that.
 *
 * Throws an actionable error when the tree still has no dbt_project.yml.
 */
export async function loadRunnableWorkingTree(
  project: IDbtProject,
  opts: { userId?: string; branch?: string } = {},
): Promise<Array<{ path: string; content: string }>> {
  let files = await loadWorkingTreeContents(project, opts);
  if (hasRootDbtProjectYml(files)) return files;

  let branch: string | undefined;
  if (project.repo) {
    branch =
      opts.branch ??
      (opts.userId
        ? await getCheckoutBranch(project, opts.userId)
        : project.repo.branch);
    const updatedBy = opts.userId ?? "system";
    logger.warn("dbt working tree has no dbt_project.yml; re-syncing branch", {
      projectId: project._id.toString(),
      branch,
    });
    try {
      await syncProjectBranchFromRepo(project, branch as string, updatedBy);
    } catch (syncError) {
      await reanchorTrackedBranch(
        project,
        branch as string,
        syncError,
        updatedBy,
      );
    }
    files = await loadWorkingTreeContents(project, opts);
  }

  if (!hasRootDbtProjectYml(files)) {
    const where = branch ? ` on branch "${branch}"` : "";
    throw new Error(
      `dbt project "${project.name}" has no dbt_project.yml in its working ` +
        `tree${where} — the project files are missing or not synced. ` +
        (project.repo
          ? "Check the repository/subdirectory binding and run a sync " +
            "(Version control → Sync, or dbt_sync_from_repo)."
          : "Create a dbt_project.yml at the project root first."),
    );
  }
  return files;
}

/** Sync the project's default branch (backwards-compatible entry point). */
export async function syncProjectFromRepo(
  project: IDbtProject,
  updatedBy: string,
): Promise<SyncResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  return syncProjectBranchFromRepo(project, project.repo.branch, updatedBy);
}

/** Build a DbtFile insert payload from fetched repo files (first import). */
export function repoFilesToInserts(
  files: FetchedRepoFile[],
  params: {
    workspaceId: Types.ObjectId;
    projectId: Types.ObjectId;
    branch: string;
    updatedBy: string;
  },
) {
  return files.map(file => ({
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    branch: params.branch,
    path: file.path,
    content: file.content,
    updatedBy: params.updatedBy,
    repoBlobSha: file.blobSha,
  }));
}
