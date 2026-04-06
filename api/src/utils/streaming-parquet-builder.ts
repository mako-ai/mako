import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { loggers } from "../logging";

const logger = loggers.api("streaming-parquet-builder");

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
 * Map a driver-reported type string and/or JS sample values to a DuckDB
 * column type.  The driver type string (from `getStreamingQueryFields` or
 * similar) is checked first; if absent or unrecognised we fall back to
 * inspecting the first non-null sample value.
 */
export function inferDuckDBType(
  driverType: string | undefined,
  sampleValues: unknown[],
): DuckDBColumnType {
  if (driverType) {
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
    if (
      ft.includes("date") ||
      ft.includes("time") ||
      ft.includes("timestamp")
    ) {
      return "TIMESTAMP";
    }

    return "VARCHAR";
  }

  for (const val of sampleValues) {
    if (val == null) continue;
    if (typeof val === "boolean") return "BOOLEAN";
    if (typeof val === "bigint") return "BIGINT";
    if (typeof val === "number") {
      return Number.isInteger(val) ? "BIGINT" : "DOUBLE";
    }
    if (val instanceof Date) return "TIMESTAMP";
    if (typeof val === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(val) && !isNaN(Date.parse(val))) {
        return "TIMESTAMP";
      }
    }
    break;
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
    const samples: unknown[] = [];
    const limit = Math.min(100, batch.length);
    for (let i = 0; i < limit; i++) {
      samples.push(batch[i]?.[col]);
    }
    typeMap.set(col, inferDuckDBType(undefined, samples));
  }

  return { columns: ordered, typeMap };
}

/**
 * Infer type for a single late-discovered column by sampling values from
 * the current batch.
 */
function inferColumnFromBatch(
  col: string,
  batch: Record<string, unknown>[],
): DuckDBColumnType {
  const samples: unknown[] = [];
  const limit = Math.min(100, batch.length);
  for (let i = 0; i < limit; i++) {
    samples.push(batch[i]?.[col]);
  }
  return inferDuckDBType(undefined, samples);
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
      if (typeof value === "object") {
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
      }
      return `'${String(value).replace(/'/g, "''")}'`;
    }
  }
}

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
  let totalRows = 0;
  let tableCreated = false;
  let columns: string[] = [];
  let columnTypeMap = new Map<string, DuckDBColumnType>();

  try {
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

      const valueRows = batch.map(
        row =>
          `(${columns.map(col => escapeDuckDBValue(row[col], columnTypeMap.get(col) ?? "VARCHAR")).join(", ")})`,
      );

      const CHUNK_SIZE = 1000;
      for (let i = 0; i < valueRows.length; i += CHUNK_SIZE) {
        const chunk = valueRows.slice(i, i + CHUNK_SIZE);
        await connection.run(`INSERT INTO _data VALUES ${chunk.join(", ")}`);
      }

      totalRows += batch.length;

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
    });

    return {
      filePath: parquetPath,
      rowCount: totalRows,
      byteSize: stat.size,
    };
  } finally {
    connection.closeSync();
    await fsPromises.rm(dbPath, { force: true }).catch(() => undefined);
    await fsPromises
      .rm(`${dbPath}.wal`, { force: true })
      .catch(() => undefined);
  }
}
