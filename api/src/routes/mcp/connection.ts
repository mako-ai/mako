/** Connecting an MCP server: credentials, OAuth client and flow, test + tool refresh. */
import { createRoute, z } from "@hono/zod-openapi";
import { loggers } from "../../logging";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { parseEntityId } from "../../database/pg/id-codec";
import { mcpRepo } from "../../repositories/mcp";
import { getMcpPreset } from "../../mcp/presets";
import { encryptRecord } from "../../services/crypto.service";
import { discoverMcpTools } from "../../services/mcp-client.service";
import {
  saveMcpOAuthClient,
  startMcpOAuthFlow,
} from "../../services/mcp-oauth.service";
import { fail, failFromThrown } from "../lib/respond";
import {
  ServerIdParam,
  requireAdmin,
  serializeServer,
  loadServer,
} from "./shared";

const logger = loggers.api("mcp");

export const mcpServerConnectionRoutes = createRouter();

const CredentialsSchema = z.object({
  headers: z.record(z.string(), z.string()),
});

// --- Save credentials (admin for workspace-performer, self for user-performer) ---
mcpServerConnectionRoutes.openapi(
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
      if (!workspaceId || !parseEntityId(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }

      let configUserId: string | null;
      if (server.authPerformer === "workspace") {
        const adminUserId = await requireAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (!adminUserId) {
          return fail(c, 403, "Workspace admin role required");
        }
        configUserId = null;
      } else {
        configUserId = user.id;
      }

      const parsed = CredentialsSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return fail(c, 400, "Invalid request body");
      }

      await mcpRepo.upsertConnectionCredentials({
        workspaceId: server.workspaceId,
        serverId: server.id,
        userId: configUserId,
        headersEncrypted: encryptRecord(parsed.data.headers),
      });

      if (server.status === "created") {
        await mcpRepo.updateServer(server.workspaceId, server.id, {
          status: "awaiting_auth",
        });
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error saving MCP credentials", { error });
      return fail(c, 500, "Failed to save credentials");
    }
  },
);

const OAuthClientSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().max(500).optional(),
});

// --- Save a pre-registered OAuth client (admin; manual-client presets) ---
mcpServerConnectionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/oauth/client",
    tags: ["MCP"],
    summary:
      "Save a pre-registered OAuth app (client ID + secret) for an MCP server",
    security: AUTH_SECURITY,
    request: {
      params: ServerIdParam,
      body: {
        required: true,
        content: { "application/json": { schema: OAuthClientSchema } },
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
      // The app credential is shared by every connecting member — admin only.
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
      if (server.authType !== "oauth") {
        return fail(c, 400, "This server does not use OAuth");
      }
      const preset = getMcpPreset(server.connectorType);
      if (preset.oauth?.clientMode !== "manual") {
        return fail(
          c,
          400,
          "This connector registers its OAuth client automatically — manual client ID/secret is not supported",
        );
      }
      const parsed = OAuthClientSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return fail(c, 400, "Invalid request body");
      }
      await saveMcpOAuthClient({
        server,
        clientId: parsed.data.clientId.trim(),
        clientSecret: parsed.data.clientSecret?.trim() || undefined,
      });
      const updated = await loadServer(workspaceId, id);
      return c.json({
        success: true,
        server: serializeServer(updated ?? server),
      });
    } catch (error) {
      logger.error("Error saving MCP OAuth client", { error });
      return fail(c, 500, "Failed to save OAuth client");
    }
  },
);

// --- Start an OAuth connection (returns the authorization URL) ---
mcpServerConnectionRoutes.openapi(
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
      if (server.authType !== "oauth") {
        return fail(c, 400, "This server does not use OAuth");
      }

      let configUserId: string;
      if (server.authPerformer === "workspace") {
        const adminUserId = await requireAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (!adminUserId) {
          return fail(c, 403, "Workspace admin role required");
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
      return failFromThrown(c, error, "Failed to start OAuth flow");
    }
  },
);

// --- Test connection + refresh tools ---
mcpServerConnectionRoutes.openapi(
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
      if (!workspaceId || !parseEntityId(workspaceId)) {
        return fail(c, 400, "Valid workspace ID is required");
      }
      const user = (c as AuthenticatedContext).get("user");
      if (!user) {
        return fail(c, 401, "Unauthorized");
      }
      const server = await loadServer(workspaceId, id);
      if (!server) {
        return fail(c, 404, "Server not found");
      }

      // Test with the credential this request's user would use at chat time.
      const configUserId = server.authPerformer === "user" ? user.id : null;
      const config = await mcpRepo.findConnectionConfig(
        server.workspaceId,
        server.id,
        configUserId,
      );
      const missingCredential =
        server.authType === "oauth"
          ? !config?.oauthTokensEncrypted
          : !config && server.authType !== "none";
      if (missingCredential) {
        return fail(
          c,
          400,
          server.authType === "oauth"
            ? server.authPerformer === "user"
              ? "Connect your account first"
              : "Connect the workspace account first"
            : server.authPerformer === "user"
              ? "Connect your credentials first"
              : "Save workspace credentials first",
        );
      }

      try {
        const tools = await discoverMcpTools(
          server,
          config?.headersEncrypted ?? {},
          configUserId ?? "",
        );
        const updated =
          (await mcpRepo.updateServer(server.workspaceId, server.id, {
            cachedTools: tools,
            status: "connected",
            lastError: null,
            lastConnectedAt: new Date(),
          })) ?? server;
        logger.info("MCP server connected", {
          workspaceId,
          serverId: server.id,
          toolCount: tools.length,
        });
        return c.json({ success: true, server: serializeServer(updated) });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Connection failed";
        const errored =
          (await mcpRepo.updateServer(server.workspaceId, server.id, {
            status: "error",
            lastError: message.substring(0, 500),
          })) ?? server;
        return fail(c, 502, message, { server: serializeServer(errored) });
      }
    } catch (error) {
      logger.error("Error testing MCP server", { error });
      return fail(c, 500, "Failed to test server");
    }
  },
);
