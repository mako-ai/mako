import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";
import { DuckDBInstance, type DuckDBAppender } from "@duckdb/node-api";
import { loggers } from "../logging";
import { DEFAULT_PARQUET_ROW_LIMIT, fmtRows } from "./parquet-row-limit";
import {
  SNAPPY_WRITE_OPTIONS,
  buildParquetCopySql,
  type ParquetCodec,
  type ParquetWriteOptions,
} from "./parquet-compression";

const logger = loggers.api("streaming-parquet-builder");

/**
 * Rows appended to the staging table before they are cast into `_data`. Small
 * enough that the synchronous appends stay a few milliseconds on the event
 * loop and the staging table stays a few megabytes.
 */
const STAGE_FLUSH_ROWS = 2048;
/** Staged text that forces an early flush (UTF-16 units, about 8 MB). */
const STAGE_FLUSH_CHARS = 4 * 1024 * 1024;
const DEFAULT_DUCKDB_MEMORY_LIMIT_MB = 512;
const DEFAULT_DUCKDB_THREADS = 1;

function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FieldMeta {
  name: string;
  type?: string;
}

export interface StreamingParquetResult {
  filePath: string;
  rowCount: number;
  byteSize: number;
  /** Rows arrived past `rowLimit` and were dropped (only with `onRowLimit: "truncate"`). */
  truncated: boolean;
  compression: ParquetCodec;
  /** Only for ZSTD. */
  zstdLevel?: number;
  rowGroupSize?: number;
  /** Wall time of the COPY ... TO parquet statement alone. */
  encodeDurationMs: number;
}

export interface StreamingParquetOptions {
  filenameBase?: string;
  /** Default DEFAULT_PARQUET_ROW_LIMIT. */
  rowLimit?: number;
  /**
   * What to do when the source yields more than `rowLimit` rows.
   * `truncate` (default) keeps the first `rowLimit` rows and reports
   * `truncated: true` — right where the limit is a declared cap the reader
   * chose. `fail` throws ParquetRowLimitError and builds nothing — right where
   * the artifact is read as the whole result, so a cut would be summed as if
   * complete.
   */
  onRowLimit?: "truncate" | "fail";
  /**
   * With `onRowLimit: "fail"`: once past the limit, keep reading (without
   * writing) until the stream ends or this many rows have arrived, so the
   * error can say how many rows the query returned. Unset = stop at once.
   */
  countRowsUpTo?: number;
  fields?: FieldMeta[];
  /**
   * Columns every row must carry as a valid timestamp (the sync writers pass
   * `_syncedAt` and `_mako_source_ts`). They are typed TIMESTAMP whatever
   * `fields` says, and a row whose value is missing or unparseable fails the
   * build with MissingRowTimestampError, so it never reaches a destination.
   */
  requiredTimestampColumns?: string[];
  onBatchInserted?: (totalRows: number) => Promise<void>;
  /**
   * Codec and row-group options for the COPY. Default SNAPPY: the CDC and
   * sync load paths rely on it. App bindings pass
   * `appBindingParquetWriteOptions()`.
   */
  writeOptions?: ParquetWriteOptions;
}

/**
 * A row reached the Parquet build without a valid value in a column the
 * caller marked required (`requiredTimestampColumns`). The build stops and
 * writes nothing: a NULL `_mako_source_ts` or `_syncedAt` in live is a row
 * the CDC merge and incremental anchors cannot order.
 */
export class MissingRowTimestampError extends Error {
  readonly column: string;
  readonly rowsMissing: number;
  constructor(column: string, rowsMissing: number) {
    super(
      `${rowsMissing} row(s) have no valid "${column}" timestamp. ` +
        `Nothing was written: a row without it cannot be ordered by the CDC merge.`,
    );
    this.name = "MissingRowTimestampError";
    this.column = column;
    this.rowsMissing = rowsMissing;
  }
}

function isValidTimestamp(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "string" || typeof value === "number") {
    if (value === "") return false;
    return !Number.isNaN(new Date(value).getTime());
  }
  return false;
}

/**
 * The source yielded more rows than the artifact may hold, and the caller
 * asked for no truncated artifact. Thrown from inside the batch callback, so
 * the query stops streaming; drivers report it as the stream's failure.
 */
