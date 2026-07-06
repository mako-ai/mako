/**
 * MCP server admin + grants routes.
 *
 * Mounted at `/api/workspaces/:workspaceId/mcp-servers` (authenticated,
 * workspace-scoped — same access pattern as skills.ts). Server CRUD and
 * shared-credential management require the workspace owner/admin role;
 * per-user credentials and grants are managed by each member for themselves.
 *
 * A small public catalog route (`/api/mcp/presets`) exposes the preset
 * metadata that drives the "Add MCP server" form.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  type IMcpServer,
  McpConnectionConfig,
  McpServer,
  McpToolGrant,
} from "../database/workspace-schema";
import { MCP_PRESETS, getMcpPreset } from "../mcp/presets";
import { encryptRecord } from "../services/crypto.service";
import {
  assertSafeMcpUrl,
  discoverMcpTools,
  listMcpToolUiInfo,
  mcpToolRestriction,
  mcpToolRiskTier,
} from "../services/mcp-client.service";
import {
  completeMcpOAuthFlow,
  startMcpOAuthFlow,
} from "../services/mcp-oauth.service";

const logger = loggers.api("mcp");

// ---------------------------------------------------------------------------
// Preset catalog (public: static metadata, like /api/connectors/types) and
// the OAuth callback (session-authed browser redirect target).
// ---------------------------------------------------------------------------

export const mcpPresetRoutes = createRouter();

mcpPresetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/presets",
    tags: ["MCP"],
    summary: "List MCP connector presets",
    responses: { ...OPEN_RESPONSES },
  }),
  c => {
    return c.json({ success: true, presets: Object.values(MCP_PRESETS) });
  },
);

// OAuth callback — the browser lands here after consenting at the provider.
// Session-authed (cookies ride the redirect); the flow is looked up by the
// unguessable `state` and must belong to the session user.
mcpPresetRoutes.use("/oauth/callback", unifiedAuthMiddleware);
mcpPresetRoutes.openapi(
  createRoute({
    method: "get",
    path: "/oauth/callback",
    tags: ["MCP"],
    summary: "MCP OAuth authorization callback",
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { code, state, error, error_description } = c.req.query();
    const settingsUrl = "/settings/mcp";
    if (error) {
      logger.warn("MCP OAuth callback returned an error", {
        error,
        error_description,
      });
      return c.redirect(
        `${settingsUrl}?oauth_error=${encodeURIComponent(error_description || error)}`,
      );
    }
    if (!code || !state) {
      return c.redirect(`${settingsUrl}?oauth_error=Missing+code+or+state`);
    }
    const user = (c as AuthenticatedContext).get("user");
    if (!user) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    try {
      await completeMcpOAuthFlow({
        state,
        code,
        sessionUserId: user.id,
      });
      return c.redirect(`${settingsUrl}?oauth_connected=1`);
    } catch (err) {
      logger.error("MCP OAuth callback failed", { error: err });
      const message =
        err instanceof Error ? err.message : "OAuth connection failed";
      return c.redirect(
        `${settingsUrl}?oauth_error=${encodeURIComponent(message)}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Workspace-scoped server CRUD + credentials + grants
// ---------------------------------------------------------------------------

export const mcpRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const ServerIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

mcpRoutes.use("*", unifiedAuthMiddleware);

// Workspace access check — mirrors skills.ts
mcpRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    await next();
    return;
  }
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { success: false, error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

async function requireAdmin(
  c: AuthenticatedContext,
  workspaceId: string,
): Promise<string | null> {
  const user = c.get("user");
  if (!user) return null;
  const isAdmin = await workspaceService.isAdmin(workspaceId, user.id);
  return isAdmin ? user.id : null;
}

function serializeServer(
  server: IMcpServer,
  extras: {
    hasWorkspaceCredential?: boolean;
    hasUserCredential?: boolean;
  } = {},
) {
  return {
    id: server._id.toString(),
    name: server.name,
    description: server.description ?? null,
    connectorType: server.connectorType,
    transport: server.transport,
    authType: server.authType,
    authPerformer: server.authPerformer,
    writeScope: server.writeScope,
    toolPolicy: {
      defaultRestriction: server.toolPolicy?.defaultRestriction ?? "always",
      restrictions: server.toolPolicy?.restrictions ?? {},
    },
    cachedTools: (server.cachedTools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? null,
      annotations: t.annotations ?? null,
      riskTier: mcpToolRiskTier(server, t),
      restriction: mcpToolRestriction(server, t),
    })),
    status: server.status,
    lastError: server.lastError ?? null,
    lastConnectedAt: server.lastConnectedAt ?? null,
    isActive: server.isActive,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    hasWorkspaceCredential: extras.hasWorkspaceCredential ?? false,
    hasUserCredential: extras.hasUserCredential ?? false,
  };
}

async function loadServer(
  workspaceId: string,
  id: string,
): Promise<IMcpServer | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return McpServer.findOne({
    _id: new Types.ObjectId(id),
    workspaceId: new Types.ObjectId(workspaceId),
  });
}

// --- List servers ---
mcpRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["MCP"],
    summary: "List MCP servers",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const user = (c as AuthenticatedContext).get("user");
      const servers = await McpServer.find({
        workspaceId: new Types.ObjectId(workspaceId),
      }).sort({ createdAt: 1 });

      const configs = await McpConnectionConfig.find({
        serverId: { $in: servers.map(s => s._id) },
      })
        .select("serverId userId oauthTokens headers")
        .lean();

      // For OAuth servers a credential only counts once tokens exist.
      const hasUsableCredential = (
        server: IMcpServer,
        cfg: (typeof configs)[number],
      ): boolean =>
        server.authType === "oauth"
          ? !!cfg.oauthTokens
          : Object.keys(cfg.headers ?? {}).length > 0;

      return c.json({
        success: true,
        servers: servers.map(server =>
          serializeServer(server, {
            hasWorkspaceCredential: configs.some(
              cfg =>
                cfg.serverId.toString() === server._id.toString() &&
                cfg.userId === "" &&
                hasUsableCredential(server, cfg),
            ),
            hasUserCredential: configs.some(
              cfg =>
                cfg.serverId.toString() === server._id.toString() &&
                cfg.userId === (user?.id ?? "") &&
                hasUsableCredential(server, cfg),
            ),
          }),
        ),
      });
    } catch (error) {
      logger.error("Error listing MCP servers", { error });
      return c.json({ success: false, error: "Failed to list servers" }, 500);
    }
  },
);

const CreateServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  connectorType: z.string().min(1).max(50),
  url: z.string().url().optional(),
  authType: z.enum(["none", "api_key", "oauth"]).optional(),
  writeScope: z.enum(["read", "write_safe", "write_destructive"]).optional(),
});

// --- Create server (admin) ---
mcpRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["MCP"],
    summary: "Create an MCP server",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        required: true,
        content: { "application/json": { schema: CreateServerSchema } },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const adminUserId = await requireAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (!adminUserId) {
        return c.json(
          { success: false, error: "Workspace admin role required" },
          403,
        );
      }

      const parsed = CreateServerSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid request body" }, 400);
      }
      const body = parsed.data;
      const preset = getMcpPreset(body.connectorType);
      const url = preset.urlEditable ? body.url : preset.url;
      if (!url) {
        return c.json({ success: false, error: "Server URL is required" }, 400);
      }
      try {
        await assertSafeMcpUrl(url);
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error ? error.message : "URL is not allowed",
          },
          400,
        );
      }

      const server = await McpServer.create({
        workspaceId: new Types.ObjectId(workspaceId),
        name: body.name,
        description: body.description,
        connectorType: preset.type,
        transport: { type: "http", url },
        authType: body.authType ?? preset.authType,
        // Claude-connectors model: every user authenticates and signs in
        // individually. Enabling a connector never grants shared data access.
        authPerformer: "user",
        writeScope: body.writeScope ?? "read",
        status: "awaiting_auth",
        createdBy: adminUserId,
      });

      return c.json({ success: true, server: serializeServer(server) });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return c.json(
          { success: false, error: "A server with this name already exists" },
          409,
        );
      }
      logger.error("Error creating MCP server", { error });
      return c.json({ success: false, error: "Failed to create server" }, 500);
    }
  },
);

const UpdateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  url: z.string().url().optional(),
  writeScope: z.enum(["read", "write_safe", "write_destructive"]).optional(),
  isActive: z.boolean().optional(),
  toolPolicy: z
    .object({
      defaultRestriction: z.enum(["always", "ask", "block"]).optional(),
      restrictions: z
        .record(z.string(), z.enum(["always", "ask", "block"]))
        .optional(),
    })
    .optional(),
});

// --- Update server (admin) ---
mcpRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["MCP"],
    summary: "Update an MCP server",
    security: AUTH_SECURITY,
    request: {
      params: ServerIdParam,
      body: {
        required: true,
        content: { "application/json": { schema: UpdateServerSchema } },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const adminUserId = await requireAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (!adminUserId) {
        return c.json(
          { success: false, error: "Workspace admin role required" },
          403,
        );
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }

      const parsed = UpdateServerSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid request body" }, 400);
      }
      const body = parsed.data;
      const preset = getMcpPreset(server.connectorType);

      if (body.name !== undefined) server.name = body.name;
      if (body.description !== undefined) server.description = body.description;
      if (body.url !== undefined && preset.urlEditable) {
        try {
          await assertSafeMcpUrl(body.url);
        } catch (error) {
          return c.json(
            {
              success: false,
              error:
                error instanceof Error ? error.message : "URL is not allowed",
            },
            400,
          );
        }
        server.transport = { type: "http", url: body.url };
      }
      if (body.writeScope !== undefined) server.writeScope = body.writeScope;
      if (body.isActive !== undefined) server.isActive = body.isActive;
      if (body.toolPolicy) {
        if (body.toolPolicy.defaultRestriction !== undefined) {
          server.toolPolicy.defaultRestriction =
            body.toolPolicy.defaultRestriction;
        }
        if (body.toolPolicy.restrictions !== undefined) {
          server.toolPolicy.restrictions = body.toolPolicy.restrictions;
          server.markModified("toolPolicy.restrictions");
        }
      }
      await server.save();
      return c.json({ success: true, server: serializeServer(server) });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return c.json(
          { success: false, error: "A server with this name already exists" },
          409,
        );
      }
      logger.error("Error updating MCP server", { error });
      return c.json({ success: false, error: "Failed to update server" }, 500);
    }
  },
);

// --- Delete server (admin) ---
mcpRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["MCP"],
    summary: "Delete an MCP server",
    security: AUTH_SECURITY,
    request: { params: ServerIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const adminUserId = await requireAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (!adminUserId) {
        return c.json(
          { success: false, error: "Workspace admin role required" },
          403,
        );
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      await Promise.all([
        McpConnectionConfig.deleteMany({ serverId: server._id }),
        McpToolGrant.deleteMany({ serverId: server._id }),
        server.deleteOne(),
      ]);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error deleting MCP server", { error });
      return c.json({ success: false, error: "Failed to delete server" }, 500);
    }
  },
);

const CredentialsSchema = z.object({
  headers: z.record(z.string(), z.string()),
});

// --- Save credentials (admin for workspace-performer, self for user-performer) ---
mcpRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/credentials",
    tags: ["MCP"],
    summary: "Save MCP server credentials",
    security: AUTH_SECURITY,
    request: {
      params: ServerIdParam,
      body: {
        required: true,
        content: { "application/json": { schema: CredentialsSchema } },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }

      let configUserId: string;
      if (server.authPerformer === "workspace") {
        const adminUserId = await requireAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (!adminUserId) {
          return c.json(
            { success: false, error: "Workspace admin role required" },
            403,
          );
        }
        configUserId = "";
      } else {
        configUserId = user.id;
      }

      const parsed = CredentialsSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid request body" }, 400);
      }

      await McpConnectionConfig.updateOne(
        { serverId: server._id, userId: configUserId },
        {
          $set: {
            workspaceId: server.workspaceId,
            headers: encryptRecord(parsed.data.headers),
          },
        },
        { upsert: true },
      );

      if (server.status === "created") {
        server.status = "awaiting_auth";
        await server.save();
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error saving MCP credentials", { error });
      return c.json(
        { success: false, error: "Failed to save credentials" },
        500,
      );
    }
  },
);

// --- Start an OAuth connection (returns the authorization URL) ---
mcpRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/oauth/connect",
    tags: ["MCP"],
    summary: "Start the OAuth flow for an MCP server connection",
    security: AUTH_SECURITY,
    request: { params: ServerIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !id) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      if (server.authType !== "oauth") {
        return c.json(
          { success: false, error: "This server does not use OAuth" },
          400,
        );
      }

      let configUserId: string;
      if (server.authPerformer === "workspace") {
        const adminUserId = await requireAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (!adminUserId) {
          return c.json(
            { success: false, error: "Workspace admin role required" },
            403,
          );
        }
        configUserId = "";
      } else {
        configUserId = user.id;
      }

      const { authorizationUrl } = await startMcpOAuthFlow({
        server,
        configUserId,
        startedByUserId: user.id,
      });
      return c.json({
        success: true,
        authorizationUrl,
        alreadyAuthorized: authorizationUrl === "",
      });
    } catch (error) {
      logger.error("Error starting MCP OAuth flow", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to start OAuth flow",
        },
        500,
      );
    }
  },
);

// --- Test connection + refresh tools ---
mcpRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["MCP"],
    summary: "Test MCP server connection and refresh its tool list",
    security: AUTH_SECURITY,
    request: { params: ServerIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }

      // Test with the credential this request's user would use at chat time.
      const configUserId = server.authPerformer === "user" ? user.id : "";
      const config = await McpConnectionConfig.findOne({
        serverId: server._id,
        userId: configUserId,
      }).lean();
      const missingCredential =
        server.authType === "oauth"
          ? !config?.oauthTokens
          : !config && server.authType !== "none";
      if (missingCredential) {
        return c.json(
          {
            success: false,
            error:
              server.authType === "oauth"
                ? server.authPerformer === "user"
                  ? "Connect your account first"
                  : "Connect the workspace account first"
                : server.authPerformer === "user"
                  ? "Connect your credentials first"
                  : "Save workspace credentials first",
          },
          400,
        );
      }

      try {
        const tools = await discoverMcpTools(
          server,
          (config?.headers ?? {}) as Record<string, string>,
          configUserId,
        );
        server.cachedTools = tools;
        server.status = "connected";
        server.lastError = undefined;
        server.lastConnectedAt = new Date();
        await server.save();
        logger.info("MCP server connected", {
          workspaceId,
          serverId: server._id.toString(),
          toolCount: tools.length,
        });
        return c.json({ success: true, server: serializeServer(server) });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Connection failed";
        server.status = "error";
        server.lastError = message.substring(0, 500);
        await server.save();
        return c.json(
          { success: false, error: message, server: serializeServer(server) },
          502,
        );
      }
    } catch (error) {
      logger.error("Error testing MCP server", { error });
      return c.json({ success: false, error: "Failed to test server" }, 500);
    }
  },
);

// --- Tool UI info for the chat approval cards ---
mcpRoutes.openapi(
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
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const user = (c as AuthenticatedContext).get("user");
      const tools = await listMcpToolUiInfo(workspaceId, user?.id);
      return c.json({ success: true, tools });
    } catch (error) {
      logger.error("Error listing MCP tool info", { error });
      return c.json({ success: false, error: "Failed to list tool info" }, 500);
    }
  },
);

const GrantSchema = z.object({
  toolName: z.string().min(1),
  decision: z.enum(["always_allow", "always_deny"]),
});

// --- List my grants for a server ---
mcpRoutes.openapi(
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
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
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
      return c.json({ success: false, error: "Failed to list grants" }, 500);
    }
  },
);

// --- Upsert a grant (always allow / always deny) for the current user ---
mcpRoutes.openapi(
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
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      const parsed = GrantSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid request body" }, 400);
      }
      const { toolName, decision } = parsed.data;

      const cachedTool = server.cachedTools.find(t => t.name === toolName);
      if (!cachedTool) {
        return c.json({ success: false, error: "Unknown tool" }, 404);
      }
      // The admin restriction is a ceiling: users can always choose stricter
      // (always_deny/Block is always permitted), but "Always allow" requires
      // an "always" ceiling.
      const ceiling = mcpToolRestriction(server, cachedTool);
      if (decision === "always_allow" && ceiling !== "always") {
        return c.json(
          {
            success: false,
            error:
              ceiling === "block"
                ? "This tool has been blocked by a workspace admin."
                : "A workspace admin restricted this tool to Ask — it cannot be always-allowed.",
          },
          403,
        );
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
      });
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error saving MCP grant", { error });
      return c.json({ success: false, error: "Failed to save grant" }, 500);
    }
  },
);

// --- Revoke a grant (own only) ---
mcpRoutes.openapi(
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
        return c.json({ success: false, error: "Grant not found" }, 404);
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return c.json({ success: false, error: "Server not found" }, 404);
      }
      if (!Types.ObjectId.isValid(grantId)) {
        return c.json({ success: false, error: "Grant not found" }, 404);
      }
      const result = await McpToolGrant.deleteOne({
        _id: new Types.ObjectId(grantId),
        serverId: server._id,
        userId: user.id,
      });
      if (result.deletedCount === 0) {
        return c.json({ success: false, error: "Grant not found" }, 404);
      }
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error revoking MCP grant", { error });
      return c.json({ success: false, error: "Failed to revoke grant" }, 500);
    }
  },
);
