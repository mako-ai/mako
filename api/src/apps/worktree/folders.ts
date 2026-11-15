/**
 * App folders are real directories, moved with real commits: moves, the
 * archive, empty folders, and stamping a copied app's id.
 */
import { Types } from "mongoose";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { requireWorkspaceRepo } from "../workspace-repo-required";
import { assertSafeRelPath, runGit } from "../git";
import {
  DEFAULT_BRANCH,
  readBlob,
  updateRefCas,
  type GitAuthor,
} from "../repository.service";
import {
  invalidateAppsIndexCache,
  loadAppsIndex,
  syncAppsIndexFromRepo,
  type AppIndexRow,
} from "../app-index.service";
import {
  APP_MANIFEST,
  FOLDER_KEEP_FILE,
  appRepoPath,
  parseAppRepoPath,
  appTreeRoot,
  isSafeSegment,
  stampManifestId,
} from "../app-paths";
import { appSdkDependency } from "../app-sdk-package";

import {
  freshenBeforeMainWrite,
  mirrorPushNow,
  resolveMirrorTarget,
} from "../cloud-repo.service";
import { appRootFor } from "./repo";
import { pokeApp } from "./push";
import {
  AppFolderTarget,
  settleTargetHandle,
  occupiedPaths,
  commitFilesOnBranch,
} from "./projects";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Folders: real directories, moved with real commits
// ---------------------------------------------------------------------------

export class AppFolderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "AppFolderError";
  }
}

function folderPathOf(target: AppFolderTarget): string {
  for (const seg of target.folderSegments) {
    if (!isSafeSegment(seg)) {
      throw new AppFolderError(`Invalid folder name: ${JSON.stringify(seg)}`);
    }
  }
  return [
    appTreeRoot(target.scope, target.ownerHandle),
    ...target.folderSegments,
  ].join("/");
}

/** Is `candidate` the app itself or something inside it? */
export function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Manifest writes that pin every app under `dir` to the id the index already
 * knows it by — so a move never changes an identity, even for an app that
 * predates manifest ids. Paths are the NEW ones (post-move).
 */
export async function moveWritesUnder(
  workspaceId: string,
  repoDir: string,
  moves: Array<{ from: string; to: string }>,
): Promise<Record<string, string>> {
  const snapshot = await loadAppsIndex(workspaceId, { freshen: false });
  const writes: Record<string, string> = {};
  const readAt = async (rel: string): Promise<string | null> => {
    try {
      return (await readBlob(repoDir, DEFAULT_BRANCH, rel)).contents;
    } catch {
      return null;
    }
  };
  for (const app of snapshot.apps) {
    const move = moves.find(m => isWithin(app.path, m.from));
    if (!move) continue;
    const newPath = `${move.to}${app.path.slice(move.from.length)}`;
    if (!app.hasManifestId) {
      const stamped = stampManifestId(
        await readAt(`${app.path}/${APP_MANIFEST}`),
        app.appId,
      );
      if (stamped !== null) writes[`${newPath}/${APP_MANIFEST}`] = stamped;
    }
    // A pre-npm `file:../../packages/app-sdk` dependency is relative to the
    // app's depth: it breaks the moment the folder moves. Point it at the
    // registry package the scaffold uses.
    const pkgRaw = await readAt(`${app.path}/package.json`);
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as {
          dependencies?: Record<string, string>;
        };
        const dep = pkg.dependencies?.["@makoai/app-sdk"];
        if (typeof dep === "string" && dep.startsWith("file:")) {
          pkg.dependencies = { ...pkg.dependencies, ...appSdkDependency() };
          writes[`${newPath}/package.json`] =
            `${JSON.stringify(pkg, null, 2)}\n`;
        }
      } catch {
        // Not JSON: leave it to the user.
      }
    }
  }
  return writes;
}

/**
 * A lifecycle commit on main that must reach the durable mirror: on
 * serverless hosts the local repo is a cache, so a commit the mirror never
 * received would be a commit that never happened. Rolled back on failure,
 * as createProject does.
 */
type MainMutation = Parameters<typeof commitFilesOnBranch>[2];

