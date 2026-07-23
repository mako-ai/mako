/**
 * Mako as an MCP server.
 *
 * Exposes the existing server-side agent tools (apps, SQL, MongoDB) over the
 * Model Context Protocol so external MCP clients (Claude Code, Claude
 * Desktop, custom agents) can build and operate Mako apps headlessly with
 * nothing but a workspace API key. The tool implementations are the same
 * factories the in-product agent uses — this module only bridges AI SDK
 * tool definitions (zod input schema + execute) into MCP registrations.
 *
 * Which agent tools are exposed is decided by bridge-policy.ts (not by
 * hand-picking in this file). Unclassified tools fail the inventory test.
 *
 * One Server instance is built per HTTP request (stateless Streamable HTTP,
 * JSON response mode) — see stateless-transport.ts and mcp-server.routes.ts.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool as AiTool } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";

import { createServerAppTools } from "../agent-lib/tools/server-app-tools";
import { createSqlToolsV2 } from "../agent-lib/tools/sql-tools";
import { createMongoToolsV2 } from "../agent-lib/tools/mongodb-tools";
import { createUniversalTools } from "../agent-lib/tools/universal-tools";
import { createServerConsoleTools } from "../agent-lib/tools/server-console-tools";
import { createConsoleSearchTools } from "../agent-lib/tools/console-search-tools";
import { createDashboardSearchTools } from "../agent-lib/tools/dashboard-search-tools";
import { createVersionHistoryTools } from "../agent-lib/tools/version-history-tools";
import { createSkillTools } from "../agent-lib/tools/skill-tools";
import { createWebTools } from "../agent-lib/tools/web-tools";
import {
  getSystemSkillIndex,
  getSystemSkillFullText,
} from "../agent-lib/skills/system-skills";
import {
  queryAccessFromScopes,
  resolveWorkspaceApiKeyScopes,
  type QueryAccess,
  type WorkspaceApiKeyScope,
} from "../auth/api-key-scopes";
import { loggers } from "../logging";
import {
  MCP_BRIDGE_POLICY,
  mcpDestructiveHint,
  mcpOpenWorldHint,
  mcpReadOnlyHint,
} from "./bridge-policy";

const logger = loggers.api("mcp-server");

const SERVER_NAME = "mako";
const SERVER_VERSION = "0.1.0";

/**
 * Injected into the client's system context on initialize. Kept short — it
 * costs the client tokens on every session — but a compact workflow guide
 * saves far more by avoiding failed exploratory round-trips.
 */
const SERVER_INSTRUCTIONS = `Mako builds data apps (React + data bindings) inside one workspace.

Typical loop:
1. Discover data: list_connections, then sql_list_tables / sql_inspect_table.
2. Validate queries with sql_execute_query (short exploration timeout). For slow warehouses: create_console → run_console → check_query_status.
3. create_app → app_write_file / app_edit_file → app_create_data_binding (bind the validated query; pass consoleId to seed from a console).
4. Verify with render_app after edits. Pass includeScreenshot: false when you only need status/errors — it is much cheaper than the screenshot.
5. app_save_version to snapshot/publish.

Skills (same knowledge as the in-product agent):
- list_skills → compact index (workspace + system).
- get_relevant_skills({ query }) → ranked bodies for your task (call this early).
- load_skill / read_skill_resource / mako://skills/{name} for specifics.
Before writing app code: get_relevant_skills("build a Mako app") or resource mako://skills/apps.
Optional: search_dashboards, web_search / fetch_url for public docs.`;

/** ACP Desktop Chat — no headless preview tokens; the user already has a live tab. */
const ACP_DESKTOP_SERVER_INSTRUCTIONS = `Mako builds data apps (React + data bindings) inside Mako Desktop Chat.

Typical loop:
1. Discover data: list_connections, then sql_list_tables / sql_inspect_table.
2. Validate queries with sql_execute_query (short exploration timeout). For slow warehouses: create_console → run_console → check_query_status.
3. create_app → app_write_file / app_edit_file → app_create_data_binding (bind the validated query; pass consoleId to seed from a console).
4. Desktop opens/refreshes the app tab automatically. Do NOT create_preview_token, render_app, or paste /preview/… URLs. Use mako-desktop run_app / get_preview_errors for iframe errors.
5. app_save_version to snapshot/publish.

Skills (same knowledge as the in-product agent):
- list_skills → compact index (workspace + system).
- get_relevant_skills({ query }) → ranked bodies for your task (call this early).
- load_skill / read_skill_resource / mako://skills/{name} for specifics.
Before writing app code: get_relevant_skills("build a Mako app") or resource mako://skills/apps.
Optional: search_dashboards, web_search / fetch_url for public docs.`;

