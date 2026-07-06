/**
 * Builds the short status line shown in a tool card header once the tool
 * finishes (e.g. "3 rows", "success"). Kept in its own module so it can be
 * unit-tested without importing the React component graph, and so the
 * component file keeps a Fast-Refresh-friendly component-only export surface.
 */
export function getOutputSummary(output: unknown): string | null {
  if (output === null || output === undefined) return null;

  const o = output as Record<string, unknown>;

  if (o.success === false || o.error) {
    const raw = o.error;
    const err =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "message" in raw
          ? String((raw as { message: unknown }).message)
          : "Failed";
    return err.length > 50 ? err.slice(0, 50) + "…" : err;
  }

  // dbt run-status tools (dbt_get_run / dbt_run_job / dbt_cancel_run) return a
  // run id plus the run's lifecycle status. Surface the status so the card
  // header reads "success" / "running" instead of a bare "Done".
  if (typeof o.runId === "string" && typeof o.status === "string") {
    const steps = Array.isArray(o.stepResults) ? o.stepResults.length : 0;
    return steps > 0
      ? `${o.status} · ${steps} step${steps !== 1 ? "s" : ""}`
      : o.status;
  }

  if (o.state === "definition_updated") {
    return "Definition saved only";
  }
  if (o.state === "loaded") {
    if (typeof o.rowCount === "number") {
      return `${o.rowCount} row${o.rowCount !== 1 ? "s" : ""}`;
    }
    return "Fresh data loaded";
  }

  if (Array.isArray(o.data)) {
    return `${o.data.length} row${o.data.length !== 1 ? "s" : ""}`;
  }
  if (typeof o.rowCount === "number") {
    return `${o.rowCount} row${o.rowCount !== 1 ? "s" : ""}`;
  }

  if (Array.isArray(output)) {
    return `${output.length} result${output.length !== 1 ? "s" : ""}`;
  }

  if (Array.isArray(o.fields)) {
    return `${o.fields.length} field${o.fields.length !== 1 ? "s" : ""}`;
  }
  if (Array.isArray(o.columns)) {
    return `${o.columns.length} column${o.columns.length !== 1 ? "s" : ""}`;
  }
  if (Array.isArray(o.databases)) {
    return `${o.databases.length} database${o.databases.length !== 1 ? "s" : ""}`;
  }
  if (Array.isArray(o.tables)) {
    return `${o.tables.length} table${o.tables.length !== 1 ? "s" : ""}`;
  }

  return null;
}
