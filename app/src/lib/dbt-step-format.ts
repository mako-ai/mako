/**
 * Cell formatting shared by every dbt node-results table (editor Commands
 * panel, project console, run history, run card) so they render dbt's raw
 * per-node numbers identically.
 */

/**
 * dbt's `adapter_response.rows_affected` is -1 when the warehouse has no
 * meaningful count for the statement — Postgres/Redshift report it for
 * `CREATE VIEW`, for instance. Showing "-1" in a Rows column reads as a bug,
 * so unknown counts render blank while a genuine 0 still shows.
 */
export function formatRowsAffected(rows: number | undefined): string {
  if (rows === undefined || rows < 0) return "";
  return String(rows);
}

/** Node execution time as seconds, e.g. `1.90s`. */
export function formatStepDuration(executionTimeMs: number): string {
  return `${(executionTimeMs / 1000).toFixed(2)}s`;
}
