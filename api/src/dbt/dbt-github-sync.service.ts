/**
 * Import / sync dbt project files from a GitHub repository into Mongo
 * (DbtFile). Mongo stays the canonical source the runner materializes from;
 * this service is the bridge that pulls a repo's contents in.
 *
 * On sync the repo is treated as the source of truth: files present in the
 * tracked branch are upserted, and previously-imported files that no longer
 * exist on the branch are soft-deleted (a branch pull, like dbt Cloud).
 * Committing local edits back to the repo is a later slice.
 */
import { Types } from "mongoose";

import {
  DbtFile,
  type IDbtProject,
  type IDbtRepoBinding,
} from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { gitBlobSha } from "../integrations/github/git-blob";
import {
  getBlobContent,
  getBranchHeadSha,
  getRepoTree,
} from "../integrations/github/github-api";

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
  /**
   * Paths skipped because they had uncommitted local edits and
   * `preserveLocalEdits` was set — left untouched so the work isn't lost.
   */
  preservedLocal: string[];
}

export interface SyncOptions {
  /**
   * When true, never overwrite or soft-delete a file that has uncommitted local
   * changes (locally added, or content diverged from its last-synced blob).
   * Non-conflicting files still fast-forward to the remote. This makes a sync
   * safe like `git pull` (which refuses to clobber a dirty working tree) and is
   * used for background/automatic syncs (push webhooks, branch switches that
   * the caller hasn't explicitly told to discard). Defaults to false, where the
   * remote is the source of truth (an explicit, user-confirmed overwrite).
   */
  preserveLocalEdits?: boolean;
}

/** A file is locally modified if its current content no longer matches the
 * blob recorded at the last sync/push — or it was added locally and never
 * synced (no recorded blob). Soft-deleted rows are handled separately. */
function isLocallyModified(prev: {
  content?: string;
  is_deleted?: boolean;
  repoBlobSha?: string;
}): boolean {
  if (prev.is_deleted) return false;
  if (!prev.repoBlobSha) return true; // locally added, never pushed
  return gitBlobSha(prev.content ?? "") !== prev.repoBlobSha;
}

/**
 * Pull the latest repo state into an existing repo-bound project: upsert
 * changed files, soft-delete files no longer on the branch, and stamp the
 * project's lastSyncedSha/At.
 *
 * By default the remote wins (use only for explicit, user-confirmed pulls). For
 * background syncs pass `{ preserveLocalEdits: true }` so a remote push or a
 * branch switch can never silently destroy a user's uncommitted working-tree
 * changes — those files are left exactly as-is and reported in `preservedLocal`.
 */
export async function syncProjectFromRepo(
  project: IDbtProject,
  updatedBy: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  if (!project.repo) {
    throw new Error("Project is not connected to a repository");
  }
  const preserveLocalEdits = options.preserveLocalEdits ?? false;
  const { sha, files, skippedLarge } = await fetchRepoDbtFiles(project.repo);

  const existing = await DbtFile.find({ projectId: project._id })
    .select("path content is_deleted repoBlobSha")
    .lean();
  const existingByPath = new Map(existing.map(f => [f.path, f]));
  const remotePaths = new Set(files.map(f => f.path));

  let added = 0;
  let updated = 0;
  let deleted = 0;
  const preservedLocal: string[] = [];

  const ops: Array<Promise<unknown>> = [];
  for (const file of files) {
    const prev = existingByPath.get(file.path);

    // Don't clobber a file the user is actively editing locally. Leave it
    // untouched (and keep its old base blob) so it still shows as a pending
    // change the user can review/commit, rather than vanishing.
    if (preserveLocalEdits && prev && isLocallyModified(prev)) {
      preservedLocal.push(file.path);
      continue;
    }

    if (!prev || prev.is_deleted) {
      added++;
    } else if (prev.content !== file.content) {
      updated++;
    } else {
      // Content unchanged, but still record the blob SHA so diffing works.
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, path: file.path },
          { $set: { repoBlobSha: file.blobSha } },
        ).exec(),
      );
      continue;
    }
    ops.push(
      DbtFile.updateOne(
        { projectId: project._id, path: file.path },
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

  // Reconcile files that are no longer on the branch. Pulling makes the remote
  // the source of truth, so a file absent upstream is "in sync when deleted" —
  // it must NOT keep a repoBlobSha, or getGitStatus() would surface it as a
  // permanent phantom "deleted" change that can never be committed (committing
  // a sha:null delete for a path missing from base_tree → 422 GitRPC::BadObject)
  // nor discarded (the next pull would re-create it).
  for (const prev of existing) {
    if (remotePaths.has(prev.path)) continue;

    // A locally-added file (never on this branch) is unsaved work, not a
    // deletion. Under preserveLocalEdits, keep it instead of soft-deleting it —
    // this is the exact case that used to wipe new models on a branch switch.
    if (preserveLocalEdits && !prev.is_deleted && !prev.repoBlobSha) {
      preservedLocal.push(prev.path);
      continue;
    }

    if (!prev.is_deleted) {
      deleted++;
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, path: prev.path },
          {
            $set: { is_deleted: true, updatedBy },
            $unset: { repoBlobSha: "" },
          },
        ).exec(),
      );
    } else if (prev.repoBlobSha) {
      // Already soft-deleted locally and gone upstream: drop the stale blob SHA
      // so it stops counting as a pending deletion (heals previously-stuck rows).
      ops.push(
        DbtFile.updateOne(
          { projectId: project._id, path: prev.path },
          { $unset: { repoBlobSha: "" } },
        ).exec(),
      );
    }
  }

  await Promise.all(ops);

  project.repo.lastSyncedSha = sha;
  project.repo.lastSyncedAt = new Date();
  project.markModified("repo");
  await project.save();

  return { sha, added, updated, deleted, skippedLarge, preservedLocal };
}

/** Build a DbtFile insert payload from fetched repo files (first import). */
export function repoFilesToInserts(
  files: FetchedRepoFile[],
  params: {
    workspaceId: Types.ObjectId;
    projectId: Types.ObjectId;
    updatedBy: string;
  },
) {
  return files.map(file => ({
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    path: file.path,
    content: file.content,
    updatedBy: params.updatedBy,
    repoBlobSha: file.blobSha,
  }));
}
