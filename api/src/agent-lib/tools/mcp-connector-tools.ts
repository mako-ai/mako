/**
 * MCP connector management tools — lets the agent do what the Settings →
 * MCP Servers "Add MCP server" dialog does: list available presets and
 * configured servers, register a new server, and test/refresh a connection.
 *
 * Mirrors the HTTP routes in `routes/mcp.routes.ts` (same auth model):
 *  - list/test: any workspace member
 *  - add/remove: workspace owner/admin only
 *
 * Credentials are deliberately NOT accepted here: secrets pasted into chat
 * would be persisted in the transcript. The tools return precise next steps
 * (connect via OAuth or save credentials in Settings → MCP Servers) instead.
 */
import { Types } from "mongoose";
import { tool } from "ai";
import { z } from "zod";
import {
  type IMcpServer,
  McpConnectionConfig,
  McpServer,
  McpToolGrant,
} from "../../database/workspace-schema";
import {
  MCP_PRESETS,
  getMcpPreset,
  mcpPresetEnvOAuthClient,
} from "../../mcp/presets";
import {
  assertSafeMcpUrl,
  discoverMcpTools,
} from "../../services/mcp-client.service";
import { mcpOAuthClientSource } from "../../services/mcp-oauth.service";
import { workspaceService } from "../../services/workspace.service";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface McpConnectorToolOptions {
  workspaceId: string;
  userId?: string;
}

const SETTINGS_HINT = "Settings → MCP Servers (/settings/mcp)";

/** Auth-completion guidance for a server, matching what the UI offers. */
function nextStepsFor(server: IMcpServer): string {
  const preset = getMcpPreset(server.connectorType);
  if (server.authType === "none") {
    return "No authentication needed — call test_mcp_connector to discover its tools.";
  }
  if (server.authType === "api_key") {
    return `The user must save their credential headers in ${SETTINGS_HINT} (never paste secrets into this chat), then call test_mcp_connector.`;
  }
  // OAuth
  const needsClient =
    preset.oauth?.clientMode === "manual" &&
    mcpOAuthClientSource(server) === null;
  if (needsClient) {
    return `${preset.label} OAuth needs a pre-registered app: a workspace admin must save its Client ID and Client Secret in ${SETTINGS_HINT} first, then each member clicks "Connect ${preset.label} account" there.`;
  }
  return `The user must click "Connect account" in ${SETTINGS_HINT} to sign in with OAuth (a browser consent flow the agent cannot perform), then call test_mcp_connector.`;
}

