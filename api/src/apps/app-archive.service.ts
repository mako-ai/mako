/**
 * Archived apps — the Apps home's "Archived" chip.
 *
 * The lifecycle job (app-lifecycle.service) archives a stale app by moving
 * its folder `apps/x` → `archive/apps/x` (or `users/<h>/apps/x` →
 * `archive/users/<h>/apps/x`, with a `-YYYY-MM-DD` suffix when that address
 * was archived before). `archive/` is outside the app trees, so the index
 * ignores it; this module reads it straight from the tree at main — one
 * `ls-tree` and one `log`, cached by main's sha — and restores an app by
 * moving it back (worktree.service restoreArchivedProject).
 *
 * Visibility is the app list's: canSeeIndexedApp over the ORIGINAL
 * location (a personal app is its mapped owner's, through the handle
 * mapping) and the app's state row, which an archive keeps.
 */
import { Types } from "mongoose";
import { AppLifecycleState, AppProject } from "../database/workspace-schema";
import { loggers } from "../logging";
import { authorizeFolderTarget, canSeeIndexedApp } from "./app-authorization";
import { APP_THUMBNAIL_FILES, loadAppsIndex } from "./app-index.service";
import {
  APP_MANIFEST,
  parseAppManifest,
  parseAppRepoPath,
  type AppScope,
} from "./app-paths";
import { runGit } from "./git";
import { DEFAULT_BRANCH, resolveCommit } from "./repository.service";
import { loadOwnerDirectory } from "./user-handles.service";
import {
  ARCHIVE_DIR,
  AppFolderError,
  restoreArchivedProject,
} from "./worktree.service";
import { boundRepoDirIfExists } from "./workspace-repo-required";

const logger = loggers.api("apps-archive");

/** One archived app folder, as main has it. */
export interface ArchivedTreeEntry {
  /** Where it is now: `archive/apps/x`. */
  path: string;
  /** Where it came from (best guess from the path alone). */
  derivedOriginalPath: string;
  appId?: string;
  title: string;
  description?: string;
  thumbnail: { file: string; oid: string } | null;
  archivedAt?: string;
  archivedBy?: { name: string; email: string };
}

export interface ArchivedApp extends Omit<
  ArchivedTreeEntry,
  "derivedOriginalPath"
> {
  /** Where Restore puts it back. */
  originalPath: string;
  scope: AppScope;
  ownerId?: string;
  ownerHandle?: string;
}

/** `archive/apps/x-2026-10-20-2` → `apps/x`; null when not an app path. */
export function originalPathOf(archivedPath: string): string | null {
  if (!archivedPath.startsWith(`${ARCHIVE_DIR}/`)) return null;
  const rest = archivedPath.slice(ARCHIVE_DIR.length + 1);
  const unsuffixed = rest.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, "");
  if (unsuffixed !== rest && parseAppRepoPath(unsuffixed)) return unsuffixed;
  return parseAppRepoPath(rest) ? rest : null;
}

/**
 * The archived app folders in an `ls-tree -r` listing of `archive/`: every
 * folder holding a mako.json whose original location is an app path, minus
 * folders nested inside another archived app. Pure, so it is unit-tested.
 */
export function archivedFoldersIn(lsTree: string): Array<{
  path: string;
  originalPath: string;
  manifestOid: string;
  thumbnail: { file: string; oid: string } | null;
}> {
  const blobs = new Map<string, string>();
  for (const line of lsTree.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = line.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !oid) continue;
    blobs.set(line.slice(tab + 1), oid);
  }
  const dirs = [...blobs.keys()]
    .filter(f => f.endsWith(`/${APP_MANIFEST}`))
    .map(f => f.slice(0, -APP_MANIFEST.length - 1))
    .filter(d => originalPathOf(d) !== null)
    .sort();
  const out = [];
  for (const dir of dirs) {
    if (dirs.some(other => other !== dir && dir.startsWith(`${other}/`))) {
      continue;
    }
    const manifestOid = blobs.get(`${dir}/${APP_MANIFEST}`);
    const originalPath = originalPathOf(dir);
    if (!manifestOid || !originalPath) continue;
    let thumbnail: { file: string; oid: string } | null = null;
    for (const file of APP_THUMBNAIL_FILES) {
      const oid = blobs.get(`${dir}/${file}`);
      if (oid) {
        thumbnail = { file, oid };
        break;
      }
    }
    out.push({ path: dir, originalPath, manifestOid, thumbnail });
  }
  return out;
}

