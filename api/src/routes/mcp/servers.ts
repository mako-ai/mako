/** MCP server CRUD (create/update/delete are owner/admin). */
import { createRoute, z } from "@hono/zod-openapi";
import { loggers } from "../../logging";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { parseEntityId } from "../../database/pg/id-codec";
import {
  isDuplicateServerNameError,
  mcpRepo,
  type McpConnectionConfigRecord,
  type McpServerRecord,
  type UpdateMcpServerPatch,
} from "../../repositories/mcp";
import { getMcpPreset } from "../../mcp/presets";
import { assertSafeMcpUrl } from "../../services/mcp-client.service";
import { fail } from "../lib/respond";
import {
  WorkspaceParam,
  ServerIdParam,
  requireAdmin,
  serializeServer,
  loadServer,
} from "./shared";

const logger = loggers.api("mcp");

export const mcpServerRoutes = createRouter();

// --- List servers ---
mcpServerRoutes.openapi(
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
      if (!workspaceId || !parseEntityId(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const user = (c as AuthenticatedContext).get("user");
      const currentUserId = user?.id ?? null;
      const servers = await mcpRepo.listServersByWorkspace(workspaceId);
      const configs = await mcpRepo.listConnectionConfigsForUser(
        workspaceId,
        servers.map(s => s.id),
        currentUserId,
      );

      // For OAuth servers a credential only counts once tokens exist.
      const hasUsableCredential = (
        server: McpServerRecord,
        cfg: McpConnectionConfigRecord,
      ): boolean =>
        server.authType === "oauth"
          ? !!cfg.oauthTokensEncrypted
          : Object.keys(cfg.headersEncrypted ?? {}).length > 0;

      return c.json({
        success: true,
        servers: servers.map(server =>
          serializeServer(server, {
            hasWorkspaceCredential: configs.some(
              cfg =>
                cfg.serverId === server.id &&
                cfg.userId === null &&
                hasUsableCredential(server, cfg),
            ),
            hasUserCredential:
              currentUserId !== null &&
              configs.some(
                cfg =>
                  cfg.serverId === server.id &&
                  cfg.userId !== null &&
                  hasUsableCredential(server, cfg),
              ),
          }),
        ),
      });
    } catch (error) {
      logger.error("Error listing MCP servers", { error });
      return fail(c, 500, "Failed to list servers");
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
mcpServerRoutes.openapi(
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
      if (!workspaceId || !parseEntityId(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const adminUserId = await requireAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (!adminUserId) {
        return fail(c, 403, "Workspace admin role required");
      }

      const parsed = CreateServerSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return fail(c, 400, "Invalid request body");
      }
      const body = parsed.data;
      const preset = getMcpPreset(body.connectorType);
      const url = preset.urlEditable ? body.url : preset.url;
      if (!url) {
        return fail(c, 400, "Server URL is required");
      }
      try {
        await assertSafeMcpUrl(url);
      } catch (error) {
        return fail(
          c,
          400,
          error instanceof Error ? error.message : "URL is not allowed",
        );
      }

      const server = await mcpRepo.createServer({
        workspaceId,
        name: body.name.trim(),
        description: body.description?.trim() ?? null,
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
      if (isDuplicateServerNameError(error)) {
        return fail(c, 409, "A server with this name already exists");
      }
      logger.error("Error creating MCP server", { error });
      return fail(c, 500, "Failed to create server");
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
mcpServerRoutes.openapi(
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
      if (!workspaceId || !parseEntityId(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const adminUserId = await requireAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (!adminUserId) {
        return fail(c, 403, "Workspace admin role required");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }

      const parsed = UpdateServerSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return fail(c, 400, "Invalid request body");
      }
      const body = parsed.data;
      const preset = getMcpPreset(server.connectorType);

      const patch: UpdateMcpServerPatch = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.description !== undefined) {
        patch.description = body.description.trim();
      }
      if (body.url !== undefined && preset.urlEditable) {
        try {
          await assertSafeMcpUrl(body.url);
        } catch (error) {
          return fail(
            c,
            400,
            error instanceof Error ? error.message : "URL is not allowed",
          );
        }
        patch.transport = { type: "http", url: body.url };
      }
      if (body.writeScope !== undefined) patch.writeScope = body.writeScope;
      if (body.isActive !== undefined) patch.isActive = body.isActive;
      if (body.toolPolicy) {
        patch.toolPolicy = {
          ...(body.toolPolicy.defaultRestriction !== undefined
            ? { defaultRestriction: body.toolPolicy.defaultRestriction }
            : {}),
          ...(body.toolPolicy.restrictions !== undefined
            ? { restrictions: body.toolPolicy.restrictions }
            : {}),
        };
      }

      const updated = await mcpRepo.updateServer(workspaceId, server.id, patch);
      if (!updated) {
        return fail(c, 404, "Server not found");
      }
      return c.json({ success: true, server: serializeServer(updated) });
    } catch (error) {
      if (isDuplicateServerNameError(error)) {
        return fail(c, 409, "A server with this name already exists");
      }
      logger.error("Error updating MCP server", { error });
      return fail(c, 500, "Failed to update server");
    }
  },
);

// --- Delete server (admin) ---
mcpServerRoutes.openapi(
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
      if (!workspaceId || !parseEntityId(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const adminUserId = await requireAdmin(
        c as AuthenticatedContext,
        workspaceId,
      );
      if (!adminUserId) {
        return fail(c, 403, "Workspace admin role required");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }
      await mcpRepo.deleteServerCascade(workspaceId, server.id);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error deleting MCP server", { error });
      return fail(c, 500, "Failed to delete server");
    }
  },
);
