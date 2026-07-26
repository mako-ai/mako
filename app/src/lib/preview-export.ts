/**
 * Client-side CSV / NDJSON export for the dbt editor's Preview grid.
 *
 * A preview is a bounded result set already held in memory (DBT_PREVIEW_
 * DEFAULT_LIMIT rows), so exporting it needs no server round trip — unlike the
 * SQL console, whose exports stream a full, possibly paginated query result.
 * The cell semantics deliberately mirror the server's streaming exporter
 * (api/src/utils/query-export-stream.ts) so a preview export and a console
 * export of the same rows produce identical bytes.
 */

export type PreviewExportFormat = "csv" | "ndjson";

/** RFC 4180 cell: quote when needed, double embedded quotes, blank for null. */
function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  const escaped = raw.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

/** Union of keys across rows, in first-seen order. */
function unionColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) columns.add(key);
  }
  return [...columns];
}

/**
 * `columns` fixes the order (the warehouse's, as reported by dbt) — pass an
 * empty array to derive it from the rows instead.
 */
export function rowsToCsv(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const header = columns.length > 0 ? columns : unionColumns(rows);
  if (header.length === 0) return "";

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map(column => escapeCsvCell(row?.[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function rowsToNdjson(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}

/** `stg_orders` → `stg_orders.csv`, with path separators etc. stripped. */
export function previewFilename(
  model: string | undefined,
  format: PreviewExportFormat,
): string {
  const safe = (model ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return `${safe || "preview"}.${format}`;
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadTextFile(
  filename: string,
  content: string,
  format: PreviewExportFormat,
): void {
  const mime =
    format === "csv"
      ? "text/csv;charset=utf-8"
      : "application/x-ndjson;charset=utf-8";
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
