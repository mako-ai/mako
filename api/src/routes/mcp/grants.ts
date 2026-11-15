/** Tool approval: the chat cards' tool info and each member's own grants. */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { loggers } from "../../logging";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  MCP_SERVER_WIDE_GRANT_TOOL,
  McpToolGrant,
} from "../../database/workspace-schema";
import {
  listMcpToolUiInfo,
  mcpToolRestriction,
} from "../../services/mcp-client.service";
import { fail } from "../lib/respond";
import { WorkspaceParam, ServerIdParam, loadServer } from "./shared";

const logger = loggers.api("mcp");

export const mcpGrantRoutes = createRouter();

// --- Tool UI info for the chat approval cards ---
mcpGrantRoutes.openapi(
  createRoute({
    method: "get",
    path: "/tool-info",
    tags: ["MCP"],
    summary: "List MCP tool metadata for the chat UI",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const user = (c as AuthenticatedContext).get("user");
      const tools = await listMcpToolUiInfo(workspaceId, user?.id);
      return c.json({ success: true, tools });
    } catch (error) {
      logger.error("Error listing MCP tool info", { error });
      return fail(c, 500, "Failed to list tool info");
    }
  },
);

const GrantSchema = z.object({
  /**
   * Raw MCP tool name, or `"*"` for a server-wide Always allow / Block grant
   * (applies to every tool the admin ceiling still permits).
   */
  toolName: z.string().min(1),
  decision: z.enum(["always_allow", "always_deny"]),
});

// --- List my grants for a server ---
mcpGrantRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/grants",
    tags: ["MCP"],
    summary: "List the current user's tool grants for an MCP server",
    security: AUTH_SECURITY,
    request: { params: ServerIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !id) {
        return fail(c, 404, "Server not found");
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }
      const grants = await McpToolGrant.find({
        serverId: server._id,
        userId: user.id,
      }).lean();
      return c.json({
        success: true,
        grants: grants.map(g => ({
          id: g._id.toString(),
          toolName: g.toolName,
          decision: g.decision,
          lastUsedAt: g.lastUsedAt ?? null,
          createdAt: g.createdAt,
        })),
      });
    } catch (error) {
      logger.error("Error listing MCP grants", { error });
      return fail(c, 500, "Failed to list grants");
    }
  },
);

// --- Upsert a grant (always allow / always deny) for the current user ---
mcpGrantRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/grants",
    tags: ["MCP"],
    summary: "Create or update a tool grant for the current user",
    security: AUTH_SECURITY,
    request: {
      params: ServerIdParam,
      body: {
        required: true,
        content: { "application/json": { schema: GrantSchema } },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !id) {
        return fail(c, 404, "Server not found");
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }
      const parsed = GrantSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return fail(c, 400, "Invalid request body");
      }
      const { toolName, decision } = parsed.data;
      const isServerWide = toolName === MCP_SERVER_WIDE_GRANT_TOOL;

      if (!isServerWide) {
        const cachedTool = server.cachedTools.find(t => t.name === toolName);
        if (!cachedTool) {
          return fail(c, 404, "Unknown tool");
        }
        // The admin restriction is a ceiling: users can always choose stricter
        // (always_deny/Block is always permitted), but "Always allow" requires
        // an "always" ceiling.
        const ceiling = mcpToolRestriction(server, cachedTool);
        if (decision === "always_allow" && ceiling !== "always") {
          return fail(
            c,
            403,
            ceiling === "block"
              ? "This tool has been blocked by a workspace admin."
              : "A workspace admin restricted this tool to Ask — it cannot be always-allowed.",
          );
        }
      } else if (decision === "always_allow") {
        // Server-wide Always allow only covers tools with an "always" ceiling;
        // ask/block tools still prompt or stay hidden. Require at least one
        // always-allowable tool so the grant isn't a silent no-op.
        const hasAlwaysCeiling = server.cachedTools.some(
          t => mcpToolRestriction(server, t) === "always",
        );
        if (!hasAlwaysCeiling) {
          return fail(
            c,
            403,
            "No tools on this server can be always-allowed — a workspace admin restricted them to Ask or Block.",
          );
        }
      }

      await McpToolGrant.updateOne(
        { serverId: server._id, userId: user.id, toolName },
        { $set: { workspaceId: server.workspaceId, decision } },
        { upsert: true },
      );
      logger.info("MCP tool grant saved", {
        workspaceId,
        serverId: server._id.toString(),
        toolName,
        decision,
        serverWide: isServerWide,
      });
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error saving MCP grant", { error });
      return fail(c, 500, "Failed to save grant");
    }
  },
);

// --- Revoke a grant (own only) ---
mcpGrantRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/grants/{grantId}",
    tags: ["MCP"],
    summary: "Revoke one of the current user's tool grants",
    security: AUTH_SECURITY,
    request: {
      params: ServerIdParam.extend({
        grantId: z.string().openapi({ param: { name: "grantId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      const grantId = c.req.param("grantId");
      if (!workspaceId || !id || !grantId) {
        return fail(c, 404, "Grant not found");
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }
      if (!Types.ObjectId.isValid(grantId)) {
        return fail(c, 404, "Grant not found");
      }
      const result = await McpToolGrant.deleteOne({
        _id: new Types.ObjectId(grantId),
        serverId: server._id,
        userId: user.id,
      });
      if (result.deletedCount === 0) {
        return fail(c, 404, "Grant not found");
      }
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error revoking MCP grant", { error });
      return fail(c, 500, "Failed to revoke grant");
    }
  },
);
