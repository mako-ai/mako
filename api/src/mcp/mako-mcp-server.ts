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
import {
  getSystemSkillIndex,
  getSystemSkillFullText,
} from "../agent-lib/skills/system-skills";
import { loggers } from "../logging";

const logger = loggers.api("mcp-server");

const SERVER_NAME = "mako";
const SERVER_VERSION = "0.1.0";

/** Defensive cap so a huge query result cannot blow up the JSON response. */
const MAX_TOOL_RESULT_CHARS = 200_000;

const SKILL_URI_PREFIX = "mako://skills/";

export interface MakoMcpContext {
  workspaceId: string;
  /** Acting user (the API key's creator). */
  userId?: string;
}

type BridgeableTool = Pick<AiTool, "description" | "inputSchema" | "execute">;

/**
 * The toolset exposed over MCP. Same implementations the in-product agent
 * uses; assembled per request so every execution is bound to the caller's
 * workspace + acting user.
 */
export function buildMakoMcpToolset(
  context: MakoMcpContext,
): Record<string, BridgeableTool> {
  const { workspaceId, userId } = context;

  // The chatId feeds realtime echo-suppression (`agent:<chatId>`); a fresh
  // id per exchange means no open browser tab suppresses these events, so
  // tabs live-reload on every MCP-driven mutation.
  const appTools = createServerAppTools({
    workspaceId,
    userId,
    chatId: `mcp-${nanoid(10)}`,
  });

  const sqlTools = createSqlToolsV2(workspaceId, [], undefined, userId);
  const mongoTools = createMongoToolsV2(workspaceId, [], undefined, userId);

  return {
    ...appTools,
    sql_list_connections: sqlTools.sql_list_connections,
    sql_list_databases: sqlTools.sql_list_databases,
    sql_list_tables: sqlTools.sql_list_tables,
    sql_inspect_table: sqlTools.sql_inspect_table,
    sql_execute_query: sqlTools.sql_execute_query,
    mongo_list_connections: mongoTools.list_connections,
    mongo_list_databases: mongoTools.list_databases,
    mongo_list_collections: mongoTools.list_collections,
    mongo_inspect_collection: mongoTools.inspect_collection,
    mongo_execute_query: mongoTools.execute_query,
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

function serializeToolResult(result: unknown): string {
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
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

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description ?? "",
      inputSchema: toolInputJsonSchema(tool),
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
      return {
        content: [
          { type: "text" as const, text: serializeToolResult(result) },
        ],
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
