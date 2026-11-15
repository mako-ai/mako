/**
 * The caller's own view of workspaces: pending invites, the list, create,
 * the current workspace, and invite lookup/acceptance by token.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { workspaceService } from "../../services/workspace.service";
import { optionalWorkspace } from "../../middleware/workspace.middleware";
import { normalizeEmail } from "../../utils/email.utils";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  dataResponse,
} from "../../openapi/core";
import { CreateWorkspaceBody, WorkspaceSchema, TokenParam } from "./schemas";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const accountWorkspaceRoutes = createRouter();

// Get pending invitations for current user's email
accountWorkspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/pending-invites",
    tags: ["Workspaces"],
    summary: "List pending invites for the current user",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const invites = await workspaceService.getPendingInvitesForEmail(
        user.email,
      );

      return c.json({
        success: true,
        data: invites.map((invite: any) => ({
          token: invite.token,
          workspaceName: invite.workspaceId?.name || "Unknown Workspace",
          inviterEmail: invite.invitedBy?.email || "Unknown",
          role: invite.role,
          expiresAt: invite.expiresAt,
        })),
      });
    } catch (error) {
      logger.error("Error getting pending invites", { error });
      return failFromThrown(c, error, "Failed to get pending invites");
    }
  },
);

// Get all workspaces for current user
accountWorkspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Workspaces"],
    summary: "List workspaces",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    responses: {
      ...OPEN_RESPONSES,
      200: dataResponse(z.array(WorkspaceSchema), "Workspaces for the user."),
    },
  }),
  async c => {
    try {
      const user = c.get("user");
      const workspace = c.get("workspace");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }

      if (workspace) {
        const member = await workspaceService.getMember(
          workspace._id.toString(),
          user.id,
        );
        return c.json({
          success: true,
          data: [
            {
              id: workspace._id,
              name: workspace.name,
              slug: workspace.slug,
              role: member?.role,
              createdAt: workspace.createdAt,
              updatedAt: workspace.updatedAt,
              settings: workspace.settings,
            },
          ],
        });
      }

      const workspaces = await workspaceService.getWorkspacesForUser(user.id);
      return c.json({
        success: true,
        data: workspaces.map(({ workspace, role }) => ({
          id: workspace._id,
          name: workspace.name,
          slug: workspace.slug,
          role,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          settings: workspace.settings,
        })),
      });
    } catch (error) {
      logger.error("Error getting workspaces", { error });
      return failFromThrown(c, error, "Failed to get workspaces");
    }
  },
);

// Create new workspace
accountWorkspaceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Workspaces"],
    summary: "Create a workspace",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    request: { body: CreateWorkspaceBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const body = await c.req.json();
      const { name, slug } = body;

      if (!name || typeof name !== "string") {
        return fail(c, 400, "Workspace name is required");
      }

      if (!user) {
        return fail(c, 401, "Unauthorized");
      }

      const workspace = await workspaceService.createWorkspace(
        user.id,
        name,
        slug,
      );

      return c.json(
        {
          success: true,
          data: {
            id: workspace._id,
            name: workspace.name,
            slug: workspace.slug,
            createdAt: workspace.createdAt,
            settings: workspace.settings,
          },
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating workspace", { error });
      return failFromThrown(c, error, "Failed to create workspace");
    }
  },
);

// Get current workspace
accountWorkspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/current",
    tags: ["Workspaces"],
    summary: "Get the current workspace",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, optionalWorkspace] as const,
    responses: {
      ...OPEN_RESPONSES,
      200: dataResponse(
        WorkspaceSchema.nullable(),
        "The active workspace, or null.",
      ),
    },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const memberRole = c.get("memberRole");

      if (!workspace) {
        return c.json({
          success: true,
          data: null,
        });
      }

      return c.json({
        success: true,
        data: {
          id: workspace._id,
          name: workspace.name,
          slug: workspace.slug,
          role: memberRole,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          settings: workspace.settings,
        },
      });
    } catch (error) {
      logger.error("Error getting current workspace", { error });
      return failFromThrown(c, error, "Failed to get current workspace");
    }
  },
);

// Get invite details (public endpoint - no auth required)
// NOTE: This route MUST be defined before /:id to avoid being matched as a workspace ID
accountWorkspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/invites/{token}",
    tags: ["Workspaces"],
    summary: "Get invite details (public)",
    security: [],
    request: { params: TokenParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const token = c.req.param("token");

      const invite = await workspaceService.getInviteByToken(token);

      if (!invite) {
        return fail(c, 404, "Invalid or expired invitation");
      }

      // Check if invite is expired
      if (invite.expiresAt < new Date()) {
        return fail(c, 410, "This invitation has expired");
      }

      // Return invite details without sensitive data
      const workspace = invite.workspaceId as unknown as {
        name?: string;
      } | null;
      const inviter = invite.invitedBy as unknown as { email?: string } | null;

      return c.json({
        success: true,
        data: {
          workspaceName: workspace?.name || "Unknown Workspace",
          inviterEmail: inviter?.email || "Unknown",
          inviteeEmail: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
      });
    } catch (error) {
      logger.error("Error getting invite", { error });
      return failFromThrown(c, error, "Failed to get invite");
    }
  },
);

// Accept invite (requires auth, enforces email matching)
// NOTE: This route MUST be defined before /:id to avoid being matched as a workspace ID
accountWorkspaceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/invites/{token}/accept",
    tags: ["Workspaces"],
    summary: "Accept a workspace invite",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    request: { params: TokenParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const token = c.req.param("token");

      // Get invite to check email
      const invite = await workspaceService.getInviteByToken(token);

      if (!invite) {
        return fail(c, 404, "Invalid or expired invitation");
      }

      // Check if invite is expired BEFORE checking email match
      // This ensures users get the correct error message
      if (invite.expiresAt < new Date()) {
        return fail(c, 410, "This invitation has expired");
      }

      // Enforce email matching
      if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
        return fail(
          c,
          403,
          `This invitation was sent to ${invite.email}. Please log in with that email address to accept it.`,
        );
      }

      const workspace = await workspaceService.acceptInvite(token, user.id);

      return c.json({
        success: true,
        data: {
          id: workspace._id,
          name: workspace.name,
          slug: workspace.slug,
        },
        message: "Invite accepted successfully",
      });
    } catch (error) {
      logger.error("Error accepting invite", { error });
      return failFromThrown(c, error, "Failed to accept invite");
    }
  },
);
