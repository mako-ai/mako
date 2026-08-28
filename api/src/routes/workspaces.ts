import { createRoute, z } from "@hono/zod-openapi";
import {
  isSessionAuth,
  unifiedAuthMiddleware,
} from "../auth/unified-auth.middleware";
import {
  parseWorkspaceApiKeyScopes,
  resolveWorkspaceApiKeyScopes,
  type WorkspaceApiKeyScope,
} from "../auth/api-key-scopes";
import {
  listMcpConnections,
  mintMcpAccessTokenForUser,
  revokeMcpConnection,
} from "../auth/mcp-oauth.service";
import { workspaceService } from "../services/workspace.service";
import {
  APP_BINDING_REFRESH_CONCURRENCY_MAX,
  clampAppBindingRefreshConcurrency,
  clampDashboardRefreshConcurrency,
  DASHBOARD_REFRESH_CONCURRENCY_MAX,
  DEFAULT_APP_BINDING_REFRESH_CONCURRENCY,
  DEFAULT_DASHBOARD_REFRESH_CONCURRENCY,
} from "../services/workspace-refresh-limits.service";
import {
  approveAcpPlanGrant,
  revokeAcpPlanGrant,
} from "../services/acp-plan-grant.service";
import {
  requireWorkspace,
  requireWorkspaceRole,
  optionalWorkspace,
} from "../middleware/workspace.middleware";
import { Types } from "mongoose";
import { Workspace } from "../database/workspace-schema";
import { User } from "../database/schema";
import { normalizeEmail } from "../utils/email.utils";
import { loggers } from "../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  dataResponse,
  jsonBody,
  zDateTime,
  zObjectId,
} from "../openapi/core";

const MemberRole = z.enum(["admin", "member", "viewer"]);
/**
 * A workspace name is a LABEL, not a document. Unbounded free text pasted
 * at onboarding (entire app prompts, SQL queries) poisoned every list that
 * renders names — the super-admin flags page became unreadable. Collapse
 * whitespace/control characters to single spaces, trim, and cap the length;
 * the frontend mirrors the same limit.
 */
export const WORKSPACE_NAME_MAX = 80;
const workspaceNameControlChars = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + "\u007f]+",
  "g",
);
const WorkspaceName = z
  .string()
  .transform(value =>
    value.replace(workspaceNameControlChars, " ").replace(/\s+/g, " ").trim(),
  )
  .pipe(
    z
      .string()
      .min(1, "Workspace name is required")
      .max(
        WORKSPACE_NAME_MAX,
        `Workspace name must be at most ${WORKSPACE_NAME_MAX} characters`,
      ),
  );
const CreateWorkspaceBody = jsonBody(
  z.object({ name: WorkspaceName, slug: z.string().optional() }),
);
const UpdateWorkspaceBody = jsonBody(
  z.object({
    name: WorkspaceName.optional(),
    settings: z.record(z.string(), z.any()).optional(),
  }),
  true,
);
const AddMemberBody = jsonBody(
  z.object({ userId: z.string(), role: MemberRole }),
);
const UpdateMemberRoleBody = jsonBody(z.object({ role: MemberRole }));
const CreateInviteBody = jsonBody(
  z.object({ email: z.string(), role: MemberRole }),
);
const AcpPlanDecisionBody = jsonBody(
  z.object({
    agentSessionId: z.string().uuid(),
    decision: z.enum(["approve", "request_changes", "cancel"]),
    planMarkdown: z.string().max(100_000).optional(),
    grants: z
      .array(
        z.enum([
          "artifact-write",
          "warehouse-write",
          "git-write",
          "schedule-write",
        ]),
      )
      .optional(),
  }),
);

const WorkspaceSchema = z
  .object({
    id: zObjectId(),
    name: z.string(),
    slug: z.string(),
    role: z.string().optional(),
    createdAt: zDateTime(),
    updatedAt: zDateTime(),
    settings: z.record(z.string(), z.any()),
  })
  .openapi("Workspace");

const logger = loggers.workspace();

export const workspaceRoutes = createRouter();

const IdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const TokenParam = z.object({
  token: z.string().openapi({ param: { name: "token", in: "path" } }),
});
const IdUserParam = IdParam.extend({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});
const IdInviteParam = IdParam.extend({
  inviteId: z.string().openapi({ param: { name: "inviteId", in: "path" } }),
});
const IdKeyParam = IdParam.extend({
  keyId: z.string().openapi({ param: { name: "keyId", in: "path" } }),
});
const JsonBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

type WorkspaceMemberResponseSource = {
  _id: unknown;
  userId?: unknown;
  role: string;
  joinedAt: unknown;
};

function serializeWorkspaceMember(member: WorkspaceMemberResponseSource) {
  const populatedUser =
    member.userId && typeof member.userId === "object"
      ? (member.userId as { _id?: unknown; email?: unknown })
      : null;

  return {
    id: member._id,
    userId: populatedUser?._id ?? member.userId,
    email: typeof populatedUser?.email === "string" ? populatedUser.email : "",
    role: member.role,
    joinedAt: member.joinedAt,
  };
}

// Get pending invitations for current user's email
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Unauthorized" }, 401);
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
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Unauthorized" }, 401);
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
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get workspaces",
        },
        500,
      );
    }
  },
);

// Create new workspace
workspaceRoutes.openapi(
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
        return c.json(
          { success: false, error: "Workspace name is required" },
          400,
        );
      }

      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
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
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to create workspace",
        },
        500,
      );
    }
  },
);

// Get current workspace
workspaceRoutes.openapi(
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
workspaceRoutes.openapi(
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
      logger.error("Error getting invite", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get invite",
        },
        500,
      );
    }
  },
);

// Accept invite (requires auth, enforces email matching)
// NOTE: This route MUST be defined before /:id to avoid being matched as a workspace ID
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
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
      if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
        return c.json(
          {
            success: false,
            error: `This invitation was sent to ${invite.email}. Please log in with that email address to accept it.`,
          },
          403,
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
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const workspaceId = c.req.param("id");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json({ success: false, error: "Invalid workspace ID" }, 400);
      }

      if (authenticatedWorkspace) {
        if (authenticatedWorkspace._id.toString() !== workspaceId) {
          return c.json({ success: false, error: "Access denied" }, 403);
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
              typeof authenticatedWorkspace.selfDirective === "string"
                ? authenticatedWorkspace.selfDirective
                : "",
          },
        });
      }

      // Check if user has access
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const workspace = await workspaceService.getWorkspaceById(workspaceId);
      if (!workspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
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
            typeof workspace.selfDirective === "string"
              ? workspace.selfDirective
              : "",
        },
      });
    } catch (error) {
      logger.error("Error getting workspace", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get workspace",
        },
        500,
      );
    }
  },
);

// Update workspace
workspaceRoutes.openapi(
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

      if (!updatedWorkspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
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

// Update the workspace's AI model blocklist.
//
// The workspace settings UI is enable-centric ("uncheck to hide from this
// workspace"), but the source of truth is the inverse: `disabledModelIds` is
// the list of super-admin-curated models the workspace has explicitly opted
// out of. An empty blocklist means every curated model is available, so
// models the platform adds later automatically appear in the chat dropdown.
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const body = await c.req.json();
      const { disabledModelIds } = body as {
        disabledModelIds?: unknown;
      };

      if (
        !Array.isArray(disabledModelIds) ||
        !disabledModelIds.every(id => typeof id === "string")
      ) {
        return c.json(
          {
            success: false,
            error: "disabledModelIds must be an array of strings",
          },
          400,
        );
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
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update disabled models",
        },
        500,
      );
    }
  },
);

// Get the workspace's AI model blocklist.
workspaceRoutes.openapi(
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
      return c.json(
        { success: false, error: "Failed to fetch disabled models" },
        500,
      );
    }
  },
);

function isFiniteNumberish(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return Number.isFinite(parseInt(value, 10));
  return false;
}