/**
 * When and by whom each archived folder arrived, from
 * `git log --diff-filter=A --format=%x00%aI%x00%an%x00%ae --name-only`:
 * the NEWEST commit that added its mako.json (log order is newest first).
 */
export function archiveCommitsIn(
  log: string,
): Map<string, { at: string; name: string; email: string }> {
  const out = new Map<string, { at: string; name: string; email: string }>();
  const records = log.split("\0");
  // Records come as [ "", at, name, email\n\nfiles..., at, name, ... ].
  for (let i = 1; i + 2 < records.length; i += 3) {
    const at = records[i].trim();
    const name = records[i + 1];
    const [email, ...files] = records[i + 2].split("\n");
    for (const file of files.map(f => f.trim()).filter(Boolean)) {
      if (!file.endsWith(`/${APP_MANIFEST}`)) continue;
      const dir = file.slice(0, -APP_MANIFEST.length - 1);
      if (!out.has(dir)) {
        out.set(dir, { at, name, email: email.trim() });
      }
    }
  }
  return out;
}

const treeCache = new Map<
  string,
  { sha: string; entries: ArchivedTreeEntry[] }
>();

/** Forget cached archive listings (tests). */
export function invalidateArchiveCache(workspaceId?: string): void {
  if (workspaceId) treeCache.delete(workspaceId);
  else treeCache.clear();
}

/** Every archived app folder on main, unfiltered. Cached by main's sha. */
async function loadArchivedTree(
  workspaceId: string,
): Promise<ArchivedTreeEntry[]> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir === null) return [];
  const sha = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!sha) return [];
  const cached = treeCache.get(workspaceId);
  if (cached?.sha === sha) return cached.entries;

  const [{ stdout: tree }, { stdout: log }] = await Promise.all([
    runGit(["-C", repoDir, "ls-tree", "-r", sha, "--", ARCHIVE_DIR], {
      timeoutMs: 15_000,
      maxBufferBytes: 64 * 1024 * 1024,
    }),
    runGit(
      [
        "-C",
        repoDir,
        "log",
        sha,
        "--diff-filter=A",
        "--format=%x00%aI%x00%an%x00%ae",
        "--name-only",
        "--",
        ARCHIVE_DIR,
      ],
      { timeoutMs: 15_000, maxBufferBytes: 64 * 1024 * 1024 },
    ),
  ]);
  const folders = archivedFoldersIn(tree);
  const commits = archiveCommitsIn(log);
  const entries = await Promise.all(
    folders.map(async folder => {
      const manifest = await runGit([
        "-C",
        repoDir,
        "cat-file",
        "blob",
        folder.manifestOid,
      ]).then(
        r => r.stdout,
        () => null,
      );
      const slug = folder.originalPath.split("/").pop() ?? folder.path;
      const parsed = parseAppManifest(manifest, slug);
      const commit = commits.get(folder.path);
      const entry: ArchivedTreeEntry = {
        path: folder.path,
        derivedOriginalPath: folder.originalPath,
        title: parsed.title,
        thumbnail: folder.thumbnail,
        ...(parsed.id ? { appId: parsed.id } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(commit
          ? {
              archivedAt: new Date(commit.at).toISOString(),
              archivedBy: { name: commit.name, email: commit.email },
            }
          : {}),
      };
      return entry;
    }),
  );
  treeCache.set(workspaceId, { sha, entries });
  return entries;
}

/**
 * The archived apps this person may see, newest archive first. An archived
 * copy whose id is live again (restored by hand, or re-created) is left out:
 * there is nothing to restore.
 */
