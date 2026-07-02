/**
 * MCP (Model Context Protocol) client service.
 *
 * Mako acts as an MCP *client*: workspace admins register remote MCP servers
 * (Close CRM, or any Streamable-HTTP server), and the agent gets their tools.
 *
 * Design notes:
 *  - Tool *definitions* come from the DB (`cachedTools`, persisted on
 *    connect/test/refresh), so starting a chat never blocks on MCP servers.
 *  - Tool *executions* open a short-lived client per call (connect → call →
 *    close). No pooling — every call is bound to exactly one workspace/user
 *    credential, so credentials can never bleed across tenants.
 *  - Write-risk tiers + per-user grants drive the AI SDK's native
 *    `needsApproval` human-in-the-loop flow (allow once / always allow).
 */

import { createMCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { lookup as dnsLookup } from "node:dns/promises";
import { Types } from "mongoose";
import {
  type IMcpCachedTool,
  type IMcpServer,
  McpConnectionConfig,
  McpServer,
  McpToolGrant,
} from "../database/workspace-schema";
import { getMcpPreset } from "../mcp/presets";
import { decryptRecord } from "./crypto.service";
import { assertPublicIp, SafeFetchError } from "./safe-fetch.service";
import { loggers } from "../logging";

const logger = loggers.agent();

export type McpRiskTier = "read" | "write" | "destructive";

/** How a tool execution was authorized (for audit logs + UI). */
export type McpApprovalSource =
  | "auto-read"
  | "grant"
  | "manual"
  | "denied-by-grant";

const MCP_TOOL_PREFIX = "mcp";

/**
 * Validate an MCP server URL against SSRF (private ranges, metadata IPs).
 * `MCP_ALLOW_PRIVATE_URLS=true` bypasses the check for local development
 * against MCP servers on localhost.
 */
export async function assertSafeMcpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError(`Invalid MCP server URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`Blocked URL scheme: ${url.protocol}`);
  }
  if (process.env.MCP_ALLOW_PRIVATE_URLS === "true") return;

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new SafeFetchError(`Blocked hostname: ${url.hostname}`);
  }
  const { address } = await dnsLookup(host);
  assertPublicIp(address);
}

/** Deterministic tool-name prefix for a server (e.g. "Close CRM" → close_crm). */
export function mcpServerSlug(serverName: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return slug || "server";
}

export function mcpPrefixedToolName(
  serverName: string,
  toolName: string,
): string {
  return `${MCP_TOOL_PREFIX}_${mcpServerSlug(serverName)}_${toolName}`;
}

/**
 * Risk tier for a discovered tool.
 *
 * - The whole connection is read-tier when the server's writeScope is "read"
 *   (providers with scope headers, e.g. Close, also enforce this server-side).
 * - `readOnlyHint: true` marks a tool read-tier.
 * - `destructiveHint: true` marks it destructive-tier. Absent hints fall back
 *   to plain "write" so unannotated custom servers stay usable (their calls
 *   still require approval; the provider-side scope caps real capability).
 */
export function mcpToolRiskTier(
  server: Pick<IMcpServer, "writeScope">,
  tool: Pick<IMcpCachedTool, "annotations">,
): McpRiskTier {
  if (server.writeScope === "read") return "read";
  if (tool.annotations?.readOnlyHint === true) return "read";
  if (tool.annotations?.destructiveHint === true) return "destructive";
  return "write";
}

/** Tools the given server's policy exposes to the agent. */
export function mcpAllowedCachedTools(server: IMcpServer): IMcpCachedTool[] {
  if (server.toolPolicy.mode === "allowlist") {
    const allowed = new Set(server.toolPolicy.allowedTools);
    return server.cachedTools.filter(t => allowed.has(t.name));
  }
  return server.cachedTools;
}

function buildConnectionHeaders(
  server: IMcpServer,
  encryptedHeaders: Record<string, string>,
): Record<string, string> {
  const headers = decryptRecord(encryptedHeaders ?? {});
  const preset = getMcpPreset(server.connectorType);
  if (preset.scopeHeader) {
    headers[preset.scopeHeader.name] =
      preset.scopeHeader.scopeValues[server.writeScope];
  }
  return headers;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: IMcpCachedTool["annotations"];
}

/**
 * Connect to an MCP server and list its tools (raw, with annotations and
 * input schemas). Used by the test-connection / refresh-tools endpoints.
 */
export async function discoverMcpTools(
  server: IMcpServer,
  encryptedHeaders: Record<string, string>,
): Promise<McpDiscoveredTool[]> {
  await assertSafeMcpUrl(server.transport.url);
  const headers = buildConnectionHeaders(server, encryptedHeaders);

  const client = await createMCPClient({
    transport: { type: "http", url: server.transport.url, headers },
  });
  try {
    const result = await client.listTools();
    return result.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      annotations: t.annotations as IMcpCachedTool["annotations"],
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Execute one MCP tool call with a short-lived client bound to the resolved
 * credential. Connect → call → close; nothing is shared across calls.
 */
async function executeMcpToolCall(params: {
  server: IMcpServer;
  encryptedHeaders: Record<string, string>;
  toolName: string;
  input: unknown;
}): Promise<unknown> {
  const { server, encryptedHeaders, toolName, input } = params;
  await assertSafeMcpUrl(server.transport.url);
  const headers = buildConnectionHeaders(server, encryptedHeaders);

  const client = await createMCPClient({
    transport: { type: "http", url: server.transport.url, headers },
  });
  try {
    const tools = await client.tools();
    const tool = tools[toolName];
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(
        `Tool "${toolName}" is no longer available on MCP server "${server.name}" — refresh its tools in Settings → MCP Servers`,
      );
    }
    return await tool.execute(input, {
      toolCallId: `mcp-${Date.now()}`,
      messages: [],
      context: undefined,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export interface McpChatTools {
  tools: ToolSet;
  /** Prefixed names of read-tier tools (usable under the plan gate). */
  readOnlyToolNames: string[];
  /** All prefixed MCP tool names (for the mode-runtime allowlist). */
  allToolNames: string[];
}

interface ResolvedMcpServer {
  server: IMcpServer;
  encryptedHeaders: Record<string, string>;
}

/**
 * Resolve the active MCP servers usable by this user in this workspace:
 * workspace-credential servers with a shared config, plus user-credential
 * servers where this user has connected. Servers without a usable credential
 * are skipped (their tools never reach the model).
 */
async function resolveActiveServers(
  workspaceId: string,
  userId: string | undefined,
): Promise<ResolvedMcpServer[]> {
  const servers = await McpServer.find({
    workspaceId: new Types.ObjectId(workspaceId),
    isActive: true,
    status: "connected",
  }).lean<IMcpServer[]>();
  if (servers.length === 0) return [];

  const configs = await McpConnectionConfig.find({
    serverId: { $in: servers.map(s => s._id) },
  }).lean();

  const resolved: ResolvedMcpServer[] = [];
  for (const server of servers) {
    const wantUserId = server.authPerformer === "user" ? (userId ?? "") : "";
    if (server.authPerformer === "user" && !userId) continue;
    const config = configs.find(
      c =>
        c.serverId.toString() === server._id.toString() &&
        c.userId === wantUserId,
    );
    if (!config && server.authType !== "none") continue;
    resolved.push({
      server: server as IMcpServer,
      encryptedHeaders: (config?.headers ?? {}) as Record<string, string>,
    });
  }
  return resolved;
}

/**
 * Approval decision for one tool call, implementing the resolution order:
 * excluded tools never get here (filtered at build time); then
 * always_deny → no prompt (execute refuses); read-tier → auto-run;
 * destructive without admin unlock → always prompt; always_allow → auto-run;
 * otherwise prompt.
 */
async function mcpNeedsApproval(params: {
  server: IMcpServer;
  riskTier: McpRiskTier;
  toolName: string;
  userId: string | undefined;
}): Promise<boolean> {
  const { server, riskTier, toolName, userId } = params;
  if (riskTier === "read") return false;

  const grant = userId
    ? await McpToolGrant.findOne({
        serverId: server._id,
        userId,
        toolName,
      }).lean()
    : null;

  if (grant?.decision === "always_deny") {
    // No approval prompt: execute() returns the denial to the model.
    return false;
  }
  if (riskTier === "destructive" && !server.toolPolicy.allowDestructiveGrants) {
    return true;
  }
  return grant?.decision !== "always_allow";
}

/**
 * Build the MCP portion of the agent toolset for one chat request, from
 * cached tool definitions (no MCP round-trips here).
 */
export async function buildMcpToolsForChat(params: {
  workspaceId: string;
  userId?: string;
}): Promise<McpChatTools> {
  const { workspaceId, userId } = params;
  const empty: McpChatTools = {
    tools: {},
    readOnlyToolNames: [],
    allToolNames: [],
  };

  let resolved: ResolvedMcpServer[];
  try {
    resolved = await resolveActiveServers(workspaceId, userId);
  } catch (error) {
    logger.warn("Failed to resolve MCP servers for chat", {
      error,
      workspaceId,
    });
    return empty;
  }
  if (resolved.length === 0) return empty;

  const tools: ToolSet = {};
  const readOnlyToolNames: string[] = [];
  const allToolNames: string[] = [];

  for (const { server, encryptedHeaders } of resolved) {
    for (const cachedTool of mcpAllowedCachedTools(server)) {
      const prefixedName = mcpPrefixedToolName(server.name, cachedTool.name);
      if (tools[prefixedName]) continue; // name collision: first wins
      const riskTier = mcpToolRiskTier(server, cachedTool);

      tools[prefixedName] = dynamicTool({
        description: `[${server.name} via MCP] ${cachedTool.description ?? cachedTool.name}`,
        inputSchema: jsonSchema(
          (cachedTool.inputSchema ?? {
            type: "object",
            properties: {},
          }) as Parameters<typeof jsonSchema>[0],
        ),
        needsApproval: async () =>
          mcpNeedsApproval({
            server,
            riskTier,
            toolName: cachedTool.name,
            userId,
          }),
        execute: async input => {
          const grant = userId
            ? await McpToolGrant.findOne({
                serverId: server._id,
                userId,
                toolName: cachedTool.name,
              }).lean()
            : null;

          if (grant?.decision === "always_deny") {
            logger.info("MCP tool call denied by user grant", {
              workspaceId,
              userId,
              serverId: server._id.toString(),
              toolName: cachedTool.name,
            });
            return {
              success: false,
              denied: true,
              error: `The user has permanently denied "${cachedTool.name}" on ${server.name}. Do not retry; ask the user to change this in Settings → MCP Servers if needed.`,
            };
          }

          const approvalSource: McpApprovalSource =
            riskTier === "read"
              ? "auto-read"
              : grant?.decision === "always_allow"
                ? "grant"
                : "manual";

          const startedAt = Date.now();
          try {
            const output = await executeMcpToolCall({
              server,
              encryptedHeaders,
              toolName: cachedTool.name,
              input,
            });
            logger.info("MCP tool call executed", {
              workspaceId,
              userId,
              serverId: server._id.toString(),
              serverName: server.name,
              toolName: cachedTool.name,
              riskTier,
              approvalSource,
              durationMs: Date.now() - startedAt,
            });
            if (grant) {
              void McpToolGrant.updateOne(
                { _id: grant._id },
                { $set: { lastUsedAt: new Date() } },
              ).catch(() => undefined);
            }
            return output;
          } catch (error) {
            logger.warn("MCP tool call failed", {
              error,
              workspaceId,
              serverId: server._id.toString(),
              toolName: cachedTool.name,
            });
            return {
              success: false,
              error:
                error instanceof Error ? error.message : "MCP tool call failed",
            };
          }
        },
      });

      allToolNames.push(prefixedName);
      if (riskTier === "read") readOnlyToolNames.push(prefixedName);
    }
  }

  return { tools, readOnlyToolNames, allToolNames };
}

/**
 * Metadata the chat UI needs to render approval cards and grant buttons for
 * every exposed MCP tool, keyed by prefixed tool name.
 */
export interface McpToolUiInfo {
  prefixedName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  riskTier: McpRiskTier;
  /** False when destructive-tier and the admin has not unlocked grants. */
  canAlwaysAllow: boolean;
}

export async function listMcpToolUiInfo(
  workspaceId: string,
  userId: string | undefined,
): Promise<McpToolUiInfo[]> {
  const resolved = await resolveActiveServers(workspaceId, userId);
  const infos: McpToolUiInfo[] = [];
  for (const { server } of resolved) {
    for (const cachedTool of mcpAllowedCachedTools(server)) {
      const riskTier = mcpToolRiskTier(server, cachedTool);
      infos.push({
        prefixedName: mcpPrefixedToolName(server.name, cachedTool.name),
        serverId: server._id.toString(),
        serverName: server.name,
        toolName: cachedTool.name,
        riskTier,
        canAlwaysAllow:
          riskTier === "write" ||
          (riskTier === "destructive" &&
            server.toolPolicy.allowDestructiveGrants),
      });
    }
  }
  return infos;
}
