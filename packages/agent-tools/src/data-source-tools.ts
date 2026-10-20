/**
 * Client-Side Data Source Tools
 *
 * Primitives for inspecting and querying an app's data sources (its data
 * bindings). Each tool takes a `surface` discriminator (`{ kind: "app", id }`)
 * so another surface could be added without renaming the tools; the client
 * executor dispatches to the app runtime.
 *
 * "Data source" means a named (connection, query) that materializes into an
 * in-browser DuckDB table you can query with SQL.
 */

import { tool } from "ai";
import { z } from "zod";

const surfaceSchema = z
  .object({
    kind: z
      .enum(["app"])
      .describe("Which surface owns the data source"),
    id: z.string().describe("App ID (from app_list_apps)"),
  })
  .describe("Target surface that owns the data source(s)");

export const clientDataSourceTools = {
  list_data_sources: tool({
    description:
      "List the data sources of an app: name, connection, query, " +
      "materialization mode, build status, and row counts. Pass surface.kind " +
      "and surface.id. Use this to understand what data is available and how " +
      "it was built.",
    inputSchema: z.object({ surface: surfaceSchema }),
  }),
  inspect_data_source: tool({
    description:
      "Inspect one data source: its connection, query, column schema, and a few " +
      "sample rows (from in-browser DuckDB when materialized, otherwise a live " +
      "preview).",
    inputSchema: z.object({
      surface: surfaceSchema,
      dataSource: z
        .string()
        .describe("Data source (binding) name"),
    }),
  }),
  query_duckdb: tool({
    description:
      "Run analytical DuckDB SQL in the browser against a surface's in-memory " +
      "tables and return the rows. Table names are the data source names. Use " +
      "to validate aggregations before writing them into app `useDuckDB` calls.",
    inputSchema: z.object({
      surface: surfaceSchema,
      sql: z.string().describe("DuckDB SQL to execute"),
    }),
  }),
};
