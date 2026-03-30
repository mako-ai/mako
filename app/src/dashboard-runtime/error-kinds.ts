export type DashboardErrorKind =
  | "source_sql_syntax"
  | "source_sql_runtime"
  | "source_connection_failed"
  | "materialization_failed"
  | "duckdb_sql_syntax"
  | "duckdb_sql_runtime"
  | "vega_schema_invalid"
  | "vega_compile_failed"
  | "vega_render_failed"
  | "crossfilter_invalid"
  | "stale_dependency";

export function classifyDuckDBError(message: string): DashboardErrorKind {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("parser") ||
    normalized.includes("syntax") ||
    normalized.includes("parse error") ||
    normalized.includes("catalog error")
  ) {
    return "duckdb_sql_syntax";
  }
  return "duckdb_sql_runtime";
}

export function classifySourceError(message: string): DashboardErrorKind {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("connection") ||
    normalized.includes("timeout") ||
    normalized.includes("network") ||
    normalized.includes("refused")
  ) {
    return "source_connection_failed";
  }
  if (
    normalized.includes("syntax") ||
    normalized.includes("parse") ||
    normalized.includes("parser")
  ) {
    return "source_sql_syntax";
  }
  return "source_sql_runtime";
}
