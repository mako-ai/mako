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
import {
  AGENT_CAPABILITY_BY_NAME,
  CAPABILITY_GRANTS,
  type CapabilityGrant,
} from "@mako/agent-tools";

import {
  authorizeAgentCapability,
  missingInputConditionalGrant,
} from "../agent-lib/capabilities/runtime";
import { createHeadlessRunAppTool } from "./preview-tools";
import { createServerAppTools } from "../agent-lib/tools/server-app-tools";
import { createAppsV2Tools } from "../agent-lib/tools/apps-v2-tools";
import { createSqlToolsV2 } from "../agent-lib/tools/sql-tools";
import { createMongoToolsV2 } from "../agent-lib/tools/mongodb-tools";
import { createUniversalTools } from "../agent-lib/tools/universal-tools";
import { createServerConsoleTools } from "../agent-lib/tools/server-console-tools";
import { createServerDashboardTools } from "../agent-lib/tools/server-dashboard-tools";
import { createNotebookServerTools } from "../agent-lib/tools/server-notebook-tools";
import { createConsoleSearchTools } from "../agent-lib/tools/console-search-tools";
import { createDashboardSearchTools } from "../agent-lib/tools/dashboard-search-tools";
import { createVersionHistoryTools } from "../agent-lib/tools/version-history-tools";
import { createSkillTools } from "../agent-lib/tools/skill-tools";
import { createSelfDirectiveTools } from "../agent-lib/tools/self-directive-tool";
import { createWebTools } from "../agent-lib/tools/web-tools";
import { createDbtServerTools } from "../agent-lib/tools/dbt-tools";
import {
  getSystemSkillIndex,
  getSystemSkillFullText,
} from "../agent-lib/skills/system-skills";
import {
  capabilityGrantsFromScopes,
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
1. Discover data: list_connections, then list_databases / list_tables / inspect_table (they dispatch on connection type — SQL or MongoDB).
2. Validate queries with sql_execute_query (short exploration timeout). For slow warehouses: create_console → run_console → check_query_status.
3. create_app → app_write_file / app_edit_file → app_create_data_binding (bind the validated query; pass consoleId to seed from a console).
4. Verify with run_app after edits (server-side headless render). Pass includeScreenshot: false when you only need status/errors — it is much cheaper than the screenshot. Pass width/height (e.g. 390x844) to verify the mobile layout before publishing.
5. app_save_version to snapshot/publish.

dbt: read_dbt_project_tree → read/edit files → validate with dbt_parse / dbt_compile_model / dbt_show (async: poll dbt_get_run). Check dbt_git_status before finishing — edits are working-tree drafts until committed. Warehouse-mutating runs (dbt_run_model, dbt_run_job) appear only when the API key has the warehouse:write scope; Git mutations (dbt_commit_to_branch, branches, PRs) only with git:write.

Skills (same knowledge as the in-product agent):
- list_skills → compact index (workspace + system).
- get_relevant_skills({ query }) → ranked bodies for your task (call this early).
- load_skill / read_skill_resource / mako://skills/{name} for specifics.
Before writing app code: get_relevant_skills("build a Mako app") or resource mako://skills/apps.
Optional: search_dashboards, web_search / fetch_url for public docs.`;

/** ACP Desktop Chat — no headless preview tokens; the user already has a live tab. */
const ACP_DESKTOP_SERVER_INSTRUCTIONS = `Mako builds data apps (React + data bindings) inside Mako Desktop Chat.

Typical loop:
1. Discover data: list_connections, then list_databases / list_tables / inspect_table (they dispatch on connection type — SQL or MongoDB).
2. Validate queries with sql_execute_query (short exploration timeout). For slow warehouses: create_console → run_console → check_query_status.
3. create_app → app_write_file / app_edit_file → app_create_data_binding (bind the validated query; pass consoleId to seed from a console).
4. For dbt work: read_dbt_project_tree → read/edit files → validate asynchronously, then poll dbt_get_run. For large or destructive work (warehouse runs, Git mutations, schedules), prefer proposing a plan via mako-desktop submit_plan before acting.
5. Desktop opens/refreshes the app tab automatically. Do NOT create_preview_token, render_app, or paste /preview/… URLs. Verify with mako-desktop run_app: status, iframe errors, and a screenshot of the live tab (rebuild: false polls without rebuilding; includeScreenshot: false is much cheaper). For consoles use open_console / create_console; for notebooks use create_notebook / cell tools.
6. Interactive UX: mako-desktop ask_clarifying_questions / submit_plan (docked Chat cards) — never ask as plain text.
7. Durable memory: read_self_directive / update_self_directive only. Do NOT write .claude/**/MEMORY.md or other local Claude memory files.
8. app_save_version to snapshot/publish.

Skills (same knowledge as the in-product agent):
- list_skills → compact index (workspace + system).
- get_relevant_skills({ query }) → ranked bodies for your task (call this early).
- load_skill / read_skill_resource / mako://skills/{name} for specifics.
Before writing app code: get_relevant_skills("build a Mako app") or resource mako://skills/apps.
Optional: search_dashboards, web_search / fetch_url for public docs.`;

/**
 * Apps v2 steering appended to initialize instructions (§13.21). The base
 * instructions describe the legacy v1 app loop; a workspace that has moved
 * to git-backed apps needs the agent working in the app2_* toolset instead
 * — and the two systems must never be mixed on one app.
 */
const APPS_V2_STEER = `

THIS WORKSPACE USES APPS V2 (git-backed). For app work, IGNORE the v1 app loop above and use:
app2_list_apps → app2_create_app → app2_write_file / app2_edit_file / app2_bash → app2_materialize (bindings are bindings/<name>.sql files) → verify with app2_open_app (starts the dev server, focuses the user's UI) + app2_dev_log (vite + browser console) + app2_browse (headless browser: click, navigate, screenshot the running app) → app2_commit → app2_merge_to_main (main is what publishes buildable state).
create_app / app_write_file / app_save_version / run_app are the LEGACY v1 system — do not use them here, and never mix the two toolsets on one app.
Before writing app code: resource mako://skills/apps-v2.`;

const APPS_V2_HINT = `

If asked to work on a git-backed Apps v2 app (folders under apps/ in the workspace repo), use the app2_* toolset (start with app2_list_apps); never mix it with the v1 app tools on one app.`;

/** Defensive cap so a huge query result cannot blow up the JSON response. */
const MAX_TOOL_RESULT_CHARS = 200_000;

const SKILL_URI_PREFIX = "mako://skills/";

export interface MakoMcpContext {
  workspaceId: string;
  /**
   * Workspace is on Apps v2 (settings.appsV2Enabled). Steers initialize
   * instructions to the app2_* loop instead of the legacy v1 app loop —
   * tools for BOTH systems stay registered; this only changes guidance.
   */
  appsV2Enabled?: boolean;
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
  /** Approved task grants resolved server-side for this agent session. */
  capabilityGrants?: readonly CapabilityGrant[];
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

  const appsV2Tools = createAppsV2Tools({ workspaceId, userId });

  const consoleTools = createServerConsoleTools({
    workspaceId,
    userId,
    chatId,
    queryAccess,
    surface: "mcp",
  });

  // Dashboards manage data sources the same way apps manage bindings: the
  // server leg of update_data_source_query (per-surface adapter, run_app
  // pattern) lets headless agents edit queries, toggle materialization, and
  // set the dashboard refresh schedule.
  const dashboardTools = createServerDashboardTools({
    workspaceId,
    userId,
    chatId,
    queryAccess,
  });

  const notebookTools = createNotebookServerTools({
    workspaceId,
    userId,
    chatId,
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
  const { list_connections, list_databases, list_tables, inspect_table } =
    createUniversalTools(workspaceId, [], undefined, userId);
  const consoleSearchTools = createConsoleSearchTools(workspaceId);
  const dashboardSearchTools = createDashboardSearchTools(workspaceId);
  const versionHistoryTools = createVersionHistoryTools(workspaceId);
  const skillTools = createSkillTools(workspaceId, userId);
  const selfDirectiveTools = createSelfDirectiveTools(workspaceId, userId);
  const webTools = createWebTools();
  const dbtTools = createDbtServerTools(workspaceId, userId, { chatId });
  // Headless adapter for the canonical run_app capability (external MCP
  // only — the bridge policy omits it for Desktop ACP, where mako-desktop
  // provides run_app against the live tab).
  const headlessRunApp = createHeadlessRunAppTool(context);

  return {
    ...appTools,
    ...headlessRunApp,
    ...appsV2Tools,
    ...consoleTools,
    ...dashboardTools,
    ...notebookTools,
    ...selfDirectiveTools,
    // Unified cross-engine discovery (dispatches on connection type). The
    // namespaced sql_*/mongo_* discovery tools below remain as aliases for
    // existing external clients.
    list_connections,
    list_databases,
    list_tables,
    inspect_table,
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
    ...dbtTools,
  };
}

/**
 * Grants held by this MCP session.
 *
 * External MCP keeps its long-standing implicit headless-authoring authority
 * (artifact-write for app/notebook/dbt-file drafts, schedule-write for
 * binding schedules — both relied on by every existing key), and derives the
 * rest from explicit opt-in API-key scopes (warehouse:write → the
 * warehouse-write grant behind dbt_run_model / dbt_run_job / dbt_cancel_run).
 *
 * Desktop ACP holds every grant: plan-grant gating is DISABLED pending
 * product review — see the CallTool comment below.
 */
const EXTERNAL_MCP_IMPLICIT_GRANTS: readonly CapabilityGrant[] = [
  "artifact-write",
  "schedule-write",
];

function sessionCapabilityGrants(
  context: MakoMcpContext,
  scopes: readonly WorkspaceApiKeyScope[],
): Set<CapabilityGrant> {
  if (context.acpDesktop) {
    return new Set<CapabilityGrant>([
      ...CAPABILITY_GRANTS,
      ...(context.capabilityGrants ?? []),
    ]);
  }
  return new Set<CapabilityGrant>([
    ...EXTERNAL_MCP_IMPLICIT_GRANTS,
    ...capabilityGrantsFromScopes(scopes),
    ...(context.capabilityGrants ?? []),
  ]);
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
  const grants = sessionCapabilityGrants(context, scopes);
  const candidates = buildMakoMcpCandidateTools(context);
  const exposed: Record<string, BridgeableTool> = {};

  for (const [name, tool] of Object.entries(candidates)) {
    const entry = MCP_BRIDGE_POLICY[name];
    if (!entry || entry.status !== "bridge") continue;
    if (entry.acpDesktopOnly && !context.acpDesktop) continue;
    if (entry.omitForAcpDesktop && context.acpDesktop) continue;
    if (entry.requiresQueryAccess && queryAccess === "none") continue;
    // Grant-gated tools stay hidden from stateless external clients that
    // did not opt in via scopes (mirrors the requiresQueryAccess hiding
    // above). Execution re-checks via authorizeAgentCapability regardless.
    const requiredGrant = AGENT_CAPABILITY_BY_NAME.get(name)?.requiredGrant;
    if (requiredGrant && !grants.has(requiredGrant)) continue;
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
      instructions:
        (context.acpDesktop
          ? ACP_DESKTOP_SERVER_INSTRUCTIONS
          : SERVER_INSTRUCTIONS) +
        (context.appsV2Enabled ? APPS_V2_STEER : APPS_V2_HINT),
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
    // Desktop ACP plan-grant gating is DISABLED pending product review:
    // the philosophy there is "same capabilities everywhere", matching
    // native Chat (see PLAN_GRANT_GATING_ENABLED in
    // agents/modes/runtime.ts) — sessionCapabilityGrants hands ACP every
    // grant. External MCP has no human in the loop, so it holds only the
    // implicit headless-authoring grants plus whatever the API key's
    // scopes explicitly opt into (warehouse:write → warehouse-write).
    // Surface membership and query-access scopes still apply. To
    // re-enable ACP gating, restore: artifact-write +
    // context.capabilityGrants (from resolveAcpPlanGrants).
    const grants = sessionCapabilityGrants(
      context,
      resolveWorkspaceApiKeyScopes(context.scopes),
    );
    const authorization = authorizeAgentCapability(name, {
      surface: context.acpDesktop ? "desktop-acp" : "external-mcp",
      queryAccess,
      grants,
    });
    if (!authorization.allowed) {
      return {
        content: [
          {
            type: "text" as const,
            text: authorization.reason ?? `Tool ${name} is not authorized`,
          },
        ],
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

    // Input-conditional grants (e.g. app_update_data_binding's schedule leg
    // requires schedule-write) — checked on the parsed input.
    const missingGrant = missingInputConditionalGrant(name, input, grants);
    if (missingGrant) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${name}: ${missingGrant.behavior} requires the ` +
              `"${missingGrant.grant}" grant on this session.`,
          },
        ],
        isError: true,
      };
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