// Get workspace refresh / concurrency limits.
workspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/settings/limits",
    tags: ["Workspaces"],
    summary: "Get workspace refresh concurrency limits",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const dashboardRefreshConcurrency = clampDashboardRefreshConcurrency(
        workspace.settings?.dashboardRefreshConcurrency ??
          DEFAULT_DASHBOARD_REFRESH_CONCURRENCY,
      );
      const appBindingRefreshConcurrency = clampAppBindingRefreshConcurrency(
        workspace.settings?.appBindingRefreshConcurrency ??
          DEFAULT_APP_BINDING_REFRESH_CONCURRENCY,
      );
      return c.json({
        success: true,
        dashboardRefreshConcurrency,
        appBindingRefreshConcurrency,
        dashboardRefreshConcurrencyMax: DASHBOARD_REFRESH_CONCURRENCY_MAX,
        appBindingRefreshConcurrencyMax: APP_BINDING_REFRESH_CONCURRENCY_MAX,
        dashboardRefreshConcurrencyDefault:
          DEFAULT_DASHBOARD_REFRESH_CONCURRENCY,
        appBindingRefreshConcurrencyDefault:
          DEFAULT_APP_BINDING_REFRESH_CONCURRENCY,
      });
    } catch (error) {
      logger.error("Error fetching workspace limits settings", { error });
      return c.json(
        {
          success: false,
          error: "Failed to fetch workspace limits settings",
        },
        500,
      );
    }
  },
);

// Update workspace refresh / concurrency limits.
workspaceRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/settings/limits",
    tags: ["Workspaces"],
    summary: "Update workspace refresh concurrency limits",
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
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const body = (await c.req.json()) as {
        dashboardRefreshConcurrency?: unknown;
        appBindingRefreshConcurrency?: unknown;
      };

      if (
        body.dashboardRefreshConcurrency === undefined &&
        body.appBindingRefreshConcurrency === undefined
      ) {
        return c.json(
          {
            success: false,
            error:
              "Provide dashboardRefreshConcurrency and/or appBindingRefreshConcurrency",
          },
          400,
        );
      }

      if (
        body.dashboardRefreshConcurrency !== undefined &&
        !isFiniteNumberish(body.dashboardRefreshConcurrency)
      ) {
        return c.json(
          {
            success: false,
            error: "dashboardRefreshConcurrency must be a number",
          },
          400,
        );
      }

      if (
        body.appBindingRefreshConcurrency !== undefined &&
        !isFiniteNumberish(body.appBindingRefreshConcurrency)
      ) {
        return c.json(
          {
            success: false,
            error: "appBindingRefreshConcurrency must be a number",
          },
          400,
        );
      }

      const dashboardRefreshConcurrency = clampDashboardRefreshConcurrency(
        body.dashboardRefreshConcurrency ??
          workspace.settings?.dashboardRefreshConcurrency ??
          DEFAULT_DASHBOARD_REFRESH_CONCURRENCY,
      );
      const appBindingRefreshConcurrency = clampAppBindingRefreshConcurrency(
        body.appBindingRefreshConcurrency ??
          workspace.settings?.appBindingRefreshConcurrency ??
          DEFAULT_APP_BINDING_REFRESH_CONCURRENCY,
      );

      await Workspace.findByIdAndUpdate(workspaceId, {
        $set: {
          "settings.dashboardRefreshConcurrency": dashboardRefreshConcurrency,
          "settings.appBindingRefreshConcurrency": appBindingRefreshConcurrency,
        },
      });

      logger.info("Updated workspace refresh limits", {
        workspaceId,
        dashboardRefreshConcurrency,
        appBindingRefreshConcurrency,
      });

      return c.json({
        success: true,
        dashboardRefreshConcurrency,
        appBindingRefreshConcurrency,
        dashboardRefreshConcurrencyMax: DASHBOARD_REFRESH_CONCURRENCY_MAX,
        appBindingRefreshConcurrencyMax: APP_BINDING_REFRESH_CONCURRENCY_MAX,
        dashboardRefreshConcurrencyDefault:
          DEFAULT_DASHBOARD_REFRESH_CONCURRENCY,
        appBindingRefreshConcurrencyDefault:
          DEFAULT_APP_BINDING_REFRESH_CONCURRENCY,
      });
    } catch (error) {
      logger.error("Error updating workspace limits settings", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update workspace limits settings",
        },
        500,
      );
    }
  },
);

