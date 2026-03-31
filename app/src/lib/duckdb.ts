/* eslint-disable no-console */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

let dbInstance: AsyncDuckDB | null = null;
let initPromise: Promise<AsyncDuckDB> | null = null;
const activeDuckDBInstances = new Set<AsyncDuckDB>();
const duckDBInstanceIds = new WeakMap<AsyncDuckDB, number>();
let nextDuckDBInstanceId = 1;
let unloadHandlerRegistered = false;
const httpfsInitState = new WeakMap<AsyncDuckDB, Promise<boolean>>();

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

export function untrackDuckDBInstance(db: AsyncDuckDB, reason: string): void {
  const id = getDuckDBInstanceId(db);
  activeDuckDBInstances.delete(db);
  if (dbInstance === db) {
    dbInstance = null;
    initPromise = null;
  }
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
  let worker: Worker;
  try {
    worker = new Worker(workerUrl);
    console.log(
      `[opfs-diag] createWorkerAndInstantiate: worker created from ${workerUrl}`,
    );
  } catch {
    console.warn(
      `[opfs-diag] createWorkerAndInstantiate: direct worker creation failed for ${workerUrl}, falling back to blob worker`,
    );
    const resp = await fetch(workerUrl);
    const blob = new Blob([await resp.text()], { type: "text/javascript" });
    worker = new Worker(URL.createObjectURL(blob));
    console.log(
      "[opfs-diag] createWorkerAndInstantiate: blob worker created successfully",
    );
  }

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  const id = getDuckDBInstanceId(db);
  console.log(`[opfs-diag] DuckDB instance #${id} instantiating`);
  await db.instantiate(bundle.mainModule);
  console.log(`[opfs-diag] DuckDB instance #${id} instantiated`);
  trackDuckDBInstance(db, "createWorkerAndInstantiate");
  return db;
}

export async function ensureHttpfsLoaded(db: AsyncDuckDB): Promise<boolean> {
  const existing = httpfsInitState.get(db);
  if (existing) {
    return await existing;
  }

  const init = (async () => {
    const conn = await db.connect();
    try {
      await conn.query("INSTALL httpfs");
      await conn.query("LOAD httpfs");
      return true;
    } catch (error) {
      console.warn("[opfs-diag] Failed to load DuckDB httpfs extension", error);
      return false;
    } finally {
      await conn.close();
    }
  })();

  httpfsInitState.set(db, init);
  return await init;
}

export async function createDuckDBInstance(): Promise<AsyncDuckDB> {
  console.log("[opfs-diag] createDuckDBInstance: creating in-memory DuckDB");
  return createWorkerAndInstantiate();
}

/**
 * Lazily initialize DuckDB-WASM in single-threaded mode.
 * Returns a singleton instance shared across all dashboards.
 */
export async function initDuckDB(): Promise<AsyncDuckDB> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const db = await createDuckDBInstance();
    dbInstance = db;
    return db;
  })();

  return initPromise;
}

/**
 * Get the current DuckDB instance (null if not initialized).
 */
export function getDuckDB(): AsyncDuckDB | null {
  return dbInstance;
}

/**
 * Register an Arrow IPC buffer as a named table in DuckDB.
 */
export async function loadArrowTable(
  db: AsyncDuckDB,
  tableName: string,
  arrowBuffer: Uint8Array,
): Promise<void> {
  console.log(
    `[opfs-diag] loadArrowTable start: table="${tableName}" bytes=${arrowBuffer.byteLength}`,
  );
  if (arrowBuffer.byteLength === 0) {
    console.warn(
      `[opfs-diag] loadArrowTable early return: table="${tableName}" received 0-byte Arrow buffer`,
    );
    return;
  }
  await db.registerFileBuffer(`${tableName}.arrow`, arrowBuffer);
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.query(
      `CREATE TABLE "${tableName}" AS SELECT * FROM '${tableName}.arrow'`,
    );
    console.log(
      `[opfs-diag] loadArrowTable success: table="${tableName}" bytes=${arrowBuffer.byteLength}`,
    );
  } finally {
    await conn.close();
    console.log(
      `[opfs-diag] loadArrowTable connection closed: table="${tableName}"`,
    );
  }
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

async function countTableRows(
  db: AsyncDuckDB,
  tableName: string,
): Promise<number> {
  const conn = await db.connect();
  try {
    const result = await conn.query(
      `SELECT count(*) as cnt FROM "${tableName}"`,
    );
    return Number(result.getChild("cnt")?.get(0) ?? 0);
  } finally {
    await conn.close();
  }
}

