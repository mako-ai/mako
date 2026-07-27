/**
 * Structured row previews from `dbt show --output json`.
 *
 * `dbt show` has no artifact — the preview arrives as a log event. With
 * `--output json` dbt emits one info-level `ShowNode` event per previewed node
 * whose message is `{"node": "<name>", "show": [ {...row}, ... ]}`, so the rows
 * are recovered by scanning the captured log lines rather than by reading
 * `target/`. Used by the editor's Preview button (and safe to reuse anywhere a
 * `show` command's rows are needed) so the UI renders a real data grid instead
 * of dbt's ASCII table.
 */

/**
 * Rows a Preview fetches when the caller doesn't say. Big enough to eyeball a
 * transform, small enough that the grid stays responsive and the warehouse
 * scan stays cheap.
 */
export const DBT_PREVIEW_DEFAULT_LIMIT = 500;

/** Hard ceiling on `--limit`; previews are for eyeballing, not extracting. */
export const DBT_PREVIEW_MAX_LIMIT = 5000;

export interface DbtShowPreview {
  /**
   * Column names in warehouse order. Derived from the row objects' key order
   * (JSON preserves it) rather than sorted, so the grid matches the SELECT.
   */
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Node the preview belongs to, when dbt reported one. */
  node?: string;
}

interface ShowNodePayload {
  node?: unknown;
  show?: unknown;
}

function isPlainRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the last `ShowNode` payload out of a run's log lines, or `null` when the
 * command produced no preview (failed compile, non-`show` command, or a dbt
 * build that predates `--output json`). A node that legitimately returned zero
 * rows yields an empty preview, NOT `null` — the caller distinguishes "no rows"
 * from "no preview".
 */
export function parseDbtShowPreview(
  logs: Array<{ level: string; line: string }>,
): DbtShowPreview | null {
  let found: DbtShowPreview | null = null;

  for (const log of logs) {
    const line = log.line.trim();
    // Cheap guard: the payload is always a JSON object mentioning "show".
    if (!line.startsWith("{") || !line.includes('"show"')) continue;

    let payload: ShowNodePayload;
    try {
      payload = JSON.parse(line) as ShowNodePayload;
    } catch {
      continue;
    }
    if (!Array.isArray(payload.show)) continue;

    const rows = payload.show.filter(isPlainRow);
    // A selector can match several nodes; dbt prints one event each and the
    // last one is the node the user asked about (`+model` previews upstream
    // first). Keep overwriting so `found` ends on it.
    found = {
      ...(typeof payload.node === "string" ? { node: payload.node } : {}),
      columns: unionColumns(rows),
      rows,
    };
  }

  return found;
}

/** Every key across the rows, in first-seen order. */
function unionColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return [...columns];
}
