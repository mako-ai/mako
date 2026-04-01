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
}

function escapeDuckDBValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) {
    const ts = value.getTime();
    return isNaN(ts) ? "NULL" : `'${value.toISOString()}'`;
  }
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
        const colDefs = columns.map(col => `${escapeIdentifier(col)} VARCHAR`);
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
            await connection.run(
              `ALTER TABLE _data ADD COLUMN ${escapeIdentifier(col)} VARCHAR`,
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
