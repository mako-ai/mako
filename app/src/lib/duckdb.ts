/* eslint-disable no-console */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { normalizeDuckDBValue } from "./normalize-duckdb-value";

const activeDuckDBInstances = new Set<AsyncDuckDB>();
const duckDBInstanceIds = new WeakMap<AsyncDuckDB, number>();
let nextDuckDBInstanceId = 1;
let unloadHandlerRegistered = false;

function getDuckDBInstanceId(db: AsyncDuckDB): number {
  const existing = duckDBInstanceIds.get(db);
  if (existing) {
    return existing;
  }
  const id = nextDuckDBInstanceId++;
  duckDBInstanceIds.set(db, id);
  return id;
}

function trackDuckDBInstance(db: AsyncDuckDB, reason: string): void {
  const id = getDuckDBInstanceId(db);
  activeDuckDBInstances.add(db);
  console.log(
    `[opfs-diag] DuckDB instance #${id} registered (${reason}); activeInstances=${activeDuckDBInstances.size}`,
  );
}

function untrackDuckDBInstance(db: AsyncDuckDB, reason: string): void {
  const id = getDuckDBInstanceId(db);
  activeDuckDBInstances.delete(db);
  console.log(
    `[opfs-diag] DuckDB instance #${id} unregistered (${reason}); activeInstances=${activeDuckDBInstances.size}`,
  );
}

export async function terminateTrackedDuckDBInstance(
  db: AsyncDuckDB,
  reason: string,
): Promise<void> {
  const id = getDuckDBInstanceId(db);
  console.log(`[opfs-diag] Terminating DuckDB instance #${id} (${reason})`);
  try {
    await (db as any).terminate?.();
    console.log(`[opfs-diag] Terminated DuckDB instance #${id} (${reason})`);
  } catch (error) {
    console.warn(
      `[opfs-diag] Failed to terminate DuckDB instance #${id} (${reason})`,
      error,
    );
  } finally {
    untrackDuckDBInstance(db, `${reason}:post-terminate`);
  }
}

function ensureDuckDBUnloadHandler(): void {
  if (typeof window === "undefined" || unloadHandlerRegistered) {
    return;
  }

  window.addEventListener("beforeunload", () => {
    const instances = Array.from(activeDuckDBInstances);
    console.log(
      `[opfs-diag] beforeunload cleanup start; activeInstances=${instances.length}`,
    );
    for (const db of instances) {
      const id = getDuckDBInstanceId(db);
      try {
        void (db as any).terminate?.();
        console.log(
          `[opfs-diag] beforeunload terminate dispatched for DuckDB instance #${id}`,
        );
      } catch (error) {
        console.warn(
          `[opfs-diag] beforeunload terminate failed for DuckDB instance #${id}`,
          error,
        );
      } finally {
        untrackDuckDBInstance(db, "beforeunload");
      }
    }
    console.log("[opfs-diag] beforeunload cleanup end");
  });

  unloadHandlerRegistered = true;
  console.log("[opfs-diag] Registered beforeunload DuckDB cleanup handler");
}

async function createWorkerAndInstantiate(): Promise<AsyncDuckDB> {
  ensureDuckDBUnloadHandler();
  console.log(
    "[opfs-diag] createWorkerAndInstantiate: selecting DuckDB bundle",
  );
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = bundle.mainWorker;
  if (!workerUrl) {
    throw new Error("DuckDB worker URL is unavailable");
  }
  // Always create the worker through a same-origin blob shim (duckdb-wasm's
  // documented pattern). A direct cross-origin `new Worker(cdnUrl)` throws
  // synchronously in Chrome/Firefox (so a try/catch fallback would run), but
  // Safari/WebKit fails *asynchronously* via an error event instead — the
  // catch never fired and DuckDB silently never instantiated on Safari.
  const blobUrl = URL.createObjectURL(
    new Blob([`importScripts(${JSON.stringify(workerUrl)});`], {
      type: "text/javascript",
    }),
  );
  const worker = new Worker(blobUrl);
  console.log(
    `[opfs-diag] createWorkerAndInstantiate: blob worker created for ${workerUrl}`,
  );

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  const id = getDuckDBInstanceId(db);
  console.log(`[opfs-diag] DuckDB instance #${id} instantiating`);
  await db.instantiate(bundle.mainModule);
  console.log(`[opfs-diag] DuckDB instance #${id} instantiated`);
  trackDuckDBInstance(db, "createWorkerAndInstantiate");
  return db;
}

export async function createDuckDBInstance(): Promise<AsyncDuckDB> {
  console.log("[opfs-diag] createDuckDBInstance: creating in-memory DuckDB");
  return createWorkerAndInstantiate();
}

export async function collectStreamBytes(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (bytesReceived: number) => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
      onProgress?.(totalBytes);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

let parquetFileSeq = 0;

export async function loadParquetTable(
  db: AsyncDuckDB,
  tableName: string,
  buffer: Uint8Array,
): Promise<number> {
  // Register each buffer under a UNIQUE virtual filename. duckdb-wasm's
  // registerFileBuffer/dropFile operate on the DB-global WASM virtual
  // filesystem; repeatedly dropping + re-registering the SAME name (what an
  // in-place snapshot reload did, since the name was derived only from the
  // table) eventually leaves a stale handle, so a later read_parquet reads
  // garbage and fails with "Invalid data: TProtocolException". A fresh name per
  // load means we never re-register an existing name; the unique file is then
  // dropped in `finally` to free worker memory. The table itself is still
  // replaced under its stable name via DROP TABLE + CREATE TABLE.
  const fileName = `${tableName}__${Date.now()}_${++parquetFileSeq}.parquet`;
  const dropConn = await db.connect();
  try {
    await dropConn.query(`DROP TABLE IF EXISTS "${tableName}"`);
  } finally {
    await dropConn.close();
  }
  await db.registerFileBuffer(fileName, buffer);
  const conn = await db.connect();
  try {
    await conn.query(
      `CREATE TABLE "${tableName}" AS SELECT * FROM read_parquet('${fileName}')`,
    );
    const result = await conn.query(
      `SELECT count(*) as cnt FROM "${tableName}"`,
    );
    return Number(result.getChild("cnt")?.get(0) ?? 0);
  } finally {
    await conn.close();
    // Free the unique virtual file now that the table is materialized; a
    // failure here is non-fatal (best-effort memory cleanup).
    try {
      await db.dropFile(fileName);
    } catch {
      // Best-effort cleanup; the file may already be gone.
    }
  }
}

export interface DuckDBQueryResult {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
  rowCount: number;
}

/**
 * Execute a SQL query against DuckDB and return rows + field metadata.
 */
export async function queryDuckDB(
  db: AsyncDuckDB,
  sql: string,
): Promise<DuckDBQueryResult> {
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    const schema = result.schema;

    const fields = schema.fields.map(f => ({
      name: f.name,
      type: String(f.type),
    }));

    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < result.numRows; i++) {
      const row: Record<string, unknown> = {};
      for (const field of fields) {
        const col = result.getChild(field.name);
        row[field.name] = normalizeDuckDBValue(col?.get(i));
      }
      rows.push(row);
    }

    return { rows, fields, rowCount: result.numRows };
  } finally {
    await conn.close();
  }
}
