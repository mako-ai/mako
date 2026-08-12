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

import { tool } from "ai";
import { z } from "zod";
import { bindingMaterializationScheduleSchema } from "./app-tools";
import { clientScreenshotTools } from "./screenshot-tools";

// A loose record instead of the full ~98 KB Vega-Lite JSON Schema. The model
// already knows Vega-Lite; we describe only the Mako-specific constraints and
// rely on the client-side `MakoChartSpec` schema + `validateVegaSpec` render
// check (app/src/dashboard-runtime/validation.ts) to validate and feed errors
// back for self-correction.
const vegaLiteSpecField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Vega-Lite spec for chart widgets. Omit the `data` property — the widget binds to the local DuckDB table. " +
      "If the spec is invalid or fails to render, the tool returns the error/hint so you can fix it with modify_widget.",
  );

const saveDashboardVersionSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID (from list_open_dashboards)"),
  comment: z
    .string()
    .optional()
    .describe(
      "Short message describing this version, e.g. 'Add revenue KPI'. Shown in " +
        "the version history list.",
    ),
});

const restoreDashboardVersionSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID (from list_open_dashboards)"),
  version: z
    .number()
    .describe(
      "Version number to restore (from browse_version_history). The current " +
        "state is preserved as a new version first, so restoring is never lossy.",
    ),
  comment: z
    .string()
    .optional()
    .describe("Optional note explaining why this version was restored."),
});

const addWidgetSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  type: z.enum(["chart", "kpi", "table"]).describe("Widget type"),
  title: z.string().optional().describe("Widget title"),
  dataSourceId: z
    .string()
    .describe("ID of the data source within the dashboard"),
  localSql: z.string().describe("SQL query against the local DuckDB table"),
  vegaLiteSpec: vegaLiteSpecField,
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
  layouts: z
    .object({
      lg: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      }),
    })
    .describe(
      "Grid position and size per breakpoint (12-column grid). Provide at least lg.",
    ),
});

const modifyWidgetSchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  widgetId: z.string().describe("Widget ID to modify"),
  title: z.string().optional(),
  localSql: z.string().optional(),
  vegaLiteSpec: vegaLiteSpecField,
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
  layouts: z
    .object({
      lg: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      }),
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

const importConsoleAsDataSourceSchema = z.object({
  dashboardId: z
    .string()
    .describe("Dashboard ID to import the data source into"),
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
  dashboardId: z.string().describe("Dashboard ID to add the data source to"),
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
  materialization: z
    .enum(["live", "parquet"])
    .default("parquet")
    .describe(
      "'parquet' (default) materializes the query to a cached artifact loaded " +
        "into DuckDB — fast for aggregation and served to public shares. " +
        "'live' streams the query server-side into DuckDB on every dashboard " +
        "load (always fresh, not shown in anonymous public shares). Mirrors " +
        "app data binding materialization.",
    ),
});

export const updateDataSourceQuerySchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z.string().describe("Dashboard data source ID"),
  action: z
    .enum(["replace", "patch", "append"])
    .default("replace")
    .describe(
      "How to modify the code field. 'replace' overwrites the full query, " +
        "'patch' replaces a line range (requires startLine/endLine), " +
        "'append' adds lines at the end. Only affects the code field; " +
        "other fields (name, connectionId, etc.) are always shallow-merged.",
    ),
  name: z.string().optional().describe("Updated display name"),
  connectionId: z.string().optional().describe("Updated connection ID"),
  language: z
    .enum(["sql", "javascript", "mongodb"])
    .optional()
    .describe("Updated query language"),
  code: z
    .string()
    .optional()
    .describe("Query text/code (interpretation depends on action)"),
  databaseId: z.string().optional().describe("Updated sub-database ID"),
  databaseName: z.string().optional().describe("Updated database name"),
  timeDimension: z.string().optional().describe("Updated default time column"),
  rowLimit: z.number().optional().describe("Updated row limit"),
  materialization: z
    .enum(["live", "parquet"])
    .optional()
    .describe(
      "Switch this data source between 'live' (stream on every load) and " +
        "'parquet' (cached materialized artifact).",
    ),
  materializationSchedule: bindingMaterializationScheduleSchema
    .optional()
    .describe(
      "Set or clear the cron auto-refresh, e.g. { enabled: true, cron: " +
        "'0 * * * *' } for hourly or { enabled: false } to turn it off. " +
        "NOTE: unlike apps (per-binding), a dashboard has ONE schedule that " +
        "refreshes all of its 'parquet' data sources — setting it here " +
        "updates the whole dashboard's schedule. Mirrors " +
        "app_update_data_binding's materializationSchedule.",
    ),
  startLine: z
    .number()
    .optional()
    .describe("Starting line for patch action (1-indexed, required for patch)"),
  endLine: z
    .number()
    .optional()
    .describe(
      "Ending line for patch action (1-indexed, inclusive, required for patch)",
    ),
  run: z
    .boolean()
    .default(false)
    .describe(
      "If true, immediately execute the updated query and stream fresh draft data into DuckDB after saving. " +
        "If false (default), only saves the query definition. The dashboard keeps using the previously loaded data until run_data_source_query is called.",
    ),
});

