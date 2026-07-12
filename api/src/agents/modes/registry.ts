import {
  DBT_CAPABILITY_NAMES,
  PLAN_GATE_ALLOWED_TOOL_NAMES,
} from "@mako/agent-tools";
import type { AgentContext } from "../types";
import type { AgentMode, ExpertiseModeId } from "./types";
import {
  QUERY_MODE_SYSTEM_PROMPT,
  DASHBOARD_MODE_SYSTEM_PROMPT,
  FLOW_MODE_SYSTEM_PROMPT,
  APP_MODE_SYSTEM_PROMPT,
  TRANSFORM_MODE_SYSTEM_PROMPT,
  EXPLORE_MODE_SYSTEM_PROMPT,
  NOTEBOOK_MODE_SYSTEM_PROMPT,
} from "./prompts";

/**
 * Tools that are always active regardless of the enabled expertise mode.
 * Deliberately small — every entry here is paid for in context on every
 * request. Rarely-used cross-cutting tools live in
 * `DEFERRED_BUILTIN_TOOL_NAMES` instead: still registered and executable,
 * but activated on demand via `search_tools`/`load_tools`. The plan-mode
 * gate still filters the mutating ones (e.g. `update_self_directive`)
 * because they are not in `READ_ONLY_TOOL_NAMES`.
 */
export const CORE_ALWAYS_TOOL_NAMES: readonly string[] = [
  // Lifecycle / mode-switching + tool discovery (shared with the plan-mode
  // gate allowlist: enable_mode, todo_write, ask_clarifying_questions,
  // submit_plan, search_tools, load_tools)
  ...PLAN_GATE_ALLOWED_TOOL_NAMES,
  // Persistent memory
  "read_self_directive",
  "update_self_directive",
  // Skills: retrieval + save + tier-3 resource reads stay core (skills /
  // mode prompts name them every turn). list/delete/search stay deferred.
  "get_relevant_skills",
  "load_skill",
  "save_skill",
  "read_skill_resource",
  // Public web access (useful in every modality, not modality-specific)
  "fetch_url",
  "web_search",
];

/**
 * Built-in tools demoted out of the always-active set: registered and
 * executable but sent to the provider only after `load_tools` (or the
 * per-turn relevance preload). Anything here must be classified — the
 * tier-policy test fails when a built-in tool is neither core, in a mode's
 * toolNames, nor listed here. The map value is the catalog domain label
 * shown in `search_tools` results.
 */
export const DEFERRED_BUILTIN_TOOL_DOMAINS: Readonly<Record<string, string>> = {
  // Skill management rarer ops (retrieval/save/read_skill_resource are core)
  delete_skill: "skills",
  list_skills: "skills",
  search_skills: "skills",
  // Legacy full-file app read. Keep executable for compatibility, but the app
  // mode uses app_search + app_read_resource for bounded context.
  app_read_file: "apps",
  // Deprecated aliases of app_update_data_binding (which now takes
  // materialization + materializationSchedule directly). Kept executable for
  // external MCP clients; the in-product agent uses the merged tool.
  app_set_binding_materialization: "apps",
  app_set_binding_schedule: "apps",
  // Deprecated aliases of app_set_preview (environment + viewport folded into
  // one preview setter). Kept executable for old chats.
  app_set_preview_environment: "apps",
  app_set_preview_viewport: "apps",
  // Deprecated single-field alias of set_multiple_fields (which updates one
  // or many fields). Its FIELD_PATHS enum makes it one of the heaviest
  // schemas in the catalog, so it stays out of the flow working set.
  set_form_field: "flows",
  // Deprecated aliases of create_data_source({ consoleId }) — both imported a
  // saved console into a dashboard by value. Kept executable for old chats.
  import_console_as_data_source: "dashboards",
  add_data_source: "dashboards",
  // Deprecated alias of get_chart_template without templateId (lists all).
  get_chart_templates: "dashboards",
  // Deprecated aliases of edit_notebook_cell (mode: 'insert' | 'delete').
  // Kept executable for external MCP clients; the in-product agent uses the
  // merged tool.
  add_notebook_cell: "notebooks",
  delete_notebook_cell: "notebooks",
  // Deprecated per-engine discovery aliases of the unified
  // list_databases / list_tables / inspect_table family (which dispatches on
  // connection type). Kept executable for existing chats and external MCP
  // clients; execution stays split (sql_execute_query / mongo_execute_query).
  sql_list_connections: "sql",
  sql_list_databases: "sql",
  sql_list_tables: "sql",
  sql_inspect_table: "sql",
  mongo_list_connections: "mongodb",
  mongo_list_databases: "mongodb",
  mongo_list_collections: "mongodb",
  mongo_inspect_collection: "mongodb",
  // Deprecated per-entity aliases of the generic save_version /
  // restore_version pair (which takes an entityType + entityId ref). The
  // app_* pair stays the MCP-facing surface (the generic pair is client-side).
  app_save_version: "apps",
  app_restore_version: "apps",
  dashboard_save_version: "dashboards",
  dashboard_restore_version: "dashboards",
};

