/**
 * Creating and deleting apps: slugs, target folders, the scaffold commit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Types } from "mongoose";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { appsSessionsRoot } from "../config";
import { requireWorkspaceRepo } from "../workspace-repo-required";
import { assertSafeRelPath, runGit } from "../git";
import {
  DEFAULT_BRANCH,
  commitTree,
  repoExists,
  resolveCommit,
  snapshotDirToTree,
  updateRefCas,
  type GitAuthor,
} from "../repository.service";
import { loadAppsIndex, syncAppsIndexFromRepo } from "../app-index.service";
import { appRepoPath, parseAppFolderPath, type AppScope } from "../app-paths";
import { loadOwnerDirectory } from "../user-handles.service";

import { createAppsScaffold } from "../scaffold";
import {
  mirrorPushDefaultBranchNow,
  resolveMirrorTarget,
  queueMirrorPush,
} from "../cloud-repo.service";
import { repoForWorkspace, appRootFor, WorktreeConflictError } from "./repo";
import { pokeApp } from "./push";
import { AppFolderError, isWithin } from "./folders";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "app";
}

/** Where a new app goes: a folder chain in one of the two trees. */
export interface AppFolderTarget {
  scope: AppScope;
  /**
   * For `private`: the owner's userId. Filled in by authorizeFolderTarget
   * from the handle mapping — never taken from a folder name.
   */
  ownerId?: string;
  /** For `private`: the `users/<handle>` segment the tree lives under. */
  ownerHandle?: string;
  folderSegments: string[];
}

/**
 * Make a private target consistent with the handle mapping before a path is
 * built from it: an owner without a handle gets theirs filled in, and a
 * handle that is not the owner's (or is nobody's) is refused — whatever the
 * caller already checked. A no-op for workspace targets.
 */
export async function settleTargetHandle(
  workspaceId: string,
  target: AppFolderTarget,
): Promise<void> {
  if (target.scope !== "private") return;
  const directory = await loadOwnerDirectory(workspaceId, {
    forUserId: target.ownerId,
  });
  target.ownerHandle ??= directory.handleOf(target.ownerId);
  const owner = directory.ownerOf(target.ownerHandle);
  if (!owner || (target.ownerId && owner !== target.ownerId)) {
    throw new AppFolderError(
      "That personal folder does not belong to the app's owner",
      403,
    );
  }
  target.ownerId = owner;
}

/** Parse a folder path (`apps/Sales`, `users/<handle>/apps`) into a target. */
export function folderTargetFromPath(folderPath: string): AppFolderTarget {
  const parsed = parseAppFolderPath(folderPath.replace(/\/+$/, ""));
  if (!parsed) {
    throw new AppFolderError(
      `Not an app folder: ${JSON.stringify(folderPath)} (expected apps/… or users/<handle>/apps/…)`,
    );
  }
  return parsed;
}

/**
 * Every path an app occupies or could not occupy: the index's paths, the
 * project rows' paths (an app whose folder left main still holds its old
 * address until the row is deleted), and the folders themselves.
 */
export async function occupiedPaths(workspaceId: string): Promise<Set<string>> {
  const snapshot = await loadAppsIndex(workspaceId);
  const taken = new Set<string>(snapshot.folders);
  for (const app of snapshot.apps) taken.add(app.path);
  const rows = await AppProject.find({
    workspaceId: new Types.ObjectId(workspaceId),
    path: { $exists: true },
  })
    .select("path")
    .lean();
  for (const row of rows) if (row.path) taken.add(row.path);
  return taken;
}

async function uniqueSlug(
  workspaceId: string,
  title: string,
  target: AppFolderTarget,
): Promise<string> {
  const base = slugify(title);
  const taken = await occupiedPaths(workspaceId);
  const pathFor = (slug: string) => appRepoPath({ ...target, slug });
  if (!taken.has(pathFor(base))) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(pathFor(candidate))) return candidate;
  }
}

/**
 * Commit a mutation (writes, prefix deletions and/or directory moves)
 * directly onto a branch of the bare repo via a throwaway clone. Used for app
 * lifecycle commits (scaffold, move, delete) and by the v1→v2 migrator —
 * actor worktrees are not involved. Moves run first, then deletions, then
 * writes, so a write can land inside a just-moved folder.
 */
