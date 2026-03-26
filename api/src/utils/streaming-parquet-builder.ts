import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { loggers } from "../logging";

const logger = loggers.api("streaming-parquet-builder");

export interface StreamingParquetResult {
  filePath: string;
  rowCount: number;
  byteSize: number;
}

export interface StreamingParquetOptions {
  filenameBase?: string;
  rowLimit?: number;
  onBatchInserted?: (totalRows: number) => Promise<void>;
  /**
   * Column name → DuckDB type override. When a column appears here its type
   * is used verbatim instead of being inferred from data samples.
   *
   * Typical use: read the live BQ table's INFORMATION_SCHEMA before building
   * Parquet so staging types match the existing table exactly.
   */
  columnTypeOverrides?: Map<string, string>;
}

function escapeDuckDBValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (value instanceof Date) {
    const ts = value.getTime();
    if (isNaN(ts)) return "NULL";
    return `'${value.toISOString()}'::TIMESTAMP`;
  }
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str) && !isNaN(Date.parse(str))) {
    return `'${str.replace(/'/g, "''")}'::TIMESTAMP`;
  }
  return `'${str.replace(/'/g, "''")}'`;
}

function inferDuckDBType(values: unknown[]): string {
  for (const val of values) {
    if (val == null) continue;
    if (typeof val === "boolean") return "BOOLEAN";
    if (typeof val === "number") {
      if (Number.isInteger(val) && Math.abs(val) < 2147483647) return "INTEGER";
      return "DOUBLE";
    }
    if (val instanceof Date) return "TIMESTAMP";
    if (typeof val === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(val) && !isNaN(Date.parse(val))) {
        return "TIMESTAMP";
      }
    }
  }
  return "VARCHAR";
}

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Map BigQuery INFORMATION_SCHEMA data_type to a compatible DuckDB type for Parquet. */
export function bigQueryTypeToDuckDb(bq: string): string {
  const u = bq.trim().toUpperCase();
  if (u === "STRING" || u === "TEXT") return "VARCHAR";
  if (u === "INT64" || u === "INTEGER") return "BIGINT";
  if (u === "INT32") return "INTEGER";
  if (u === "FLOAT64" || u === "FLOAT" || u === "FLOAT32") return "DOUBLE";
  if (u === "BOOL" || u === "BOOLEAN") return "BOOLEAN";
  if (u === "BYTES") return "BLOB";
  if (u === "DATE") return "DATE";
  if (u === "DATETIME") return "TIMESTAMP";
  if (u === "TIME") return "TIME";
  if (u.startsWith("TIMESTAMP")) return "TIMESTAMP";
  if (u === "NUMERIC" || u === "BIGNUMERIC") return "DOUBLE";
  return "VARCHAR";
}

function resolveColumnType(
  column: string,
  samples: unknown[],
  overrides: Map<string, string>,
): string {
  const override = overrides.get(column);
  if (override) return override;
  return inferDuckDBType(samples);
}

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
  const overrides = options.columnTypeOverrides ?? new Map<string, string>();

  try {
    const insertBatch = async (rows: Record<string, unknown>[]) => {
      if (rows.length === 0) return;

      const limit = options.rowLimit ?? 500000;
      const remaining = limit - totalRows;
      if (remaining <= 0) return;
      const batch = remaining < rows.length ? rows.slice(0, remaining) : rows;

      if (!tableCreated) {
        const colSet = new Set<string>();
        for (const row of batch) {
          for (const key of Object.keys(row)) colSet.add(key);
        }
        columns = Array.from(colSet);
        const sampleSize = Math.min(100, batch.length);
        const colDefs = columns.map(col => {
          const samples = [];
          for (let i = 0; i < sampleSize; i++) {
            samples.push(batch[i]?.[col]);
          }
          return `${escapeIdentifier(col)} ${resolveColumnType(col, samples, overrides)}`;
        });
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
          const sampleSize = Math.min(100, batch.length);
          for (const col of newCols) {
            const samples = [];
            for (let i = 0; i < sampleSize; i++) {
              samples.push(batch[i]?.[col]);
            }
            await connection.run(
              `ALTER TABLE _data ADD COLUMN ${escapeIdentifier(col)} ${resolveColumnType(col, samples, overrides)}`,
            );
          }
          columns.push(...newCols);
        }
      }

      const valueRows = batch.map(
        row =>
          `(${columns.map(col => escapeDuckDBValue(row[col])).join(", ")})`,
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
