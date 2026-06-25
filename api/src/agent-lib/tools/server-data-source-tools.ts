/**
 * Server-side data-source tools (issue #475 pattern, extended to data sources)
 *
 * `list_data_sources`, `inspect_data_source`, and `query_duckdb` execute on the
 * API instead of in the browser. They read the authoritative MakoApp / Dashboard
 * document and query the SAME materialized Parquet artifacts the browser loads
 * into DuckDB-WASM — via node DuckDB (`@duckdb/node-api`). This makes analytical
 * validation work end-to-end with no attached browser (mobile lock, headless
 * runs, stranded turns).
 *
 * Read-only by construction: no Mongo writes, no realtime events. SQL is gated
 * to a single read-only SELECT/WITH statement with external access disabled.
 *
 * Tool schemas live in @mako/agent-tools (shared with the app's tool cards).
 */
import { tool } from "ai";
import {
  listDataSourcesSchema,
  inspectDataSourceSchema,
  queryDuckdbSchema,
} from "@mako/agent-tools";
import {
  listSurfaceDataSources,
  inspectSurfaceDataSource,
  querySurfaceDuckDB,
} from "../../services/server-data-source.service";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface ServerDataSourceToolsOptions {
  workspaceId: string;
}

export function createServerDataSourceTools({
  workspaceId,
}: ServerDataSourceToolsOptions) {
  const wrap = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | { success: false; error: string }> => {
    try {
      return await fn();
    } catch (error) {
      logger.warn(`Server data-source tool failed: ${label}`, {
        error,
        workspaceId,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : `Failed: ${label}`,
      };
    }
  };

  return {
    list_data_sources: tool({
      description:
        "List the data sources of an app or dashboard: name, connection, query, " +
        "materialization mode, build status, and row counts. Works for both " +
        "surfaces — pass surface.kind and surface.id. Use this to understand what " +
        "data is available and how it was built.",
      inputSchema: listDataSourcesSchema,
      execute: async ({ surface }) =>
        wrap("list_data_sources", () =>
          listSurfaceDataSources(workspaceId, surface),
        ),
    }),

    inspect_data_source: tool({
      description:
        "Inspect one data source: its connection, query, column schema, and a few " +
        "sample rows (from the materialized Parquet artifact when available, " +
        "otherwise a live preview). Works for apps and dashboards.",
      inputSchema: inspectDataSourceSchema,
      execute: async ({ surface, dataSource }) =>
        wrap("inspect_data_source", () =>
          inspectSurfaceDataSource(workspaceId, surface, dataSource),
        ),
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
      execute: async ({ surface, sql }) =>
        wrap("query_duckdb", () =>
          querySurfaceDuckDB(workspaceId, surface, sql),
        ),
    }),
  };
}
