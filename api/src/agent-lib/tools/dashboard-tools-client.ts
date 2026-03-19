/**
 * Client-Side Dashboard Tools
 *
 * These tools are executed on the client-side via the AI SDK's onToolCall callback.
 * They do NOT have execute functions, which signals to the AI SDK that they
 * should be handled client-side.
 *
 * The client will:
 * 1. Receive the tool call with structured parameters
 * 2. Apply the change to the local dashboard state and DuckDB instance
 * 3. Re-render affected widgets
 * 4. Call addToolOutput to provide the result back to the agent
 */

import { z } from "zod";
import { MakoChartSpecBase } from "./chart-spec-schema";

const addWidgetSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  type: z.enum(["chart", "kpi", "table"]).describe("Widget type"),
  title: z.string().optional().describe("Widget title"),
  dataSourceId: z
    .string()
    .describe("ID of the data source within the dashboard"),
  localSql: z.string().describe("SQL query against the local DuckDB table"),
  vegaLiteSpec: MakoChartSpecBase.optional().describe(
    "Vega-Lite chart spec (for chart type). Do NOT include data property.",
  ),
  kpiConfig: z
    .object({
      valueField: z.string(),
      format: z.string().optional(),
      comparisonField: z.string().optional(),
      comparisonLabel: z.string().optional(),
    })
    .optional()
    .describe("KPI configuration (for kpi type)"),
  tableConfig: z
    .object({
      columns: z.array(z.string()).optional(),
      pageSize: z.number().optional(),
    })
    .optional()
    .describe("Table configuration (for table type)"),
  layout: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .describe("Grid position and size (12-column grid)"),
});

const modifyWidgetSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  widgetId: z.string().describe("Widget ID to modify"),
  title: z.string().optional(),
  localSql: z.string().optional(),
  vegaLiteSpec: MakoChartSpecBase.optional(),
  kpiConfig: z
    .object({
      valueField: z.string(),
      format: z.string().optional(),
      comparisonField: z.string().optional(),
      comparisonLabel: z.string().optional(),
    })
    .optional(),
  tableConfig: z
    .object({
      columns: z.array(z.string()).optional(),
      pageSize: z.number().optional(),
    })
    .optional(),
  layout: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .optional(),
});

const removeWidgetSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  widgetId: z.string().describe("Widget ID to remove"),
});

const getDashboardStateSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
});

const getDataPreviewSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z.string().describe("Data source ID"),
  sql: z
    .string()
    .optional()
    .describe("SQL to run. Defaults to SELECT * LIMIT 10"),
});

const addGlobalFilterSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  type: z.enum(["date-range", "select", "multi-select", "search"]),
  label: z.string(),
  dataSourceId: z.string(),
  column: z.string(),
  defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
});

const removeGlobalFilterSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  filterId: z.string().describe("Filter ID to remove"),
});

const linkTablesSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  from: z.object({
    dataSourceId: z.string(),
    column: z.string(),
  }),
  to: z.object({
    dataSourceId: z.string(),
    column: z.string(),
  }),
  type: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]),
});

const setTimeDimensionSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z.string(),
  column: z
    .string()
    .describe("The datetime column to use as default time dimension"),
});

const suggestChartsSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z.string().describe("Data source to analyze"),
});

const importConsoleAsDataSourceSchema = z.object({
  consoleId: z
    .string()
    .describe("ID of the saved console to import into the dashboard"),
  name: z
    .string()
    .optional()
    .describe("Optional dashboard-local name for the imported data source"),
  timeDimension: z
    .string()
    .optional()
    .describe("Default time column for this data source"),
  rowLimit: z
    .number()
    .optional()
    .describe("Optional row limit for materialization"),
});

const createDataSourceSchema = z.object({
  name: z.string().describe("Dashboard-local data source name"),
  connectionId: z
    .string()
    .describe("Connection ID to execute the query against"),
  language: z
    .enum(["sql", "javascript", "mongodb"])
    .default("sql")
    .describe("Query language"),
  code: z.string().describe("Query text/code to materialize into DuckDB"),
  databaseId: z.string().optional().describe("Optional sub-database ID"),
  databaseName: z.string().optional().describe("Optional database name"),
  timeDimension: z.string().optional().describe("Default time column"),
  rowLimit: z
    .number()
    .optional()
    .describe("Optional row limit for materialization"),
});

const updateDataSourceQuerySchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z.string().describe("Dashboard data source ID"),
  name: z.string().optional().describe("Updated display name"),
  connectionId: z.string().optional().describe("Updated connection ID"),
  language: z
    .enum(["sql", "javascript", "mongodb"])
    .optional()
    .describe("Updated query language"),
  code: z.string().optional().describe("Updated query text/code"),
  databaseId: z.string().optional().describe("Updated sub-database ID"),
  databaseName: z.string().optional().describe("Updated database name"),
  timeDimension: z.string().optional().describe("Updated default time column"),
  rowLimit: z.number().optional().describe("Updated row limit"),
});

const previewDataSourceSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z.string().describe("Dashboard data source ID"),
  sql: z
    .string()
    .optional()
    .describe("Optional SQL to run against the local DuckDB table"),
});

export const clientDashboardTools = {
  import_console_as_data_source: {
    description:
      "Import a saved console into the current dashboard by value. " +
      "This duplicates the console's query definition into a dashboard-local data source and materializes it into DuckDB. " +
      "Use search_consoles first to find the console ID.",
    inputSchema: importConsoleAsDataSourceSchema,
  },
  add_data_source: {
    description:
      "Legacy alias for importing a saved console into the dashboard. Prefer import_console_as_data_source.",
    inputSchema: importConsoleAsDataSourceSchema,
  },
  create_data_source: {
    description:
      "Create a dashboard-local data source directly from a connection and query definition. " +
      "Use this when the user wants to add data without saving a console first.",
    inputSchema: createDataSourceSchema,
  },
  update_data_source_query: {
    description:
      "Modify an existing dashboard-local data source query definition and re-materialize it.",
    inputSchema: updateDataSourceQuerySchema,
  },
  add_widget: {
    description:
      "Add a chart, KPI card, or data table widget to the dashboard. " +
      "The localSql runs against the dashboard-local DuckDB tableRef. " +
      "For chart type, provide a vegaLiteSpec without a data property.",
    inputSchema: addWidgetSchema,
  },
  modify_widget: {
    description:
      "Modify an existing widget. Only include the fields you want to change.",
    inputSchema: modifyWidgetSchema,
  },
  remove_widget: {
    description: "Remove a widget from the dashboard.",
    inputSchema: removeWidgetSchema,
  },
  get_dashboard_state: {
    description:
      "Get the full dashboard specification including all widgets, data sources, and their column schemas.",
    inputSchema: getDashboardStateSchema,
  },
  preview_data_source: {
    description:
      "Run a SQL query against a dashboard-local data source in DuckDB. " +
      "Useful for understanding the loaded data before creating charts.",
    inputSchema: previewDataSourceSchema,
  },
  get_data_preview: {
    description:
      "Legacy alias for preview_data_source. Runs SQL against the loaded DuckDB table.",
    inputSchema: getDataPreviewSchema,
  },
  suggest_charts: {
    description:
      "Analyze the data sources and suggest 3-5 chart configurations. " +
      "Returns suggestions without adding them to the dashboard. " +
      "The user can then choose which ones to add.",
    inputSchema: suggestChartsSchema,
  },
  add_global_filter: {
    description:
      "Add a dashboard-level filter (date range picker, dropdown, multi-select, or search).",
    inputSchema: addGlobalFilterSchema,
  },
  remove_global_filter: {
    description: "Remove a global filter from the dashboard.",
    inputSchema: removeGlobalFilterSchema,
  },
  link_tables: {
    description:
      "Define a relationship between two data sources for cross-filtering.",
    inputSchema: linkTablesSchema,
  },
  set_time_dimension: {
    description: "Set the default time column for a data source.",
    inputSchema: setTimeDimensionSchema,
  },
};
