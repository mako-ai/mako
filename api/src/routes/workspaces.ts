import { Hono } from "hono";
import { authMiddleware } from "../auth/auth.middleware";
import { workspaceService } from "../services/workspace.service";
import {
  requireWorkspace,
  requireWorkspaceRole,
  optionalWorkspace,
  AuthenticatedContext,
} from "../middleware/workspace.middleware";
import { Types } from "mongoose";
import { Workspace } from "../database/workspace-schema";
import { normalizeEmail } from "../utils/email.utils";

export const workspaceRoutes = new Hono();

// Get pending invitations for current user's email
workspaceRoutes.get(
  "/pending-invites",
  authMiddleware,
  async (c: AuthenticatedContext) => {
    try {
      const user = c.get("user");
      const invites = await workspaceService.getPendingInvitesForEmail(
        user!.email,
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
      console.error("Error getting pending invites:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get pending invites",
        },
        500,
      );
    }
  },
);

// Get all workspaces for current user
workspaceRoutes.get("/", authMiddleware, async (c: AuthenticatedContext) => {
  try {
    const user = c.get("user");
    const workspaces = await workspaceService.getWorkspacesForUser(user!.id);
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
    console.error("Error getting workspaces:", error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get workspaces",
      },
      500,
    );
  }
});

// Create new workspace
workspaceRoutes.post("/", authMiddleware, async (c: AuthenticatedContext) => {
  try {
    const user = c.get("user");
    const body = await c.req.json();
    const { name, slug } = body;

    if (!name || typeof name !== "string") {
      return c.json(
        { success: false, error: "Workspace name is required" },
        400,
      );
    }

    const workspace = await workspaceService.createWorkspace(
      user!.id,
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
    console.error("Error creating workspace:", error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create workspace",
      },
      500,
    );
  }
});

// Get current workspace
workspaceRoutes.get(
  "/current",
  authMiddleware,
  optionalWorkspace,
  async (c: AuthenticatedContext) => {
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
      console.error("Error getting current workspace:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get current workspace",
        },
        500,
      );
    }
  },
);

// Get invite details (public endpoint - no auth required)
// NOTE: This route MUST be defined before /:id to avoid being matched as a workspace ID
workspaceRoutes.get("/invites/:token", async c => {
  try {
    const token = c.req.param("token");

    const invite = await workspaceService.getInviteByToken(token);

    if (!invite) {
      return c.json(
        {
          success: false,
          error: "Invalid or expired invitation",
        },
        404,
      );
    }

    // Check if invite is expired
    if (invite.expiresAt < new Date()) {
      return c.json(
        {
          success: false,
          error: "This invitation has expired",
        },
        410,
      );
    }

    // Return invite details without sensitive data
    const workspace = invite.workspaceId as any;
    const inviter = invite.invitedBy as any;

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
    console.error("Error getting invite:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get invite",
      },
      500,
    );
  }
});

// Accept invite (requires auth, enforces email matching)
// NOTE: This route MUST be defined before /:id to avoid being matched as a workspace ID
workspaceRoutes.post(
  "/invites/:token/accept",
  authMiddleware,
  async (c: AuthenticatedContext) => {
    try {
      const user = c.get("user");
      const token = c.req.param("token");

      // Get invite to check email
      const invite = await workspaceService.getInviteByToken(token);

      if (!invite) {
        return c.json(
          {
            success: false,
            error: "Invalid or expired invitation",
          },
          404,
        );
      }

      // Check if invite is expired BEFORE checking email match
      // This ensures users get the correct error message
      if (invite.expiresAt < new Date()) {
        return c.json(
          {
            success: false,
            error: "This invitation has expired",
          },
          410,
        );
      }

      // Enforce email matching
      if (normalizeEmail(user!.email) !== normalizeEmail(invite.email)) {
        return c.json(
          {
            success: false,
            error: `This invitation was sent to ${invite.email}. Please log in with that email address to accept it.`,
          },
          403,
        );
      }

      const workspace = await workspaceService.acceptInvite(token, user!.id);

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
      console.error("Error accepting invite:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to accept invite",
        },
        500,
      );
    }
  },
);

// Get specific workspace
workspaceRoutes.get("/:id", authMiddleware, async (c: AuthenticatedContext) => {
  try {
    const user = c.get("user");
    const workspaceId = c.req.param("id");

    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json({ success: false, error: "Invalid workspace ID" }, 400);
    }

    // Check if user has access
    const hasAccess = await workspaceService.hasAccess(workspaceId, user!.id);
    if (!hasAccess) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const workspace = await workspaceService.getWorkspaceById(workspaceId);
    if (!workspace) {
      return c.json({ success: false, error: "Workspace not found" }, 404);
    }

    const member = await workspaceService.getMember(workspaceId, user!.id);

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
      },
    });
  } catch (error) {
    console.error("Error getting workspace:", error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get workspace",
      },
      500,
    );
  }
});