export class ParquetRowLimitError extends Error {
  readonly rowLimit: number;
  /** Rows the source yielded before the build stopped reading. */
  readonly rowCount: number;
  /** True when `rowCount` is the query's whole result (the stream ended). */
  readonly exact: boolean;
  constructor(
    rowLimit: number,
    { rowCount, exact }: { rowCount?: number; exact?: boolean } = {},
  ) {
    const count = rowCount ?? rowLimit;
    super(
      `Query returned ${exact ? "" : "more than "}${fmtRows(count)} rows. ` +
        `This parquet artifact may hold ${fmtRows(rowLimit)}. Nothing was stored, so readers keep the previous ` +
        `build rather than a silently truncated one. Narrow the query, or split it ` +
        `into several bindings that each stay under the limit.`,
    );
    this.name = "ParquetRowLimitError";
    this.rowLimit = rowLimit;
    this.rowCount = count;
    this.exact = exact ?? false;
  }
}

// ---------------------------------------------------------------------------
// DuckDB type inference
// ---------------------------------------------------------------------------

type DuckDBColumnType =
  "BIGINT" | "DOUBLE" | "BOOLEAN" | "TIMESTAMP" | "VARCHAR";

/**
 * Map a driver-reported type string to a DuckDB column type.
 * When no type is declared, defaults to VARCHAR — no guessing from values.
 */
export function inferDuckDBType(
  driverType: string | undefined,
  _sampleValues?: unknown[],
): DuckDBColumnType {
  if (!driverType) return "VARCHAR";

  const ft = driverType.toLowerCase();

  if (ft.includes("bigint") || ft.includes("int8") || ft.includes("int64")) {
    return "BIGINT";
  }
  if (ft.includes("int") || ft.includes("serial") || ft.includes("integer")) {
    return "BIGINT";
  }
  if (
    ft.includes("float") ||
    ft.includes("double") ||
    ft.includes("decimal") ||
    ft.includes("numeric") ||
    ft.includes("real") ||
    ft.includes("money")
  ) {
    return "DOUBLE";
  }
  if (ft.includes("bool")) return "BOOLEAN";
  if (ft.includes("date") || ft.includes("time") || ft.includes("timestamp")) {
    return "TIMESTAMP";
  }

  return "VARCHAR";
}

/**
 * Build the column-name list and a name->DuckDBColumnType map from
 * pre-supplied field metadata and the first batch of rows.
 *
 * 1. Pre-supplied `fields` are authoritative (name + driver type).
 * 2. Columns present in row data but missing from `fields` are inferred
 *    by sampling up to 100 values from the batch.
 */
function resolveColumnSchema(
  fields: FieldMeta[],
  batch: Record<string, unknown>[],
): { columns: string[]; typeMap: Map<string, DuckDBColumnType> } {
  const typeMap = new Map<string, DuckDBColumnType>();
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (!field.name || seen.has(field.name)) continue;
    seen.add(field.name);
    ordered.push(field.name);
    typeMap.set(field.name, inferDuckDBType(field.type, []));
  }

  const colSet = new Set<string>();
  for (const row of batch) {
    for (const key of Object.keys(row)) colSet.add(key);
  }

  for (const col of colSet) {
    if (seen.has(col)) continue;
    seen.add(col);
    ordered.push(col);
    typeMap.set(col, "VARCHAR");
  }

  return { columns: ordered, typeMap };
}

function inferColumnFromBatch(
  _col: string,
  _batch: Record<string, unknown>[],
): DuckDBColumnType {
  return "VARCHAR";
}

// ---------------------------------------------------------------------------
// Value escaping (type-aware)
// ---------------------------------------------------------------------------

/**
 * The text DuckDB casts to the column's type, or null for SQL NULL. Rows reach
 * DuckDB through an appender into an all-VARCHAR staging table and one
 * `INSERT ... SELECT CAST(...)` per slice. They used to travel as an
 * `INSERT INTO _data VALUES (...)` statement per 120 rows, and parsing that
 * SQL text cost about 20 times the CPU of everything else in a build.
 */