// Delete workspace
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      await workspaceService.deleteWorkspace(workspaceId);

      return c.json({
        success: true,
        message: "Workspace deleted successfully",
      });
    } catch (error) {
      logger.error("Error deleting workspace", { error });
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
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const workspaceId = c.req.param("id");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json({ success: false, error: "Invalid workspace ID" }, 400);
      }

      if (authenticatedWorkspace) {
        if (authenticatedWorkspace._id.toString() !== workspaceId) {
          return c.json({ success: false, error: "Access denied" }, 403);
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
workspaceRoutes.openapi(
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
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const members = await workspaceService.getMembers(workspaceId);

      return c.json({
        success: true,
        data: members.map(serializeWorkspaceMember),
      });
    } catch (error) {
      logger.error("Error getting members", { error });
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
workspaceRoutes.openapi(
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
          data: serializeWorkspaceMember(member),
        },
        201,
      );
    } catch (error) {
      logger.error("Error adding member", { error });
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
workspaceRoutes.openapi(
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
        data: serializeWorkspaceMember(updatedMember),
      });
    } catch (error) {
      logger.error("Error updating member role", { error });
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
workspaceRoutes.openapi(
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
      logger.error("Error removing member", { error });
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
workspaceRoutes.openapi(
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

      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
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
workspaceRoutes.openapi(
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
      logger.error("Error getting invites", { error });
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
workspaceRoutes.openapi(
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
      logger.error("Error cancelling invite", { error });
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
workspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/api-keys",
    tags: ["Workspaces"],
    summary: "List workspace API keys",
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
      if (!isSessionAuth(c)) {
        return c.json(
          {
            success: false,
            error: "API key management requires a browser session",
          },
          403,
        );
      }
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
          scopes: resolveWorkspaceApiKeyScopes(key.scopes),
        })) || [];

      return c.json({
        success: true,
        apiKeys,
      });
    } catch (error) {
      logger.error("Error listing API keys", { error });
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
workspaceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/api-keys",
    tags: ["Workspaces"],
    summary: "Create a workspace API key",
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
      if (!isSessionAuth(c)) {
        return c.json(
          {
            success: false,
            error: "API key management requires a browser session",
          },
          403,
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { name, scopes: rawScopes } = body;

      if (workspaceId !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return c.json(
          { success: false, error: "API key name is required" },
          400,
        );
      }

      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      let scopes: WorkspaceApiKeyScope[];
      try {
        scopes = parseWorkspaceApiKeyScopes(rawScopes);
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error ? error.message : "Invalid API key scopes",
          },
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
        scopes,
        createdAt: new Date(),
        createdBy: user.id,
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
          createdAt: createdKey?.createdAt,
          scopes: resolveWorkspaceApiKeyScopes(createdKey?.scopes),
        },
        key, // Only return the full key once, during creation
        message:
          "API key created successfully. Store this key securely - it won't be shown again.",
      });
    } catch (error) {
      logger.error("Error creating API key", { error });
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
workspaceRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/api-keys/{keyId}",
    tags: ["Workspaces"],
    summary: "Delete a workspace API key",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdKeyParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return c.json(
          {
            success: false,
            error: "API key management requires a browser session",
          },
          403,
        );
      }
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
      logger.error("Error deleting API key", { error });
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

// MCP OAuth connections (agents connected via the MCP sign-in flow)

const IdClientParam = IdParam.extend({
  clientId: z.string().openapi({ param: { name: "clientId", in: "path" } }),
});

