/**
 * What every apps tool group shares: the caller, the target (an app, or a
 * workflow folder standing in for one), project loading with its access
 * checks, and the per-turn read-before-write bookkeeping.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { Types } from "mongoose";
import { type IAppProject } from "../../../database/workspace-schema";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../../../repositories/apps-metadata";
import { requireWorkspaceRepo } from "../../../apps/workspace-repo-required";
import { workspaceService } from "../../../services/workspace.service";
import { canReadResource, canWriteResource } from "../../../utils/resource-acl";
import {
  WorktreeConflictError,
  listAppFolders,
  ensureWorktree,
  scopeOf,
  appRootFor,
  resolveProjectRef,
} from "../../../apps/worktree.service";
import {
  WORKFLOWS_DIR,
  appTreeRoot,
  isSafeSegment,
} from "../../../apps/app-paths";
import {
  handleForUser,
  loadOwnerDirectory,
} from "../../../apps/user-handles.service";
import { canSeeIndexedApp } from "../../../apps/app-authorization";
import { loggers } from "../../../logging";

export const logger = loggers.agent();

/**
 * Full app_bash outputs kept in the sandbox's scratch dir (oldest pruned).
 * Each is at most ~1 MB (the exec output cap) and the box disk is small.
 */
export const FULL_OUTPUT_FILES_KEPT = 20;