async function insertArrowStreamWithChunks(
  conn: any,
  tableName: string,
  stream: ReadableStream<Uint8Array>,
  onProgress?: (bytesReceived: number) => void,
): Promise<number> {
  const reader = stream.getReader();
  let bytesReceived = 0;
  let chunksReceived = 0;

  try {
    console.log(
      `[opfs-diag] insertArrowStreamWithChunks start: table="${tableName}"`,
    );
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      chunksReceived += 1;
      bytesReceived += value.byteLength;
      if (chunksReceived === 1) {
        console.log(
          `[opfs-diag] insertArrowStreamWithChunks first chunk: table="${tableName}" bytes=${value.byteLength}`,
        );
      }
      onProgress?.(bytesReceived);
      await conn.insertArrowFromIPCStream(value, { name: tableName });
    }

    if (bytesReceived === 0) {
      console.warn(
        `[opfs-diag] insertArrowStreamWithChunks empty stream: table="${tableName}"`,
      );
      return 0;
    }

    // DuckDB-WASM's chunked insert API requires an explicit end-of-stream marker.
    await conn.insertArrowFromIPCStream(
      new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]),
      { name: tableName },
    );
    console.log(
      `[opfs-diag] insertArrowStreamWithChunks success: table="${tableName}" chunks=${chunksReceived} bytes=${bytesReceived}`,
    );
    return bytesReceived;
  } catch (error) {
    console.warn(
      `[opfs-diag] insertArrowStreamWithChunks failed: table="${tableName}" chunks=${chunksReceived} bytes=${bytesReceived}`,
      error,
    );
    throw error;
  } finally {
    reader.releaseLock();
    console.log(
      `[opfs-diag] insertArrowStreamWithChunks reader released: table="${tableName}"`,
    );
  }
}

/**
 * Load an Arrow IPC ReadableStream into DuckDB with bounded browser memory.
 * Falls back to buffering the full stream if the current DuckDB-WASM build
 * does not support incremental IPC insertion. Returns the inserted row count.
 */
export async function loadArrowStreamTable(
  db: AsyncDuckDB,
  tableName: string,
  stream: ReadableStream<Uint8Array>,
  options?: {
    onProgress?: (bytesReceived: number) => void;
  },
): Promise<number> {
  const conn = await db.connect();

  try {
    console.log(
      `[opfs-diag] loadArrowStreamTable start: table="${tableName}" streamingApi=${typeof (conn as any).insertArrowFromIPCStream === "function"}`,
    );
    if (typeof (conn as any).insertArrowFromIPCStream === "function") {
      const [primaryStream, fallbackStream] =
        typeof stream.tee === "function" ? stream.tee() : [stream, null];

      try {
        const bytesLoaded = await insertArrowStreamWithChunks(
          conn,
          tableName,
          primaryStream,
          options?.onProgress,
        );
        console.log(
          `[opfs-diag] loadArrowStreamTable streaming path finished: table="${tableName}" bytes=${bytesLoaded}`,
        );
        const rowCount = await countTableRows(db, tableName);
        console.log(
          `[opfs-diag] loadArrowStreamTable streaming row count: table="${tableName}" rows=${rowCount}`,
        );
        return rowCount;
      } catch (error) {
        if (fallbackStream) {
          console.warn(
            `[opfs-diag] loadArrowStreamTable streaming path failed; starting buffered Arrow fallback for table="${tableName}"`,
            error,
          );
          const arrowBuffer = await collectStreamBytes(fallbackStream);
          console.log(
            `[opfs-diag] loadArrowStreamTable buffered fallback collected bytes: table="${tableName}" bytes=${arrowBuffer.byteLength}`,
          );
          await loadArrowTable(db, tableName, arrowBuffer);
          const rowCount = await countTableRows(db, tableName);
          console.log(
            `[opfs-diag] loadArrowStreamTable buffered fallback row count: table="${tableName}" rows=${rowCount}`,
          );
          return rowCount;
        }
        console.warn(
          `[opfs-diag] loadArrowStreamTable no buffered fallback available for table="${tableName}"`,
          error,
        );
        throw error;
      }
    }

    console.log(
      `[opfs-diag] loadArrowStreamTable streaming API unavailable; buffering full stream for table="${tableName}"`,
    );
    const arrowBuffer = await collectStreamBytes(stream, options?.onProgress);
    if (arrowBuffer.byteLength === 0) {
      console.warn(
        `[opfs-diag] loadArrowStreamTable received 0-byte Arrow buffer after collect: table="${tableName}"`,
      );
      return 0;
    }
    await loadArrowTable(db, tableName, arrowBuffer);
    const rowCount = await countTableRows(db, tableName);
    console.log(
      `[opfs-diag] loadArrowStreamTable buffered-only path row count: table="${tableName}" rows=${rowCount}`,
    );
    return rowCount;
  } finally {
    await conn.close();
    console.log(
      `[opfs-diag] loadArrowStreamTable connection closed: table="${tableName}"`,
    );
  }
}