export type UpdateDataSourceQueryInput = z.infer<
  typeof updateDataSourceQuerySchema
>;

/**
 * Resolve the `action`-based code edit for update_data_source_query. Shared
 * by the browser executor and the server (MCP) leg so the edit semantics
 * cannot drift between surfaces. Returns the unchanged code when no `code`
 * was provided (non-patch actions treat code as optional).
 */
export function resolveDataSourceCodeEdit(
  existingCode: string,
  input: {
    action?: string;
    code?: string;
    startLine?: number;
    endLine?: number;
  },
): { ok: true; code: string } | { ok: false; error: string } {
  const action = typeof input.action === "string" ? input.action : "replace";
  if (action === "patch") {
    if (
      typeof input.startLine !== "number" ||
      typeof input.endLine !== "number"
    ) {
      return {
        ok: false,
        error:
          "startLine and endLine are required for patch action. Use get_dashboard_state to see the current query code.",
      };
    }
    if (typeof input.code !== "string") {
      return { ok: false, error: "code is required for patch action." };
    }
  }
  if (typeof input.code !== "string") {
    return { ok: true, code: existingCode };
  }
  switch (action) {
    case "patch": {
      const lines = existingCode.split("\n");
      const rawStart = input.startLine as number;
      const rawEnd = input.endLine as number;
      if (rawStart < 1 || rawStart > lines.length) {
        return {
          ok: false,
          error: `startLine ${rawStart} is out of range — the query only has ${lines.length} line(s). Use get_dashboard_state to see the current query code.`,
        };
      }
      if (rawEnd < rawStart || rawEnd > lines.length) {
        return {
          ok: false,
          error: `endLine ${rawEnd} is out of range — the query only has ${lines.length} line(s) and startLine is ${rawStart}. Use get_dashboard_state to see the current query code.`,
        };
      }
      const before = lines.slice(0, rawStart - 1);
      const after = lines.slice(rawEnd);
      return {
        ok: true,
        code: [...before, ...input.code.split("\n"), ...after].join("\n"),
      };
    }
    case "append":
      return {
        ok: true,
        code:
          existingCode + (existingCode.endsWith("\n") ? "" : "\n") + input.code,
      };
    case "replace":
    default:
      return { ok: true, code: input.code };
  }
}

const runDataSourceQuerySchema = z.object({
  dashboardId: z.string().describe("Dashboard ID"),
  dataSourceId: z
    .string()
    .describe("Data source ID to execute and load into DuckDB"),
});

const createDashboardSchema = z.object({
  title: z.string().describe("Dashboard title"),
  description: z.string().optional().describe("Brief description"),
});

