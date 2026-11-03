/**
 * Instant-open snapshot for Apps v2 bindings.
 *
 * The old dashboards feature embedded ≤500 preview rows on the dashboard
 * document so widgets painted before DuckDB-WASM finished loading parquet
 * (`a79bac96`, capped in `9e352eaf`; removed with dashboards in #1100).
 * Apps get the same trick as a sibling artifact: `<parquetKey minus
 * .parquet>.snapshot.json` holds the schema and the first N rows of the
 * build, small enough to fetch without WASM. An app opts in per hook with
 * `useQuery(name, { snapshot: true })` and gets the rows as `preview`, never
 * as `data`.
 *
 * The rows are read back FROM THE BUILT PARQUET and encoded with the SDK's
 * own decoding rules (packages/app-sdk/data-core.js toPlainRows), so a preview
 * row and the parquet row the app gets a second later have the same types:
 * DATE → "YYYY-MM-DD", TIMESTAMP → ISO 8601, a 64-bit integer → number when
 * it fits. Two values JSON cannot carry ride as strings the SDK turns back:
 * a 64-bit integer past 2^53 (→ BigInt) and a non-finite float (→ NaN,
 * ±Infinity). A column type the SDK's parquet path hands over as an Arrow
 * object (DECIMAL, LIST, STRUCT, MAP, BLOB, …) gets no snapshot at all: a
 * preview the app would have to type differently is worse than none.
 *
 * "First N" is the first N rows of the build stream, in whatever order the
 * query produced them. Without an ORDER BY that order is the warehouse's
 * choice, so a snapshot is a skeleton, not a sample.
 *
 * Caps (overridable): APPS_BINDING_SNAPSHOT_MAX_ROWS (500) and
 * APPS_BINDING_SNAPSHOT_MAX_BYTES (200 KiB).
 */
import {
  DuckDBInstance,
  DuckDBDateValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
} from "@duckdb/node-api";
import { getArtifactStore, type ArtifactStore } from "./artifact-store.service";
import { loggers } from "../logging";

const logger = loggers.api("binding-snapshot");

export const SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_SNAPSHOT_MAX_ROWS = 500;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 200 * 1024;

export interface SnapshotField {
  name: string;
  /** DuckDB type name, e.g. "BIGINT", "TIMESTAMP". */
  type: string;
}

export interface BindingSnapshot {
  version: typeof SNAPSHOT_VERSION;
  builtAt: string;
  /** Total rows in the parquet artifact (not the preview length). */
  rowCount: number;
  /** Rows included in `rows`. */
  snapshotRowCount: number;
  /** True when `rows` holds fewer rows than the artifact. */
  truncated: boolean;
  fields: SnapshotField[];
  rows: Record<string, unknown>[];
}

function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function snapshotLimits(): { maxRows: number; maxBytes: number } {
  return {
    maxRows: parsePositiveInt(
      process.env.APPS_BINDING_SNAPSHOT_MAX_ROWS,
      DEFAULT_SNAPSHOT_MAX_ROWS,
    ),
    maxBytes: parsePositiveInt(
      process.env.APPS_BINDING_SNAPSHOT_MAX_BYTES,
      DEFAULT_SNAPSHOT_MAX_BYTES,
    ),
  };
}

/** Sibling of a parquet artifact key: `….parquet` → `….snapshot.json`. */
export function snapshotArtifactKey(parquetKey: string): string {
  if (parquetKey.endsWith(".parquet")) {
    return `${parquetKey.slice(0, -".parquet".length)}.snapshot.json`;
  }
  return `${parquetKey}.snapshot.json`;
}

// The column types a snapshot can carry, and how each value is encoded.
// Must stay in step with packages/app-sdk/data-core.js (SNAPSHOT_* sets).
const INT64_TYPES = new Set(["BIGINT", "UBIGINT"]);
const FLOAT_TYPES = new Set(["DOUBLE", "FLOAT"]);
const PLAIN_TYPES = new Set([
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "VARCHAR",
]);
const DATE_TYPES = new Set(["DATE"]);
const TIMESTAMP_TYPES = new Set([
  "TIMESTAMP",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMP WITH TIME ZONE",
]);

export function snapshotSupportsType(type: string): boolean {
  return (
    INT64_TYPES.has(type) ||
    FLOAT_TYPES.has(type) ||
    PLAIN_TYPES.has(type) ||
    DATE_TYPES.has(type) ||
    TIMESTAMP_TYPES.has(type)
  );
}