/**
 * Load JSON rows as a named table in DuckDB.
 * Simpler and more reliable than Arrow IPC for moderate datasets.
 */
export async function loadJsonTable(
  db: AsyncDuckDB,
  tableName: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;

  const jsonStr = JSON.stringify(rows);
  const encoder = new TextEncoder();
  const buffer = encoder.encode(jsonStr);

  await db.registerFileBuffer(`${tableName}.json`, buffer);
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.query(
      `CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${tableName}.json')`,
    );
  } finally {
    await conn.close();
  }
}

/**
 * Load newline-delimited JSON from a ReadableStream into DuckDB in bounded batches.
 * This avoids materializing a single giant JSON array in browser memory.
 */
export async function loadNdjsonStreamTable(
  db: AsyncDuckDB,
  tableName: string,
  stream: ReadableStream<Uint8Array>,
  options?: {
    batchLineCount?: number;
    onProgress?: (rowsLoaded: number) => void;
  },
): Promise<number> {
  const batchLineCount = Math.max(1, options?.batchLineCount || 2000);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const tempPath = `__mako_stream_${tableName}.jsonl`;
  const conn = await db.connect();

  let pendingText = "";
  let pendingLines: string[] = [];
  let insertedRows = 0;
  let tableCreated = false;

  const normalizeNestedValue = (value: unknown): unknown => {
    if (value === null || value === undefined) {
      return null;
    }

    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return value;
  };

  const normalizeJsonLine = (line: string): string => {
    const parsed = JSON.parse(line) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return line;
    }

    const normalized = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        normalizeNestedValue(value),
      ]),
    );

    return JSON.stringify(normalized);
  };

  const flushBatch = async () => {
    if (pendingLines.length === 0) {
      return;
    }

    const batchText = pendingLines.map(normalizeJsonLine).join("\n");
    insertedRows += pendingLines.length;
    pendingLines = [];

    await db.registerFileText(tempPath, batchText);

    if (!tableCreated) {
      await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
      await conn.query(
        `CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${tempPath}', format = 'newline_delimited')`,
      );
      tableCreated = true;
      options?.onProgress?.(insertedRows);
      return;
    }

    await conn.query(
      `INSERT INTO "${tableName}" SELECT * FROM read_json_auto('${tempPath}', format = 'newline_delimited')`,
    );

    options?.onProgress?.(insertedRows);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      pendingText += decoder.decode(value, { stream: true });
      const lines = pendingText.split(/\r?\n/);
      pendingText = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        pendingLines.push(trimmed);
        if (pendingLines.length >= batchLineCount) {
          await flushBatch();
        }
      }
    }

    pendingText += decoder.decode();
    if (pendingText.trim()) {
      pendingLines.push(pendingText.trim());
    }

    await flushBatch();

    if (!tableCreated) {
      await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    }

    return insertedRows;
  } finally {
    reader.releaseLock();
    await conn.close();
  }
}

export async function loadParquetTable(
  db: AsyncDuckDB,
  tableName: string,
  buffer: Uint8Array,
): Promise<number> {
  await db.registerFileBuffer(`${tableName}.parquet`, buffer);
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.query(
      `CREATE TABLE "${tableName}" AS SELECT * FROM read_parquet('${tableName}.parquet')`,
    );
    const result = await conn.query(
      `SELECT count(*) as cnt FROM "${tableName}"`,
    );
    return Number(result.getChild("cnt")?.get(0) ?? 0);
  } finally {
    await conn.close();
  }
}

export async function attachRemoteParquetSource(
  db: AsyncDuckDB,
  tableName: string,
  parquetUrl: string,
): Promise<void> {
  const resolvedParquetUrl =
    typeof window !== "undefined"
      ? new URL(parquetUrl, window.location.origin).toString()
      : parquetUrl;
  await ensureHttpfsLoaded(db);
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.query(`DROP VIEW IF EXISTS "${tableName}"`);
    await conn.query(
      `CREATE VIEW "${tableName}" AS SELECT * FROM read_parquet('${resolvedParquetUrl}')`,
    );
  } finally {
    await conn.close();
  }
}

