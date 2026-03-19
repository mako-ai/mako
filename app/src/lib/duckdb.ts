import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

let dbInstance: AsyncDuckDB | null = null;
let initPromise: Promise<AsyncDuckDB> | null = null;

/**
 * Lazily initialize DuckDB-WASM in single-threaded mode.
 * Returns a singleton instance shared across all dashboards.
 */
export async function initDuckDB(): Promise<AsyncDuckDB> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
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
        row[field.name] = col?.get(i);
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
        buffer: buffer.buffer,
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