// Update workspace
workspaceRoutes.put(
  "/:id",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const updates: any = {};
      if (body.name) updates.name = body.name;
      if (body.settings) {
        updates.settings = { ...workspace.settings, ...body.settings };
      }

      const updatedWorkspace = await workspaceService.updateWorkspace(
        workspaceId,
        updates,
      );

      return c.json({
        success: true,
        data: {
          id: updatedWorkspace!._id,
          name: updatedWorkspace!.name,
          slug: updatedWorkspace!.slug,
          updatedAt: updatedWorkspace!.updatedAt,
          settings: updatedWorkspace!.settings,
        },
      });
    } catch (error) {
      console.error("Error updating workspace:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update workspace",
        },
        500,
      );
    }
  },
);

// Delete workspace
workspaceRoutes.delete(
  "/:id",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      await workspaceService.deleteWorkspace(workspaceId);

      return c.json({
        success: true,
        message: "Workspace deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting workspace:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to delete workspace",
        },
        500,
      );
    }
  },
);

// Switch active workspace
workspaceRoutes.post(
  "/:id/switch",
  authMiddleware,
  async (c: AuthenticatedContext) => {
    try {
      const user = c.get("user");
      const workspaceId = c.req.param("id");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json({ success: false, error: "Invalid workspace ID" }, 400);
      }

      await workspaceService.switchWorkspace(user!.id, workspaceId);

      return c.json({
        success: true,
        message: "Workspace switched successfully",
      });
    } catch (error) {
      console.error("Error switching workspace:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to switch workspace",
        },
        500,
      );
    }
  },
);

// Get workspace members
workspaceRoutes.get(
  "/:id/members",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const members = await workspaceService.getMembers(workspaceId);

      return c.json({
        success: true,
        data: members.map((member: any) => ({
          id: member._id,
          userId: member.userId._id || member.userId,
          email: member.userId.email || "",
          role: member.role,
          joinedAt: member.joinedAt,
        })),
      });
    } catch (error) {
      console.error("Error getting members:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get members",
        },
        500,
      );
    }
  },
);

// Add member to workspace
workspaceRoutes.post(
  "/:id/members",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { userId, role } = body;

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      if (!userId || typeof userId !== "string") {
        return c.json(
          { success: false, error: "Valid user ID is required" },
          400,
        );
      }

      if (!role || !["admin", "member", "viewer"].includes(role)) {
        return c.json(
          {
            success: false,
            error: "Valid role is required (admin, member, or viewer)",
          },
          400,
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
          data: {
            id: member._id,
            userId: member.userId,
            role: member.role,
            joinedAt: member.joinedAt,
          },
        },
        201,
      );
    } catch (error) {
      console.error("Error adding member:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to add member",
        },
        500,
      );
    }
  },
);

// Update member role
workspaceRoutes.put(
  "/:id/members/:userId",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const userId = c.req.param("userId");
      const body = await c.req.json();
      const { role } = body;

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      if (!role || !["admin", "member", "viewer"].includes(role)) {
        return c.json(
          {
            success: false,
            error: "Valid role is required (admin, member, or viewer)",
          },
          400,
        );
      }

      // Don't allow changing owner role
      const currentMember = await workspaceService.getMember(
        workspaceId,
        userId,
      );
      if (currentMember?.role === "owner") {
        return c.json(
          { success: false, error: "Cannot change owner role" },
          403,
        );
      }

      const updatedMember = await workspaceService.updateMemberRole(
        workspaceId,
        userId,
        role,
      );

      if (!updatedMember) {
        return c.json({ success: false, error: "Member not found" }, 404);
      }

      return c.json({
        success: true,
        data: {
          id: updatedMember._id,
          userId: updatedMember.userId,
          role: updatedMember.role,
          joinedAt: updatedMember.joinedAt,
        },
      });
    } catch (error) {
      console.error("Error updating member role:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update member role",
        },
        500,
      );
    }
  },
);

