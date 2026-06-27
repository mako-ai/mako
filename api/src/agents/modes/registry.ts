import { PLAN_GATE_ALLOWED_TOOL_NAMES } from "@mako/agent-tools";
import type { AgentContext } from "../types";
import type { AgentMode, ExpertiseModeId } from "./types";
import {
  QUERY_MODE_SYSTEM_PROMPT,
  DASHBOARD_MODE_SYSTEM_PROMPT,
  FLOW_MODE_SYSTEM_PROMPT,
  APP_MODE_SYSTEM_PROMPT,
  TRANSFORM_MODE_SYSTEM_PROMPT,
  EXPLORE_MODE_SYSTEM_PROMPT,
} from "./prompts";

/**
 * Tools that are always active regardless of the enabled expertise mode:
 * the lifecycle/core tools plus the cross-cutting memory, skills, search, and
 * version-history tools that the legacy unified agent kept available in every
 * modality. The plan-mode gate still filters the mutating ones (e.g.
 * `update_self_directive`) because they are not in `READ_ONLY_TOOL_NAMES`.
 */
export const CORE_ALWAYS_TOOL_NAMES: readonly string[] = [
  // Lifecycle / mode-switching (shared with the plan-mode gate allowlist)
  ...PLAN_GATE_ALLOWED_TOOL_NAMES,
  // Persistent memory
  "read_self_directive",
  "update_self_directive",
  // Skills
  "save_skill",
  "delete_skill",
  "load_skill",
  "read_skill_resource",
  "search_skills",
  // Cross-surface search (parity: both are discovery, not modality work)
  "search_consoles",
  "search_dashboards",
  // Version history
  "browse_version_history",
  "get_version_snapshot",
];

const QUERY_MODE_TOOL_NAMES: string[] = [
  // Client console tools
  "read_console",
  "modify_console",
  "create_console",
  "list_open_consoles",
  "set_console_connection",
  "open_console",
  "run_console",
  // Chart + screenshot
  "modify_chart_spec",
  "get_chart_template",
  "capture_screenshot",
  // Discovery
  "list_connections",
  // MongoDB
  "mongo_list_connections",
  "mongo_list_databases",
  "mongo_list_collections",
  "mongo_inspect_collection",
  "mongo_execute_query",
  // SQL
  "sql_list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
  "sql_execute_query",
];

const DASHBOARD_MODE_TOOL_NAMES: string[] = [
  "list_open_dashboards",
  "open_dashboard",
  "enter_edit_mode",
  "create_dashboard",
  "import_console_as_data_source",
  "add_data_source",
  "create_data_source",
  "update_data_source_query",
  "run_data_source_query",
  "add_widget",
  "modify_widget",
  "remove_widget",
  "get_dashboard_state",
  // Shared surface-scoped data-source primitives (apps + dashboards)
  "list_data_sources",
  "inspect_data_source",
  "query_duckdb",
  "add_global_filter",
  "remove_global_filter",
  "link_tables",
  "set_time_dimension",
  "get_chart_templates",
  "get_chart_template",
  "dashboard_save_version",
  "dashboard_restore_version",
  "capture_screenshot",
  // Search + discovery for building data sources
  "search_dashboards",
  "list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
];

const FLOW_MODE_TOOL_NAMES: string[] = [
  // Flow server tools (unified agent strips flow's discovery tools in favor
  // of the universal ones, so we list those here for discovery).
  "validate_query",
  "execute_query",
  "explain_template",
  // Client flow form tools
  "get_form_state",
  "set_form_field",
  "set_multiple_fields",
  "create_flow_tab",
  "list_flow_tabs",
  // Discovery
  "list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
];

const APP_MODE_TOOL_NAMES: string[] = [
  // Client app tools
  "list_open_apps",
  "open_app",
  "create_app",
  "get_app_state",
  "app_read_file",
  "app_write_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_delete_data_binding",
  "app_save_version",
  "app_restore_version",
  "materialize_binding",
  "run_app",
  // Shared surface-scoped data-source primitives (apps + dashboards)
  "list_data_sources",
  "inspect_data_source",
  "query_duckdb",
  "capture_screenshot",
  // Discovery for validating binding queries
  "list_connections",
  "sql_list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
  "sql_execute_query",
  "mongo_list_connections",
  "mongo_list_databases",
  "mongo_list_collections",
  "mongo_inspect_collection",
  "mongo_execute_query",
  "fetch_url",
  "web_search",
];

const TRANSFORM_MODE_TOOL_NAMES: string[] = [
  // Bootstrap: create a project when the workspace has none
  "dbt_create_project",
  // Client dbt file tools
  "read_dbt_project_tree",
  "read_dbt_file",
  "create_dbt_file",
  "modify_dbt_file",
  "delete_dbt_file",
  // Server dbt verification + execution tools
  "dbt_parse",
  "dbt_compile_model",
  "dbt_run_model",
  "dbt_run_job",
  "dbt_get_run",
  "dbt_show",
  "dbt_create_job",
  "dbt_update_job",
  // Git: commit/push edits to the connected repo (only when the user asks).
  "dbt_git_status",
  "dbt_commit_and_push",
  "dbt_create_branch",
  "dbt_switch_branch",
  "dbt_list_branches",
  "dbt_open_pull_request",
  // Discovery: inspect sources before writing staging models; preview built
  // tables after dbt_run_model.
  "list_connections",
  "sql_list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
  "sql_execute_query",
];

