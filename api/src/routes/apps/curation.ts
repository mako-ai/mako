/**
 * Lifecycle and curation (the stale plan, `verified`, share-with-workspace,
 * move, stamp-id) and reading / deleting one app.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  deleteProject,
  appRootFor,
  folderTargetFromPath,
  moveProject,
  stampAppId,
} from "../../apps/worktree.service";
import { resolveAppRef } from "../../apps/app-index.service";
import { parseAppRepoPath } from "../../apps/app-paths";
import { loadOwnerDirectory } from "../../apps/user-handles.service";
import { authorizeAppMove } from "../../apps/app-authorization";
import {
  getAppLifecyclePlan,
  setAppVerified,
} from "../../apps/app-lifecycle.service";
import { RepoRequiredError } from "../../apps/config";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  ProjectParam,
  WorkspaceParam,
  actingUserId,
  handleError,
  isWorkspaceAdminRole,
  loadProject,
  manifestForProject,
  memberRoleFor,
  toProjectJson,
} from "./shared";

export const appsCurationRoutes = createRouter();

// ---------------------------------------------------------------------------
// Lifecycle + curation (app-lifecycle.service.ts): the stale/unviewed plan,
// the admin `verified` mark, and "Share with workspace".
// ---------------------------------------------------------------------------

appsCurationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/lifecycle/plan",
    tags: ["Apps"],
    summary: "What the app lifecycle job would do now (admins)",
    description:
      "The daily lifecycle job's plan for this workspace, computed now and changing nothing: apps it would notify as stale, archive, or whose binding schedules it would pause or resume. `mode` says whether the job only logs this plan (dry-run, the default) or applies it.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const userId = actingUserId(c);
      if (!isWorkspaceAdminRole(await memberRoleFor(workspaceId, userId))) {
        return c.json(
          { success: false, error: "Only workspace admins can see this" },
          403,
        );
      }
      const plan = await getAppLifecyclePlan(workspaceId);
      return c.json({ success: true as const, plan }, 200);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: false, error: error.message }, 412);
      }
      return handleError(c, error);
    }
  },
);

appsCurationRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/verified",
    tags: ["Apps"],
    summary: "Mark an app verified (or not) — workspace admins",
    description:
      "A workspace admin vouches for an app: the mark (with who and when) is shown on the app list as `verified`, and a verified app is never archived as stale.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ verified: z.boolean() }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const workspaceId = loaded.project.workspaceId.toString();
      const userId = loaded.userId;
      if (
        !userId ||
        !isWorkspaceAdminRole(await memberRoleFor(workspaceId, userId))
      ) {
        return c.json(
          { success: false, error: "Only workspace admins can verify apps" },
          403,
        );
      }
      if (parseAppRepoPath(appRootFor(loaded.project))?.scope !== "workspace") {
        return c.json(
          {
            success: false,
            error: "Only apps in the Workspace tree can be verified",
          },
          400,
        );
      }
      const { verified } = c.req.valid("json");
      const result = await setAppVerified(
        workspaceId,
        loaded.project._id.toString(),
        verified,
        userId,
      );
      return c.json({ success: true as const, ...result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsCurationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/share-with-workspace",
    tags: ["Apps"],
    summary: "Move a personal app into the Workspace tree",
    description:
      "The explicit step that turns a personal app (`users/<me>/apps/…`) into workspace content: one commit on main moving its folder under `apps/` (or the given workspace folder) and writing the one-line description into mako.json. The app keeps its id, so its deployment, sharing and favourites follow it. Only the app's owner, with an editing role, can do this.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              /** One line telling colleagues what the app is for. */
              description: z.string().trim().min(1).max(300),
              /** Workspace folder to file it in (default: `apps`). */
              folder: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { description, folder } = c.req.valid("json");
      const workspaceId = loaded.project.workspaceId.toString();
      const userId = loaded.userId;
      const source = parseAppRepoPath(appRootFor(loaded.project));
      if (source?.scope !== "private") {
        return c.json(
          { success: false, error: "This app is already in the Workspace" },
          409,
        );
      }
      const target = folderTargetFromPath(folder ?? "apps");
      if (target.scope !== "workspace") {
        return c.json(
          { success: false, error: "Pick a folder in the Workspace tree" },
          400,
        );
      }
      // `users/<handle>/` is the owner's tree through the handle mapping,
      // never by the raw segment.
      const denied = authorizeAppMove(
        source,
        target,
        userId,
        await memberRoleFor(workspaceId, userId),
        await loadOwnerDirectory(workspaceId, { forUserId: userId }),
      );
      if (denied) return c.json({ success: false, error: denied }, 403);
      const moved = await moveProject(loaded.project, target, {
        userId,
        description,
      });
      return c.json(
        {
          success: true as const,
          ...moved,
          app: toProjectJson(loaded.project, {
            title: loaded.project.title,
            description,
          }),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsCurationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/move",
    tags: ["Apps"],
    summary: "File the app in another folder (and/or rename its folder)",
    description:
      "One commit on main moving the app's directory. The app keeps its id — stamped into mako.json if it had none — so deployments, sharing, env vars and favourites follow it, and nothing is rebuilt. Moving into or out of the Workspace tree needs an editing role; a personal tree is its owner's.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              /** Destination folder: `apps`, `apps/Sales`, `users/<handle>/apps`. */
              folder: z.string().min(1),
              /** New folder name for the app itself (a rename). */
              name: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { folder, name } = c.req.valid("json");
      const workspaceId = loaded.project.workspaceId.toString();
      const userId = loaded.userId;
      const role = await memberRoleFor(workspaceId, userId);
      const target = folderTargetFromPath(folder);
      const source = parseAppRepoPath(appRootFor(loaded.project));
      const denied = authorizeAppMove(
        source,
        target,
        userId,
        role,
        await loadOwnerDirectory(workspaceId, { forUserId: userId }),
      );
      if (denied) return c.json({ success: false, error: denied }, 403);
      const moved = await moveProject(
        loaded.project,
        { ...target, slug: name },
        { userId },
      );
      return c.json(
        {
          success: true as const,
          ...moved,
          app: toProjectJson(loaded.project),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsCurationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/stamp-id",
    tags: ["Apps"],
    summary: "Give a copied app its own id",
    description:
      "For a folder whose mako.json declares an id another app already holds (a copy that kept its source's manifest). Writes the id the index filed it under into its manifest, as one commit on main.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const workspaceId = loaded.project.workspaceId.toString();
      const row = await resolveAppRef(
        workspaceId,
        loaded.project._id.toString(),
      );
      if (!row) {
        return c.json(
          { success: false, error: "App folder is not on main" },
          404,
        );
      }
      await stampAppId(workspaceId, row, { userId: loaded.userId });
      return c.json({ success: true as const, id: row.appId }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsCurationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Apps"],
    summary: "Get an Apps project",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const manifest = await manifestForProject(
        loaded.project.workspaceId.toString(),
        loaded.project,
      );
      return c.json(
        {
          success: true as const,
          app: toProjectJson(loaded.project, manifest),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsCurationRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Apps"],
    summary: "Delete an Apps project (repo included)",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      await deleteProject(loaded.project);
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
