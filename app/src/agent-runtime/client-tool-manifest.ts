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
  | "help-circle";

export type AgentToolDomain =
  | "console"
  | "chart"
  | "dashboard"
  | "flow"
  | "search"
  | "memory"
  | "database";

export type ClientToolExecutor = "console" | "dashboard" | "flow";

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
  modify_console: {
    domain: "console",
    execution: "client",
    clientExecutor: "console",
    getLabel: input => {
      const action = (input as Record<string, unknown>)?.action;
      return action === "patch" ? "Patching console" : "Editing console";
    },
    icon: "pencil",
    preview: { field: "content", language: "sql" },
  },
  create_console: {
    domain: "console",
    execution: "client",
    clientExecutor: "console",
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating "${title}"` : "Creating console";
    },
    icon: "plus",
    preview: { field: "content", language: "sql" },
  },
  read_console: {
    domain: "console",
    execution: "client",
    clientExecutor: "console",
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
    execution: "client",
    clientExecutor: "console",
    getLabel: () => "Setting connection",
    icon: "link",
  },
  open_console: {
    domain: "console",
    execution: "client",
    clientExecutor: "console",
    longRunning: true,
    getLabel: () => "Opening console",
    icon: "external-link",
  },
  run_console: {
    domain: "console",
    execution: "client",
    clientExecutor: "console",
    longRunning: true,
    getLabel: () => "Executing console query",
    icon: "play",
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
  preview_data_source: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Previewing data",
    icon: "eye",
    preview: { field: "sql", language: "sql" },
  },
  get_data_preview: {
    domain: "dashboard",
    execution: "client",
    clientExecutor: "dashboard",
    longRunning: true,
    getLabel: () => "Previewing data",
    icon: "eye",
    preview: { field: "sql", language: "sql" },
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
  search_consoles: {
    domain: "search",
    execution: "server",
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching "${query}"` : "Searching consoles";
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
} as const satisfies Record<string, AgentToolManifestEntry>;

export type AgentToolName = keyof typeof AGENT_TOOL_MANIFEST;

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

export const LONG_RUNNING_DASHBOARD_TOOL_NAMES = createToolNameSet(
  entry =>
    entry.execution === "client" &&
    entry.clientExecutor === "dashboard" &&
    entry.longRunning === true,
);

export function getAgentToolManifestEntry(
  toolName: string,
): AgentToolManifestEntry | undefined {
  return AGENT_TOOL_MANIFEST[toolName as AgentToolName];
}
