/** Invitations an owner/admin sends, lists and revokes. */
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
import { CreateInviteBody, IdParam, IdInviteParam } from "./schemas";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const workspaceInviteRoutes = createRouter();

// Create workspace invite
workspaceInviteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/invites",
    tags: ["Workspaces"],
    summary: "Create a workspace invite",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: CreateInviteBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { email, role } = body;

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      if (!email || typeof email !== "string") {
        return fail(c, 400, "Email is required");
      }

      if (!role || !["admin", "member", "viewer"].includes(role)) {
        return fail(
          c,
          400,
          "Valid role is required (admin, member, or viewer)",
        );
      }

      if (!user) {
        return fail(c, 401, "Unauthorized");
      }

      const invite = await workspaceService.createInvite(
        workspaceId,
        email,
        role,
        user.id,
      );

      return c.json(
        {
          success: true,
          data: {
            id: invite._id,
            email: invite.email,
            role: invite.role,
            token: invite.token,
            expiresAt: invite.expiresAt,
          },
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating invite", { error });
      const message =
        error instanceof Error ? error.message : "Failed to create invite";
      return fail(c, message.includes("already a member") ? 409 : 500, message);
    }
  },
);

// Get pending invites
workspaceInviteRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/invites",
    tags: ["Workspaces"],
    summary: "List pending workspace invites",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
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

      const invites = await workspaceService.getPendingInvites(workspaceId);

      return c.json({
        success: true,
        data: invites.map(invite => ({
          id: invite._id,
          email: invite.email,
          role: invite.role,
          invitedBy: invite.inviter?.email || "",
          expiresAt: invite.expiresAt,
        })),
      });
    } catch (error) {
      logger.error("Error getting invites", { error });
      return failFromThrown(c, error, "Failed to get invites");
    }
  },
);

// Cancel invite
workspaceInviteRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/invites/{inviteId}",
    tags: ["Workspaces"],
    summary: "Cancel a workspace invite",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdInviteParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const inviteId = c.req.param("inviteId");

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      const cancelled = await workspaceService.cancelInvite(
        workspaceId,
        inviteId,
      );

      if (!cancelled) {
        return fail(c, 404, "Invite not found");
      }

      return c.json({
        success: true,
        message: "Invite cancelled successfully",
      });
    } catch (error) {
      logger.error("Error cancelling invite", { error });
      return failFromThrown(c, error, "Failed to cancel invite");
    }
  },
);

// API Key Management Routes
