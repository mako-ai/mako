/**
 * Parse structured row previews from `dbt show` JSON log events.
 *
 * With `--log-format json --output json`, dbt emits a ShowNode event whose
 * `data.preview` is a JSON array of row objects. We capture that on
 * {@link DbtLogLine.showPreview} in the runner and turn it into columns/rows
 * for the editor data grid.
 */

export interface DbtShowPreview {
  columns: string[];
  rows: unknown[][];
}

export interface ShowPreviewLogLine {
  line: string;
  /** Raw `data.preview` string from a ShowNode JSON log event. */
  showPreview?: string;
}

/**
 * Extract the first ShowNode preview payload from command logs.
 * Prefer structured `showPreview`; fall back to scanning the human message
 * for a JSON array (defensive — older capture paths).
 */
export function parseShowPreview(
  logs: ShowPreviewLogLine[],
): DbtShowPreview | undefined {
  for (const log of logs) {
    const raw = log.showPreview?.trim();
    if (raw) {
      const parsed = tryParsePreviewJson(raw);
      if (parsed) return parsed;
    }
  }

  // Fallback: agent-style scrape — look for a JSON array in info lines after
  // the "Previewing" marker (rare; structured capture should win).
  const infoLines = logs.map(log => log.line);
  const markerIdx = infoLines.findIndex(line => line.includes("Previewing"));
  const candidates =
    markerIdx >= 0 ? infoLines.slice(markerIdx) : infoLines.slice(-5);
  for (const line of candidates) {
    const start = line.indexOf("[");
    const end = line.lastIndexOf("]");
    if (start < 0 || end <= start) continue;
    const parsed = tryParsePreviewJson(line.slice(start, end + 1));
    if (parsed) return parsed;
  }

  return undefined;
}

function tryParsePreviewJson(raw: string): DbtShowPreview | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return undefined;

    if (value.length === 0) {
      return { columns: [], rows: [] };
    }

    // dbt --output json: array of row objects
    if (isPlainObject(value[0])) {
      const rows = value as Array<Record<string, unknown>>;
      const columns: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (!seen.has(key)) {
            seen.add(key);
            columns.push(key);
          }
        }
      }
      return {
        columns,
        rows: rows.map(row => columns.map(col => row[col] ?? null)),
      };
    }

    // Already a matrix: [[...], [...]]
    if (Array.isArray(value[0])) {
      const matrix = value as unknown[][];
      const width = Math.max(0, ...matrix.map(r => r.length));
      const columns = Array.from({ length: width }, (_, i) => `col_${i}`);
      return { columns, rows: matrix };
    }

    // Scalar list — single column
    return {
      columns: ["value"],
      rows: value.map(v => [v]),
    };
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ensure a validated `show` argv requests JSON row output so ShowNode carries
 * a parseable `data.preview`. No-op when `--output` is already set.
 */
export function ensureShowJsonOutput(argv: string[]): string[] {
  if (argv[0] !== "show") return argv;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--output" || argv[i] === "-o") return argv;
  }
  return [...argv, "--output", "json"];
}
