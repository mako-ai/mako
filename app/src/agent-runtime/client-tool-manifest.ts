import type { MakoUITools } from "@mako/agent-tools";

export type ToolIconKey =
  | "pencil"
  | "plus"
  | "eye"
  | "list"
  | "link"
  | "external-link"
  | "play"
  | "database"
  | "table"
  | "search"
  | "bar-chart"
  | "download"
  | "trash"
  | "filter"
  | "clock"
  | "brain"
  | "shield-check"
  | "square"
  | "help-circle";

export type AgentToolDomain =
  | "console"
  | "chart"
  | "dashboard"
  | "flow"
  | "app"
  | "dbt"
  | "search"
  | "memory"
  | "database"
  | "notebook"
  | "plan";

export type ClientToolExecutor =
  | "console"
  | "dashboard"
  | "flow"
  | "app"
  | "dbt"
  | "data"
  | "notebook";

export interface ToolUiConfig {
  getLabel: (input?: unknown) => string;
  icon: ToolIconKey;
  preview?: { field: string; language: string };
}

export interface AgentToolManifestEntry extends ToolUiConfig {
  domain: AgentToolDomain;
  execution: "client" | "server";
  clientExecutor?: ClientToolExecutor;
  longRunning?: boolean;
}

export const AGENT_TOOL_MANIFEST = {
  // Console data tools execute SERVER-SIDE against the authoritative draft
  // since issue #475 (open windows follow along via the realtime channel).
  // Entries are kept for tool-card labels/icons/previews.
  modify_console: {
    domain: "console",
    execution: "server",
    getLabel: input => {
      const action = (input as Record<string, unknown>)?.action;
      return action === "patch" ? "Patching console" : "Editing console";
    },
    icon: "pencil",
    preview: { field: "content", language: "sql" },
  },
  create_console: {
    domain: "console",
    execution: "server",
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating "${title}"` : "Creating console";
    },
    icon: "plus",
    preview: { field: "content", language: "sql" },
  },
  read_console: {
    domain: "console",
    execution: "server",
    getLabel: () => "Reading console",
    icon: "eye",
  },
  list_open_consoles: {
    domain: "console",
    execution: "client",
    clientExecutor: "console",
    getLabel: () => "Listing open consoles",
    icon: "list",
  },
  set_console_connection: {
    domain: "console",
    execution: "server",
    getLabel: () => "Setting connection",
    icon: "link",
  },
  open_console: {
    domain: "console",
    execution: "server",
    getLabel: () => "Opening console",
    icon: "external-link",
  },
  run_console: {
    domain: "console",
    execution: "server",
    getLabel: () => "Executing console query",
    icon: "play",
  },
  list_console_executions: {
    domain: "console",
    execution: "server",
    getLabel: () => "Listing console executions",
    icon: "list",
  },
  sql_execute_query: {
    domain: "database",
    execution: "server",
    getLabel: () => "Executing SQL query",
    icon: "play",
    preview: { field: "query", language: "sql" },
  },
  sql_list_connections: {
    domain: "database",
    execution: "server",
    getLabel: () => "Listing SQL connections",
    icon: "database",
  },
  sql_list_databases: {
    domain: "database",
    execution: "server",
    getLabel: () => "Listing databases",
    icon: "database",
  },
  sql_list_tables: {
    domain: "database",
    execution: "server",
    getLabel: input => {
      const db = (input as Record<string, unknown>)?.database;
      return db ? `Listing tables in ${db}` : "Listing tables";
    },
    icon: "table",
  },
  sql_inspect_table: {
    domain: "database",
    execution: "server",
    getLabel: input => {
      const table = (input as Record<string, unknown>)?.table;
      return table ? `Inspecting ${table}` : "Inspecting table";
    },
    icon: "search",
  },
  mongo_execute_query: {
    domain: "database",
    execution: "server",
    getLabel: () => "Executing MongoDB query",
    icon: "play",
    preview: { field: "query", language: "javascript" },
  },
  mongo_list_connections: {
    domain: "database",
    execution: "server",
    getLabel: () => "Listing MongoDB connections",
    icon: "database",
  },
  mongo_list_databases: {
    domain: "database",
    execution: "server",
    getLabel: () => "Listing databases",
    icon: "database",
  },
  mongo_list_collections: {
    domain: "database",
    execution: "server",
    getLabel: input => {
      const db = (input as Record<string, unknown>)?.databaseName;
      return db ? `Listing collections in ${db}` : "Listing collections";
    },
    icon: "table",
  },
  mongo_inspect_collection: {
    domain: "database",
    execution: "server",
    getLabel: input => {
      const coll = (input as Record<string, unknown>)?.collectionName;
      return coll ? `Inspecting ${coll}` : "Inspecting collection";
    },
    icon: "search",
  },
  list_connections: {
    domain: "database",
    execution: "server",
    getLabel: () => "Listing connections",
    icon: "database",
  },
  modify_chart_spec: {
    domain: "chart",
    execution: "client",
    clientExecutor: "console",
    longRunning: true,
    getLabel: () => "Setting chart specification",
    icon: "bar-chart",
    preview: { field: "vegaLiteSpec", language: "json" },
  },
  list_open_dashboards: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Listing open dashboards",
    icon: "list",
  },
  search_dashboards: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query
        ? `Searching dashboards: "${query}"`
        : "Searching dashboards";
    },
    icon: "search",
  },
  open_dashboard: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Opening dashboard",
    icon: "external-link",
  },
  create_dashboard: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating dashboard "${title}"` : "Creating dashboard";
    },
    icon: "plus",
  },
  enter_edit_mode: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Entering edit mode",
    icon: "pencil",
  },
  add_widget: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const type = (input as Record<string, unknown>)?.type;
      return type ? `Adding ${type} widget` : "Adding widget";
    },
    icon: "plus",
    preview: { field: "localSql", language: "sql" },
  },
  modify_widget: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Modifying widget",
    icon: "pencil",
    preview: { field: "localSql", language: "sql" },
  },
  remove_widget: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Removing widget",
    icon: "trash",
  },
  create_data_source: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Creating data source "${name}"` : "Creating data source";
    },
    icon: "plus",
    preview: { field: "code", language: "sql" },
  },
  update_data_source_query: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const inp = input as Record<string, unknown>;
      const action = inp?.action;
      const run = inp?.run === true;
      const suffix = run ? "" : " (definition only)";
      if (action === "patch") return `Patching data source query${suffix}`;
      if (action === "append") return `Appending to data source query${suffix}`;
      return `Updating data source query${suffix}`;
    },
    icon: "pencil",
    preview: { field: "code", language: "sql" },
  },
  run_data_source_query: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Running data source query",
    icon: "play",
  },
  import_console_as_data_source: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Importing console as data source",
    icon: "download",
  },
  add_data_source: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Importing data source",
    icon: "download",
  },
  get_dashboard_state: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Reading dashboard state",
    icon: "eye",
  },
  capture_screenshot: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const target = (input as Record<string, unknown>)?.target;
      return target
        ? `Capturing screenshot (${target})`
        : "Capturing screenshot";
    },
    icon: "eye",
  },
  add_global_filter: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: input => {
      const label = (input as Record<string, unknown>)?.label;
      return label ? `Adding filter "${label}"` : "Adding filter";
    },
    icon: "filter",
  },
  remove_global_filter: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Removing filter",
    icon: "trash",
  },
  link_tables: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Linking tables",
    icon: "link",
  },
  set_time_dimension: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Setting time dimension",
    icon: "clock",
  },
  get_chart_templates: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Listing chart templates",
    icon: "list",
  },
  get_chart_template: {
    domain: "chart",
    execution: "client",
    clientExecutor: "dashboard",
    getLabel: () => "Reading chart template",
    icon: "eye",
  },
  dashboard_save_version: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const comment = (input as Record<string, unknown>)?.comment;
      return comment
        ? `Publishing version: "${comment}"`
        : "Publishing dashboard version";
    },
    icon: "clock",
  },
  dashboard_restore_version: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: input => {
      const version = (input as Record<string, unknown>)?.version;
      return version
        ? `Restoring version ${version}`
        : "Restoring dashboard version";
    },
    icon: "clock",
  },
  // Full-server apps: list/create/read/inspect/materialize execute SERVER-SIDE
  // (see api/src/agent-lib/tools/server-app-tools.ts). Entries kept for tool-card
  // labels/icons. Only open_app and run_app remain browser-executed.
  list_open_apps: {
    domain: "app",
    execution: "server",
    getLabel: () => "Listing apps",
    icon: "list",
  },
  open_app: {
    domain: "app",
    execution: "client",
    clientExecutor: "app",
    longRunning: true,
    getLabel: () => "Opening app",
    icon: "external-link",
  },
  create_app: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating app "${title}"` : "Creating app";
    },
    icon: "plus",
  },
  get_app_state: {
    domain: "app",
    execution: "server",
    getLabel: () => "Reading app state",
    icon: "eye",
  },
  app_search: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching app for "${query}"` : "Searching app";
    },
    icon: "search",
  },
  app_read_resource: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const resource = (input as Record<string, unknown>)?.resource;
      return resource ? `Reading ${resource}` : "Reading app resource";
    },
    icon: "eye",
  },
  app_read_file: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Reading ${path}` : "Reading file";
    },
    icon: "eye",
  },
  // App mutation tools execute SERVER-SIDE (issue #475 pattern; see
  // api/src/agent-lib/tools/server-app-tools.ts). Open tabs follow along via
  // the realtime channel (app.updated). Entries kept for tool-card UI.
  app_write_file: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Writing ${path}` : "Writing file";
    },
    icon: "pencil",
    preview: { field: "contents", language: "typescript" },
  },
  app_edit_file: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Editing ${path}` : "Editing file";
    },
    icon: "pencil",
    preview: { field: "newString", language: "typescript" },
  },
  app_delete_file: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Deleting ${path}` : "Deleting file";
    },
    icon: "trash",
  },
  app_rename_file: {
    domain: "app",
    execution: "server",
    getLabel: () => "Renaming file",
    icon: "pencil",
  },
  app_add_dependency: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Adding dependency ${name}` : "Adding dependency";
    },
    icon: "plus",
  },
  app_remove_dependency: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Removing dependency ${name}` : "Removing dependency";
    },
    icon: "trash",
  },
  app_create_data_binding: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Binding data "${name}"` : "Creating data binding";
    },
    icon: "database",
    preview: { field: "code", language: "sql" },
  },
  app_update_data_binding: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const inp = input as Record<string, unknown>;
      const name = inp?.name;
      if (name && inp?.materialization) {
        return `Switching "${name}" to ${inp.materialization}`;
      }
      if (name && inp?.materializationSchedule) {
        return `Updating refresh schedule for "${name}"`;
      }
      return name ? `Updating data binding "${name}"` : "Updating data binding";
    },
    icon: "database",
    preview: { field: "code", language: "sql" },
  },
  app_delete_data_binding: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Deleting data binding "${name}"` : "Deleting data binding";
    },
    icon: "trash",
  },
  app_set_binding_materialization: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const inp = input as Record<string, unknown>;
      const name = inp?.name;
      const mode = inp?.materialization;
      if (name && mode) return `Switching "${name}" to ${mode}`;
      return "Switching materialization";
    },
    icon: "database",
  },
  app_save_version: {
    domain: "app",
    execution: "server",
    getLabel: input => {
      const comment = (input as Record<string, unknown>)?.comment;
      return comment ? `Saving version: "${comment}"` : "Saving app version";
    },
    icon: "clock",
  },
  app_restore_version: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const version = (input as Record<string, unknown>)?.version;
      return version ? `Restoring version ${version}` : "Restoring app version";
    },
    icon: "clock",
  },
  materialize_binding: {
    domain: "app",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Materializing "${name}"` : "Materializing binding";
    },
    icon: "database",
  },
  list_data_sources: {
    domain: "database",
    execution: "client",
    clientExecutor: "data",
    getLabel: () => "Listing data sources",
    icon: "list",
  },
  inspect_data_source: {
    domain: "database",
    execution: "client",
    clientExecutor: "data",
    longRunning: true,
    getLabel: input => {
      const ds = (input as Record<string, unknown>)?.dataSource;
      return ds ? `Inspecting "${ds}"` : "Inspecting data source";
    },
    icon: "search",
  },
  query_duckdb: {
    domain: "database",
    execution: "client",
    clientExecutor: "data",
    longRunning: true,
    getLabel: () => "Running DuckDB query",
    icon: "play",
    preview: { field: "sql", language: "sql" },
  },
  run_app: {
    domain: "app",
    execution: "client",
    clientExecutor: "app",
    longRunning: true,
    getLabel: input =>
      (input as { rebuild?: boolean } | undefined)?.rebuild === false
        ? "Checking preview errors"
        : "Rebuilding app preview",
    icon: "play",
  },
  // Legacy alias from pre-0.3 Local Agent builds — run_app({ rebuild: false }).
  get_preview_errors: {
    domain: "app",
    execution: "client",
    clientExecutor: "app",
    getLabel: () => "Checking preview errors",
    icon: "eye",
  },
  app_set_preview_environment: {
    domain: "app",
    execution: "client",
    clientExecutor: "app",
    longRunning: true,
    getLabel: input => {
      const env = (input as Record<string, unknown>)?.environment;
      return env
        ? `Previewing dbt env "${env}"`
        : "Resetting preview dbt env to prod";
    },
    icon: "database",
  },
  app_set_preview_viewport: {
    domain: "app",
    execution: "client",
    clientExecutor: "app",
    getLabel: input => {
      const { preset, width, height } = (input ?? {}) as {
        preset?: string;
        width?: number;
        height?: number;
      };
      if (width && height) return `Preview viewport ${width}×${height}`;
      return preset && preset !== "desktop"
        ? `Preview viewport: ${preset}`
        : "Preview viewport: desktop";
    },
    icon: "eye",
  },
  // dbt reads execute SERVER-SIDE (issue #475) — reading the authoritative
  // DbtProject/DbtFile docs avoids a pending client tool tearing down the SSE
  // turn ("stream disconnected before tool completed") when the tab is slow or
  // detached. See api/src/agent-lib/tools/dbt-tools.ts.
  read_dbt_project_tree: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Reading dbt project tree",
    icon: "list",
  },
  read_dbt_file: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Reading ${path}` : "Reading dbt file";
    },
    icon: "eye",
  },
  // dbt file mutation tools execute SERVER-SIDE (issue #475 pattern; see
  // createDbtServerTools in api/src/agent-lib/tools/dbt-tools.ts). Open editor
  // tabs follow along via the realtime channel (dbt.file.updated).
  create_dbt_file: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Creating ${path}` : "Creating dbt file";
    },
    icon: "plus",
    preview: { field: "contents", language: "sql" },
  },
  modify_dbt_file: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Rewriting ${path}` : "Rewriting dbt file";
    },
    icon: "pencil",
    preview: { field: "contents", language: "sql" },
  },
  edit_dbt_file: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Editing ${path}` : "Editing dbt file";
    },
    icon: "pencil",
    preview: { field: "newString", language: "sql" },
  },
  delete_dbt_file: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Deleting ${path}` : "Deleting dbt file";
    },
    icon: "trash",
  },
  dbt_parse: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: () => "Validating dbt project",
    icon: "shield-check",
  },
  dbt_compile_model: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const model = (input as Record<string, unknown>)?.model;
      return model ? `Compiling ${model}` : "Compiling model";
    },
    icon: "shield-check",
  },
  dbt_run_model: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const model = (input as Record<string, unknown>)?.model;
      return model ? `Building ${model}` : "Building model";
    },
    icon: "play",
  },
  dbt_run_job: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const jobName = (input as Record<string, unknown>)?.jobName;
      return jobName ? `Running job "${jobName}"` : "Running dbt job";
    },
    icon: "play",
  },
  // dbt_get_run polls the runner for a run's status. Without an explicit entry
  // it fell back to humanizeToolName ("Dbt Get Run"), which is what surfaced in
  // the agent transcript after a build. Give it a human label + a clock icon.
  dbt_get_run: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Checking dbt run status",
    icon: "clock",
  },
  dbt_show: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const model = (input as Record<string, unknown>)?.model;
      return model ? `Previewing ${model}` : "Previewing model";
    },
    icon: "eye",
  },
  dbt_create_project: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Creating dbt project "${name}"` : "Creating dbt project";
    },
    icon: "plus",
  },
  dbt_cancel_run: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Cancelling dbt run",
    icon: "square",
  },
  dbt_ensure_dev_environment: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Provisioning personal dbt environment",
    icon: "database",
  },
  dbt_create_job: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Creating job "${name}"` : "Creating dbt job";
    },
    icon: "plus",
  },
  dbt_update_job: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Updating job "${name}"` : "Updating dbt job";
    },
    icon: "pencil",
  },
  dbt_delete_job: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Deleting dbt job",
    icon: "trash",
  },
  dbt_sync_from_repo: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: () => "Syncing from repo",
    icon: "download",
  },
  dbt_list_recoverable_files: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Listing recoverable files",
    icon: "list",
  },
  dbt_restore_file: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const path = (input as Record<string, unknown>)?.path;
      return path ? `Restoring ${path}` : "Restoring file";
    },
    icon: "plus",
  },
  dbt_git_status: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Checking git status",
    icon: "eye",
  },
  dbt_commit_and_push: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const paths = (input as Record<string, unknown>)?.paths;
      return Array.isArray(paths) && paths.length > 0
        ? `Committing ${paths.length} file${paths.length === 1 ? "" : "s"} & pushing`
        : "Committing & pushing";
    },
    icon: "external-link",
  },
  dbt_commit_to_branch: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      const paths = (input as Record<string, unknown>)?.paths;
      const count =
        Array.isArray(paths) && paths.length > 0 ? paths.length : null;
      if (name && count) {
        return `Committing ${count} file${count === 1 ? "" : "s"} to ${name}`;
      }
      return name ? `Committing to ${name}` : "Committing to new branch";
    },
    icon: "external-link",
  },
  dbt_create_branch: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Creating branch ${name}` : "Creating branch";
    },
    icon: "plus",
  },
  dbt_switch_branch: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const branch = (input as Record<string, unknown>)?.branch;
      return branch ? `Switching to ${branch}` : "Switching branch";
    },
    icon: "link",
  },
  dbt_list_branches: {
    domain: "dbt",
    execution: "server",
    getLabel: () => "Listing branches",
    icon: "list",
  },
  dbt_compare_branches: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const params = input as Record<string, unknown> | undefined;
      const head = params?.head;
      const base = params?.base;
      if (head && base) return `Comparing ${head} against ${base}`;
      if (head) return `Comparing ${head} against the default branch`;
      return "Comparing branches";
    },
    icon: "eye",
  },
  dbt_delete_branch: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Deleting branch ${name}` : "Deleting branch";
    },
    icon: "trash",
  },
  dbt_open_pull_request: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Opening PR: ${title}` : "Opening pull request";
    },
    icon: "external-link",
  },
  dbt_merge_pull_request: {
    domain: "dbt",
    execution: "server",
    longRunning: true,
    getLabel: input => {
      const prNumber = (input as Record<string, unknown>)?.prNumber;
      return prNumber ? `Merging PR #${prNumber}` : "Merging pull request";
    },
    icon: "external-link",
  },
  dbt_list_pull_requests: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const state = (input as Record<string, unknown>)?.state;
      return state && state !== "open"
        ? `Listing ${state} pull requests`
        : "Listing pull requests";
    },
    icon: "list",
  },
  dbt_update_pull_request: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const prNumber = (input as Record<string, unknown>)?.prNumber;
      return prNumber ? `Updating PR #${prNumber}` : "Updating pull request";
    },
    icon: "external-link",
  },
  dbt_close_pull_request: {
    domain: "dbt",
    execution: "server",
    getLabel: input => {
      const prNumber = (input as Record<string, unknown>)?.prNumber;
      return prNumber ? `Closing PR #${prNumber}` : "Closing pull request";
    },
    icon: "external-link",
  },
  search_consoles: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching "${query}"` : "Searching consoles";
    },
    icon: "search",
  },
  fetch_url: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const url = (input as Record<string, unknown>)?.url;
      if (typeof url === "string" && url.length > 0) {
        const display = url.length > 48 ? `${url.slice(0, 45)}…` : url;
        return `Fetching ${display}`;
      }
      return "Fetching URL";
    },
    icon: "external-link",
  },
  web_search: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching web: "${query}"` : "Searching the web";
    },
    icon: "search",
  },
  read_self_directive: {
    domain: "memory",
    execution: "server",
    getLabel: () => "Reading memory",
    icon: "brain",
  },
  update_self_directive: {
    domain: "memory",
    execution: "server",
    getLabel: () => "Updating memory",
    icon: "brain",
  },
  save_skill: {
    domain: "memory",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Saving skill "${name}"` : "Saving skill";
    },
    icon: "brain",
  },
  delete_skill: {
    domain: "memory",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Deleting skill "${name}"` : "Deleting skill";
    },
    icon: "trash",
  },
  load_skill: {
    domain: "memory",
    execution: "server",
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Loading skill "${name}"` : "Loading skill";
    },
    icon: "brain",
  },
  search_skills: {
    domain: "memory",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching skills: "${query}"` : "Searching skills";
    },
    icon: "search",
  },
  get_form_state: {
    domain: "flow",
    execution: "client",
    clientExecutor: "flow",
    getLabel: () => "Reading form state",
    icon: "eye",
  },
  set_form_field: {
    domain: "flow",
    execution: "client",
    clientExecutor: "flow",
    getLabel: input => {
      const field = (input as Record<string, unknown>)?.fieldName;
      return field ? `Setting ${field}` : "Setting form field";
    },
    icon: "pencil",
  },
  set_multiple_fields: {
    domain: "flow",
    execution: "client",
    clientExecutor: "flow",
    getLabel: input => {
      const fields = (input as Record<string, unknown>)?.fields;
      const count =
        fields && typeof fields === "object" ? Object.keys(fields).length : 0;
      return count > 0 ? `Setting ${count} fields` : "Setting form fields";
    },
    icon: "pencil",
  },
  create_flow_tab: {
    domain: "flow",
    execution: "client",
    clientExecutor: "flow",
    getLabel: () => "Creating flow tab",
    icon: "plus",
  },
  list_flow_tabs: {
    domain: "flow",
    execution: "client",
    clientExecutor: "flow",
    getLabel: () => "Listing flow tabs",
    icon: "list",
  },
  list_databases: {
    domain: "flow",
    execution: "server",
    getLabel: () => "Listing databases",
    icon: "database",
  },
  list_tables: {
    domain: "flow",
    execution: "server",
    getLabel: () => "Listing tables",
    icon: "table",
  },
  inspect_table: {
    domain: "flow",
    execution: "server",
    getLabel: input => {
      const table = (input as Record<string, unknown>)?.table;
      return table ? `Inspecting ${table}` : "Inspecting table";
    },
    icon: "search",
  },
  execute_query: {
    domain: "flow",
    execution: "server",
    getLabel: () => "Executing query",
    icon: "play",
    preview: { field: "query", language: "sql" },
  },
  validate_query: {
    domain: "flow",
    execution: "server",
    getLabel: () => "Validating query",
    icon: "shield-check",
    preview: { field: "query", language: "sql" },
  },
  explain_template: {
    domain: "flow",
    execution: "server",
    getLabel: input => {
      const placeholder = (input as Record<string, unknown>)?.placeholder;
      return placeholder
        ? `Explaining {{${placeholder}}}`
        : "Explaining template";
    },
    icon: "help-circle",
  },
  enable_mode: {
    domain: "plan",
    execution: "server",
    getLabel: input => {
      const mode = (input as Record<string, unknown>)?.mode;
      return mode ? `Switching to ${mode} mode` : "Switching mode";
    },
    icon: "filter",
  },
  todo_write: {
    domain: "plan",
    execution: "server",
    getLabel: () => "Updating todos",
    icon: "list",
  },
  ask_clarifying_questions: {
    domain: "plan",
    execution: "client",
    getLabel: () => "Asking clarifying questions",
    icon: "help-circle",
  },
  // Tool discovery meta-tools (deferred-tool working set; see
  // api/src/agent-lib/tools/tool-discovery-tools.ts).
  search_tools: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching tools: ${query}` : "Searching tools";
    },
    icon: "search",
  },
  load_tools: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const names = (input as Record<string, unknown>)?.names;
      return Array.isArray(names) && names.length > 0
        ? `Loading ${names.length} tool${names.length === 1 ? "" : "s"}`
        : "Loading tools";
    },
    icon: "download",
  },
  submit_plan: {
    domain: "plan",
    execution: "client",
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Plan: ${title}` : "Submitting plan";
    },
    icon: "shield-check",
  },
  // Notebook tools execute SERVER-SIDE (Phase A durable runs; see
  // api/src/agent-lib/tools/server-notebook-tools.ts). They mutate the durable
  // GCS notebook + kernel and poke open tabs over the realtime channel
  // (notebook.updated), so a run survives the tab closing — and the browser
  // must NOT also run them, or every call would happen twice (two notebooks per
  // create_notebook). Entries kept only for the tool-card UI.
  create_notebook: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Creating notebook",
    icon: "plus",
  },
  list_open_notebooks: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Listing notebooks",
    icon: "list",
  },
  read_notebook: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Inspecting notebook",
    icon: "eye",
  },
  search_notebook: {
    domain: "notebook",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return typeof query === "string" && query
        ? `Searching notebook: ${query}`
        : "Searching notebook";
    },
    icon: "search",
  },
  read_notebook_cell: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Reading notebook cell",
    icon: "eye",
  },
  add_notebook_cell: {
    domain: "notebook",
    execution: "server",
    getLabel: input => {
      const type = (input as Record<string, unknown>)?.type;
      return `Adding ${typeof type === "string" ? type : ""} cell`.replace(
        "  ",
        " ",
      );
    },
    icon: "plus",
    preview: { field: "source", language: "sql" },
  },
  edit_notebook_cell: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Editing cell",
    icon: "pencil",
    preview: { field: "source", language: "sql" },
  },
  delete_notebook_cell: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Deleting cell",
    icon: "trash",
  },
  run_notebook_sql_cell: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Running SQL cell",
    icon: "play",
  },
  run_notebook_code_cell: {
    domain: "notebook",
    execution: "server",
    getLabel: () => "Running Python cell",
    icon: "play",
  },
} as const satisfies Record<string, AgentToolManifestEntry>;