// Remove member from workspace
workspaceRoutes.delete(
  "/:id/members/:userId",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const userId = c.req.param("userId");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      // Don't allow removing owner
      const member = await workspaceService.getMember(workspaceId, userId);
      if (member?.role === "owner") {
        return c.json(
          { success: false, error: "Cannot remove workspace owner" },
          403,
        );
      }

      const removed = await workspaceService.removeMember(workspaceId, userId);

      if (!removed) {
        return c.json({ success: false, error: "Member not found" }, 404);
      }

      return c.json({
        success: true,
        message: "Member removed successfully",
      });
    } catch (error) {
      console.error("Error removing member:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to remove member",
        },
        500,
      );
    }
  },
);

// Create workspace invite
workspaceRoutes.post(
  "/:id/invites",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const user = c.get("user");
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { email, role } = body;

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      if (!email || typeof email !== "string") {
        return c.json({ success: false, error: "Email is required" }, 400);
      }

      if (!role || !["admin", "member", "viewer"].includes(role)) {
        return c.json(
          {
            success: false,
            error: "Valid role is required (admin, member, or viewer)",
          },
          400,
        );
      }

      const invite = await workspaceService.createInvite(
        workspaceId,
        email,
        role,
        user!.id,
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
      console.error("Error creating invite:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to create invite",
        },
        500,
      );
    }
  },
);

// Get pending invites
workspaceRoutes.get(
  "/:id/invites",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const invites = await workspaceService.getPendingInvites(workspaceId);

      return c.json({
        success: true,
        data: invites.map((invite: any) => ({
          id: invite._id,
          email: invite.email,
          role: invite.role,
          invitedBy: invite.invitedBy?.email || "",
          expiresAt: invite.expiresAt,
        })),
      });
    } catch (error) {
      console.error("Error getting invites:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get invites",
        },
        500,
      );
    }
  },
);

// Cancel invite
workspaceRoutes.delete(
  "/:id/invites/:inviteId",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const inviteId = c.req.param("inviteId");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const cancelled = await workspaceService.cancelInvite(inviteId);

      if (!cancelled) {
        return c.json({ success: false, error: "Invite not found" }, 404);
      }

      return c.json({
        success: true,
        message: "Invite cancelled successfully",
      });
    } catch (error) {
      console.error("Error cancelling invite:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to cancel invite",
        },
        500,
      );
    }
  },
);

// API Key Management Routes

// GET /api/workspaces/:id/api-keys - List API keys
workspaceRoutes.get(
  "/:id/api-keys",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      // Return API keys without the hash
      const apiKeys =
        workspace.apiKeys?.map((key: any) => ({
          id: key._id,
          name: key.name,
          prefix: key.prefix,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          createdBy: key.createdBy,
        })) || [];

      return c.json({
        success: true,
        apiKeys,
      });
    } catch (error) {
      console.error("Error listing API keys:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to list API keys",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:id/api-keys - Create new API key
workspaceRoutes.post(
  "/:id/api-keys",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const user = c.get("user");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { name } = body;

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return c.json(
          { success: false, error: "API key name is required" },
          400,
        );
      }

      // Import the generateApiKey function
      const { generateApiKey } = await import("../auth/api-key.middleware");

      // Generate new API key
      const { key, hash, prefix } = generateApiKey();

      // Add API key to workspace
      const newApiKey = {
        name: name.trim(),
        keyHash: hash,
        prefix,
        createdAt: new Date(),
        createdBy: user!.id,
      };

      const updatedWorkspace = await Workspace.findByIdAndUpdate(
        workspace._id,
        {
          $push: { apiKeys: newApiKey },
        },
        { new: true },
      );

      // Find the newly created API key
      const createdKey = updatedWorkspace?.apiKeys?.slice(-1)[0];

      return c.json({
        success: true,
        apiKey: {
          id: createdKey?._id,
          name: createdKey?.name,
          prefix: createdKey?.prefix,
          key, // Only return the full key once, during creation
          createdAt: createdKey?.createdAt,
        },
        message:
          "API key created successfully. Store this key securely - it won't be shown again.",
      });
    } catch (error) {
      console.error("Error creating API key:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to create API key",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:id/api-keys/:keyId - Delete API key
workspaceRoutes.delete(
  "/:id/api-keys/:keyId",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const keyId = c.req.param("keyId");

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      // Remove API key from workspace
      const updatedWorkspace = await Workspace.findByIdAndUpdate(
        workspace._id,
        {
          $pull: { apiKeys: { _id: keyId } },
        },
        { new: true },
      );

      if (!updatedWorkspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
      }

      return c.json({
        success: true,
        message: "API key deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting API key:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to delete API key",
        },
        500,
      );
    }
  },
);