// The epoch milliseconds the SDK computes for a timestamp: toPlainRows's
// fast path splits quotient and remainder (`(v - rem) / div + rem / div`),
// the same value Arrow's own getter yields, so `new Date(ms)` truncates the
// same way here.
function splitMillis(v: number, div: number): number {
  const rem = v % div;
  return (v - rem) / div + rem / div;
}
function timestampMillis(value: unknown): number | null {
  if (value instanceof DuckDBTimestampValue) {
    return splitMillis(Number(value.micros), 1000);
  }
  if (value instanceof DuckDBTimestampTZValue) {
    return splitMillis(Number(value.micros), 1000);
  }
  if (value instanceof DuckDBTimestampMillisecondsValue) {
    return Number(value.millis);
  }
  if (value instanceof DuckDBTimestampSecondsValue) {
    return Number(value.seconds) * 1000;
  }
  if (value instanceof DuckDBTimestampNanosecondsValue) {
    return splitMillis(Number(value.nanos), 1_000_000);
  }
  return null;
}

function isoOrNull(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One DuckDB value as snapshot JSON, by its column's DuckDB type. */
export function encodeSnapshotValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (INT64_TYPES.has(type)) {
    const n = typeof value === "bigint" ? value : BigInt(value as number);
    return n >= BigInt(Number.MIN_SAFE_INTEGER) &&
      n <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(n)
      : n.toString();
  }
  if (FLOAT_TYPES.has(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : String(n);
  }
  if (DATE_TYPES.has(type)) {
    if (!(value instanceof DuckDBDateValue)) return null;
    return isoOrNull(value.days * 86_400_000)?.slice(0, 10) ?? null;
  }
  if (TIMESTAMP_TYPES.has(type)) return isoOrNull(timestampMillis(value));
  if (typeof value === "bigint") return Number(value);
  return value;
}

/**
 * Read the first rows of a built parquet file and encode them as a
 * snapshot. Null when a column has a type the snapshot cannot carry.
 */
export async function snapshotFromParquet(
  parquetPath: string,
  rowCount: number,
  opts: { maxRows?: number; maxBytes?: number; builtAt?: Date } = {},
): Promise<BindingSnapshot | null> {
  const limits = snapshotLimits();
  const maxRows = opts.maxRows ?? limits.maxRows;
  const maxBytes = opts.maxBytes ?? limits.maxBytes;
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("PRAGMA threads=1");
    const reader = await connection.runAndReadAll(
      `SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}') LIMIT ${Math.max(0, Math.floor(maxRows))}`,
    );
    const names = reader.columnNames();
    const types = reader.columnTypes().map(t => t.toString());
    const fields = names.map((name, i) => ({ name, type: types[i] }));
    const unsupported = fields.filter(f => !snapshotSupportsType(f.type));
    if (unsupported.length > 0) {
      logger.info("Binding snapshot skipped: column types JSON cannot mirror", {
        columns: unsupported.map(f => `${f.name} ${f.type}`),
      });
      return null;
    }
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    for (const values of reader.getRows()) {
      const row: Record<string, unknown> = {};
      for (let i = 0; i < names.length; i++) {
        row[names[i]] = encodeSnapshotValue(values[i], types[i]);
      }
      const size = Buffer.byteLength(JSON.stringify(row), "utf8");
      // Always keep the first row so one wide row still paints.
      if (rows.length > 0 && bytes + size > maxBytes) break;
      rows.push(row);
      bytes += size;
    }
    return {
      version: SNAPSHOT_VERSION,
      builtAt: (opts.builtAt ?? new Date()).toISOString(),
      rowCount,
      snapshotRowCount: rows.length,
      truncated: rows.length < rowCount,
      fields,
      rows,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** snapshotFromParquet that never throws: a snapshot is never worth a build. */
export async function snapshotFromParquetBestEffort(
  parquetPath: string,
  rowCount: number,
  context?: Record<string, unknown>,
): Promise<BindingSnapshot | null> {
  try {
    return await snapshotFromParquet(parquetPath, rowCount);
  } catch (error) {
    logger.warn("Binding snapshot not built; parquet is unaffected", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Store a parquet and its snapshot so that an old snapshot can never sit next
 * to a new parquet. Content-addressed keys are rebuilt in place (a refresh
 * writes the same key), so the order is: delete the old snapshot, upload the
 * parquet, then write the new snapshot. A failed delete aborts before the
 * parquet moves (both stay the previous build's); a failed snapshot write
 * only leaves the new parquet without a preview.
 */
export async function storeParquetWithSnapshot(input: {
  parquetKey: string;
  snapshot: BindingSnapshot | null;
  uploadParquet: () => Promise<void>;
  store?: ArtifactStore;
  context?: Record<string, unknown>;
}): Promise<void> {
  const store = input.store ?? getArtifactStore();
  const snapshotKey = snapshotArtifactKey(input.parquetKey);
  await store.delete(snapshotKey);
  await input.uploadParquet();
  if (!input.snapshot) return;
  try {
    await store.putBuffer(
      Buffer.from(JSON.stringify(input.snapshot)),
      snapshotKey,
      "application/json",
      { kind: "binding-snapshot" },
    );
  } catch (error) {
    logger.warn("Binding snapshot not stored; parquet is still available", {
      parquetKey: input.parquetKey,
      ...input.context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