// POST /api/workspaces/:id/mcp-access-token — mint MCP Bearer for ACP attach
workspaceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/mcp-access-token",
    tags: ["Workspaces"],
    summary:
      "Mint a short-lived MCP access token for attaching Mako tools to a local ACP session",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return c.json(
          {
            success: false,
            error: "MCP access tokens require a browser session",
          },
          403,
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const tokens = await mintMcpAccessTokenForUser({
        userId: user.id,
        workspaceId: workspace._id.toString(),
      });

      // Client builds absolute mcpUrl from window.location.origin so preview
      // proxies and custom hosts stay correct; we only mint the Bearer here.
      return c.json({
        success: true,
        data: {
          accessToken: tokens.accessToken,
          expiresIn: tokens.expiresInSeconds,
          scopes: tokens.scopes,
          agentSessionId: tokens.agentSessionId,
          mcpPath: "/api/mcp",
          authorization: `Bearer ${tokens.accessToken}`,
        },
      });
    } catch (error) {
      logger.error("Error minting MCP access token", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to mint MCP access token",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:id/acp-plan-grant — approve/revoke Desktop task grants
workspaceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/acp-plan-grant",
    tags: ["Workspaces"],
    summary: "Apply a Desktop ACP plan decision",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam, body: AcpPlanDecisionBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return c.json(
          { success: false, error: "Plan decisions require a browser session" },
          403,
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }
      const input = c.req.valid("json");
      if (input.decision === "approve") {
        if (!input.planMarkdown?.trim()) {
          return c.json(
            {
              success: false,
              error: "An approved plan must include planMarkdown",
            },
            400,
          );
        }
        const grant = await approveAcpPlanGrant({
          workspaceId: workspace._id.toString(),
          userId: String(user.id),
          agentSessionId: input.agentSessionId,
          planMarkdown: input.planMarkdown,
          grants: input.grants ?? ["artifact-write"],
        });
        return c.json({ success: true, data: grant });
      }
      await revokeAcpPlanGrant({
        workspaceId: workspace._id.toString(),
        userId: String(user.id),
        agentSessionId: input.agentSessionId,
      });
      return c.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to apply plan decision";
      const status = /not found/i.test(message) ? 404 : 500;
      logger.error("Error applying ACP plan decision", { error });
      return c.json({ success: false, error: message }, status);
    }
  },
);

/** Members see their own connected agents; owners/admins see everyone's. */
function canSeeAllMcpConnections(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

// GET /api/workspaces/:id/mcp-connections - List agents connected via OAuth
workspaceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/mcp-connections",
    tags: ["Workspaces"],
    summary: "List MCP agents connected to the workspace via OAuth",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return c.json(
          {
            success: false,
            error: "MCP connection management requires a browser session",
          },
          403,
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      const seeAll = canSeeAllMcpConnections(c.get("memberRole"));
      const all = await listMcpConnections(workspace._id.toString());
      const visible = seeAll
        ? all
        : all.filter(conn => conn.userId === user.id);

      // User _ids are UUID strings, not ObjectIds.
      const userIds = [...new Set(visible.map(conn => conn.userId))];
      const users = await User.find({ _id: { $in: userIds } })
        .select("email")
        .lean();
      const emailByUserId = new Map(
        users.map(u => [String(u._id), u.email] as const),
      );

      return c.json({
        success: true,
        connections: visible.map(conn => ({
          clientId: conn.clientId,
          clientName: conn.clientName || "Unknown client",
          userId: conn.userId,
          userEmail: emailByUserId.get(conn.userId) ?? "",
          isOwn: conn.userId === user.id,
          connectedAt: conn.connectedAt,
          lastUsedAt: conn.lastUsedAt ?? null,
        })),
        canSeeAll: seeAll,
      });
    } catch (error) {
      logger.error("Error listing MCP connections", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to list MCP connections",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:id/mcp-connections/:clientId - Revoke an agent
workspaceRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/mcp-connections/{clientId}",
    tags: ["Workspaces"],
    summary: "Revoke an MCP agent's OAuth access to the workspace",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: IdClientParam,
      query: z.object({ userId: z.string().optional() }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return c.json(
          {
            success: false,
            error: "MCP connection management requires a browser session",
          },
          403,
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return c.json({ success: false, error: "Workspace ID mismatch" }, 400);
      }

      // Members may only revoke their own grants; owners/admins anyone's.
      const targetUserId = c.req.query("userId") || user.id;
      if (
        targetUserId !== user.id &&
        !canSeeAllMcpConnections(c.get("memberRole"))
      ) {
        return c.json(
          { success: false, error: "Insufficient permissions in workspace" },
          403,
        );
      }

      const revoked = await revokeMcpConnection({
        workspaceId: workspace._id.toString(),
        clientId: c.req.param("clientId"),
        userId: targetUserId,
      });
      if (revoked === 0) {
        return c.json({ success: false, error: "Connection not found" }, 404);
      }

      return c.json({ success: true, revokedGrants: revoked });
    } catch (error) {
      logger.error("Error revoking MCP connection", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to revoke MCP connection",
        },
        500,
      );
    }
  },
);
