/**
 * Access granted to agents: MCP access tokens, Desktop task (ACP) plan
 * grants, and agents connected through the MCP OAuth sign-in flow.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  isSessionAuth,
  unifiedAuthMiddleware,
} from "../../auth/unified-auth.middleware";
import {
  listMcpConnections,
  mintMcpAccessTokenForUser,
  revokeMcpConnection,
} from "../../auth/mcp-oauth.service";
import {
  approveAcpPlanGrant,
  revokeAcpPlanGrant,
} from "../../services/acp-plan-grant.service";
import { requireWorkspace } from "../../middleware/workspace.middleware";
import { authRepo } from "../../repositories/auth";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { AcpPlanDecisionBody, IdParam } from "./schemas";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const workspaceAgentAccessRoutes = createRouter();

// MCP OAuth connections (agents connected via the MCP sign-in flow)

const IdClientParam = IdParam.extend({
  clientId: z.string().openapi({ param: { name: "clientId", in: "path" } }),
});

// POST /api/workspaces/:id/mcp-access-token — mint MCP Bearer for ACP attach
workspaceAgentAccessRoutes.openapi(
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
        return fail(c, 403, "MCP access tokens require a browser session");
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
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
      return failFromThrown(c, error, "Failed to mint MCP access token");
    }
  },
);

// POST /api/workspaces/:id/acp-plan-grant — approve/revoke Desktop task grants
workspaceAgentAccessRoutes.openapi(
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
        return fail(c, 403, "Plan decisions require a browser session");
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }
      const input = c.req.valid("json");
      if (input.decision === "approve") {
        if (!input.planMarkdown?.trim()) {
          return fail(c, 400, "An approved plan must include planMarkdown");
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
      return fail(c, status, message);
    }
  },
);

/** Members see their own connected agents; owners/admins see everyone's. */
function canSeeAllMcpConnections(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

// GET /api/workspaces/:id/mcp-connections - List agents connected via OAuth
workspaceAgentAccessRoutes.openapi(
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
        return fail(
          c,
          403,
          "MCP connection management requires a browser session",
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      const seeAll = canSeeAllMcpConnections(c.get("memberRole"));
      const all = await listMcpConnections(workspace._id.toString());
      const visible = seeAll
        ? all
        : all.filter(conn => conn.userId === user.id);

      // User ids are string identifiers (15-char Lucia IDs or UUIDs), not ObjectIds.
      const userIds = [...new Set(visible.map(conn => conn.userId))];
      const users = await authRepo.findUsersByIds(userIds);
      const emailByUserId = new Map(users.map(u => [u.id, u.email] as const));

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
      return failFromThrown(c, error, "Failed to list MCP connections");
    }
  },
);

// DELETE /api/workspaces/:id/mcp-connections/:clientId - Revoke an agent
workspaceAgentAccessRoutes.openapi(
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
        return fail(
          c,
          403,
          "MCP connection management requires a browser session",
        );
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      if (c.req.param("id") !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      // Members may only revoke their own grants; owners/admins anyone's.
      const targetUserId = c.req.query("userId") || user.id;
      if (
        targetUserId !== user.id &&
        !canSeeAllMcpConnections(c.get("memberRole"))
      ) {
        return fail(c, 403, "Insufficient permissions in workspace");
      }

      const revoked = await revokeMcpConnection({
        workspaceId: workspace._id.toString(),
        clientId: c.req.param("clientId"),
        userId: targetUserId,
      });
      if (revoked === 0) {
        return fail(c, 404, "Connection not found");
      }

      return c.json({ success: true, revokedGrants: revoked });
    } catch (error) {
      logger.error("Error revoking MCP connection", { error });
      return failFromThrown(c, error, "Failed to revoke MCP connection");
    }
  },
);