const EXPLORE_MODE_TOOL_NAMES: string[] = [
  "list_connections",
  "sql_list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
  "mongo_list_connections",
  "mongo_list_databases",
  "mongo_list_collections",
  "mongo_inspect_collection",
  "search_consoles",
  "search_dashboards",
  "read_console",
  "list_open_consoles",
  "list_open_dashboards",
  "get_dashboard_state",
  "capture_screenshot",
  "fetch_url",
  "web_search",
];

export const modeRegistry: Record<ExpertiseModeId, AgentMode> = {
  query: {
    id: "query",
    name: "Query",
    routingPrompt:
      "Build and run queries in consoles (SQL, MongoDB), funnels, reports, and analyses.",
    systemPrompt: QUERY_MODE_SYSTEM_PROMPT,
    toolNames: QUERY_MODE_TOOL_NAMES,
    trajectories: [
      "Discover the relevant connection and tables",
      "Draft the query in a console",
      "Run the query and verify the results",
    ],
  },
  dashboard: {
    id: "dashboard",
    name: "Dashboard",
    routingPrompt:
      "Create and edit dashboards, widgets, data sources, filters, and charts.",
    systemPrompt: DASHBOARD_MODE_SYSTEM_PROMPT,
    toolNames: DASHBOARD_MODE_TOOL_NAMES,
    trajectories: [
      "Locate or create the target dashboard",
      "Add or update the data source",
      "Add or modify widgets and verify they render",
    ],
  },
  flow: {
    id: "flow",
    name: "Sync Flow",
    routingPrompt:
      "Configure database-to-database sync flows, query templates, and schema mapping.",
    systemPrompt: FLOW_MODE_SYSTEM_PROMPT,
    toolNames: FLOW_MODE_TOOL_NAMES,
    trajectories: [
      "Identify source and destination connections",
      "Write and validate the source query",
      "Configure pagination and schema mapping",
    ],
  },
  app: {
    id: "app",
    name: "React App",
    routingPrompt:
      "Build React apps wired to workspace data: edit files, add dependencies, and create data bindings.",
    systemPrompt: APP_MODE_SYSTEM_PROMPT,
    toolNames: APP_MODE_TOOL_NAMES,
    trajectories: [
      "Locate or create the target app",
      "Validate the data and create data bindings",
      "Edit app files and verify the preview builds without errors",
    ],
  },
  transform: {
    id: "transform",
    name: "Transforms",
    routingPrompt:
      "Build and run dbt transformations: edit project files, compile, test, and run models against the warehouse.",
    systemPrompt: TRANSFORM_MODE_SYSTEM_PROMPT,
    toolNames: TRANSFORM_MODE_TOOL_NAMES,
    trajectories: [
      "Inspect the source tables for the model",
      "Write the model SQL + schema.yml entries",
      "Verify with dbt_parse, dbt_compile_model, then dbt_run_model on dev",
    ],
  },
  explore: {
    id: "explore",
    name: "Explore",
    routingPrompt:
      "Read-only investigation across connections, consoles, dashboards, and memory.",
    systemPrompt: EXPLORE_MODE_SYSTEM_PROMPT,
    toolNames: EXPLORE_MODE_TOOL_NAMES,
    readOnly: true,
  },
};

export const EXPERTISE_MODE_IDS = Object.keys(
  modeRegistry,
) as ExpertiseModeId[];

export function isExpertiseModeId(value: unknown): value is ExpertiseModeId {
  return typeof value === "string" && value in modeRegistry;
}

/**
 * Legacy mode ids → current ids. Existing chats persist `enable_mode` tool
 * calls; `deriveModeState` replays them, so a rename must keep resolving the
 * old id (e.g. the dbt mode was renamed to "transform").
 */
const LEGACY_MODE_ALIASES: Record<string, ExpertiseModeId> = {
  dbt: "transform",
};

/**
 * Resolve a (possibly legacy) mode id to a current `ExpertiseModeId`, or
 * `undefined` if it is not a known mode.
 */
export function resolveExpertiseModeId(
  value: unknown,
): ExpertiseModeId | undefined {
  if (typeof value !== "string") return undefined;
  const resolved = LEGACY_MODE_ALIASES[value] ?? value;
  return isExpertiseModeId(resolved) ? resolved : undefined;
}

/**
 * Pick the expertise mode to enable by default for a fresh request, based on
 * what the user is currently looking at. This replaces PostHog's small-model
 * router with a zero-cost heuristic; a model router can be layered on later.
 */
export function defaultExpertiseMode(
  context: Pick<AgentContext, "activeView">,
  tabKind?: string,
): ExpertiseModeId {
  const view = context.activeView;
  if (view === "dashboard" || tabKind === "dashboard") return "dashboard";
  if (view === "flow-editor" || tabKind === "flow-editor") return "flow";
  if (view === "app" || tabKind === "app") return "app";
  if (view === "dbt" || tabKind === "dbt-file" || tabKind === "dbt-job") {
    return "transform";
  }
  return "query";
}

/** Names of the tools unlocked by the given enabled expertise modes. */
export function toolNamesForModes(
  enabledModes: Iterable<ExpertiseModeId>,
): Set<string> {
  const names = new Set<string>(CORE_ALWAYS_TOOL_NAMES);
  for (const modeId of enabledModes) {
    const mode = modeRegistry[modeId];
    if (!mode) continue;
    for (const name of mode.toolNames) names.add(name);
  }
  return names;
}
