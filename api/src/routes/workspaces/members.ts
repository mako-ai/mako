/** Workspace membership: list, add, change role, remove. */
import { createRoute } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { workspaceService } from "../../services/workspace.service";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  AddMemberBody,
  UpdateMemberRoleBody,
  IdParam,
  IdUserParam,
  serializeWorkspaceMember,
} from "./schemas";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const workspaceMemberRoutes = createRouter();

// Get workspace members
workspaceMemberRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/members",
    tags: ["Workspaces"],
    summary: "List workspace members",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
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

      const members = await workspaceService.getMembers(workspaceId);

      return c.json({
        success: true,
        data: members.map(serializeWorkspaceMember),
      });
    } catch (error) {
      logger.error("Error getting members", { error });
      return failFromThrown(c, error, "Failed to get members");
    }
  },
);

// Add member to workspace
workspaceMemberRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/members",
    tags: ["Workspaces"],
    summary: "Add a workspace member",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: AddMemberBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { userId, role } = body;

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      if (!userId || typeof userId !== "string") {
        return fail(c, 400, "Valid user ID is required");
      }

      if (!role || !["admin", "member", "viewer"].includes(role)) {
        return fail(
          c,
          400,
          "Valid role is required (admin, member, or viewer)",
        );
      }

      const member = await workspaceService.addMember(
        workspaceId,
        userId,
        role,
      );

      return c.json(
        {
          success: true,
          data: serializeWorkspaceMember(member),
        },
        201,
      );
    } catch (error) {
      logger.error("Error adding member", { error });
      return failFromThrown(c, error, "Failed to add member");
    }
  },
);

// Update member role
workspaceMemberRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/members/{userId}",
    tags: ["Workspaces"],
    summary: "Update a member's role",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdUserParam, body: UpdateMemberRoleBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const userId = c.req.param("userId");
      const body = await c.req.json();
      const { role } = body;

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      if (!role || !["admin", "member", "viewer"].includes(role)) {
        return fail(
          c,
          400,
          "Valid role is required (admin, member, or viewer)",
        );
      }

      // Don't allow changing owner role
      const currentMember = await workspaceService.getMember(
        workspaceId,
        userId,
      );
      if (currentMember?.role === "owner") {
        return fail(c, 403, "Cannot change owner role");
      }

      const updatedMember = await workspaceService.updateMemberRole(
        workspaceId,
        userId,
        role,
      );

      if (!updatedMember) {
        return fail(c, 404, "Member not found");
      }

      return c.json({
        success: true,
        data: serializeWorkspaceMember(updatedMember),
      });
    } catch (error) {
      logger.error("Error updating member role", { error });
      return failFromThrown(c, error, "Failed to update member role");
    }
  },
);

// Remove member from workspace
workspaceMemberRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/members/{userId}",
    tags: ["Workspaces"],
    summary: "Remove a workspace member",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdUserParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const userId = c.req.param("userId");

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      // Don't allow removing owner
      const member = await workspaceService.getMember(workspaceId, userId);
      if (member?.role === "owner") {
        return fail(c, 403, "Cannot remove workspace owner");
      }

      const removed = await workspaceService.removeMember(workspaceId, userId);

      if (!removed) {
        return fail(c, 404, "Member not found");
      }

      return c.json({
        success: true,
        message: "Member removed successfully",
      });
    } catch (error) {
      logger.error("Error removing member", { error });
      return failFromThrown(c, error, "Failed to remove member");
    }
  },
);