export type AgentToolName = keyof typeof AGENT_TOOL_MANIFEST;

/** Names of the client-side agent tools, inferred from @mako/agent-tools. */
export type ClientAgentToolName = keyof MakoUITools;

/**
 * Compile-time drift guard. Every client-side tool defined in the shared
 * `@mako/agent-tools` package must have a manifest entry here, since this
 * manifest drives the chat tool cards and the `onToolCall` client dispatch.
 * If a client tool is added to the package without a manifest entry, the
 * `Assert<...>` below fails to satisfy its `extends true` constraint and the
 * build breaks until the entry is added. (The companion unit test checks the
 * reverse direction — that manifest client entries match the tool schemas.)
 */
type Assert<T extends true> = T;
export type _AssertManifestCoversClientTools = Assert<
  ClientAgentToolName extends AgentToolName ? true : false
>;

function createToolNameSet(
  predicate: (entry: AgentToolManifestEntry) => boolean,
): Set<AgentToolName> {
  return new Set(
    (
      Object.entries(AGENT_TOOL_MANIFEST) as Array<
        [AgentToolName, AgentToolManifestEntry]
      >
    )
      .filter(([, entry]) => predicate(entry))
      .map(([toolName]) => toolName),
  );
}

export const DASHBOARD_EXECUTOR_TOOL_NAMES = createToolNameSet(
  entry => entry.execution === "client" && entry.clientExecutor === "dashboard",
);