export async function commitOnMainDurably(
  workspaceId: string,
  repoDir: string,
  /**
   * The change, or a function computing it. A function runs AFTER the
   * freshen below, so anything it reads from main (a manifest to stamp, a
   * package.json to rewrite) is the mirror's current content, not a copy
   * a laptop push has since replaced.
   */
  mutation: MainMutation | (() => Promise<MainMutation>),
  options: { message: string; author?: GitAuthor },
): Promise<void> {
  const mirror = await resolveMirrorTarget(workspaceId);
  // Commit onto the mirror's main, not a stale local copy of it — a laptop
  // push this instance has not seen would make the result unmirrorable.
  await freshenBeforeMainWrite(workspaceId);
  invalidateAppsIndexCache(workspaceId);
  const commit = await commitFilesOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    typeof mutation === "function" ? await mutation() : mutation,
    options,
  );
  try {
    if (mirror) await mirrorPushNow(workspaceId);
  } catch (error) {
    // The CAS returns false (it does not throw) when main moved on
    // meanwhile; the commit then stays on a local tip the mirror never got.
    const rolledBack = await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      commit.previousHead,
      commit.commitOid,
    ).catch(() => false);
    if (!rolledBack) {
      logger.warn("Apps lifecycle commit rollback skipped: main moved on", {
        workspaceId,
        commit: commit.commitOid,
      });
    }
    throw new Error(
      `Could not store the change durably (GitHub push failed): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  invalidateAppsIndexCache(workspaceId);
  await syncAppsIndexFromRepo(workspaceId).catch(() => undefined);
}

/**
 * File an app somewhere else: `git mv` of its folder, as one commit on main.
 * The app keeps its id (stamped into the manifest in the same commit if it
 * had none), so deployments, sharing, env vars and favourites all follow it.
 * Nothing is rebuilt: the folder's tree oid is unchanged, and deploy-on-push
 * keys on that.
 */
export async function moveProject(
  project: IAppProject,
  target: AppFolderTarget & { slug?: string },
  options: {
    userId?: string;
    author?: GitAuthor;
    /**
     * Write this one-line description into the app's `mako.json` in the
     * same commit ("Share with workspace" asks for one).
     */
    description?: string;
  } = {},
): Promise<{ from: string; to: string }> {
  const workspaceId = project.workspaceId.toString();
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await settleTargetHandle(workspaceId, target);
  const from = appRootFor(project);
  const slug = target.slug ?? project.slug ?? from.split("/").pop() ?? "app";
  if (!isSafeSegment(slug)) {
    throw new AppFolderError(
      `Invalid app folder name: ${JSON.stringify(slug)}`,
    );
  }
  const to = appRepoPath({ ...target, slug });
  if (to === from) return { from, to };
  const snapshot = await loadAppsIndex(workspaceId);
  if (!snapshot.apps.some(a => a.path === from)) {
    throw new AppFolderError(`App folder ${from} is not on main`, 404);
  }
  const taken = await occupiedPaths(workspaceId);
  if (taken.has(to)) {
    throw new AppFolderError(`${to} already exists`, 409);
  }
  // Never file an app inside another app: the outer one would swallow it.
  const parent = snapshot.apps.find(a => isWithin(to, a.path));
  if (parent) {
    throw new AppFolderError(`${parent.path} is an app, not a folder`, 409);
  }
  const moves = [{ from, to }];
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      // Re-check against the freshened main: the folder may have moved or
      // gone in a push this instance had not seen a moment ago.
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      if (!fresh.apps.some(a => a.path === from)) {
        throw new AppFolderError(`App folder ${from} is not on main`, 404);
      }
      const writes = await moveWritesUnder(workspaceId, repoDir, moves);
      if (options.description !== undefined) {
        const manifestAt = `${to}/${APP_MANIFEST}`;
        let current: string | null = writes[manifestAt] ?? null;
        if (current === null) {
          try {
            current = (
              await readBlob(repoDir, DEFAULT_BRANCH, `${from}/${APP_MANIFEST}`)
            ).contents;
          } catch {
            current = null;
          }
        }
        const described = withManifestDescription(current, options.description);
        if (described !== null && described !== current) {
          writes[manifestAt] = described;
        }
      }
      return { moves, writes };
    },
    {
      message: `Move app "${project.title}" (${from} → ${to})`,
      author: options.author,
    },
  );
  // The sync above relocated the row; keep the caller's copy honest too.
  // Visibility follows the tree: filed into a personal tree, the app is that
  // person's (private, theirs); filed back into the workspace tree, it is
  // workspace content again — a row-backed app must not keep the visibility
  // of the tree it left, or a "personal" app stays readable by everyone.
  const fromScope = parseAppRepoPath(from)?.scope;
  const visibility: Partial<IAppProject> =
    target.scope === "private"
      ? { access: "private", owner_id: target.ownerId }
      : fromScope === "private"
        ? { access: "workspace" }
        : {};
  project.path = to;
  project.slug = slug;
  Object.assign(project, visibility);
  await AppProject.updateOne(
    { _id: project._id, workspaceId: project.workspaceId },
    { $set: { path: to, slug, ...visibility } },
  );
  pokeApp(project.workspaceId, project._id, "lifecycle", options.userId);
  return { from, to };
}

/**
 * Set `description` in a manifest, keeping every other key in place. A
 * manifest that does not parse is left alone (null), as stampManifestId does.
 */
export function withManifestDescription(
  contents: string | null,
  description: string,
): string | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = contents ? (JSON.parse(contents) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const clean = description.trim();
  if (!clean) return contents;
  return `${JSON.stringify({ ...raw, description: clean }, null, 2)}\n`;
}

/** Where archived content lives: outside both app trees, so never built. */
export const ARCHIVE_DIR = "archive";

/**
 * Archive an app: move its folder to `archive/<its path>` as one commit on
 * main. `archive/` is outside `apps/` and `users/<id>/apps/`, so the index
 * stops listing it and deploy-on-push unpublishes it like a deleted folder —
 * but git keeps every file, and moving the folder back restores the app
 * under the same id (stamped into the manifest here if it had none).
 *
 * The project row keeps its state (shares, env vars, public link) and gives
 * up its path: a new app created at the old address must not inherit this
 * app's identity from a stale incumbent row.
 */
export async function archiveProject(
  workspaceId: string,
  appPath: string,
  options: { author?: GitAuthor; reason?: string } = {},
): Promise<{ from: string; to: string }> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  const from = appPath.replace(/\/+$/, "");
  if (!parseAppRepoPath(from)) {
    throw new AppFolderError(`Not an app folder: ${JSON.stringify(from)}`);
  }
  const snapshot = await loadAppsIndex(workspaceId);
  const app = snapshot.apps.find(a => a.path === from);
  if (!app) throw new AppFolderError(`App folder ${from} is not on main`, 404);
  const existsOnMain = (rel: string) =>
    runGit(["-C", repoDir, "cat-file", "-e", `${DEFAULT_BRANCH}:${rel}`])
      .then(() => true)
      .catch(() => false);
  // Archived before (restored, then stale again): keep both copies.
  const base = `${ARCHIVE_DIR}/${from}`;
  const day = new Date().toISOString().slice(0, 10);
  let to = base;
  for (let i = 1; await existsOnMain(to); i++) {
    to = i === 1 ? `${base}-${day}` : `${base}-${day}-${i}`;
  }
  const moves = [{ from, to }];
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      if (!fresh.apps.some(a => a.path === from)) {
        throw new AppFolderError(`App folder ${from} is not on main`, 404);
      }
      return {
        moves,
        writes: await moveWritesUnder(workspaceId, repoDir, moves),
      };
    },
    {
      message: `Archive app "${app.title}" (${from} → ${to})${options.reason ? `\n\n${options.reason}` : ""}`,
      author: options.author,
    },
  );
  await AppProject.updateOne(
    {
      _id: new Types.ObjectId(app.appId),
      workspaceId: new Types.ObjectId(workspaceId),
      path: from,
    },
    { $unset: { path: 1 } },
  );
  pokeApp(workspaceId, app.appId, "lifecycle");
  return { from, to };
}

/**
 * Restore an archived app: move `archive/<...>` back to `to` (its original
 * app folder) as one commit on main — the reverse of archiveProject. The
 * manifest id was stamped before the archive move, so the app comes back
 * under the same id with its row's shares, env vars and public link. 409
 * when anything already sits at `to` (an app, a folder, a file) or inside
 * an app there.
 */
export async function restoreArchivedProject(
  workspaceId: string,
  archivedPath: string,
  to: string,
  options: {
    appId?: string;
    title?: string;
    author?: GitAuthor;
    userId?: string;
  } = {},
): Promise<{ from: string; to: string }> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  const from = archivedPath.replace(/\/+$/, "");
  const location = parseAppRepoPath(to);
  if (!from.startsWith(`${ARCHIVE_DIR}/`) || !location) {
    throw new AppFolderError(`Not an archived app: ${JSON.stringify(from)}`);
  }
  assertSafeRelPath(from);
  const existsOnMain = (rel: string) =>
    runGit(["-C", repoDir, "cat-file", "-e", `${DEFAULT_BRANCH}:${rel}`])
      .then(() => true)
      .catch(() => false);
  const checkTarget = async (
    snapshot: Awaited<ReturnType<typeof loadAppsIndex>>,
  ) => {
    if (!(await existsOnMain(`${from}/${APP_MANIFEST}`))) {
      throw new AppFolderError(`${from} is not in the archive on main`, 404);
    }
    if (await existsOnMain(to)) {
      throw new AppFolderError(`${to} already exists`, 409);
    }
    const parent = snapshot.apps.find(a => isWithin(to, a.path));
    if (parent) {
      throw new AppFolderError(`${parent.path} is an app, not a folder`, 409);
    }
    if (options.appId && snapshot.apps.some(a => a.appId === options.appId)) {
      throw new AppFolderError(
        "This app is already live in the workspace",
        409,
      );
    }
  };
  await checkTarget(await loadAppsIndex(workspaceId));
  const taken = await occupiedPaths(workspaceId);
  if (taken.has(to)) throw new AppFolderError(`${to} already exists`, 409);
  const moves = [{ from, to }];
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      // Against the freshened main: a push may have taken the address.
      await checkTarget(await loadAppsIndex(workspaceId, { freshen: false }));
      return { moves, writes: {} };
    },
    {
      message: `Restore app "${options.title ?? location.slug}" (${from} → ${to})`,
      author: options.author,
    },
  );
  if (options.appId && Types.ObjectId.isValid(options.appId)) {
    await AppProject.updateOne(
      {
        _id: new Types.ObjectId(options.appId),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      { $set: { path: to, slug: location.slug } },
    );
  }
  pokeApp(workspaceId, options.appId ?? null, "lifecycle", options.userId);
  return { from, to };
}

/**
 * A new, empty folder. Git cannot hold an empty directory, so it is a
 * `.gitkeep` — the marker the index reads folders from.
 */
export async function createAppFolder(
  workspaceId: string,
  target: AppFolderTarget,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<{ path: string }> {
  if (target.folderSegments.length === 0) {
    throw new AppFolderError("A folder needs a name");
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await settleTargetHandle(workspaceId, target);
  const folderPath = folderPathOf(target);
  const snapshot = await loadAppsIndex(workspaceId);
  if (snapshot.folders.includes(folderPath)) {
    throw new AppFolderError(`${folderPath} already exists`, 409);
  }
  const clash = snapshot.apps.find(
    a => a.path === folderPath || isWithin(folderPath, a.path),
  );
  if (clash) {
    throw new AppFolderError(`${clash.path} is an app, not a folder`, 409);
  }
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    { writes: { [`${folderPath}/${FOLDER_KEEP_FILE}`]: "" } },
    { message: `Create folder ${folderPath}`, author: options.author },
  );
  pokeApp(workspaceId, null, "lifecycle", options.userId);
  return { path: folderPath };
}

/**
 * Rename or move a folder, apps and subfolders included. Every app inside
 * keeps its id (stamped where missing), so nothing rebuilds or loses state.
 */
export async function moveAppFolder(
  workspaceId: string,
  from: AppFolderTarget,
  to: AppFolderTarget,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<{ from: string; to: string; apps: number }> {
  if (from.folderSegments.length === 0 || to.folderSegments.length === 0) {
    throw new AppFolderError("The tree roots cannot be moved");
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await settleTargetHandle(workspaceId, from);
  await settleTargetHandle(workspaceId, to);
  const fromPath = folderPathOf(from);
  const toPath = folderPathOf(to);
  if (fromPath === toPath) return { from: fromPath, to: toPath, apps: 0 };
  if (isWithin(toPath, fromPath)) {
    throw new AppFolderError("A folder cannot be moved into itself", 409);
  }
  const snapshot = await loadAppsIndex(workspaceId);
  if (!snapshot.folders.includes(fromPath)) {
    throw new AppFolderError(`Folder ${fromPath} not found`, 404);
  }
  const taken = await occupiedPaths(workspaceId);
  if (taken.has(toPath)) {
    throw new AppFolderError(`${toPath} already exists`, 409);
  }
  const parentApp = snapshot.apps.find(a => isWithin(toPath, a.path));
  if (parentApp) {
    throw new AppFolderError(`${parentApp.path} is an app, not a folder`, 409);
  }
  const moves = [{ from: fromPath, to: toPath }];
  const apps = snapshot.apps.filter(a => isWithin(a.path, fromPath));
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    async () => {
      const fresh = await loadAppsIndex(workspaceId, { freshen: false });
      if (!fresh.folders.includes(fromPath)) {
        throw new AppFolderError(`Folder ${fromPath} not found`, 404);
      }
      return {
        moves,
        writes: await moveWritesUnder(workspaceId, repoDir, moves),
      };
    },
    { message: `Move folder ${fromPath} → ${toPath}`, author: options.author },
  );
  pokeApp(workspaceId, null, "lifecycle", options.userId);
  return { from: fromPath, to: toPath, apps: apps.length };
}

/** Delete a folder. Only an empty one — deleting apps is deleteProject's job. */
export async function deleteAppFolder(
  workspaceId: string,
  target: AppFolderTarget,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<void> {
  if (target.folderSegments.length === 0) {
    throw new AppFolderError("The tree roots cannot be deleted");
  }
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await settleTargetHandle(workspaceId, target);
  const folderPath = folderPathOf(target);
  const snapshot = await loadAppsIndex(workspaceId);
  if (!snapshot.folders.includes(folderPath)) {
    throw new AppFolderError(`Folder ${folderPath} not found`, 404);
  }
  const inside = snapshot.apps.filter(a => isWithin(a.path, folderPath));
  if (inside.length > 0) {
    throw new AppFolderError(
      `${folderPath} still holds ${inside.length} app(s); move or delete them first`,
      409,
    );
  }
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    { deletePrefixes: [folderPath] },
    { message: `Delete folder ${folderPath}`, author: options.author },
  );
  pokeApp(workspaceId, null, "lifecycle", options.userId);
}

/**
 * Give a copied app (one that declared another app's id) an identity of its
 * own: write the id the index filed it under into its manifest.
 */
export async function stampAppId(
  workspaceId: string,
  app: AppIndexRow,
  options: { userId?: string; author?: GitAuthor } = {},
): Promise<void> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  let contents: string | null;
  try {
    contents = (
      await readBlob(repoDir, DEFAULT_BRANCH, `${app.path}/${APP_MANIFEST}`)
    ).contents;
  } catch {
    contents = null;
  }
  const stamped = stampManifestId(contents, app.appId);
  if (stamped === null) {
    throw new AppFolderError(
      `${app.path}/${APP_MANIFEST} is not valid JSON; fix it before stamping an id`,
    );
  }
  // Already carries this id: nothing to write, no empty commit to push.
  if (stamped === contents) return;
  await commitOnMainDurably(
    workspaceId,
    repoDir,
    { writes: { [`${app.path}/${APP_MANIFEST}`]: stamped } },
    { message: `Stamp app id for ${app.path}`, author: options.author },
  );
  pokeApp(workspaceId, app.appId, "lifecycle", options.userId);
}
