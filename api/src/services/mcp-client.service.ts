/**
 * MCP (Model Context Protocol) client service.
 *
 * Mako acts as an MCP *client*: workspace admins register remote MCP servers
 * (Close CRM, or any Streamable-HTTP server), and the agent gets their tools.
 *
 * Design notes:
 *  - Tool *definitions* come from the DB (`cachedTools`, persisted on
 *    connect/test/refresh), so starting a chat never blocks on MCP servers.
 *  - Tool *executions* open a short-lived client per call (connect -> call ->
 *    close). No pooling — every call is bound to exactly one workspace/user
 *    credential, so credentials can never bleed across tenants.
 *  - Risk tiers + per-user grants (per-tool or server-wide `*`) drive the
 *    AI SDK's native `needsApproval` flow (allow once / always allow).
 *    Read-tier tools with an open admin ceiling auto-run; writes prompt
 *    until granted.
 */

import { createMCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Types } from "mongoose";
import type { IMcpServer } from "../database/workspace-schema";
import {
  MCP_SERVER_WIDE_GRANT_TOOL,
  mcpRepo,
  type IMcpCachedTool,
  type McpGrantDecision,
  type McpServerRecord,
  type McpToolRestriction,
} from "../repositories/mcp";
import { getMcpPreset } from "../mcp/presets";
import { decryptRecord } from "./crypto.service";
import { assertPublicIp, SafeFetchError } from "./safe-fetch.service";
import { loggers } from "../logging";

const logger = loggers.agent();

export type McpRiskTier = "read" | "write" | "destructive";

/** How a tool execution was authorized (for audit logs + UI). */
export type McpApprovalSource = "grant" | "manual" | "denied-by-grant";

/** Accepts either canonical `McpServerRecord` or legacy Mongoose `IMcpServer` (tests). */
export type McpServerLike = McpServerRecord | IMcpServer;

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

/** Deterministic tool-name prefix for a server (e.g. "Close CRM" -> close_crm). */
export function mcpServerSlug(serverName: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return slug || "server";
}

/**
 * Providers enforce `^[a-zA-Z0-9_-]{1,64}$` for tool names (Anthropic and
 * OpenAI both cap at 64). MCP tool names are freeform, so the prefixed name
 * is sanitized and, when it must be truncated, disambiguated with a short
 * deterministic hash so two long names can't silently collide.
 */
const PROVIDER_TOOL_NAME_MAX = 64;

export function mcpPrefixedToolName(
  serverName: string,
  toolName: string,
): string {
  const sanitizedTool = toolName
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const full = `${MCP_TOOL_PREFIX}_${mcpServerSlug(serverName)}_${sanitizedTool}`;
  if (full.length <= PROVIDER_TOOL_NAME_MAX) return full;
  const hash = crypto
    .createHash("sha256")
    .update(`${serverName}:${toolName}`)
    .digest("hex")
    .slice(0, 6);
  return `${full.slice(0, PROVIDER_TOOL_NAME_MAX - 7)}_${hash}`;
}

/**
 * Risk tier for a discovered tool.
 */
export function mcpToolRiskTier(
  server: Pick<McpServerRecord, "writeScope">,
  tool: Pick<IMcpCachedTool, "annotations">,
): McpRiskTier {
  if (server.writeScope === "read") return "read";
  if (tool.annotations?.readOnlyHint === true) return "read";
  if (tool.annotations?.destructiveHint === true) return "destructive";
  return "write";
}

/**
 * Admin-set permission ceiling for a tool (Claude-connectors model):
 * explicit per-tool restriction, else a risk-aware default.
 */
export function mcpToolRestriction(
  server: Pick<McpServerRecord, "toolPolicy" | "writeScope">,
  tool: Pick<IMcpCachedTool, "name" | "annotations">,
): McpToolRestriction {
  const explicit = server.toolPolicy?.restrictions?.[tool.name];
  if (explicit) return explicit;
  if (mcpToolRiskTier(server, tool) === "destructive") return "ask";
  return server.toolPolicy?.defaultRestriction ?? "always";
}

/** Tools the server's restrictions expose to the agent (non-blocked). */
export function mcpAllowedCachedTools(
  server: Pick<McpServerRecord, "cachedTools" | "toolPolicy" | "writeScope">,
): IMcpCachedTool[] {
  return server.cachedTools.filter(
    t => mcpToolRestriction(server, t) !== "block",
  );
}