export const DEFERRED_BUILTIN_TOOL_NAMES: readonly string[] = Object.keys(
  DEFERRED_BUILTIN_TOOL_DOMAINS,
);

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
  // Discovery (search_consoles was core before tiering; query is the
  // default mode, so keep console lookup available without a load step).
  // list_databases/list_tables/inspect_table dispatch on connection type
  // (MongoDB vs SQL); only execution stays per-engine.
  "search_consoles",
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
  "mongo_execute_query",
  "sql_execute_query",
  // Long-running query lifecycle (pairs with sql_execute_query / run_console)
  "check_query_status",
  "cancel_query",
  "list_console_executions",
];

const DASHBOARD_MODE_TOOL_NAMES: string[] = [
  "list_open_dashboards",
  "open_dashboard",
  "enter_edit_mode",
  "create_dashboard",
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
  "get_chart_template",
  "save_version",
  "restore_version",
  "browse_version_history",
  "get_version_snapshot",
  "capture_screenshot",
  // Search + discovery for building data sources
  "search_consoles",
  "search_dashboards",
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
];

const FLOW_MODE_TOOL_NAMES: string[] = [
  // Flow server tools (unified agent strips flow's discovery tools in favor
  // of the universal ones, so we list those here for discovery).
  "validate_query",
  "execute_query",
  "explain_template",
  // Client flow form tools
  "get_form_state",
  "set_multiple_fields",
  "create_flow_tab",
  "list_flow_tabs",
  // Discovery
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
];

/**
 * Tools that operate ONLY on Apps v2 (git-backed) projects. Kept as a set so
 * {@link isolateAppToolFamily} can prune the wrong family when the user is
 * clearly working in one of the two app systems (adopted from the parallel
 * apps-v2 branch): a v2 project id passed to a v1 tool (or vice versa) fails
 * confusingly, and models otherwise mix the suites.
 */
export const APP_V2_ONLY_TOOL_NAMES = new Set<string>([
  "app2_list_apps",
  "app2_create_app",
  "app2_bash",
  "app2_read_file",
  "app2_glob",
  "app2_grep",
  "app2_write_file",
  "app2_edit_file",
  "app2_status",
  "app2_commit",
  "app2_list_branches",
  "app2_merge_to_main",
]);

/** Tools that operate ONLY on Apps v1 (Mongo-document) apps. */
export const APP_V1_ONLY_TOOL_NAMES = new Set<string>([
  "list_open_apps",
  "open_app",
  "create_app",
  "get_app_state",
  "app_read_file",
  "app_write_file",
  "app_edit_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_update_data_binding",
  "app_delete_data_binding",
  "app_set_binding_materialization",
  "app_set_binding_schedule",
  "app_save_version",
  "app_restore_version",
  "materialize_binding",
  "run_app",
  "app_set_preview_environment",
]);

/**
 * When the user's focus unambiguously belongs to one app system (an app tab
 * of either kind, or one of the two app explorers), hide the OTHER system's
 * tools from the step so the model cannot cross the streams.
 */
export function isolateAppToolFamily(
  activeTools: string[],
  tabKind: string | undefined,
  activeExplorer?: AgentContext["activeExplorer"],
): string[] {
  const isAppV2Tab = tabKind === "app-v2" || tabKind === "app-v2-file";
  const isAppV1Tab =
    tabKind === "app" || tabKind === "app-file" || tabKind === "app-binding";
  const excluded = isAppV2Tab
    ? APP_V1_ONLY_TOOL_NAMES
    : isAppV1Tab
      ? APP_V2_ONLY_TOOL_NAMES
      : activeExplorer === "apps-v2"
        ? APP_V1_ONLY_TOOL_NAMES
        : activeExplorer === "apps"
          ? APP_V2_ONLY_TOOL_NAMES
          : undefined;
  return excluded
    ? activeTools.filter(toolName => !excluded.has(toolName))
    : activeTools;
}