/** Defensive cap so a huge query result cannot blow up the JSON response. */
const MAX_TOOL_RESULT_CHARS = 200_000;

const SKILL_URI_PREFIX = "mako://skills/";

export interface MakoMcpContext {
  workspaceId: string;
  /** Acting user (the API key's creator). */
  userId?: string;
  /** Capabilities granted to the authenticated workspace API key. */
  scopes?: readonly WorkspaceApiKeyScope[];
  /**
   * Local Agent ACP / Desktop Chat attachment — omit headless preview
   * workflow from initialize instructions (preview tools are also not
   * registered for these clients).
   */
  acpDesktop?: boolean;
}

export type BridgeableTool = Pick<
  AiTool,
  "description" | "inputSchema" | "execute"
>;

/**
 * Assemble every server-side candidate the MCP bridge *could* expose.
 * `buildMakoMcpToolset` then filters by MCP_BRIDGE_POLICY.
 */
export function buildMakoMcpCandidateTools(
  context: MakoMcpContext,
): Record<string, BridgeableTool> {
  const { workspaceId, userId } = context;
  const scopes = resolveWorkspaceApiKeyScopes(context.scopes);
  const queryAccess = queryAccessFromScopes(scopes);

  // The chatId feeds realtime echo-suppression (`agent:<chatId>`); a fresh
  // id per exchange means no open browser tab suppresses these events, so
  // tabs live-reload on every MCP-driven mutation.
  const chatId = `mcp-${nanoid(10)}`;
  const appTools = createServerAppTools({
    workspaceId,
    userId,
    chatId,
    queryAccess,
  });

  const consoleTools = createServerConsoleTools({
    workspaceId,
    userId,
    chatId,
    queryAccess,
    surface: "mcp",
  });

  const sqlTools = createSqlToolsV2(
    workspaceId,
    [],
    undefined,
    userId,
    undefined,
    queryAccess,
  );
  const mongoTools = createMongoToolsV2(workspaceId, [], undefined, userId);
  const { list_connections } = createUniversalTools(
    workspaceId,
    [],
    undefined,
    userId,
  );
  const consoleSearchTools = createConsoleSearchTools(workspaceId);
  const dashboardSearchTools = createDashboardSearchTools(workspaceId);
  const versionHistoryTools = createVersionHistoryTools(workspaceId);
  const skillTools = createSkillTools(workspaceId, userId);
  const webTools = createWebTools();

  return {
    ...appTools,
    ...consoleTools,
    list_connections,
    ...sqlTools,
    // Namespace mongo the same way the unified agent does.
    mongo_list_connections: mongoTools.list_connections,
    mongo_list_databases: mongoTools.list_databases,
    mongo_list_collections: mongoTools.list_collections,
    mongo_inspect_collection: mongoTools.inspect_collection,
    // Included in candidates so the policy can deliberately exclude it;
    // buildMakoMcpToolset will strip it.
    mongo_execute_query: mongoTools.execute_query,
    ...consoleSearchTools,
    ...dashboardSearchTools,
    ...versionHistoryTools,
    ...skillTools,
    ...webTools,
  };
}

/**
 * The toolset exposed over MCP. Same implementations the in-product agent
 * uses; assembled per request so every execution is bound to the caller's
 * workspace + acting user. Filtering is driven by bridge-policy.ts.
 */
export function buildMakoMcpToolset(
  context: MakoMcpContext,
): Record<string, BridgeableTool> {
  const scopes = resolveWorkspaceApiKeyScopes(context.scopes);
  const queryAccess = queryAccessFromScopes(scopes);
  const candidates = buildMakoMcpCandidateTools(context);
  const exposed: Record<string, BridgeableTool> = {};

  for (const [name, tool] of Object.entries(candidates)) {
    const entry = MCP_BRIDGE_POLICY[name];
    if (!entry || entry.status !== "bridge") continue;
    if (entry.requiresQueryAccess && queryAccess === "none") continue;
    exposed[name] = tool;
  }

  return exposed;
}

