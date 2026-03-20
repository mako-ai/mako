import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { queryDuckDB } from "../lib/duckdb";
import type { DashboardQueryExecutor } from "./types";

export function createDuckDBQueryExecutor(
  db: AsyncDuckDB,
): DashboardQueryExecutor {
  return async (sql: string) => await queryDuckDB(db, sql);
}