export interface DuckDBQueryResult {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
  rowCount: number;
}

function normalizeDuckDBValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    if (value <= max && value >= min) {
      return Number(value);
    }
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDuckDBValue);
  }

  if (value && typeof value === "object") {
    // Arrow Decimal128/typed-array values: coerce to number via toString()
    if (ArrayBuffer.isView(value)) {
      const num = Number(value.toString());
      return Number.isNaN(num) ? value.toString() : num;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeDuckDBValue(nested),
      ]),
    );
  }

  return value;
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

/**
 * Drop a table from DuckDB.
 */
export async function dropTable(
  db: AsyncDuckDB,
  tableName: string,
): Promise<void> {
  const conn = await db.connect();
  try {
    await conn.query(`DROP VIEW IF EXISTS "${tableName}"`);
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
  } finally {
    await conn.close();
  }
}

/**
 * Describe a table's columns (name + type).
 */
export async function describeTable(
  db: AsyncDuckDB,
  tableName: string,
): Promise<Array<{ name: string; type: string }>> {
  const conn = await db.connect();
  try {
    const result = await conn.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY ordinal_position`,
    );
    const rows: Array<{ name: string; type: string }> = [];
    for (let i = 0; i < result.numRows; i++) {
      rows.push({
        name: String(result.getChild("column_name")?.get(i)),
        type: String(result.getChild("data_type")?.get(i)),
      });
    }
    return rows;
  } finally {
    await conn.close();
  }
}

/**
 * Get the list of all tables currently loaded in DuckDB.
 */
export async function listTables(db: AsyncDuckDB): Promise<string[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query("SHOW TABLES");
    const tables: string[] = [];
    for (let i = 0; i < result.numRows; i++) {
      tables.push(String(result.getChild("name")?.get(i)));
    }
    return tables;
  } finally {
    await conn.close();
  }
}

// --- IndexedDB payload caching ---

const CACHE_DB_NAME = "mako-dashboard-cache";
const CACHE_STORE_NAME = "dashboard-payload-cache";
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour

export type DuckDBPayloadFormat = "arrow" | "parquet" | "ndjson";

interface CacheEntry {
  key: string;
  buffer: ArrayBuffer;
  timestamp: number;
  rowCount: number;
  byteSize: number;
  queryHash: string;
  format: DuckDBPayloadFormat;
}

function openCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a cache key for a data source export.
 */
export async function getCacheKey(
  consoleId: string,
  queryContent: string,
  connectionId: string,
): Promise<string> {
  const queryHash = await hashString(queryContent);
  return `${consoleId}:${queryHash}:${connectionId}`;
}

/**
 * Check if a cached Arrow buffer exists and is fresh.
 */
export async function getCachedPayload(
  cacheKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ buffer: Uint8Array; format: DuckDBPayloadFormat } | null> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(cacheKey);
      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }
        const age = Date.now() - entry.timestamp;
        if (age > ttlMs) {
          resolve(null);
          return;
        }
        resolve({
          buffer: new Uint8Array(entry.buffer),
          format: entry.format || "arrow",
        });
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/**
 * Store an Arrow buffer in the cache.
 */
export async function setCachedPayload(
  cacheKey: string,
  buffer: Uint8Array,
  queryHash: string,
  rowCount: number,
  format: DuckDBPayloadFormat,
): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const entry: CacheEntry = {
        key: cacheKey,
        buffer: buffer.slice().buffer as ArrayBuffer,
        timestamp: Date.now(),
        rowCount,
        byteSize: buffer.byteLength,
        queryHash,
        format,
      };
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Cache write failure is non-critical
  }
}

export async function getCachedArrow(
  cacheKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<Uint8Array | null> {
  const payload = await getCachedPayload(cacheKey, ttlMs);
  return payload?.format === "arrow" ? payload.buffer : null;
}

export async function setCachedArrow(
  cacheKey: string,
  buffer: Uint8Array,
  queryHash: string,
  rowCount: number,
): Promise<void> {
  await setCachedPayload(cacheKey, buffer, queryHash, rowCount, "arrow");
}

/**
 * Clear all cached data.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silent
  }
}

/**
 * Remove a specific cache entry.
 */
export async function removeCacheEntry(cacheKey: string): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.delete(cacheKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silent
  }
}