function toolAnnotations(
  name: string,
  queryAccess: QueryAccess,
): Record<string, unknown> {
  const readOnly = mcpReadOnlyHint(name, queryAccess);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && mcpDestructiveHint(name),
    openWorldHint: mcpOpenWorldHint(name),
  };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    (value as { "~standard": { vendor?: string } })["~standard"].vendor ===
      "zod"
  );
}

function toolInputJsonSchema(tool: BridgeableTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (isZodSchema(schema)) {
    try {
      return z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
    } catch (error) {
      logger.warn("Failed to convert tool schema to JSON Schema", { error });
    }
  }
  return { type: "object", properties: {} };
}

/**
 * Escape hatch for tools whose result is richer than text (e.g. render_app
 * screenshots): a result of shape `{ mcpContent: [...] }` is passed through
 * as the MCP content array verbatim instead of being JSON-stringified.
 */
function extractMcpContent(
  result: unknown,
): Array<Record<string, unknown>> | null {
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { mcpContent?: unknown }).mcpContent)
  ) {
    return (result as { mcpContent: Array<Record<string, unknown>> })
      .mcpContent;
  }
  return null;
}

function serializeToolResult(result: unknown): string {
  // Compact JSON on purpose: results feed straight into the client model's
  // context, and pretty-printing inflates token usage by roughly a third.
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text === undefined) return "null";
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n… [truncated: result exceeded ${MAX_TOOL_RESULT_CHARS} characters]`
  );
}

/**
 * Build a stateless MCP Server bound to one workspace + acting user.
 * `extraTools` lets the route layer add endpoint-specific tools (e.g.
 * create_preview_token / render_app) without widening this module.
 */
export function buildMakoMcpServer(
  context: MakoMcpContext,
  extraTools?: Record<string, BridgeableTool>,
): Server {
  const tools: Record<string, BridgeableTool> = {
    ...buildMakoMcpToolset(context),
    ...extraTools,
  };
  const queryAccess = queryAccessFromScopes(
    resolveWorkspaceApiKeyScopes(context.scopes),
  );

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: context.acpDesktop
        ? ACP_DESKTOP_SERVER_INSTRUCTIONS
        : SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description ?? "",
      inputSchema: toolInputJsonSchema(tool),
      annotations: toolAnnotations(name, queryAccess),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const tool = tools[name];
    if (!tool?.execute) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    let input: unknown = args ?? {};
    if (isZodSchema(tool.inputSchema)) {
      const parsed = tool.inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid arguments for ${name}: ${parsed.error.message}`,
            },
          ],
          isError: true,
        };
      }
      input = parsed.data;
    }

    try {
      const result = await tool.execute(input as never, {
        toolCallId: nanoid(),
        messages: [],
      });
      const richContent = extractMcpContent(result);
      if (richContent) {
        return { content: richContent };
      }
      return {
        content: [{ type: "text" as const, text: serializeToolResult(result) }],
      };
    } catch (error) {
      logger.error("MCP tool execution failed", {
        tool: name,
        workspaceId: context.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool ${name} failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  });

  // System skills (the git-versioned authoring playbooks under
  // api/src/agent-skills) exposed as MCP resources, so external agents can
  // read the same guidance the in-product agent retrieves.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: getSystemSkillIndex().map(skill => ({
      uri: `${SKILL_URI_PREFIX}${skill.name}`,
      name: skill.name,
      description: skill.description,
      mimeType: "text/markdown",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, request => {
    const uri = request.params.uri;
    if (!uri.startsWith(SKILL_URI_PREFIX)) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    const name = uri.slice(SKILL_URI_PREFIX.length);
    const text = getSystemSkillFullText(name);
    if (!text) {
      throw new Error(`Unknown skill: ${name}`);
    }
    return {
      contents: [{ uri, mimeType: "text/markdown", text }],
    };
  });

  return server;
}