export const clientDashboardTools = {
  // Client-side visual inspection tool (capture_screenshot)
  ...clientScreenshotTools,

  list_open_dashboards: tool({
    description:
      "List all open dashboard tabs. Returns each dashboard's id, title, description, " +
      "data source count, widget count, and isActive flag. " +
      "Call this FIRST to get dashboard IDs before using any other dashboard tool.",
    inputSchema: z.object({}),
  }),
  open_dashboard: tool({
    description:
      "Open a saved dashboard by its ID. Use after search_dashboards to load a found dashboard " +
      "into a tab. The dashboard will be fetched, its data sources materialized into DuckDB, " +
      "and it will appear as an open tab. Returns the dashboardId to use with other tools.",
    inputSchema: z.object({
      dashboardId: z.string().describe("Dashboard ID to open"),
    }),
  }),
  enter_edit_mode: tool({
    description:
      "Switch a dashboard into edit mode by acquiring the edit lock. " +
      "MUST be called before any write operations (add_widget, modify_widget, etc). " +
      "If another user holds the lock, a confirmation dialog is shown to the user — " +
      "the tool blocks until they approve or reject the force-acquire.",
    inputSchema: z.object({
      dashboardId: z
        .string()
        .describe(
          "Dashboard ID to enter edit mode for (must be currently open)",
        ),
    }),
  }),
  create_dashboard: tool({
    description:
      "Create a new empty dashboard. After creation, use create_data_source to add data sources " +
      "and add_widget to add charts, KPIs, or tables. Returns the new dashboardId.",
    inputSchema: createDashboardSchema,
  }),
  import_console_as_data_source: tool({
    description:
      "Import a saved console into a dashboard by value. " +
      "This duplicates the console's query definition into a dashboard-local data source and materializes it into DuckDB. " +
      "Use search_consoles first to find the console ID.",
    inputSchema: importConsoleAsDataSourceSchema,
  }),
  add_data_source: tool({
    description:
      "Legacy alias for importing a saved console into the dashboard. Prefer import_console_as_data_source.",
    inputSchema: importConsoleAsDataSourceSchema,
  }),
  create_data_source: tool({
    description:
      "Create a dashboard-local data source directly from a connection and query definition. " +
      "Use this when the user wants to add data without saving a console first.",
    inputSchema: createDataSourceSchema,
  }),
  update_data_source_query: tool({
    description:
      "Modify an existing dashboard-local data source query definition. " +
      "By default only saves the definition (no execution). Set run=true to immediately " +
      "execute the query and stream fresh draft data into DuckDB, or call run_data_source_query separately afterward. " +
      "Supports three edit modes via the 'action' field: " +
      "'replace' (default — full code replacement), " +
      "'patch' (replace a specific line range — requires startLine/endLine, preferred for small edits), " +
      "'append' (add lines to the end of the existing code). " +
      "Non-code fields (name, connectionId, language, materialization, etc.) are always shallow-merged regardless of action. " +
      "materializationSchedule sets the dashboard's cron auto-refresh (dashboard-level — one schedule refreshes all parquet sources). " +
      "When run=false, treat the response as definition_saved_only and use the returned nextRecommendedTool if you need fresh data. " +
      "IMPORTANT for 'patch': line numbers are 1-indexed and inclusive; do NOT include line number prefixes in your code content.",
    inputSchema: updateDataSourceQuerySchema,
  }),
  run_data_source_query: tool({
    description:
      "Execute a data source query and stream the results into DuckDB WASM. " +
      "Use after update_data_source_query to load fresh data, or to reload an existing source. " +
      "Streams via NDJSON for stability. Automatically recovers if DuckDB WASM crashes.",
    inputSchema: runDataSourceQuerySchema,
  }),
  add_widget: tool({
    description:
      "Add a chart, KPI card, or data table widget to the dashboard. " +
      "The localSql runs against the dashboard-local DuckDB tableRef. " +
      "For chart type, provide a vegaLiteSpec without a data property.",
    inputSchema: addWidgetSchema,
  }),
  modify_widget: tool({
    description:
      "Modify an existing widget. Only include the fields you want to change. " +
      "Layouts are deep-merged: sending only lg preserves existing md/sm/xs breakpoints.",
    inputSchema: modifyWidgetSchema,
  }),
  remove_widget: tool({
    description: "Remove a widget from the dashboard.",
    inputSchema: removeWidgetSchema,
  }),
  get_dashboard_state: tool({
    description:
      "Get the full dashboard definition: widgets (with layouts, vegaLiteSpec, localSql, kpiConfig), " +
      "data sources (with query code, column schemas, runtime status, active source, load path, and materialization diagnostics), cross-filter config, " +
      "global filters, relationships, and materialization schedule. " +
      "Also includes truncated sample rows and widget snapshots.",
    inputSchema: getDashboardStateSchema,
  }),
  add_global_filter: tool({
    description:
      "Add a dashboard-level filter (date range picker, dropdown, multi-select, or search).",
    inputSchema: addGlobalFilterSchema,
  }),
  remove_global_filter: tool({
    description: "Remove a global filter from the dashboard.",
    inputSchema: removeGlobalFilterSchema,
  }),
  link_tables: tool({
    description:
      "Define a relationship between two data sources for cross-filtering.",
    inputSchema: linkTablesSchema,
  }),
  set_time_dimension: tool({
    description: "Set the default time column for a data source.",
    inputSchema: setTimeDimensionSchema,
  }),
  get_chart_templates: tool({
    description:
      "List available best-practice chart templates with IDs and descriptions. " +
      "Call before creating charts to discover proven simple patterns " +
      "(e.g. multi-series line with hover rule, donut, stacked bar).",
    inputSchema: z.object({}),
  }),
  get_chart_template: tool({
    description:
      "Get a specific chart template with full vegaLiteSpec, SQL pattern, and implementation notes. " +
      "Prefer template-driven simple specs over hand-written complex layering.",
    inputSchema: z.object({
      templateId: z.string().describe("Template ID from get_chart_templates"),
    }),
  }),
  dashboard_save_version: tool({
    description:
      "Save AND publish the dashboard's current edits as a new version. Persists " +
      "the working draft to the server, creates an immutable version snapshot in " +
      "history, and publishes it — the published snapshot is what viewers and " +
      "shared/public links render. Call enter_edit_mode first. Only call this " +
      "when the user asks to save/publish/snapshot; otherwise leave changes in " +
      "edit mode for the user to review. Give a short `comment`.",
    inputSchema: saveDashboardVersionSchema,
  }),
  dashboard_restore_version: tool({
    description:
      "Restore the dashboard to a previous version (get the number from " +
      "browse_version_history with entityType:'dashboard'). Reverts the working " +
      "draft to that snapshot and reloads the dashboard; the current state is " +
      "preserved as a new version first, so it is never lossy. Restoring does " +
      "NOT publish — call dashboard_save_version afterward to push the restored " +
      "state live to viewers. This replaces any unsaved edits in the open tab.",
    inputSchema: restoreDashboardVersionSchema,
  }),
};
