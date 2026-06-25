/**
 * Client-Side Data Source Tools (surface-agnostic)
 *
 * A single, shared set of primitives for inspecting and querying data sources
 * across **both** apps and dashboards. Each tool takes a `surface`
 * discriminator (`{ kind: "app" | "dashboard", id }`); the client executor
 * dispatches to the appropriate runtime. These replace the older per-surface
 * tools (app: list/inspect/run_app_duckdb; dashboard: preview_data_source /
 * get_data_preview) — fewer, better primitives.
 *
 * "Data source" means a named (connection, query) that materializes into an
 * in-browser DuckDB table you can query with SQL — the concept is identical for
 * app data bindings and dashboard data sources.
 */

import { tool } from "ai";
import { z } from "zod";

const surfaceSchema = z
  .object({
    kind: z
      .enum(["app", "dashboard"])
      .describe("Which surface owns the data source"),
    id: z
      .string()
      .describe(
        "App ID (from list_open_apps) or Dashboard ID (from list_open_dashboards)",
      ),
  })
  .describe("Target surface that owns the data source(s)");

// Input schemas are shared verbatim with the server-executed versions
// (api/src/agent-lib/tools/server-data-source-tools.ts) so the tool surface
// cannot drift between the client tool cards and the server `execute`.
export const listDataSourcesSchema = z.object({ surface: surfaceSchema });

export const inspectDataSourceSchema = z.object({
  surface: surfaceSchema,
  dataSource: z
    .string()
    .describe("Data source name (apps) or data source id (dashboards)"),
});

export const queryDuckdbSchema = z.object({
  surface: surfaceSchema,
  sql: z.string().describe("DuckDB SQL to execute"),
});

export type ListDataSourcesInput = z.infer<typeof listDataSourcesSchema>;
export type InspectDataSourceInput = z.infer<typeof inspectDataSourceSchema>;
export type QueryDuckdbInput = z.infer<typeof queryDuckdbSchema>;

export const clientDataSourceTools = {
  list_data_sources: tool({
    description:
      "List the data sources of an app or dashboard: name, connection, query, " +
      "materialization mode, build status, and row counts. Works for both " +
      "surfaces — pass surface.kind and surface.id. Use this to understand what " +
      "data is available and how it was built.",
    inputSchema: listDataSourcesSchema,
  }),
  inspect_data_source: tool({
    description:
      "Inspect one data source: its connection, query, column schema, and a few " +
      "sample rows (from the materialized Parquet artifact when available, " +
      "otherwise a live preview). Works for apps and dashboards.",
    inputSchema: inspectDataSourceSchema,
  }),
  query_duckdb: tool({
    description:
      "Run analytical DuckDB SQL against a surface's materialized tables and " +
      "return the rows. Table names are the data source names (apps) or " +
      "tableRefs (dashboards). Only read-only SELECT / WITH queries are allowed. " +
      "Tables must be materialized to Parquet first (call materialize_binding " +
      "for app bindings). Use to validate aggregations before writing them into " +
      "app `useDuckDB` calls or dashboard widget SQL.",
    inputSchema: queryDuckdbSchema,
  }),
};