export async function listArchivedApps(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<ArchivedApp[]> {
  const entries = await loadArchivedTree(workspaceId);
  if (entries.length === 0) return [];
  const ws = new Types.ObjectId(workspaceId);
  const ids = entries
    .map(e => e.appId)
    .filter((id): id is string => !!id && Types.ObjectId.isValid(id));
  const [snapshot, directory, rows, states] = await Promise.all([
    loadAppsIndex(workspaceId, { freshen: false }),
    loadOwnerDirectory(workspaceId),
    AppProject.find({
      workspaceId: ws,
      _id: { $in: ids.map(id => new Types.ObjectId(id)) },
    })
      .select("_id access workspaceRole sharedWith owner_id createdBy")
      .lean(),
    AppLifecycleState.find({
      workspaceId: ws,
      archivedTo: { $in: entries.map(e => e.path) },
    })
      .select("archivedTo archivedFrom")
      .lean(),
  ]);
  const live = new Set(snapshot.apps.map(a => a.appId));
  const rowById = new Map(rows.map(r => [r._id.toString(), r]));
  const fromByTo = new Map(
    states
      .filter(s => s.archivedTo && s.archivedFrom)
      .map(s => [s.archivedTo as string, s.archivedFrom as string]),
  );

  const out: ArchivedApp[] = [];
  for (const entry of entries) {
    if (entry.appId && live.has(entry.appId)) continue;
    // The job's receipt beats the path heuristic (a suffixed copy).
    const recorded = fromByTo.get(entry.path);
    const originalPath =
      recorded && parseAppRepoPath(recorded)
        ? recorded
        : entry.derivedOriginalPath;
    const location = parseAppRepoPath(originalPath);
    if (!location) continue;
    const ownerId =
      location.scope === "private"
        ? (directory.ownerOf(location.ownerHandle) ?? undefined)
        : undefined;
    const state = entry.appId ? rowById.get(entry.appId) : undefined;
    if (
      !canSeeIndexedApp({ scope: location.scope, ownerId }, state, userId, role)
    ) {
      continue;
    }
    const { derivedOriginalPath: _derived, ...rest } = entry;
    out.push({
      ...rest,
      originalPath,
      scope: location.scope,
      ...(ownerId ? { ownerId } : {}),
      ...(location.ownerHandle ? { ownerHandle: location.ownerHandle } : {}),
    });
  }
  return out.sort(
    (a, b) =>
      (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "") ||
      a.title.localeCompare(b.title),
  );
}

export class ArchiveRestoreError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
  }
}

/**
 * Move an archived app back where it came from, with the app-move rules:
 * the Workspace tree needs an editing role, a personal tree is its owner's
 * alone. Gives the app a fresh lifecycle grace period, so the next daily
 * run does not archive it straight back.
 */
export async function restoreArchivedApp(
  workspaceId: string,
  archivedPath: string,
  userId: string | undefined,
  role: string | undefined,
  now = new Date(),
): Promise<{ from: string; to: string; appId?: string }> {
  const app = (await listArchivedApps(workspaceId, userId, role)).find(
    a => a.path === archivedPath,
  );
  // Not there, or not theirs to see: the same answer, so a path cannot be
  // probed.
  if (!app) throw new ArchiveRestoreError("Archived app not found", 404);
  const location = parseAppRepoPath(app.originalPath);
  if (!location) throw new ArchiveRestoreError("Archived app not found", 404);
  const denied = authorizeFolderTarget(
    {
      scope: location.scope,
      ownerHandle: location.ownerHandle,
      folderSegments: location.folderSegments,
    },
    userId,
    role,
    await loadOwnerDirectory(workspaceId, { forUserId: userId }),
  );
  if (denied) throw new ArchiveRestoreError(denied, 403);
  try {
    const moved = await restoreArchivedProject(
      workspaceId,
      app.path,
      app.originalPath,
      { appId: app.appId, title: app.title, userId },
    );
    invalidateArchiveCache(workspaceId);
    if (app.appId) {
      await AppLifecycleState.updateOne(
        { workspaceId: new Types.ObjectId(workspaceId), appId: app.appId },
        {
          $set: { restoredAt: now, ...(userId ? { restoredBy: userId } : {}) },
          $unset: {
            staleSince: 1,
            staleNotifiedTo: 1,
            schedulesPausedAt: 1,
            archivedAt: 1,
            archivedFrom: 1,
            archivedTo: 1,
          },
        },
        { upsert: true },
      );
    }
    logger.info("Restored archived app", {
      workspaceId,
      appId: app.appId,
      ...moved,
    });
    return { ...moved, ...(app.appId ? { appId: app.appId } : {}) };
  } catch (error) {
    if (
      error instanceof AppFolderError &&
      (error.status === 409 || error.status === 404)
    ) {
      throw new ArchiveRestoreError(error.message, error.status);
    }
    throw error;
  }
}

/** An archived app's thumbnail ref, when this person may see the app. */
export async function archivedThumbnail(
  workspaceId: string,
  archivedPath: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<{ file: string; oid: string } | null> {
  const app = (await listArchivedApps(workspaceId, userId, role)).find(
    a => a.path === archivedPath,
  );
  return app?.thumbnail ?? null;
}
