/**
 * Read-only tool classification — single source of truth.
 *
 * Both the API (plan-mode hard gate in `prepareStep`) and the app (tool UI /
 * mode badges) import this set so the gate and the UI can never disagree about
 * which tools are safe to run before a plan is approved.
 *
 * A tool is "read-only" when calling it cannot mutate workspace artifacts
 * (consoles, dashboards, flows, data sources), persisted memory, or remote
 * data. Discovery, inspection, search, validation, and explanation tools are
 * read-only. Anything that executes a query, creates/modifies/removes an
 * artifact, writes memory, or sets form fields is considered mutating.
 *
 * NOTE: `*_execute_query` and `run_*` are intentionally treated as mutating —
 * a raw query can contain writes (INSERT/UPDATE/DELETE/DDL) and we cannot
 * statically guarantee otherwise, so plan mode blocks them until approval.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  // Cross-surface discovery
  "list_connections",
  // SQL discovery / inspection
  "sql_list_connections",
  "sql_list_databases",
  "sql_list_tables",
  "sql_inspect_table",
  // MongoDB discovery / inspection
  "mongo_list_connections",
  "mongo_list_databases",
  "mongo_list_collections",
  "mongo_inspect_collection",
  // Flow discovery / inspection (shared agent-lib builders)
  "list_databases",
  "list_tables",
  "inspect_table",
  // Console reads
  "read_console",
  "list_open_consoles",
  // Dashboard reads / previews
  "list_open_dashboards",
  "get_dashboard_state",
  "get_chart_templates",
  "get_chart_template",
  // App reads
  "list_open_apps",
  "get_app_state",
  "app_search",
  "app_read_resource",
  "app_get_data_binding",
  "app_read_file",
  // Notebook reads
  "list_open_notebooks",
  "read_notebook",
  "search_notebook",
  "read_notebook_cell",
  // dbt reads + verification (parse/compile/show/get_run never mutate the
  // warehouse; show runs a bounded SELECT, get_run reads run history)
  "read_dbt_project_tree",
  "read_dbt_file",
  "dbt_parse",
  "dbt_compile_model",
  "dbt_get_run",
  "dbt_show",
  // dbt git reads (status + branch listing/compare never mutate the repo)
  "dbt_git_status",
  "dbt_list_branches",
  "dbt_compare_branches",
  "dbt_list_recoverable_files",
  // Surface-scoped data-source reads (apps + dashboards, local DuckDB only)
  "list_data_sources",
  "inspect_data_source",
  "query_duckdb",
  // Visual inspection (no mutation)
  "capture_screenshot",
  // Search
  "search_consoles",
  "search_dashboards",
  "search_skills",
  "search_tools",
  "list_skills",
  "get_relevant_skills",
  "fetch_url",
  "web_search",
  // Memory reads
  "read_self_directive",
  "load_skill",
  "read_skill_resource",
  // Version history reads
  "browse_version_history",
  "get_version_snapshot",
  // Flow form reads + query validation/explanation (read-only by design)
  "get_form_state",
  "list_flow_tabs",
  "validate_query",
  "explain_template",
]);

/**
 * Core lifecycle tools that stay allowed while a submitted plan awaits the
 * user's approval, so the model can clarify, revise the plan, switch
 * expertise modes, and track todos while the mutation gate is closed.
 */
export const PLAN_GATE_ALLOWED_TOOL_NAMES: ReadonlySet<string> =
  new Set<string>([
    "enable_mode",
    "todo_write",
    "ask_clarifying_questions",
    "submit_plan",
    // Tool discovery stays available while the gate is closed: finding and
    // loading a tool mutates nothing (loaded write-tools are still gated).
    "search_tools",
    "load_tools",
  ]);

export function isReadOnlyToolName(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName);
}
