import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

let dbInstance: AsyncDuckDB | null = null;
let initPromise: Promise<AsyncDuckDB> | null = null;

async function createWorkerAndInstantiate(): Promise<AsyncDuckDB> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = bundle.mainWorker!;
  let worker: Worker;
  try {
    worker = new Worker(workerUrl);
  } catch {
    const resp = await fetch(workerUrl);
    const blob = new Blob([await resp.text()], { type: "text/javascript" });
    worker = new Worker(URL.createObjectURL(blob));
  }

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule);
  return db;
}

export async function createDuckDBInstance(): Promise<AsyncDuckDB> {
  return createWorkerAndInstantiate();
}

export function isOPFSAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"
  );
}

/**
 * Create a DuckDB instance backed by OPFS so data persists across page reloads.
 */
export async function createPersistentDuckDBInstance(
  opfsPath: string,
): Promise<AsyncDuckDB> {
  const duckdb = await import("@duckdb/duckdb-wasm");
  const db = await createWorkerAndInstantiate();
  await db.open({
    path: opfsPath,
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  });
  return db;
}

export async function checkpointDatabase(db: AsyncDuckDB): Promise<void> {
  const conn = await db.connect();
  try {
    await conn.query("CHECKPOINT");
  } finally {
    await conn.close();
  }
}

export async function deleteOPFSFiles(dashboardId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const name = `mako_dashboard_${dashboardId}.db`;
    await root.removeEntry(name).catch(() => {});
    await root.removeEntry(`${name}.wal`).catch(() => {});
  } catch {
    // OPFS not available or file doesn't exist
  }
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
  await db.registerFileBuffer(`${tableName}.arrow`, arrowBuffer);
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.query(
      `CREATE TABLE "${tableName}" AS SELECT * FROM '${tableName}.arrow'`,
    );
  } finally {
    await conn.close();
  }
}

async function collectStreamBytes(
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

  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      bytesReceived += value.byteLength;
      onProgress?.(bytesReceived);
      await conn.insertArrowFromIPCStream(value, { name: tableName });
    }

    // DuckDB-WASM's chunked insert API requires an explicit end-of-stream marker.
    await conn.insertArrowFromIPCStream(
      new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]),
      { name: tableName },
    );
    return bytesReceived;
  } finally {
    reader.releaseLock();
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
    if (typeof (conn as any).insertArrowFromIPCStream === "function") {
      const [primaryStream, fallbackStream] =
        typeof stream.tee === "function" ? stream.tee() : [stream, null];

      try {
        await insertArrowStreamWithChunks(
          conn,
          tableName,
          primaryStream,
          options?.onProgress,
        );
        return await countTableRows(db, tableName);
      } catch (error) {
        if (fallbackStream) {
          const arrowBuffer = await collectStreamBytes(fallbackStream);
          await loadArrowTable(db, tableName, arrowBuffer);
          return await countTableRows(db, tableName);
        }
        throw error;
      }
    }

    const arrowBuffer = await collectStreamBytes(stream, options?.onProgress);
    if (arrowBuffer.byteLength === 0) {
      return 0;
    }
    await loadArrowTable(db, tableName, arrowBuffer);
    return await countTableRows(db, tableName);
  } finally {
    await conn.close();
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

// --- OPFS Data Caching ---

const CACHE_DB_NAME = "mako-dashboard-cache";
const CACHE_STORE_NAME = "arrow-cache";
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour

interface CacheEntry {
  key: string;
  buffer: ArrayBuffer;
  timestamp: number;
  rowCount: number;
  byteSize: number;
  queryHash: string;
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
export async function getCachedArrow(
  cacheKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<Uint8Array | null> {
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
        resolve(new Uint8Array(entry.buffer));
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
export async function setCachedArrow(
  cacheKey: string,
  buffer: Uint8Array,
  queryHash: string,
  rowCount: number,
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
      };
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Cache write failure is non-critical
  }
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