const APP_MODE_TOOL_NAMES: string[] = [
  // Apps v2 (git-backed). Tool-family isolation picks v1 vs v2 per turn.
  ...APP_V2_ONLY_TOOL_NAMES,
  // Client app tools
  "list_open_apps",
  "open_app",
  "create_app",
  "get_app_state",
  "app_search",
  "app_read_resource",
  "app_write_file",
  "app_edit_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_update_data_binding",
  "app_delete_data_binding",
  "save_version",
  "restore_version",
  "browse_version_history",
  "get_version_snapshot",
  "materialize_binding",
  "run_app",
  "app_set_preview",
  // Shared surface-scoped data-source primitives (apps + dashboards)
  "list_data_sources",
  "inspect_data_source",
  "query_duckdb",
  "capture_screenshot",
  // Discovery for validating binding queries
  "search_consoles",
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
  "sql_execute_query",
  "check_query_status",
  "cancel_query",
  "mongo_execute_query",
];

const TRANSFORM_MODE_TOOL_NAMES: string[] = [
  ...DBT_CAPABILITY_NAMES,
  // Discovery: inspect sources before writing staging models; preview built
  // tables after dbt_run_model.
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
  "sql_execute_query",
  "check_query_status",
  "cancel_query",
];

const EXPLORE_MODE_TOOL_NAMES: string[] = [
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
  "search_consoles",
  "search_dashboards",
  "read_console",
  "list_open_consoles",
  "list_open_dashboards",
  "get_dashboard_state",
  "capture_screenshot",
];

const NOTEBOOK_MODE_TOOL_NAMES: string[] = [
  // Client notebook tools
  "create_notebook",
  "list_open_notebooks",
  "read_notebook",
  "search_notebook",
  "read_notebook_cell",
  "edit_notebook_cell",
  "run_notebook_sql_cell",
  "run_notebook_code_cell",
  // Discovery: find data sources + tables for SQL cells
  "list_connections",
  "list_databases",
  "list_tables",
  "inspect_table",
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
      "Build and run dbt transformations: edit project files, compile, test, and run models against the warehouse. " +
      "Also manage the project's Git repo and GitHub pull requests: commit, branch, and open/list/update/merge/close PRs.",
    systemPrompt: TRANSFORM_MODE_SYSTEM_PROMPT,
    toolNames: TRANSFORM_MODE_TOOL_NAMES,
    trajectories: [
      "Inspect the source tables for the model",
      "Write the model SQL + schema.yml entries",
      "Verify with dbt_parse, dbt_compile_model, then dbt_run_model on dev",
    ],
  },
  notebook: {
    id: "notebook",
    name: "Notebook",
    routingPrompt:
      "Build data notebooks: add SQL/Python/Markdown cells, run SQL against data sources, and iterate on the analysis.",
    systemPrompt: NOTEBOOK_MODE_SYSTEM_PROMPT,
    toolNames: NOTEBOOK_MODE_TOOL_NAMES,
    trajectories: [
      "Read the notebook and find the data source",
      "Add SQL/Markdown cells for the analysis",
      "Run the SQL cells and refine from the results",
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
  if (tabKind === "notebook") return "notebook";
  if (tabKind === "app-v2" || tabKind === "app-v2-file") return "app";
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

/**
 * Compact name-only inventory groups for the system prompt: every built-in
 * tool name (no schemas), grouped so the model can see what exists without
 * paying for definitions. MCP tools are intentionally omitted — those are
 * discovered via `search_tools` from the server list.
 */
export function builtinToolInventoryGroups(): Array<{
  label: string;
  names: readonly string[];
}> {
  const groups: Array<{ label: string; names: readonly string[] }> = [
    { label: "core (always on)", names: CORE_ALWAYS_TOOL_NAMES },
  ];
  for (const modeId of EXPERTISE_MODE_IDS) {
    const mode = modeRegistry[modeId];
    if (!mode) continue;
    groups.push({
      label: `${modeId} mode (enable_mode("${modeId}"))`,
      names: mode.toolNames,
    });
  }
  if (DEFERRED_BUILTIN_TOOL_NAMES.length > 0) {
    groups.push({
      label: "deferred built-ins (search_tools → load_tools, then call)",
      names: DEFERRED_BUILTIN_TOOL_NAMES,
    });
  }
  return groups;
}
