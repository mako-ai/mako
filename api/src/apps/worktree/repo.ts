/**
 * The workspace repo an app lives in, an app's root inside it, and the
 * handle / scope types every worktree operation takes.
 */
import { Types } from "mongoose";
import {
  type IAppProject,
  type IAppWorktree,
} from "../../database/workspace-schema";
import { RepoRequiredError } from "../config";
import { getWorkspaceRepo } from "../../services/workspace-repos.service";
import { assertSafeRelPath } from "../git";
import { DEFAULT_BRANCH, repoDirFor } from "../repository.service";
import { APPS_DIR } from "../app-paths";

import { ensureLocalRepo } from "../cloud-repo.service";

/**
 * Local repo dir for a project, restoring it from the cloud mirror first
 * when the cache is cold (serverless hosts start with an empty
 * APPS_GIT_ROOT — see ensureLocalRepo).
 */
export async function repoFor(project: IAppProject): Promise<string> {
  return repoForWorkspace(project.workspaceId.toString());
}

/** §10 monorepo: the ONE bare repo per workspace (clone-on-miss). */
export async function repoForWorkspace(workspaceId: string): Promise<string> {
  if (!(await getWorkspaceRepo(workspaceId))) {
    throw new RepoRequiredError();
  }
  await ensureLocalRepo(workspaceId);
  return repoDirFor(workspaceId);
}

/**
 * Repo-relative folder an app's content lives under. `path` is maintained by
 * the apps index from the tree at main; rows that predate it are at
 * `apps/<slug>`, which is what every app was before folders nested.
 */
export function appRootFor(project: IAppProject): string {
  return (
    project.path ?? `${APPS_DIR}/${project.slug ?? project._id.toString()}`
  );
}

/** Prefix an app-relative path into its repo-relative form. */
export function appPath(project: IAppProject, relPath: string): string {
  return `${appRootFor(project)}/${assertSafeRelPath(relPath)}`;
}

/** Prefix a handle-relative path into its repo-relative form ("" root = repo). */
export function scopedPath(handle: WorktreeHandle, relPath: string): string {
  const safe = assertSafeRelPath(relPath);
  return handle.appRoot ? `${handle.appRoot}/${safe}` : safe;
}

/** The app this handle was opened for; workspace-scoped handles have none. */
export function handleProject(handle: WorktreeHandle): IAppProject {
  if (!handle.project) {
    throw new Error("This operation requires an app-scoped worktree handle");
  }
  return handle.project;
}

// There is also no per-worktree mutex here any more. It existed to serialize
// compare-and-swap advances of the WIP ref; git takes its own index lock, and
// concurrent writers to one checkout are now exactly as (un)safe as they are
// on any developer's machine.

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
  doc: IAppWorktree;
  /** Absent for a workspace-scoped handle (Source Control, repo-level ops). */
  project?: IAppProject;
  repoDir: string;
  /** Repo-relative root this handle is scoped to; "" = the whole repo. */
  appRoot: string;
}

/**
 * What repo-level reads operate on: the workspace repo, optionally narrowed
 * to one content root. The repo is a WORKSPACE-level thing (§10) — an app is
 * just one lens on it — so functions like status/history/branches take this
 * instead of an IAppProject, and the Source Control surface needs no app
 * handle at all.
 */
export interface RepoScope {
  workspaceId: string;
  /** Repo-relative content root to filter to; null = the whole repo. */
  root: string | null;
  defaultBranch: string;
  /** Present when the scope is one app (window pokes carry the app id). */
  projectId?: Types.ObjectId;
}

/** Scope of one app: its folder, its default branch. */
export function scopeOf(project: IAppProject): RepoScope {
  return {
    workspaceId: project.workspaceId.toString(),
    root: appRootFor(project),
    defaultBranch: project.defaultBranch || DEFAULT_BRANCH,
    projectId: project._id,
  };
}

/** Scope of the whole workspace repo. */
export function workspaceScope(workspaceId: string): RepoScope {
  return { workspaceId, root: null, defaultBranch: DEFAULT_BRANCH };
}