export const CONSOLE_EXECUTOR_TOOL_NAMES = createToolNameSet(
  entry => entry.execution === "client" && entry.clientExecutor === "console",
);

export const APP_EXECUTOR_TOOL_NAMES = createToolNameSet(
  entry => entry.execution === "client" && entry.clientExecutor === "app",
);

export const DBT_EXECUTOR_TOOL_NAMES = createToolNameSet(
  entry => entry.execution === "client" && entry.clientExecutor === "dbt",
);

export const DATA_SOURCE_EXECUTOR_TOOL_NAMES = createToolNameSet(
  entry => entry.execution === "client" && entry.clientExecutor === "data",
);

export const NOTEBOOK_EXECUTOR_TOOL_NAMES = createToolNameSet(
  entry => entry.execution === "client" && entry.clientExecutor === "notebook",
);

export const LONG_RUNNING_DASHBOARD_TOOL_NAMES = createToolNameSet(
  entry =>
    entry.execution === "client" &&
    entry.clientExecutor === "dashboard" &&
    entry.longRunning === true,
);

/**
 * Claude Code / Codex ACP often emit PascalCase built-in names (`ToolSearch`)
 * that are not Mako tools. Alias them onto the closest native card so icons
 * and labels stay consistent with in-app Chat.
 */
const ACP_TOOL_MANIFEST_ALIASES: Record<string, AgentToolName> = {
  ToolSearch: "search_tools",
  tool_search: "search_tools",
  WebSearch: "web_search",
  web_search: "web_search",
};

function toSnakeToolId(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}

export function getAgentToolManifestEntry(
  toolName: string,
): AgentToolManifestEntry | undefined {
  const direct = AGENT_TOOL_MANIFEST[toolName as AgentToolName];
  if (direct) return direct;

  const aliased = ACP_TOOL_MANIFEST_ALIASES[toolName];
  if (aliased) return AGENT_TOOL_MANIFEST[aliased];

  const snake = toSnakeToolId(toolName);
  if (snake && snake !== toolName) {
    const viaSnake = AGENT_TOOL_MANIFEST[snake as AgentToolName];
    if (viaSnake) return viaSnake;
    const aliasViaSnake = ACP_TOOL_MANIFEST_ALIASES[snake];
    if (aliasViaSnake) return AGENT_TOOL_MANIFEST[aliasViaSnake];
  }

  return undefined;
}
