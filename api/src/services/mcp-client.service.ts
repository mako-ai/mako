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
import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { Types } from "mongoose";
import {
  type IMcpCachedTool,
  type IMcpServer,
  type McpToolRestriction,
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
export type McpApprovalSource = "grant" | "manual" | "denied-by-grant";

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

/**
 * Admin-set permission ceiling for a tool (Claude-connectors model):
 * explicit per-tool restriction, else a risk-aware default. Restrictions cap
 * what users can choose — a user can always pick something stricter.
 *
 * Destructive-tier tools default to "ask" (never always-allowable) unless an
 * admin explicitly relaxes that tool to "always" on this server.
 */
export function mcpToolRestriction(
  server: Pick<IMcpServer, "toolPolicy" | "writeScope">,
  tool: Pick<IMcpCachedTool, "name" | "annotations">,
): McpToolRestriction {
  const explicit = server.toolPolicy?.restrictions?.[tool.name];
  if (explicit) return explicit;
  if (mcpToolRiskTier(server, tool) === "destructive") return "ask";
  return server.toolPolicy?.defaultRestriction ?? "always";
}

/** Tools the server's restrictions expose to the agent (non-blocked). */
export function mcpAllowedCachedTools(server: IMcpServer): IMcpCachedTool[] {
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
  server: IMcpServer,
  encryptedHeaders: Record<string, string>,
  configUserId: string,
): Promise<Record<string, string>> {
  const headers = decryptRecord(encryptedHeaders ?? {});
  const preset = getMcpPreset(server.connectorType);
  if (preset.scopeHeader) {
    headers[preset.scopeHeader.name] =
      preset.scopeHeader.scopeValues[server.writeScope];
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
  server: IMcpServer,
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
 * credential. Connect → call → close; nothing is shared across calls.
 */
async function executeMcpToolCall(params: {
  server: IMcpServer;
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

/**
 * Cap on the serialized size of one MCP tool result. MCP servers can return
 * arbitrarily large payloads (full record lists, documents); an uncapped
 * result would blow the model context in a single step. Mirrors what other
 * MCP hosts do (Claude Code / Cursor truncate large tool outputs).
 */
const MCP_OUTPUT_MAX_CHARS = 16_000;

/**
 * Normalize an MCP CallToolResult for the model: extract text blocks into a
 * plain string (instead of JSON-encoding the whole content-block envelope),
 * summarize non-text blocks, and truncate oversized output with an explicit
 * marker so the model knows data was elided.
 */
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

/** Search/inventory metadata for one MCP tool (no schema — cards only). */
export interface McpToolCatalogInfo {
  /** Prefixed provider-facing name (`mcp_<server>_<tool>`). */
  name: string;
  serverId: string;
  serverName: string;
  /** Full upstream description (the provider-facing one is dieted). */
  description: string;
  readOnly: boolean;
}

/**
 * Schema diet: MCP servers routinely ship 1–2k-token descriptions and
 * schemas. The provider-facing definition gets a truncated description and a
 * schema stripped of prose bloat; the full description stays available to
 * `search_tools` via the catalog, where it is actually useful.
 */
const MCP_TOOL_DESCRIPTION_MAX_CHARS = 200;
const MCP_SCHEMA_DESCRIPTION_MAX_CHARS = 160;

export function dietMcpDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length <= MCP_TOOL_DESCRIPTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS - 1)}…`;
}

/**
 * Deep-copy a JSON schema, truncating verbose nested `description` strings
 * and dropping documentation-only keys (`examples`, `$comment`) that cost
 * context without improving argument quality. Structural keywords are
 * untouched, so validation behavior is identical.
 */
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
  server: IMcpServer;
  encryptedHeaders: Record<string, string>;
  /** Which connection config the credential belongs to ("" = workspace). */
  configUserId: string;
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
    // OAuth connections are only usable once tokens exist.
    if (server.authType === "oauth" && !config?.oauthTokens) continue;
    resolved.push({
      server: server as IMcpServer,
      encryptedHeaders: (config?.headers ?? {}) as Record<string, string>,
      configUserId: wantUserId,
    });
  }
  return resolved;
}

/**
 * Approval decision for one tool call, following the Claude-connectors
 * model: the admin restriction is a *ceiling*, and the user's per-tool
 * choice (grant) picks a setting up to that ceiling.
 *
 * Every tool — reads included — prompts on first use until the user decides
 * (Claude behavior: access is granted by the individual, never implicitly).
 *
 * Resolution:
 *  - blocked tools never get here (filtered at build time)
 *  - user chose Block (always_deny) → no prompt; execute() refuses
 *  - ceiling "ask" → always prompt (user's Always allow can't apply)
 *  - user chose Always allow → auto-run
 *  - no choice yet → prompt
 */
async function mcpNeedsApproval(params: {
  server: IMcpServer;
  tool: IMcpCachedTool;
  userId: string | undefined;
}): Promise<boolean> {
  const { server, tool, userId } = params;
  const ceiling = mcpToolRestriction(server, tool);

  const grant = userId
    ? await McpToolGrant.findOne({
        serverId: server._id,
        userId,
        toolName: tool.name,
      }).lean()
    : null;

  if (grant?.decision === "always_deny") {
    // No approval prompt: execute() returns the denial to the model.
    return false;
  }
  if (ceiling === "ask") return true;
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
      if (tools[prefixedName]) continue; // name collision: first wins
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
          // Re-check the admin ceiling at execution time: an admin may have
          // blocked the tool after this chat's toolset was built (or between
          // an approval and its continuation).
          const freshPolicy = await McpServer.findById(server._id)
            .select("toolPolicy writeScope")
            .lean();
          if (
            freshPolicy &&
            mcpToolRestriction(freshPolicy, cachedTool) === "block"
          ) {
            return {
              success: false,
              denied: true,
              error: `"${cachedTool.name}" on ${server.name} has been blocked by a workspace admin.`,
            };
          }

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
            return normalizeMcpToolOutput(output);
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
      catalog.push({
        name: prefixedName,
        serverId: server._id.toString(),
        serverName: server.name,
        description: fullDescription,
        readOnly: riskTier === "read",
      });
    }
  }

  return { tools, readOnlyToolNames, allToolNames, catalog };
}

/**
 * Metadata the chat UI needs to render approval cards and grant buttons for
 * every exposed MCP tool, keyed by prefixed tool name.
 */
export interface McpToolUiInfo {
  prefixedName: string;
  serverId: string;
  serverName: string;
  /** Preset logo or the server URL's favicon, for the approval card. */
  serverIcon: string | null;
  toolName: string;
  riskTier: McpRiskTier;
  /** False when the admin ceiling for this tool is not "always". */
  canAlwaysAllow: boolean;
}

function mcpServerIconUrl(server: IMcpServer): string | null {
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
        serverId: server._id.toString(),
        serverName: server.name,
        serverIcon: mcpServerIconUrl(server),
        toolName: cachedTool.name,
        riskTier,
        // "Always allow" is offered only when the admin ceiling permits it.
        canAlwaysAllow: mcpToolRestriction(server, cachedTool) === "always",
      });
    }
  }
  return infos;
}
