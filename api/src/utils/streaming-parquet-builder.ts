import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { loggers } from "../logging";

const logger = loggers.api("streaming-parquet-builder");

/** Max rows per INSERT VALUES clause to cap peak JS heap (SQL string materialization). */
const INSERT_MICRO_BATCH_ROWS = 120;
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
}

export interface StreamingParquetOptions {
  filenameBase?: string;
  rowLimit?: number;
  fields?: FieldMeta[];
  onBatchInserted?: (totalRows: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// DuckDB type inference
// ---------------------------------------------------------------------------

type DuckDBColumnType =
  | "BIGINT"
  | "DOUBLE"
  | "BOOLEAN"
  | "TIMESTAMP"
  | "VARCHAR";

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

function escapeDuckDBValue(
  value: unknown,
  duckdbType: DuckDBColumnType,
): string {
  if (value === null || value === undefined) return "NULL";

  switch (duckdbType) {
    case "BIGINT":
    case "DOUBLE": {
      if (typeof value === "number") return String(value);
      if (typeof value === "bigint") return String(value);
      const n = Number(value);
      return isNaN(n) ? "NULL" : String(n);
    }
    case "BOOLEAN": {
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      if (value === "true" || value === 1) return "TRUE";
      if (value === "false" || value === 0) return "FALSE";
      return "NULL";
    }
    case "TIMESTAMP": {
      if (value instanceof Date) {
        const ts = value.getTime();
        return isNaN(ts) ? "NULL" : `'${value.toISOString()}'`;
      }
      if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value as string | number);
        return isNaN(d.getTime()) ? "NULL" : `'${d.toISOString()}'`;
      }
      return "NULL";
    }
    default: {
      // DuckDB VARCHAR cannot store \u0000, and an embedded NUL truncates the
      // SQL at the napi/C++ boundary — the parser then sees an unterminated
      // '...' literal. Strip NULs at the boundary before the single-quote
      // escape so connector payloads with inlined binary (e.g. Close emails
      // with embedded PNG bytes) don't kill the whole batch.
      const raw =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      // eslint-disable-next-line no-control-regex
      const stripped = raw.replace(/\u0000/g, "");
      return `'${stripped.replace(/'/g, "''")}'`;
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
  const safeBase = (options.filenameBase || "dashboard-export").replace(
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
  let totalRows = 0;
  let tableCreated = false;
  let columns: string[] = [];
  let columnTypeMap = new Map<string, DuckDBColumnType>();

  try {
    await connection.run(`PRAGMA threads=${duckDbThreads}`);
    await connection.run(`PRAGMA memory_limit='${duckDbMemoryLimitMb}MB'`);
    await connection.run(
      `PRAGMA temp_directory='${os.tmpdir().replace(/'/g, "''")}'`,
    );

    const insertBatch = async (rows: Record<string, unknown>[]) => {
      if (rows.length === 0) return;

      const limit = options.rowLimit ?? 500000;
      const remaining = limit - totalRows;
      if (remaining <= 0) return;
      const batch = remaining < rows.length ? rows.slice(0, remaining) : rows;

      if (!tableCreated) {
        const schema = resolveColumnSchema(options.fields ?? [], batch);
        columns = schema.columns;
        columnTypeMap = schema.typeMap;

        const colDefs = columns.map(
          col =>
            `${escapeIdentifier(col)} ${columnTypeMap.get(col) ?? "VARCHAR"}`,
        );
        await connection.run(`CREATE TABLE _data (${colDefs.join(", ")})`);
        tableCreated = true;
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
            const colType = inferColumnFromBatch(col, batch);
            columnTypeMap.set(col, colType);
            await connection.run(
              `ALTER TABLE _data ADD COLUMN ${escapeIdentifier(col)} ${colType}`,
            );
          }
          columns.push(...newCols);
        }
      }

      let insertedInThisCall = 0;
      for (
        let offset = 0;
        offset < batch.length;
        offset += INSERT_MICRO_BATCH_ROWS
      ) {
        const room = limit - totalRows - insertedInThisCall;
        if (room <= 0) break;
        const sliceLen = Math.min(
          INSERT_MICRO_BATCH_ROWS,
          batch.length - offset,
          room,
        );
        const slice = batch.slice(offset, offset + sliceLen);
        const valueRows = slice.map(
          row =>
            `(${columns.map(col => escapeDuckDBValue(row[col], columnTypeMap.get(col) ?? "VARCHAR")).join(", ")})`,
        );
        await connection.run(
          `INSERT INTO _data VALUES ${valueRows.join(", ")}`,
        );
        insertedInThisCall += slice.length;
      }

      totalRows += insertedInThisCall;

      if (options.onBatchInserted) {
        await options.onBatchInserted(totalRows);
      }
    };

    await options.streamBatches(insertBatch);

    if (!tableCreated) {
      await connection.run(`CREATE TABLE _data (_empty VARCHAR)`);
    }

    await connection.run(
      `COPY _data TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    const stat = await fsPromises.stat(parquetPath);

    logger.info("Built parquet file via streaming DuckDB pipeline", {
      rowCount: totalRows,
      byteSize: stat.size,
      parquetPath,
      duckDbMemoryLimitMb,
      duckDbThreads,
    });

    return {
      filePath: parquetPath,
      rowCount: totalRows,
      byteSize: stat.size,
    };
  } finally {
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