export function duckDBCellText(
  value: unknown,
  duckdbType: DuckDBColumnType,
): string | null {
  if (value === null || value === undefined) return null;

  switch (duckdbType) {
    case "BIGINT":
    case "DOUBLE": {
      if (typeof value === "number") {
        return isNaN(value) ? null : String(value);
      }
      if (typeof value === "bigint") return String(value);
      const n = Number(value);
      return isNaN(n) ? null : String(n);
    }
    case "BOOLEAN": {
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      if (value === "true" || value === 1) return "TRUE";
      if (value === "false" || value === 0) return "FALSE";
      return null;
    }
    case "TIMESTAMP": {
      if (value instanceof Date) {
        const ts = value.getTime();
        return isNaN(ts) ? null : value.toISOString();
      }
      if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value as string | number);
        return isNaN(d.getTime()) ? null : d.toISOString();
      }
      return null;
    }
    default: {
      // DuckDB VARCHAR cannot store \u0000: connector payloads with inlined
      // binary (e.g. Close emails with embedded PNG bytes) would otherwise
      // fail the whole batch, so NULs are stripped below.
      // A Date in an untyped column goes out as plain ISO 8601, which every
      // destination casts back to a timestamp. JSON.stringify would wrap it
      // in quotes ("\"2026-…Z\""), and BigQuery's SAFE_CAST turns that into
      // NULL (17 Nov 2026: 11,165 PT Close leads lost their dates).
      const raw =
        value instanceof Date
          ? Number.isNaN(value.getTime())
            ? ""
            : value.toISOString()
          : typeof value === "object" && value !== null
            ? // MongoDB/BSON scalars (ObjectId, Decimal128, Long, Binary, ...)
              // stringify to their canonical form via toString(); nested
              // documents/arrays fall back to JSON. Matches arrow-serializer.
              "_bsontype" in (value as Record<string, unknown>) &&
              typeof (value as { toString?: unknown }).toString === "function"
              ? String(value)
              : JSON.stringify(value)
            : String(value);
      // eslint-disable-next-line no-control-regex
      return raw === undefined ? null : raw.replace(/\u0000/g, "");
    }
  }
}

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Returns true when the error looks like a DuckDB out-of-memory / memory-limit
 * failure. Used by callers that want to retry with a smaller batch size.
 */