export async function commitFilesOnBranch(
  repoDir: string,
  branch: string,
  mutation: {
    writes?: Record<string, string>;
    deletePrefixes?: string[];
    moves?: Array<{ from: string; to: string }>;
  },
  options: { message: string; author?: GitAuthor },
): Promise<{ commitOid: string; previousHead: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!head) throw new Error(`Branch ${branch} is missing`);
    await fs.mkdir(appsSessionsRoot(), { recursive: true });
    const tmp = await fs.mkdtemp(path.join(appsSessionsRoot(), "lifecycle-"));
    try {
      await runGit(["clone", "--branch", branch, repoDir, tmp], {
        timeoutMs: 120_000,
      });
      for (const move of mutation.moves ?? []) {
        const from = path.join(tmp, assertSafeRelPath(move.from));
        const to = path.join(tmp, assertSafeRelPath(move.to));
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
      }
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

export async function createProject(input: {
  workspaceId: string;
  title: string;
  description?: string;
  userId?: string;
  author?: GitAuthor;
  /**
   * Force an exact slug instead of deriving a unique one from the title. The
   * caller owns uniqueness — used by the v1→v2 migration, which assigns each
   * app a deterministic slug and clears any prior occupant first, so a re-run
   * overwrites in place rather than spawning a "…-2" duplicate.
   */
  slug?: string;
  /**
   * Where to file it. Default: the top of the workspace tree (`apps/`). A
   * `private` target puts it under the creator's `users/<handle>/apps/`.
   */
  folder?: AppFolderTarget;
}): Promise<IAppProject> {
  const title = input.title.trim() || "Untitled app";
  // Git first (#956): do not init a local-only repo that then lets consoles,
  // dbt, and prompt writes skip the 412. A GitHub binding (or a test that
  // already seeded the bare repo) is required.
  const repoDir = await requireWorkspaceRepo(input.workspaceId);
  const mirror = await resolveMirrorTarget(input.workspaceId);
  const target: AppFolderTarget = input.folder ?? {
    scope: "workspace",
    folderSegments: [],
  };
  if (target.scope === "private") {
    target.ownerId = target.ownerId ?? input.userId;
    if (!target.ownerId) {
      throw new Error("A personal app needs a signed-in owner");
    }
    await settleTargetHandle(input.workspaceId, target);
  }
  const slug =
    input.slug ?? (await uniqueSlug(input.workspaceId, title, target));
  const appPath = appRepoPath({ ...target, slug });
  // Never scaffold inside another app: the outer folder would swallow it
  // (the index files one app per outermost manifest) and the row would be
  // orphaned while the parent redeploys with a stranger's files.
  const parentApp = (await loadAppsIndex(input.workspaceId)).apps.find(a =>
    isWithin(appPath, a.path),
  );
  if (parentApp) {
    throw new AppFolderError(`${parentApp.path} is an app, not a folder`, 409);
  }
  const project = await AppProject.create({
    workspaceId: new Types.ObjectId(input.workspaceId),
    title,
    slug,
    path: appPath,
    description: input.description,
    access: "private",
    owner_id: input.userId,
    createdBy: input.userId ?? "system",
    defaultBranch: DEFAULT_BRANCH,
  });

  // §10 monorepo: commit the scaffold under its folder onto main. The row's
  // id goes into the manifest: that is the app's identity from here on,
  // whatever folder it is later filed under.
  let scaffoldCommit: { commitOid: string; previousHead: string } | null;
  try {
    const scaffold = createAppsScaffold({
      title: project.title,
      description: input.description,
      id: project._id.toString(),
    });
    const prefixed: Record<string, string> = {};
    for (const [rel, contents] of Object.entries(scaffold)) {
      prefixed[`${appPath}/${rel}`] = contents;
    }
    scaffoldCommit = await commitFilesOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: prefixed },
      { message: `Create app "${title}" (${appPath})`, author: input.author },
    );
  } catch (error) {
    // Don't leave a content-less project behind.
    await AppProject.deleteOne({
      _id: project._id,
      workspaceId: project.workspaceId,
    });
    throw error;
  }
  // Durable tier (§13.17): the connected repo. When one is bound, the
  // durable push is REQUIRED — on serverless hosts the local repo is an
  // ephemeral cache. Hosts without a binding (dev, previews) stay local-only.
  try {
    if (mirror) {
      await mirrorPushDefaultBranchNow(input.workspaceId);
    }
  } catch (error) {
    await AppProject.deleteOne({
      _id: project._id,
      workspaceId: project.workspaceId,
    });
    // Roll the scaffold commit back so the repo matches the docs. The CAS
    // returns false (it does not throw) when main moved on meanwhile; that
    // leaves the scaffold on a tip the mirror never received — say so.
    const rolledBack = await updateRefCas(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      scaffoldCommit.previousHead,
      scaffoldCommit.commitOid,
    ).catch(() => false);
    if (!rolledBack) {
      logger.warn("Apps scaffold rollback skipped: main moved on", {
        projectId: project._id.toString(),
        commit: scaffoldCommit.commitOid,
      });
    }
    logger.error("Apps creation aborted: durable push failed", {
      projectId: project._id.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Could not store the app durably (GitHub push failed): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  logger.info("Apps project created", {
    projectId: project._id.toString(),
    workspaceId: input.workspaceId,
    path: appPath,
  });
  // The list must show the new app on the very next read, on this instance
  // and every other: the index is keyed by main's sha, which just moved.
  await syncAppsIndexFromRepo(input.workspaceId).catch(() => undefined);
  pokeApp(project.workspaceId, project._id, "lifecycle", input.userId);
  return project;
}

export async function deleteProject(project: IAppProject): Promise<void> {
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
  await AppProject.deleteOne({
    _id: project._id,
    workspaceId: project.workspaceId,
  });
  await syncAppsIndexFromRepo(project.workspaceId.toString()).catch(
    () => undefined,
  );
  pokeApp(project.workspaceId, project._id, "lifecycle");
}
