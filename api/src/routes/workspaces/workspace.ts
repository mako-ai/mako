/** One workspace by id: read, update, model blocklist, delete, switch. */
import { createRoute } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { workspaceService } from "../../services/workspace.service";
import { readWorkspaceSelfDirectiveFile } from "../../apps/workspace-prompt";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import { Types } from "mongoose";
import { Workspace, type IWorkspace } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  dataResponse,
} from "../../openapi/core";
import {
  UpdateWorkspaceBody,
  WorkspaceSchema,
  IdParam,
  JsonBody,
} from "./schemas";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const workspaceByIdRoutes = createRouter();

// Get specific workspace
workspaceByIdRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Workspaces"],
    summary: "Get a workspace",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    request: { params: IdParam },
    responses: {
      ...OPEN_RESPONSES,
      200: dataResponse(WorkspaceSchema, "The workspace."),
    },
  }),
  async c => {
    try {
      const user = c.get("user");
      const authenticatedWorkspace = c.get("workspace");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const workspaceId = c.req.param("id");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return fail(c, 400, "Invalid workspace ID");
      }

      if (authenticatedWorkspace) {
        if (authenticatedWorkspace._id.toString() !== workspaceId) {
          return fail(c, 403, "Access denied");
        }

        const member = await workspaceService.getMember(workspaceId, user.id);
        return c.json({
          success: true,
          data: {
            id: authenticatedWorkspace._id,
            name: authenticatedWorkspace.name,
            slug: authenticatedWorkspace.slug,
            role: member?.role,
            createdAt: authenticatedWorkspace.createdAt,
            updatedAt: authenticatedWorkspace.updatedAt,
            settings: authenticatedWorkspace.settings,
            selfDirective:
              (await readWorkspaceSelfDirectiveFile(workspaceId)) ?? "",
          },
        });
      }

      // Check if user has access
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return fail(c, 403, "Access denied");
      }

      const workspace = await workspaceService.getWorkspaceById(workspaceId);
      if (!workspace) {
        return fail(c, 404, "Workspace not found");
      }

      const member = await workspaceService.getMember(workspaceId, user.id);

      return c.json({
        success: true,
        data: {
          id: workspace._id,
          name: workspace.name,
          slug: workspace.slug,
          role: member?.role,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          settings: workspace.settings,
          selfDirective:
            (await readWorkspaceSelfDirectiveFile(workspaceId)) ?? "",
        },
      });
    } catch (error) {
      logger.error("Error getting workspace", { error });
      return failFromThrown(c, error, "Failed to get workspace");
    }
  },
);

// Update workspace
workspaceByIdRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Workspaces"],
    summary: "Update a workspace",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: UpdateWorkspaceBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      const updates: Partial<IWorkspace> = {};
      if (body.name) updates.name = body.name;
      if (body.settings) {
        updates.settings = { ...workspace.settings, ...body.settings };
      }

      const updatedWorkspace = await workspaceService.updateWorkspace(
        workspaceId,
        updates,
      );

      if (!updatedWorkspace) {
        return fail(c, 404, "Workspace not found");
      }

      return c.json({
        success: true,
        data: {
          id: updatedWorkspace._id,
          name: updatedWorkspace.name,
          slug: updatedWorkspace.slug,
          updatedAt: updatedWorkspace.updatedAt,
          settings: updatedWorkspace.settings,
        },
      });
    } catch (error) {
      logger.error("Error updating workspace", { error });
      return failFromThrown(c, error, "Failed to update workspace");
    }
  },
);

// Update the workspace's AI model blocklist.
//
// The workspace settings UI is enable-centric ("uncheck to hide from this
// workspace"), but the source of truth is the inverse: `disabledModelIds` is
// the list of super-admin-curated models the workspace has explicitly opted
// out of. An empty blocklist means every curated model is available, so
// models the platform adds later automatically appear in the chat dropdown.
workspaceByIdRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/settings/models",
    tags: ["Workspaces"],
    summary: "Update the workspace model blocklist",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: JsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      const body = await c.req.json();
      const { disabledModelIds } = body as {
        disabledModelIds?: unknown;
      };

      if (
        !Array.isArray(disabledModelIds) ||
        !disabledModelIds.every(id => typeof id === "string")
      ) {
        return fail(c, 400, "disabledModelIds must be an array of strings");
      }

      // Deduplicate
      const deduped = Array.from(new Set(disabledModelIds as string[]));

      await Workspace.findByIdAndUpdate(workspaceId, {
        $set: { "settings.disabledModelIds": deduped },
      });

      logger.info("Updated workspace model blocklist", {
        workspaceId,
        disabledCount: deduped.length,
      });

      return c.json({ success: true, disabledModelIds: deduped });
    } catch (error) {
      logger.error("Error updating workspace model blocklist", { error });
      return failFromThrown(c, error, "Failed to update disabled models");
    }
  },
);

// Get the workspace's AI model blocklist.
workspaceByIdRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/settings/models",
    tags: ["Workspaces"],
    summary: "Get the workspace model blocklist",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const disabledModelIds = workspace.settings?.disabledModelIds ?? [];
      return c.json({ success: true, disabledModelIds });
    } catch (error) {
      logger.error("Error fetching workspace model blocklist", { error });
      return fail(c, 500, "Failed to fetch disabled models");
    }
  },
);

// Delete workspace
workspaceByIdRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Workspaces"],
    summary: "Delete a workspace",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner"]),
    ] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      await workspaceService.deleteWorkspace(workspaceId);

      return c.json({
        success: true,
        message: "Workspace deleted successfully",
      });
    } catch (error) {
      logger.error("Error deleting workspace", { error });
      return failFromThrown(c, error, "Failed to delete workspace");
    }
  },
);

// Switch active workspace
workspaceByIdRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/switch",
    tags: ["Workspaces"],
    summary: "Switch the active workspace",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const authenticatedWorkspace = c.get("workspace");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const workspaceId = c.req.param("id");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return fail(c, 400, "Invalid workspace ID");
      }

      if (authenticatedWorkspace) {
        if (authenticatedWorkspace._id.toString() !== workspaceId) {
          return fail(c, 403, "Access denied");
        }

        return c.json({
          success: true,
          message: "API key is already scoped to this workspace",
        });
      }

      await workspaceService.switchWorkspace(user.id, workspaceId);

      return c.json({
        success: true,
        message: "Workspace switched successfully",
      });
    } catch (error) {
      logger.error("Error switching workspace", { error });
      return failFromThrown(c, error, "Failed to switch workspace");
    }
  },
);