export function isDuckDBMemoryError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    msg.includes("failed to pin block") ||
    msg.includes("could not allocate") ||
    msg.includes("Out of Memory") ||
    msg.includes("memory_limit")
  );
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export async function buildParquetFromBatches(
  options: StreamingParquetOptions & {
    streamBatches: (
      insertBatch: (rows: Record<string, unknown>[]) => Promise<void>,
    ) => Promise<void>;
  },
): Promise<StreamingParquetResult> {
  const safeBase = (options.filenameBase || "query-export").replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const dbPath = path.join(
    os.tmpdir(),
    `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.duckdb`,
  );
  const parquetPath = path.join(
    os.tmpdir(),
    `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.parquet`,
  );

  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const duckDbMemoryLimitMb = parsePositiveInt(
    process.env.SYNC_PARQUET_DUCKDB_MEMORY_LIMIT_MB,
    DEFAULT_DUCKDB_MEMORY_LIMIT_MB,
  );
  const duckDbThreads = parsePositiveInt(
    process.env.SYNC_PARQUET_DUCKDB_THREADS,
    DEFAULT_DUCKDB_THREADS,
  );
  const limit = options.rowLimit ?? DEFAULT_PARQUET_ROW_LIMIT;
  let totalRows = 0;
  let truncated = false;
  let limitExceeded: ParquetRowLimitError | null = null;
  // With onRowLimit "fail" + countRowsUpTo: rows seen past the limit, counted
  // but never written.
  let countingPastLimit = false;
  let seenRows = 0;
  let tableCreated = false;
  let columns: string[] = [];
  let columnTypeMap = new Map<string, DuckDBColumnType>();
  const requiredTs = options.requiredTimestampColumns ?? [];
  let appender: DuckDBAppender | null = null;
  let castStageSql = "";

  /**
   * (Re)build the staging table for the current columns. The appender is
   * bound to the table's columns, so a new column means a new appender.
   * Called only between slices, when the staging table is empty.
   */
  const resetStage = async () => {
    appender?.closeSync();
    appender = null;
    await connection.run(
      `CREATE OR REPLACE TEMP TABLE _stage (${columns
        .map(col => `${escapeIdentifier(col)} VARCHAR`)
        .join(", ")})`,
    );
    appender = await connection.createAppender("_stage", "main", "temp");
    castStageSql = `INSERT INTO _data SELECT ${columns
      .map(
        col =>
          `CAST(${escapeIdentifier(col)} AS ${columnTypeMap.get(col) ?? "VARCHAR"})`,
      )
      .join(", ")} FROM _stage`;
  };

  try {
    await connection.run(`PRAGMA threads=${duckDbThreads}`);
    await connection.run(`PRAGMA memory_limit='${duckDbMemoryLimitMb}MB'`);
    await connection.run(
      `PRAGMA temp_directory='${os.tmpdir().replace(/'/g, "''")}'`,
    );

    const insertBatch = async (rows: Record<string, unknown>[]) => {
      if (rows.length === 0) return;
      if (limitExceeded) throw limitExceeded;
      if (countingPastLimit) {
        seenRows += rows.length;
        if (seenRows > (options.countRowsUpTo ?? 0)) {
          limitExceeded = new ParquetRowLimitError(limit, {
            rowCount: options.countRowsUpTo,
            exact: false,
          });
          throw limitExceeded;
        }
        return;
      }

      const remaining = limit - totalRows;
      if (remaining < rows.length) {
        if (options.onRowLimit === "fail") {
          seenRows = totalRows + rows.length;
          if (
            options.countRowsUpTo !== undefined &&
            options.countRowsUpTo > limit &&
            seenRows <= options.countRowsUpTo
          ) {
            // Keep reading to learn the real size; write nothing more.
            countingPastLimit = true;
            return;
          }
          limitExceeded = new ParquetRowLimitError(limit, {
            rowCount: Math.min(seenRows, options.countRowsUpTo ?? limit),
            exact: false,
          });
          throw limitExceeded;
        }
        truncated = true;
        if (remaining <= 0) return;
      }
      const batch = remaining < rows.length ? rows.slice(0, remaining) : rows;

      if (!tableCreated) {
        const schema = resolveColumnSchema(options.fields ?? [], batch);
        columns = schema.columns;
        columnTypeMap = schema.typeMap;
        for (const col of requiredTs) {
          if (columnTypeMap.has(col)) columnTypeMap.set(col, "TIMESTAMP");
        }

        const colDefs = columns.map(
          col =>
            `${escapeIdentifier(col)} ${columnTypeMap.get(col) ?? "VARCHAR"}`,
        );
        await connection.run(`CREATE TABLE _data (${colDefs.join(", ")})`);
        tableCreated = true;
        await resetStage();
      } else {
        const newCols: string[] = [];
        const existingSet = new Set(columns);
        for (const row of batch) {
          for (const key of Object.keys(row)) {
            if (!existingSet.has(key)) {
              existingSet.add(key);
              newCols.push(key);
            }
          }
        }
        if (newCols.length > 0) {
          for (const col of newCols) {
            const colType = requiredTs.includes(col)
              ? "TIMESTAMP"
              : inferColumnFromBatch(col, batch);
            columnTypeMap.set(col, colType);
            await connection.run(
              `ALTER TABLE _data ADD COLUMN ${escapeIdentifier(col)} ${colType}`,
            );
          }
          columns.push(...newCols);
          await resetStage();
        }
      }

      for (const col of requiredTs) {
        let missing = 0;
        for (const row of batch) if (!isValidTimestamp(row[col])) missing++;
        if (missing > 0) throw new MissingRowTimestampError(col, missing);
      }

      if (!appender) await resetStage();
      const stage = appender as unknown as DuckDBAppender;
      const columnTypes = columns.map(
        col => columnTypeMap.get(col) ?? "VARCHAR",
      );
      // Cast what is staged into _data. Flushed by row count and by text
      // size, so a batch of very large cells (emails with inlined files) never
      // sits whole in the appender's buffer.
      const take = Math.min(batch.length, Math.max(0, limit - totalRows));
      let stagedRows = 0;
      let stagedChars = 0;
      const flushStage = async () => {
        if (stagedRows === 0) return;
        stage.flushSync();
        await connection.run(castStageSql);
        await connection.run("TRUNCATE _stage");
        stagedRows = 0;
        stagedChars = 0;
      };
      for (let r = 0; r < take; r++) {
        const row = batch[r];
        for (let c = 0; c < columns.length; c++) {
          const text = duckDBCellText(row[columns[c]], columnTypes[c]);
          if (text === null) {
            stage.appendNull();
          } else {
            stage.appendVarchar(text);
            stagedChars += text.length;
          }
        }
        stage.endRow();
        stagedRows++;
        if (
          stagedRows >= STAGE_FLUSH_ROWS ||
          stagedChars >= STAGE_FLUSH_CHARS
        ) {
          await flushStage();
        }
      }
      await flushStage();
      const insertedInThisCall = take;

      totalRows += insertedInThisCall;

      if (options.onBatchInserted) {
        await options.onBatchInserted(totalRows);
      }
    };

    try {
      await options.streamBatches(insertBatch);
    } catch (error) {
      // Drivers report a throw from the batch callback as their own stream
      // failure (a plain Error with the message). The limit is the cause.
      if (limitExceeded) throw limitExceeded;
      throw error;
    }
    // A driver that swallowed the throw above must not turn it into a
    // complete-looking artifact.
    if (limitExceeded) throw limitExceeded;
    if (countingPastLimit) {
      throw new ParquetRowLimitError(limit, {
        rowCount: seenRows,
        exact: true,
      });
    }

    if (!tableCreated) {
      // Zero rows: the query's schema (from the probe) still defines the
      // artifact, so readers that union partitions positionally or select
      // named columns see the same shape as a non-empty build. `_empty` is
      // only for a query whose schema nobody could tell us.
      const schema = resolveColumnSchema(options.fields ?? [], []);
      const colDefs = schema.columns.map(
        col =>
          `${escapeIdentifier(col)} ${schema.typeMap.get(col) ?? "VARCHAR"}`,
      );
      await connection.run(
        colDefs.length > 0
          ? `CREATE TABLE _data (${colDefs.join(", ")})`
          : `CREATE TABLE _data (_empty VARCHAR)`,
      );
    }

    const writeOptions = options.writeOptions ?? SNAPPY_WRITE_OPTIONS;
    const encodeStartedAt = Date.now();
    await connection.run(buildParquetCopySql(parquetPath, writeOptions));
    const encodeDurationMs = Date.now() - encodeStartedAt;
    const isZstd = writeOptions.codec === "ZSTD";

    const stat = await fsPromises.stat(parquetPath);

    if (truncated) {
      logger.warn("Parquet artifact truncated at its row limit", {
        filenameBase: safeBase,
        rowLimit: limit,
      });
    }
    logger.info("Built parquet file via streaming DuckDB pipeline", {
      rowCount: totalRows,
      truncated,
      byteSize: stat.size,
      compression: writeOptions.codec,
      zstdLevel: isZstd ? writeOptions.zstdLevel : undefined,
      rowGroupSize: writeOptions.rowGroupSize,
      encodeDurationMs,
      parquetPath,
      duckDbMemoryLimitMb,
      duckDbThreads,
    });

    return {
      filePath: parquetPath,
      rowCount: totalRows,
      byteSize: stat.size,
      truncated,
      compression: writeOptions.codec,
      ...(isZstd ? { zstdLevel: writeOptions.zstdLevel } : {}),
      ...(writeOptions.rowGroupSize !== undefined
        ? { rowGroupSize: writeOptions.rowGroupSize }
        : {}),
      encodeDurationMs,
    };
  } finally {
    try {
      (appender as DuckDBAppender | null)?.closeSync();
    } catch {
      /* best-effort */
    }
    try {
      connection.closeSync();
    } catch {
      /* best-effort */
    }
    try {
      instance.closeSync();
    } catch {
      /* best-effort */
    }
    await fsPromises.rm(dbPath, { force: true }).catch(() => undefined);
    await fsPromises
      .rm(`${dbPath}.wal`, { force: true })
      .catch(() => undefined);
  }
}