/**
 * Resolve the HTTP headers for one connection: decrypted credential headers
 * plus the preset scope header, and — for OAuth servers — a fresh Bearer
 * token from the connection's stored (auto-refreshed) tokens.
 */
async function buildConnectionHeaders(
  server: McpServerLike,
  encryptedHeaders: Record<string, string>,
  configUserId: string,
): Promise<Record<string, string>> {
  const headers = decryptRecord(encryptedHeaders ?? {});
  const preset = getMcpPreset(server.connectorType);
  for (const field of preset.headerFields) {
    const value = headers[field.name];
    if (field.valuePrefix && value && !value.startsWith(field.valuePrefix)) {
      headers[field.name] = `${field.valuePrefix}${value}`;
    }
  }
  if (preset.scopeHeader) {
    const scopeValue = preset.scopeHeader.scopeValues[server.writeScope];
    if (scopeValue) headers[preset.scopeHeader.name] = scopeValue;
  }
  if (server.authType === "oauth") {
    const { getMcpOAuthAuthorization } = await import("./mcp-oauth.service");
    const oauthHeader = await getMcpOAuthAuthorization(server, configUserId);
    Object.assign(headers, oauthHeader);
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
  server: McpServerLike,
  encryptedHeaders: Record<string, string>,
  configUserId = "",
): Promise<McpDiscoveredTool[]> {
  await assertSafeMcpUrl(server.transport.url);
  const headers = await buildConnectionHeaders(
    server,
    encryptedHeaders,
    configUserId,
  );

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
 * credential. Connect -> call -> close; nothing is shared across calls.
 */
async function executeMcpToolCall(params: {
  server: McpServerRecord;
  encryptedHeaders: Record<string, string>;
  configUserId: string;
  toolName: string;
  input: unknown;
}): Promise<unknown> {
  const { server, encryptedHeaders, configUserId, toolName, input } = params;
  await assertSafeMcpUrl(server.transport.url);
  const headers = await buildConnectionHeaders(
    server,
    encryptedHeaders,
    configUserId,
  );

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

const MCP_OUTPUT_MAX_CHARS = 16_000;

export function normalizeMcpToolOutput(raw: unknown): unknown {
  let output: unknown = raw;
  const asRecord = raw as
    | { content?: Array<Record<string, unknown>>; isError?: boolean }
    | null
    | undefined;

  if (asRecord && Array.isArray(asRecord.content)) {
    const rendered = asRecord.content
      .map(block => {
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        if (block.type === "image") {
          return `[image content (${(block.mimeType as string) ?? "unknown type"}) omitted]`;
        }
        if (block.type === "resource" || block.type === "resource_link") {
          return `[resource: ${JSON.stringify(block.resource ?? block.uri ?? "")}]`;
        }
        return JSON.stringify(block);
      })
      .join("\n");
    output = asRecord.isError ? { success: false, error: rendered } : rendered;
  }

  const serialized =
    typeof output === "string" ? output : JSON.stringify(output);
  if (serialized.length > MCP_OUTPUT_MAX_CHARS) {
    return (
      serialized.slice(0, MCP_OUTPUT_MAX_CHARS) +
      `\n… [truncated ${serialized.length - MCP_OUTPUT_MAX_CHARS} characters — ask for a narrower query if you need the rest]`
    );
  }
  return output;
}

export interface McpChatTools {
  tools: ToolSet;
  /** Prefixed names of read-tier tools (usable under the plan gate). */
  readOnlyToolNames: string[];
  /** All prefixed MCP tool names (for the mode-runtime allowlist). */
  allToolNames: string[];
  /**
   * Catalog entries for the deferred-tool working set: full (undieted)
   * descriptions for `search_tools` ranking, grouped by server for the
   * system-prompt inventory. Order matches `allToolNames`.
   */
  catalog: McpToolCatalogInfo[];
}

export interface McpToolCatalogInfo {
  name: string;
  serverId: string;
  serverName: string;
  description: string;
  readOnly: boolean;
}

const MCP_TOOL_DESCRIPTION_MAX_CHARS = 200;
const MCP_SCHEMA_DESCRIPTION_MAX_CHARS = 160;

export function dietMcpDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= MCP_TOOL_DESCRIPTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS - 1)}…`;
}

export function dietMcpInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const dietValue = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map(item => dietValue(item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "examples" || k === "$comment") continue;
        out[k] = dietValue(v, k);
      }
      return out;
    }
    if (
      key === "description" &&
      typeof value === "string" &&
      value.length > MCP_SCHEMA_DESCRIPTION_MAX_CHARS
    ) {
      return `${value.slice(0, MCP_SCHEMA_DESCRIPTION_MAX_CHARS - 1)}…`;
    }
    return value;
  };
  return dietValue(schema) as Record<string, unknown>;
}

interface ResolvedMcpServer {
  server: McpServerRecord;
  encryptedHeaders: Record<string, string>;
  /** Which connection config the credential belongs to ("" = workspace). */
  configUserId: string;
}

async function resolveActiveServers(
  workspaceId: string,
  userId: string | undefined,
): Promise<ResolvedMcpServer[]> {
  const servers = await mcpRepo.listActiveConnectedServers(workspaceId);
  if (servers.length === 0) return [];

  const configs = await mcpRepo.listConnectionConfigsByServerIds(
    workspaceId,
    servers.map(s => s.id),
  );

  const resolved: ResolvedMcpServer[] = [];
  for (const server of servers) {
    const wantUserId =
      server.authPerformer === "user" ? (userId ?? null) : null;
    if (server.authPerformer === "user" && !userId) continue;
    const config = configs.find(
      c => c.serverId === server.id && c.userId === wantUserId,
    );
    if (!config && server.authType !== "none") continue;
    // OAuth connections are only usable once tokens exist.
    if (server.authType === "oauth" && !config?.oauthTokensEncrypted) continue;
    resolved.push({
      server,
      encryptedHeaders: config?.headersEncrypted ?? {},
      configUserId: wantUserId ?? "",
    });
  }
  return resolved;
}

/**
 * Resolve the effective per-user grant for a tool.
 *
 * Precedence: tool-specific grant > server-wide (`*`) grant > none.
 * A tool-level Block always wins over a server-wide Always allow.
 */
export async function resolveMcpToolGrant(params: {
  serverId: Types.ObjectId | string;
  userId: string | undefined;
  toolName: string;
  workspaceId?: string;
}): Promise<{ decision: McpGrantDecision; toolName: string } | null> {
  const { serverId, userId, toolName, workspaceId } = params;
  if (!userId) return null;

  const grants = await mcpRepo.findToolGrantsForResolution({
    serverId: typeof serverId === "string" ? serverId : serverId.toString(),
    userId,
    toolName,
    workspaceId,
  });

  const toolGrant = grants.find(g => g.toolName === toolName);
  if (toolGrant) {
    return { decision: toolGrant.decision, toolName: toolGrant.toolName };
  }
  const serverGrant = grants.find(
    g => g.toolName === MCP_SERVER_WIDE_GRANT_TOOL,
  );
  if (serverGrant) {
    return {
      decision: serverGrant.decision,
      toolName: serverGrant.toolName,
    };
  }
  return null;
}

export function mcpReadTierIsEnforced(
  server: Pick<McpServerRecord, "writeScope" | "connectorType">,
  tool: Pick<IMcpCachedTool, "annotations">,
): boolean {
  if (tool.annotations?.readOnlyHint === true) return true;
  return Boolean(getMcpPreset(server.connectorType).scopeHeader);
}

async function mcpNeedsApproval(params: {
  server: McpServerRecord;
  tool: IMcpCachedTool;
  userId: string | undefined;
}): Promise<boolean> {
  const { server, tool, userId } = params;
  const ceiling = mcpToolRestriction(server, tool);
  const grant = await resolveMcpToolGrant({
    serverId: server.id,
    workspaceId: server.workspaceId,
    userId,
    toolName: tool.name,
  });

  if (grant?.decision === "always_deny") {
    return false;
  }
  if (ceiling === "ask") return true;
  if (
    mcpToolRiskTier(server, tool) === "read" &&
    mcpReadTierIsEnforced(server, tool)
  ) {
    return false;
  }
  return grant?.decision !== "always_allow";
}

export async function buildMcpToolsForChat(params: {
  workspaceId: string;
  userId?: string;
}): Promise<McpChatTools> {
  const { workspaceId, userId } = params;
  const empty: McpChatTools = {
    tools: {},
    readOnlyToolNames: [],
    allToolNames: [],
    catalog: [],
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
  const catalog: McpToolCatalogInfo[] = [];

  for (const { server, encryptedHeaders, configUserId } of resolved) {
    for (const cachedTool of mcpAllowedCachedTools(server)) {
      const prefixedName = mcpPrefixedToolName(server.name, cachedTool.name);
      if (tools[prefixedName]) continue;
      const riskTier = mcpToolRiskTier(server, cachedTool);
      const fullDescription = cachedTool.description ?? cachedTool.name;

      tools[prefixedName] = dynamicTool({
        description: `[${server.name} via MCP] ${dietMcpDescription(fullDescription)}`,
        inputSchema: jsonSchema(
          dietMcpInputSchema(
            cachedTool.inputSchema ?? {
              type: "object",
              properties: {},
            },
          ) as Parameters<typeof jsonSchema>[0],
        ),
        needsApproval: async () =>
          mcpNeedsApproval({
            server,
            tool: cachedTool,
            userId,
          }),
        execute: async input => {
          const freshServer = await mcpRepo.findServerById(
            server.id,
            workspaceId,
          );
          if (
            !freshServer ||
            !freshServer.isActive ||
            freshServer.status !== "connected"
          ) {
            return {
              success: false,
              error: `${server.name} is no longer connected. Reconnect it in Settings → MCP Servers before trying again.`,
            };
          }
          if (mcpToolRestriction(freshServer, cachedTool) === "block") {
            return {
              success: false,
              denied: true,
              error: `"${cachedTool.name}" on ${server.name} has been blocked by a workspace admin.`,
            };
          }

          const grant = await resolveMcpToolGrant({
            serverId: server.id,
            workspaceId,
            userId,
            toolName: cachedTool.name,
          });

          if (grant?.decision === "always_deny") {
            logger.info("MCP tool call denied by user grant", {
              workspaceId,
              userId,
              serverId: server.id,
              toolName: cachedTool.name,
              grantToolName: grant.toolName,
            });
            return {
              success: false,
              denied: true,
              error: `The user has permanently denied "${cachedTool.name}" on ${server.name}. Do not retry; ask the user to change this in Settings → MCP Servers if needed.`,
            };
          }

          const approvalSource: McpApprovalSource =
            grant?.decision === "always_allow" ? "grant" : "manual";

          const startedAt = Date.now();
          try {
            const output = await executeMcpToolCall({
              server,
              encryptedHeaders,
              configUserId,
              toolName: cachedTool.name,
              input,
            });
            logger.info("MCP tool call executed", {
              workspaceId,
              userId,
              serverId: server.id,
              serverName: server.name,
              toolName: cachedTool.name,
              riskTier,
              approvalSource,
              durationMs: Date.now() - startedAt,
            });
            if (grant && userId) {
              void mcpRepo
                .touchToolGrantLastUsed({
                  workspaceId,
                  serverId: server.id,
                  userId,
                  toolName: grant.toolName,
                })
                .catch(() => undefined);
            }
            return normalizeMcpToolOutput(output);
          } catch (error) {
            logger.warn("MCP tool call failed", {
              error,
              workspaceId,
              serverId: server.id,
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
      catalog.push({
        name: prefixedName,
        serverId: server.id,
        serverName: server.name,
        description: fullDescription,
        readOnly: riskTier === "read",
      });
    }
  }

  return { tools, readOnlyToolNames, allToolNames, catalog };
}

export interface McpToolUiInfo {
  prefixedName: string;
  serverId: string;
  serverName: string;
  serverIcon: string | null;
  toolName: string;
  riskTier: McpRiskTier;
  canAlwaysAllow: boolean;
}

function mcpServerIconUrl(server: McpServerRecord): string | null {
  const preset = getMcpPreset(server.connectorType);
  if (preset.icon) return preset.icon;
  try {
    const host = new URL(server.transport.url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return null;
  }
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
        serverId: server.id,
        serverName: server.name,
        serverIcon: mcpServerIconUrl(server),
        toolName: cachedTool.name,
        riskTier,
        canAlwaysAllow: mcpToolRestriction(server, cachedTool) === "always",
      });
    }
  }
  return infos;
}