/** A tool call id as a file name: provider ids are not guaranteed path-safe. */
export function safeFileStem(id: string | undefined): string {
  const stem = (id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return stem || `out-${Date.now().toString(36)}`;
}

export interface AppsToolsOptions {
  workspaceId: string;
  userId?: string;
  /** Resolved model accepts image input; undefined = assume yes (external MCP). */
  supportsVision?: boolean;
  /**
   * Caller-owned set the write-capable tools add their app's repo-relative
   * root (`apps/<slug>`) to. The sandbox is ONE working copy per
   * (workspace, user) shared by every chat that user runs, so the turn-end
   * auto-commit needs to know which folders THIS chat wrote to — otherwise it
   * `git add -A`s the whole tree and sweeps a concurrent chat's in-flight
   * work on another app into this turn's commit.
   */
  touchedPaths?: Set<string>;
}

type LoadResult = { project: IAppProject } | { error: string };

/**
 * A file's version, as read_file answers it and write_file checks it: over
 * MCP no call remembers another, so the agent carries what it read.
 */
export const contentHash = (contents: string) =>
  createHash("sha256").update(contents).digest("hex").slice(0, 16);

/**
 * What the shell, file and git tools work on. An `app_*` tool names an app
 * (`appId`), a `workflow_*` tool a workflow folder (`workflowId`); each
 * tool's schema holds the one its kind takes, and requires it.
 */
export type TargetKind = "app" | "workflow";
type TargetInput = {
  appId: z.ZodOptional<z.ZodString>;
  workflowId: z.ZodOptional<z.ZodString>;
};
const APP_ID_DESCRIPTION =
  'The app\'s folder name under apps/ — e.g. "hello-world" for apps/hello-world. That folder IS the app. A legacy id also resolves.';
const WORKFLOW_ID_DESCRIPTION =
  'The workflow\'s folder name under workflows/ — e.g. "daily-digest" for workflows/daily-digest. Use "lib" for shared code. A new name creates the folder on first write.';
/**
 * The one key a kind's tools take. Typed as both, optional, so one tool body
 * reads either: the other is never in the schema, so never in the input.
 */
export const targetInputFor = (
  kind: TargetKind,
  describe = true,
): TargetInput => {
  const [key, description] =
    kind === "app"
      ? ["appId", APP_ID_DESCRIPTION]
      : ["workflowId", WORKFLOW_ID_DESCRIPTION];
  const id = z.string();
  return {
    [key]: describe || kind === "workflow" ? id.describe(description) : id,
  } as unknown as TargetInput;
};

export type AppsToolContext = ReturnType<typeof createAppsToolContext>;

export function createAppsToolContext(
  { workspaceId, userId, supportsVision, touchedPaths }: AppsToolsOptions,
  kind: TargetKind,
) {
  const targetInput = targetInputFor(kind, false);
  // A conversation is not a line of work.
  //
  // Chats used to get their own `chat/<chatId>` branch. That made opening a
  // chat fork the code — including when you open one merely to clear context,
  // which is most of the time — and split the agent's work from the user's
  // own: they edited the same app from two branches and each saw an app the
  // other had not touched. It also forked the WHOLE workspace monorepo, every
  // app in it, for a conversation about one of them.
  //
  // So the agent works where the user works: their branch, their checkout,
  // like any other pair of hands on a repository. The end-of-turn commit is
  // unchanged, and still gives one commit per turn to review or revert.
  const actorId = userId ?? "api-key";
  const ensureActorWorktree = (project: IAppProject) =>
    ensureWorktree(project, actorId);
  // Every tool that can dirty the working copy records the app folder it
  // wrote to; see AppsToolsOptions.touchedPaths for why. A workflow folder is
  // left out: on main a commit is the deploy, so the end of a turn must not
  // make one. Only workflow_commit does.
  const markTouched = (project: IAppProject) => {
    if (!workflowFolders.has(project)) touchedPaths?.add(appRootFor(project));
  };
  // The branch is whatever the checkout is on — main by default, or wherever
  // the user (or this agent, via `git checkout` in app_bash) switched to.
  // Read it fresh per call; a cached value goes stale the moment anyone
  // switches branches mid-conversation.
  const currentActorBranch = async (project: IAppProject) =>
    (await ensureActorWorktree(project)).doc.branch;
  // Where a workflow's commits wait for review before main, the deploy: one
  // branch per person and workflow, so two people never replace each
  // other's.
  const previewBranchFor = async (workflowId: string) => {
    const handle = await handleForUser(workspaceId, userId).catch(
      () => undefined,
    );
    return handle
      ? `workflow/${handle}/${workflowId}`
      : `workflow/${workflowId}`;
  };

  // Read-before-edit freshness tracking (a Claude Code reliability hallmark):
  // the agent must read a file before a blind full-rewrite, so it never
  // clobbers content it hasn't seen this turn. Anchored edits are inherently
  // safe (they fail on a bad anchor) so they don't require a prior read.
  // Scoped to this tool-factory instance = the current turn.
  const readThisTurn = new Set<string>();
  const readKey = (project: IAppProject, path: string) =>
    `${appRootFor(project)}\u0000${path}`;
  const markRead = (project: IAppProject, path: string) =>
    readThisTurn.add(readKey(project, path));
  const wasRead = (project: IAppProject, path: string) =>
    readThisTurn.has(readKey(project, path));

  let cachedRole: string | undefined | null = null;
  const memberRole = async (): Promise<string | undefined> => {
    if (cachedRole !== null) return cachedRole;
    if (!userId) {
      cachedRole = undefined;
      return undefined;
    }
    const member = await workspaceService.getMember(workspaceId, userId);
    cachedRole = member?.role;
    return cachedRole;
  };

  const loadProject = async (
    appId: string,
    opts: { write: boolean; deploy?: boolean },
  ): Promise<LoadResult> => {
    if (!appId) {
      return { error: `Invalid app: ${appId}. Use app_list_apps first.` };
    }
    // An app is a FOLDER (apps.md §13.6): its path (`apps/sales/report`) or
    // its folder name is what an agent working in a checkout actually has,
    // and its id is what the manifest carries. All three resolve. The lookup
    // fetches the mirror on a MISS, so an API instance cannot say "not
    // found" from an older clone right after another instance took the push
    // — while the twenty app_* calls that follow, all resolving through
    // here, do not each pay a GitHub round trip.
    const project: IAppProject | null = await resolveProjectRef(
      workspaceId,
      appId,
      { fetchOnMiss: true },
    );
    if (!project) {
      return { error: `App ${appId} not found. Use app_list_apps.` };
    }
    if (userId) {
      const role = await memberRole();
      // An app the caller cannot see is "not found", so a private app's
      // existence never leaks. One they CAN see but not change says so:
      // "not found" for an app app_list_apps just listed sends agents
      // hunting for a lookup bug that is a permission.
      if (!canReadResource(project, userId, role)) {
        return { error: `App ${appId} not found. Use app_list_apps.` };
      }
      const allowed = !opts.write || canWriteResource(project, userId, role);
      if (!allowed) {
        return {
          error:
            `You can view app ${appId} but not ${opts.deploy ? "deploy" : "change"} it: ` +
            `your access is view-only (workspace role: ${role ?? "none"}). ` +
            "Ask its owner to share it with you as an editor.",
        };
      }
    }
    return { project };
  };

  // A workflow is a folder too: `workflows/<workflowId>`, with no row behind
  // it. The shell, file and git tools take one as their target the way they
  // take an app, through an unsaved app document that only says where the
  // folder is. Nothing below persists it or looks it up.
  const workflowFolders = new WeakSet<IAppProject>();
  const loadTarget = async (
    target: { appId?: string; workflowId?: string },
    opts: { write: boolean },
  ): Promise<LoadResult> => {
    if (!target.workflowId) return loadProject(target.appId ?? "", opts);
    if (!isSafeSegment(target.workflowId)) {
      return { error: `Invalid workflow: ${target.workflowId}` };
    }
    const role = userId ? await memberRole() : "owner";
    if (!role) return { error: "You cannot see workflows in this workspace." };
    if (opts.write && role === "viewer") {
      return { error: "Viewers cannot change workflows." };
    }
    // The first workflow may be the first thing in the workspace's repo.
    // Same gate as every other content write: a connected repository.
    if (opts.write) {
      try {
        await requireWorkspaceRepo(workspaceId);
      } catch (error) {
        return { error: errorMessage(error) };
      }
    }
    const now = new Date();
    const project = toAppProjectCompat({
      id: new Types.ObjectId().toString(),
      workspaceId,
      title: target.workflowId,
      slug: target.workflowId,
      path: `${WORKFLOWS_DIR}/${target.workflowId}`,
      access: "workspace",
      createdBy: actorId,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    workflowFolders.add(project);
    return { project };
  };
  /**
   * Paths are relative to the target's folder. An agent that knows the repo
   * layout tends to pass `workflows/<id>/workflow.ts` for a workflow anyway;
   * read that as the file it means, not as a folder nested in itself.
   */
  const toRelPath = (project: IAppProject, path: string): string => {
    if (!workflowFolders.has(project)) return path;
    const prefix = `${appRootFor(project)}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  /** An app's scope names its row; a workflow folder has no row to name. */
  const scopeFor = (project: IAppProject) => {
    const scope = scopeOf(project);
    return workflowFolders.has(project)
      ? { ...scope, projectId: undefined }
      : scope;
  };

  const errorMessage = (error: unknown): string => {
    if (error instanceof WorktreeConflictError) return error.message;
    return error instanceof Error ? error.message : String(error);
  };

  /**
   * The apps this actor may see, with their state rows: the same rule as
   * GET /apps — a row's ACL when it has one, otherwise workspace content is
   * everyone's and a personal tree is its owner's (by the handle mapping).
   */
  const visibleApps = async () => {
    const folders = await listAppFolders(workspaceId);
    const docs =
      await appsMetadataRepo.listProjectAccessByWorkspace(workspaceId);
    const stateById = new Map(docs.map(d => [d.id, d]));
    const role = await memberRole();
    return folders
      .map(folder => ({ folder, state: stateById.get(folder.id) }))
      .filter(({ folder, state }) =>
        canSeeIndexedApp(folder, state, userId, role),
      );
  };

  /** `users/<handle>/apps` for the acting person, when there is one. */
  const personalRoot = async (): Promise<string | undefined> => {
    if (!userId) return undefined;
    const handle = (
      await loadOwnerDirectory(workspaceId, { forUserId: userId })
    ).handleOf(userId);
    return handle ? appTreeRoot("private", handle) : undefined;
  };

  return {
    workspaceId,
    userId,
    supportsVision,
    kind,
    targetInput,
    actorId,
    ensureActorWorktree,
    markTouched,
    currentActorBranch,
    previewBranchFor,
    markRead,
    wasRead,
    memberRole,
    loadProject,
    workflowFolders,
    loadTarget,
    toRelPath,
    scopeFor,
    errorMessage,
    visibleApps,
    personalRoot,
  };
}