export function createMcpConnectorTools(options: McpConnectorToolOptions) {
  const { workspaceId, userId } = options;
  const wsOid = new Types.ObjectId(workspaceId);

  return {
    list_mcp_connectors: tool({
      description:
        "List MCP connector presets available to add (GitHub, Close CRM, Slack, custom) and the MCP servers already configured in this workspace, with connection status and tool counts. Read-only.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const servers = await McpServer.find({ workspaceId: wsOid })
            .sort({ createdAt: 1 })
            .lean<IMcpServer[]>();
          const configs = await McpConnectionConfig.find({
            serverId: { $in: servers.map(s => s._id) },
          })
            .select("serverId userId oauthTokens headers")
            .lean();

          const hasUsableCredential = (
            server: IMcpServer,
            cfg: (typeof configs)[number],
          ): boolean =>
            server.authType === "oauth"
              ? !!cfg.oauthTokens
              : Object.keys(cfg.headers ?? {}).length > 0;

          return {
            success: true,
            presets: Object.values(MCP_PRESETS).map(preset => ({
              type: preset.type,
              label: preset.label,
              description: preset.description,
              url: preset.url || null,
              urlEditable: preset.urlEditable,
              authOptions: preset.authOptions,
              oneClickOAuth:
                preset.authOptions.includes("oauth") &&
                (preset.oauth?.clientMode !== "manual" ||
                  Boolean(mcpPresetEnvOAuthClient(preset))),
            })),
            servers: servers.map(server => ({
              id: server._id.toString(),
              name: server.name,
              connectorType: server.connectorType,
              url: server.transport.url,
              authType: server.authType,
              writeScope: server.writeScope,
              status: server.status,
              lastError: server.lastError ?? null,
              isActive: server.isActive,
              toolCount: server.cachedTools?.length ?? 0,
              userHasCredential: configs.some(
                cfg =>
                  cfg.serverId.toString() === server._id.toString() &&
                  cfg.userId ===
                    (server.authPerformer === "user" ? (userId ?? "") : "") &&
                  hasUsableCredential(server, cfg),
              ),
              nextSteps:
                server.status === "connected" ? null : nextStepsFor(server),
            })),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list MCP connectors",
          };
        }
      },
    }),

    add_mcp_connector: tool({
      description:
        "Register a new MCP server connection for this workspace (workspace admins only), like the Settings → MCP Servers dialog. Use a preset connectorType from list_mcp_connectors (e.g. 'github', 'close', 'slack') or 'custom' with a Streamable-HTTP server URL. Never ask the user for API keys or secrets in chat — the result explains where the user completes authentication. Only call after the user explicitly asks to add the connector.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .describe(
            "Display name; also drives tool prefixes, e.g. 'GitHub' → mcp_github_*.",
          ),
        connectorType: z
          .string()
          .describe(
            "Preset type from list_mcp_connectors, or 'custom' for any other MCP server.",
          ),
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "Streamable-HTTP endpoint. Required for 'custom'; ignored for fixed-URL presets.",
          ),
        authType: z
          .enum(["none", "api_key", "oauth"])
          .optional()
          .describe("Defaults to the preset's recommended auth."),
        writeScope: z
          .enum(["read", "write_safe", "write_destructive"])
          .optional()
          .describe("Defaults to 'read' (least privilege)."),
        description: z.string().max(500).optional(),
      }),
      execute: async input => {
        try {
          if (
            !userId ||
            !(await workspaceService.isAdmin(workspaceId, userId))
          ) {
            return {
              success: false,
              error:
                "Workspace admin role required to add MCP connectors. Ask a workspace owner/admin to add it.",
            };
          }

          const preset = getMcpPreset(input.connectorType);
          const authType = input.authType ?? preset.authType;
          if (!preset.authOptions.includes(authType)) {
            return {
              success: false,
              error: `${preset.label} supports auth: ${preset.authOptions.join(", ")} — not "${authType}".`,
            };
          }
          const url = preset.urlEditable ? input.url : preset.url;
          if (!url) {
            return {
              success: false,
              error: "A server URL is required for custom MCP servers.",
            };
          }
          try {
            await assertSafeMcpUrl(url);
          } catch (error) {
            return {
              success: false,
              error:
                error instanceof Error ? error.message : "URL is not allowed",
            };
          }

          const server = await McpServer.create({
            workspaceId: wsOid,
            name: input.name,
            description: input.description,
            connectorType: preset.type,
            transport: { type: "http", url },
            authType,
            // Every member authenticates individually (Claude-connectors
            // model) — same as servers created through the UI.
            authPerformer: "user",
            writeScope: input.writeScope ?? "read",
            status: "awaiting_auth",
            createdBy: userId,
          });

          logger.info("MCP server created via agent tool", {
            workspaceId,
            userId,
            serverId: server._id.toString(),
            connectorType: preset.type,
          });
          return {
            success: true,
            serverId: server._id.toString(),
            name: server.name,
            connectorType: server.connectorType,
            url,
            authType,
            writeScope: server.writeScope,
            nextSteps: nextStepsFor(server),
          };
        } catch (error) {
          if ((error as { code?: number }).code === 11000) {
            return {
              success: false,
              error: "A server with this name already exists in the workspace.",
            };
          }
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to add MCP connector",
          };
        }
      },
    }),

    test_mcp_connector: tool({
      description:
        "Test an MCP server connection and refresh its cached tool list (discovery). Uses the calling user's credential, so OAuth/API-key servers must be connected in Settings → MCP Servers first. Newly discovered tools become callable from the next turn onward.",
      inputSchema: z.object({
        serverId: z
          .string()
          .describe("The MCP server id, from list_mcp_connectors."),
      }),
      execute: async input => {
        try {
          if (!Types.ObjectId.isValid(input.serverId)) {
            return { success: false, error: "SERVER_NOT_FOUND" };
          }
          const server = await McpServer.findOne({
            _id: new Types.ObjectId(input.serverId),
            workspaceId: wsOid,
          });
          if (!server) {
            return { success: false, error: "SERVER_NOT_FOUND" };
          }

          const configUserId =
            server.authPerformer === "user" ? (userId ?? "") : "";
          const config = await McpConnectionConfig.findOne({
            serverId: server._id,
            userId: configUserId,
          }).lean();
          const missingCredential =
            server.authType === "oauth"
              ? !config?.oauthTokens
              : !config && server.authType !== "none";
          if (missingCredential) {
            return {
              success: false,
              error: `No usable credential for ${server.name}. ${nextStepsFor(server)}`,
            };
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
            logger.info("MCP server connected via agent tool", {
              workspaceId,
              serverId: server._id.toString(),
              toolCount: tools.length,
            });
            return {
              success: true,
              serverId: server._id.toString(),
              status: "connected",
              toolCount: tools.length,
              toolNames: tools.slice(0, 25).map(t => t.name),
              note: "The server's tools are registered from the next turn — use search_tools/load_tools to activate them.",
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Connection failed";
            server.status = "error";
            server.lastError = message.substring(0, 500);
            await server.save();
            return { success: false, error: message };
          }
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to test MCP connector",
          };
        }
      },
    }),

    remove_mcp_connector: tool({
      description:
        "Remove an MCP server connection from this workspace (workspace admins only). Deletes its stored credentials and per-user tool grants. Destructive — only call after the user explicitly confirms which server to remove.",
      inputSchema: z.object({
        serverId: z
          .string()
          .describe("The MCP server id, from list_mcp_connectors."),
      }),
      execute: async input => {
        try {
          if (
            !userId ||
            !(await workspaceService.isAdmin(workspaceId, userId))
          ) {
            return {
              success: false,
              error: "Workspace admin role required to remove MCP connectors.",
            };
          }
          if (!Types.ObjectId.isValid(input.serverId)) {
            return { success: false, error: "SERVER_NOT_FOUND" };
          }
          const server = await McpServer.findOne({
            _id: new Types.ObjectId(input.serverId),
            workspaceId: wsOid,
          });
          if (!server) {
            return { success: false, error: "SERVER_NOT_FOUND" };
          }
          await Promise.all([
            McpConnectionConfig.deleteMany({ serverId: server._id }),
            McpToolGrant.deleteMany({ serverId: server._id }),
            server.deleteOne(),
          ]);
          logger.info("MCP server removed via agent tool", {
            workspaceId,
            userId,
            serverId: input.serverId,
          });
          return { success: true, removed: server.name };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to remove MCP connector",
          };
        }
      },
    }),
  };
}
