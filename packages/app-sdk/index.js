// @makoai/app-sdk — see package.json. Plain ESM on purpose: no build step.
import * as React from "react";
import {
  PROGRESS_ACCEPT,
  combineBindingProgress,
  isProgressResponse,
  progressError,
  readBytes,
  readProgressStream,
} from "./progress.js";
export {
  BINDING_PHASES,
  BINDING_PHASE_LABELS,
  BINDING_STAGE_LABELS,
  bindingPhaseLabel,
  bindingPhaseStage,
} from "./progress.js";

import {
  missingBinding,
  mentionedBindings,
  quoteIdent,
  readsCatalog,
  quoteString,
  isOutOfMemoryError,
  retryDelayMs,
  toPlainRows,
  parseBindingSnapshot,
  snapshotUrl,
} from "./data-core.js";

/**
 * This package's version, visible at runtime: `window.__MAKO_APP_SDK__`
 * in a page (or this export) says which SDK a deployed app actually runs.
 * Kept in step with package.json by snapshot.test.mjs.
 */
export const SDK_VERSION = "2.12.0";
if (typeof window !== "undefined") {
  try {
    window.__MAKO_APP_SDK__ = SDK_VERSION;
  } catch {
    /* a frozen window: nothing to stamp */
  }
}

const DEFAULT_ROW_LIMIT = 500000;
const DUCKDB_ESM =
  "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

// ---------------------------------------------------------------------------
// DuckDB: one lazy instance per page, bindings registered on first use. The
// engine arrives from the CDN at runtime, so this package needs no install
// step and no dependencies of its own. The first data hook to render starts
// the boot (WASM download + instantiate, ~1 s) so it overlaps the first
// parquet download instead of waiting for it.
// ---------------------------------------------------------------------------
let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const duckdb = await import(/* @vite-ignore */ DUCKDB_ESM);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const worker = await duckdb.createWorker(bundle.mainWorker);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      // read_parquet lives in an extension DuckDB fetches on first use
      // (~660 kB from extensions.duckdb.org). Load it now, while the
      // binding bytes are still downloading, not after they arrive.
      const conn = await db.connect();
      try {
        await conn.query("LOAD parquet");
      } catch {
        /* autoload on first read_parquet still applies */
      } finally {
        await conn.close();
      }
      return db;
    })();
    // A failed boot (CDN unreachable) is retried by the next query.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Start the engine early; a no-op outside a browser and once started. */
function bootEngine() {
  if (typeof window === "undefined" || typeof Worker === "undefined") return;
  getDb().catch(() => {
    /* the query that needs it reports the failure */
  });
}

// The server answers failures with JSON { error, hint, retryAfterMs } —
// show that, not a bare status code (and never let it reach DuckDB, where it
// would surface as a baffling Catalog Error).
async function responseError(res, what) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (e.g. a published build with no artifact) */
  }
  const detail = body ? [body.error, body.hint].filter(Boolean).join(" — ") : "";
  const error = new Error(what + " (HTTP " + res.status + ")" + (detail ? ": " + detail : ""));
  error.status = res.status;
  if (body && typeof body.retryAfterMs === "number") error.retryAfterMs = body.retryAfterMs;
  return error;
}

// ---------------------------------------------------------------------------
// Progress — what each pending binding is waiting on (see progress.js). One
// record per binding while it loads or refreshes, gone when it settles.
// Notifications are batched: 34 bindings downloading at once must not
// re-render every hook on every chunk.
// ---------------------------------------------------------------------------
let progressState = {};
const progressListeners = new Set();
const progressWatchers = new Map(); // name -> Set<(record|null) => void>
let progressFlush = null;
function setProgress(name, patch) {
  const next = { ...progressState };
  if (patch === null) delete next[name];
  else next[name] = { ...progressState[name], ...patch };
  progressState = next;
  const watchers = progressWatchers.get(name);
  if (watchers) for (const w of [...watchers]) w(next[name] ?? null);
  progressFlush ??= setTimeout(() => {
    progressFlush = null;
    for (const l of [...progressListeners]) l();
  }, 50);
}
function subscribeProgress(l) {
  progressListeners.add(l);
  return () => progressListeners.delete(l);
}
function getProgressState() {
  return progressState;
}
function watchProgress(name, fn) {
  if (!progressWatchers.has(name)) progressWatchers.set(name, new Set());
  progressWatchers.get(name).add(fn);
  return () => progressWatchers.get(name)?.delete(fn);
}
/** A server event as a progress patch: the phase and whatever it counted. */
function progressPatch(event) {
  return {
    phase: event.phase,
    ...(typeof event.rowsWritten === "number" ? { rowsWritten: event.rowsWritten } : {}),
    ...(typeof event.bytes === "number" ? { bytes: event.bytes } : {}),
  };
}

/**
 * Live progress: one binding's record (null when it is not loading), or
 * every pending binding's when called without a name.
 */
export function useBindingProgress(name) {
  const all = React.useSyncExternalStore(subscribeProgress, getProgressState, getProgressState);
  return name === undefined ? all : (all[name] ?? null);
}

// Each binding becomes a TABLE, decoded from its parquet once: a view over
// read_parquet re-decoded the file on every query (SELECT * of a 149k-row
// binding: 366 ms through a view, 174 ms from a table). The file buffer is
// dropped as soon as the table exists. CREATE OR REPLACE swaps the new table
// in with one commit, so a query running during a reload reads the old rows
// or the new ones, never a missing table. Every load registers its bytes
// under its own file name, so a reload never drops a file another load is
// still reading.

// Cloud Run answers a queue timeout with a 429 and no CORS header, so an opaque
// app frame sees only "Failed to fetch": 12 of 5,087 published parquet requests
// on 2026-11-02, in 8 bursts. A burst fails one shard and every panel reading it.
const FETCH_RETRY_MS = [1000, 3000];
const RETRY_AFTER_CAP_MS = 30000;

/**
 * fetch, until headers arrive: 3 attempts on a rejected fetch, a 429 or a 503.
 * A response of any other status returns at once, and so does a stream once it
 * starts, so a build that fails is never run again from here. Honours the
 * server's `retryAfterMs`; past 30 s the caller gets the answer instead. No
 * headers timeout: the Vite plugin may hold headers for a whole build.
 */
async function fetchRetrying(url, init) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= FETCH_RETRY_MS.length;
    let wait = last ? 0 : FETCH_RETRY_MS[attempt] * (0.75 + Math.random() / 2);
    try {
      const res = await fetch(url, init);
      if (last || (res.status !== 429 && res.status !== 503)) return res;
      const asked = await res
        .clone()
        .json()
        .then(body => body?.retryAfterMs)
        .catch(() => undefined);
      if (typeof asked === "number") {
        if (asked > RETRY_AFTER_CAP_MS) return res;
        wait = asked;
      }
    } catch (error) {
      if (last || !(error instanceof TypeError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

/**
 * A binding's parquet bytes, phase-aware: asks for NDJSON phase events (a
 * build reports each step, a stored file resolving → signing and a signed
 * URL) and reports them through `report(patch)`. A server that predates the
 * events answers with the bytes, as it always did.
 */
async function downloadBinding(name, bust, report) {
  const path = "__data/" + encodeURIComponent(name) + ".parquet";
  const what = 'Data for binding "' + name + '" could not be loaded';
  report({ phase: "requesting", rowsWritten: null, bytes: null, bytesTotal: null });
  let res = await fetchRetrying(path + (bust ? "?refresh=" + Date.now() : ""), {
    headers: { accept: PROGRESS_ACCEPT },
  });
  if (isProgressResponse(res)) {
    const final = await readProgressStream(res, e => report(progressPatch(e)));
    if (final.phase === "failed") throw progressError(final, what);
    report({ phase: "downloading", rowsWritten: null, bytes: 0 });
    // No url: the server streams the bytes itself — the same path, asked
    // plainly, serves them (the build already staged or cached them).
    res = await fetchRetrying(final.url || path);
  }
  if (!res.ok) throw await responseError(res, what);
  return readBytes(res, (bytes, bytesTotal) =>
    report({ phase: "downloading", rowsWritten: null, bytes, bytesTotal }),
  );
}

// ---------------------------------------------------------------------------
// Memory (2.12). Every table lives in this frame's WASM heap, where DuckDB's
// memory_limit is 3.1 GiB. 2.8 to 2.11 never dropped one, so an app with many
// bindings (Web Performance: 106 shards) browsed its way to "Out of Memory".
//
// - Every read bumps its binding. Least recently used goes first.
// - The budget is hard: a new table lands only if it fits, after evicting what
//   no one holds. Otherwise the binding lands as a view, and a later read
//   promotes it if room has appeared. Filling the heap breaks more than
//   queries: see the next point.
// - A demoted binding is a view over its parquet in the heap (registerFileBuffer):
//   7x to 14x smaller than its table. Never a BROWSER_FILEREADER handle over a
//   Blob: duckdb-wasm 1.29.0's openFile writes the file size to
//   HEAPF64[(ptr >> 3)], and `>>` turns a pointer past 2 GiB negative. The size
//   is lost, so reads fail with "too small to be a Parquet file" or a Thrift
//   error (measured: 4 of 8 reads with 3.0 GiB of tables, 0 of 8 with 1.6 GiB,
//   every failure a pointer past 2^31; heap buffers failed 0 of 8).
// - The parquet also stays in JS memory as a Blob, so a view can become a table
//   again and a table a view without a download. Blobs have their own budget.
//   Past it, the least recently used view is dropped outright and its next read
//   downloads it again.
// - A binding a mounted hook reads, or a query in flight, is pinned. Pinned
//   tables go last, not never: loads in flight are the only thing never touched.
// - "Out of Memory" on a query demotes unpinned tables, then pinned ones, and
//   retries until it answers or no table is left. A view has the same name and
//   rows. For the next minute (pressure) no table grows back past what is left.
// - "Out of Memory" on a load demotes unpinned tables and retries once. A load
//   that still does not fit lands as a view.
// - A parquet over a quarter of the budget starts as a view: its table would
//   be 3x to 14x bigger and could not fit.
//
// All catalog changes run one at a time (catalog()), so the bookkeeping here
// always matches DuckDB's catalog. The worker runs one statement at a time
// anyway, so this costs no parallelism.
// ---------------------------------------------------------------------------
const MIB = 1024 * 1024;
export const DEFAULT_BINDING_MEMORY_BUDGET = 1536 * MIB;
export const DEFAULT_BINDING_BLOB_BUDGET = 512 * MIB;
let memoryBudget = DEFAULT_BINDING_MEMORY_BUDGET;
let blobBudget = DEFAULT_BINDING_BLOB_BUDGET;

// name -> { storage: "table" | "view", blob: Blob | null, file: string | null,
// demoted: boolean, tableBytes: number | null }. `file` is the heap copy of the
// parquet a view reads; a table keeps no file. `demoted`: a view only because
// of memory, so a read tries to promote it. `tableBytes`: what its table cost.
const entries = new Map();
const lastUse = new Map(); // name -> sequence number of its latest read
let useSeq = 0;
const pins = new Map(); // name -> how many hooks or queries hold it
const loading = new Set(); // names with a load in flight
// Loaded through ensureBinding(): app code may query them by name at any
// time, so they are demoted (still readable) but never dropped.
const externalBindings = new Set();
let measuredBytes = 0;
// A table's heap per parquet byte. Starts high (measured: 8x to 14x) and follows
// the last table loaded. Only the fit check before a load uses it.
let decodeRatio = 16;
// After an Out of Memory, tables stay at or under what relief left, for a minute.
const PRESSURE_MS = 60000;
let pressureCeiling = Infinity;
let pressureUntil = 0;

function tableCeiling() {
  return Date.now() < pressureUntil ? Math.min(memoryBudget, pressureCeiling) : memoryBudget;
}

function touch(name) {
  lastUse.set(name, ++useSeq);
}
function isPinned(name) {
  return (pins.get(name) ?? 0) > 0;
}
/** Hold `name` against eviction; the returned function lets go (once). */
function pin(name) {
  pins.set(name, (pins.get(name) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const n = (pins.get(name) ?? 1) - 1;
    if (n > 0) pins.set(name, n);
    else pins.delete(name);
  };
}

let catalogQueue = Promise.resolve();
function catalog(fn) {
  const run = catalogQueue.then(fn);
  catalogQueue = run.catch(() => {});
  return run;
}

// The statements in one transaction, so another connection never sees the
// name missing between a DROP and a CREATE.
async function exec(engine, statements) {
  const conn = await engine.connect();
  try {
    if (statements.length === 1) {
      await conn.query(statements[0]);
      return;
    }
    await conn.query("BEGIN TRANSACTION");
    try {
      for (const sql of statements) await conn.query(sql);
      await conn.query("COMMIT");
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await conn.close();
  }
}

function dropSql(storage, name) {
  return "DROP " + (storage === "view" ? "VIEW" : "TABLE") + " IF EXISTS " + quoteIdent(name);
}

let fileSeq = 0;
// Every load registers its bytes under its own file name, so a reload never
// drops a file another load is still reading.
function nextFile() {
  return "mako-" + ++fileSeq + ".parquet";
}

/** `bytes` decoded into a table named `name`, replacing what was there. */
async function putTable(engine, name, bytes) {
  const prev = entries.get(name);
  const file = nextFile();
  await engine.registerFileBuffer(file, bytes);
  try {
    const create =
      "CREATE OR REPLACE TABLE " + quoteIdent(name) +
      " AS SELECT * FROM read_parquet(" + quoteString(file) + ")";
    await exec(engine, prev && prev.storage === "view" ? [dropSql("view", name), create] : [create]);
  } finally {
    await engine.dropFile(file).catch(() => {});
  }
  if (prev && prev.file) await engine.dropFile(prev.file).catch(() => {});
}

/** A view named `name` over a heap copy of `blob`. Returns its file. */
async function putView(engine, name, blob) {
  const prev = entries.get(name);
  const file = nextFile();
  await engine.registerFileBuffer(file, new Uint8Array(await blob.arrayBuffer()));
  try {
    const create =
      "CREATE OR REPLACE VIEW " + quoteIdent(name) +
      " AS SELECT * FROM read_parquet(" + quoteString(file) + ")";
    await exec(engine, prev && prev.storage === "table" ? [dropSql("table", name), create] : [create]);
  } catch (error) {
    await engine.dropFile(file).catch(() => {});
    throw error;
  }
  if (prev && prev.file) await engine.dropFile(prev.file).catch(() => {});
  return file;
}

/**
 * What the bindings hold right now, in bytes: DuckDB's own figure plus the
 * parquet copies views read, which live in the heap outside its accounting.
 * Query scratch never shows: DuckDB returns it before the next statement runs
 * (measured, also after a failed query). The last figure if it cannot say.
 */
async function measureNow(engine) {
  const value = await duckdbBytes(engine);
  if (value !== null) {
    let views = 0;
    for (const entry of entries.values()) {
      if (entry.storage === "view" && entry.blob) views += entry.blob.size;
    }
    measuredBytes = value + views;
  }
  reportMemory();
  return measuredBytes;
}

/** duckdb_memory() alone, or null on an engine without it. */
async function duckdbBytes(engine) {
  const conn = await engine.connect();
  try {
    const result = await conn.query(
      "SELECT coalesce(sum(memory_usage_bytes), 0)::DOUBLE AS bytes FROM duckdb_memory()",
    );
    const value = Number(result.getChildAt(0)?.get(0));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null; /* the OOM retry still applies */
  } finally {
    await conn.close();
  }
}

// Hook for whoever wants the figure (the host frame, in a later step).
function reportMemory() {}

/** The least recently read binding that passes `test` and nothing holds. */
function leastRecent(test, { pinnedToo = false } = {}) {
  let best = null;
  let bestSeq = Infinity;
  for (const [name, entry] of entries) {
    if ((isPinned(name) && !pinnedToo) || loading.has(name) || !test(name, entry)) continue;
    const seq = lastUse.get(name) ?? 0;
    if (seq < bestSeq) {
      best = name;
      bestSeq = seq;
    }
  }
  return best;
}

/** Forget a binding entirely: the next read downloads it again. */
async function dropNow(engine, name) {
  const entry = entries.get(name);
  if (!entry) return;
  await exec(engine, [dropSql(entry.storage, name)]);
  if (entry.file) await engine.dropFile(entry.file).catch(() => {});
  entries.delete(name);
  loadedBindings.delete(name);
}

/** One step down: a table becomes a view over its Blob, or goes. */
async function evictNow(engine, name) {
  const entry = entries.get(name);
  if (entry.blob) {
    const file = await putView(engine, name, entry.blob);
    entries.set(name, { ...entry, storage: "view", file, demoted: true });
  } else {
    await dropNow(engine, name);
    registered.delete(name);
  }
}

const evictableTable = except => (name, entry) =>
  name !== except &&
  entry.storage === "table" &&
  (entry.blob !== null || !externalBindings.has(name));

/** Evict least recently used tables until DuckDB holds at most `target`. */
async function trimNow(engine, except, target = memoryBudget) {
  for (;;) {
    if ((await measureNow(engine)) <= target) break;
    const victim = leastRecent(evictableTable(except));
    if (!victim) break;
    await evictNow(engine, victim);
  }
  for (;;) {
    let blobs = 0;
    for (const entry of entries.values()) if (entry.blob) blobs += entry.blob.size;
    if (blobs <= blobBudget) return;
    const victim = leastRecent(
      (name, entry) =>
        name !== except && entry.blob !== null && !(entry.storage === "view" && externalBindings.has(name)),
    );
    if (!victim) return;
    const entry = entries.get(victim);
    if (entry.storage === "view") {
      await dropNow(engine, victim);
      registered.delete(victim);
    } else {
      // A table keeps its rows; evicting it later drops it outright.
      entries.set(victim, { ...entry, blob: null });
    }
  }
}

/**
 * After an Out of Memory error: demote tables, least recently used first, until
 * DuckDB holds half of what it did (or half the budget). A load in flight stops
 * at unpinned tables. A query goes on to pinned ones: `lastResort`. Only those
 * with a Blob: they keep their name and rows, where dropping one would lose it
 * under a mounted hook. Returns how many it freed; 0: a retry would fail the same way.
 */
async function relieveNow(engine, except, lastResort = false) {
  const target = Math.min(memoryBudget, await measureNow(engine)) / 2;
  let freed = 0;
  for (;;) {
    const victim =
      leastRecent(evictableTable(except)) ??
      (lastResort ? leastRecent((name, entry) => evictableTable(except)(name, entry) && entry.blob !== null, { pinnedToo: true }) : null);
    if (!victim) break;
    await evictNow(engine, victim);
    freed++;
    if ((await measureNow(engine)) <= target) break;
  }
  if (freed) {
    pressureCeiling = measuredBytes;
    pressureUntil = Date.now() + PRESSURE_MS;
  }
  return freed;
}

/**
 * Whether a table for `blob` fits under the ceiling, evicting what no one holds
 * to make room. Checked before decoding: a table placed past the ceiling could
 * only be demoted again, and a full heap breaks reads for good reasons of its
 * own (see the comment at the top of this section).
 */
async function roomForTable(engine, name, blob) {
  const prev = entries.get(name);
  const estimate = prev?.tableBytes ?? blob.size * decodeRatio;
  // CREATE OR REPLACE frees the table it replaces.
  const replaced = prev?.storage === "table" ? estimate : 0;
  for (;;) {
    if ((await measureNow(engine)) - replaced + estimate <= tableCeiling()) return true;
    const victim = leastRecent(evictableTable(name));
    if (!victim) return false;
    await evictNow(engine, victim);
  }
}

/** putTable, and what the table cost. Returns its bytes, or null if unknown. */
async function putMeasuredTable(engine, name, bytes, blob) {
  const prev = entries.get(name);
  const before = await duckdbBytes(engine);
  await putTable(engine, name, bytes);
  const after = await duckdbBytes(engine);
  if (before === null || after === null) return null;
  const tableBytes = after - before + (prev?.storage === "table" ? (prev.tableBytes ?? 0) : 0);
  if (!(tableBytes > 0)) return null;
  if (blob.size > 0) decodeRatio = tableBytes / blob.size;
  return tableBytes;
}

/** Decode a download into DuckDB: a table when it fits, else a view. */
async function placeNow(engine, name, buf, blob) {
  if (blob.size > memoryBudget / 4) {
    return { storage: "view", file: await putView(engine, name, blob), demoted: false };
  }
  if (!(await roomForTable(engine, name, blob))) {
    return { storage: "view", file: await putView(engine, name, blob), demoted: true };
  }
  try {
    return { storage: "table", file: null, demoted: false, tableBytes: await putMeasuredTable(engine, name, buf, blob) };
  } catch (error) {
    if (!isOutOfMemoryError(error)) throw error;
  }
  // The worker owns `buf` now (registerFileBuffer transfers it): the Blob
  // has the same bytes.
  if (await relieveNow(engine, name)) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { storage: "table", file: null, demoted: false, tableBytes: await putMeasuredTable(engine, name, bytes, blob) };
    } catch (error) {
      if (!isOutOfMemoryError(error)) throw error;
    }
  }
  return { storage: "view", file: await putView(engine, name, blob), demoted: true };
}

async function loadBinding(name, bust) {
  const db = getDb(); // boot in parallel with the download
  db.catch(() => {});
  loading.add(name);
  try {
    const buf = await downloadBinding(name, bust, patch => setProgress(name, patch));
    setProgress(name, { phase: "loading_duckdb" });
    const engine = await db;
    // Made before the buffer goes to the worker: the copy a demotion reads.
    const blob = new Blob([buf]);
    await catalog(async () => {
      const placed = await placeNow(engine, name, buf, blob);
      const tableBytes = placed.tableBytes ?? entries.get(name)?.tableBytes ?? null;
      entries.set(name, { ...placed, blob, tableBytes });
      loadedBindings.add(name);
      loading.delete(name);
      await trimNow(engine, name);
    });
  } finally {
    loading.delete(name);
    // A refresh owns the record until its reload is done (refreshBinding).
    if (!refreshes.has(name)) setProgress(name, null);
  }
}

/**
 * A demoted view read again: back to a table from its Blob, no download, if it
 * fits. Otherwise it stays a view, and the next read asks again: a view that
 * promoted itself into a full heap would only be demoted again.
 */
async function promote(name) {
  const engine = await getDb();
  await catalog(async () => {
    const entry = entries.get(name);
    if (!entry || entry.storage !== "view" || !entry.blob) return;
    if (!(await roomForTable(engine, name, entry.blob))) {
      entry.demoted = true;
      return;
    }
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const tableBytes = await putMeasuredTable(engine, name, bytes, entry.blob);
    entries.set(name, { ...entry, storage: "table", file: null, demoted: false, tableBytes: tableBytes ?? entry.tableBytes });
    await trimNow(engine, name);
  }).catch(() => {
    const entry = entries.get(name);
    if (entry && entry.storage === "view") entry.demoted = true;
    /* it stays a view, which reads the same rows */
  });
}

const registered = new Map(); // name -> Promise<void>
const loadedBindings = new Set(); // names DuckDB can read (table or view)
// Refreshed on the server while never loaded on this page: the next load
// must skip any cache between here and the server.
const staleBindings = new Set();
function registerBinding(name) {
  touch(name);
  const known = registered.get(name);
  if (!known) {
    const load = loadBinding(name, staleBindings.delete(name));
    registered.set(name, load);
    load.catch(() => {
      if (registered.get(name) === load) registered.delete(name);
    });
    return load;
  }
  const entry = entries.get(name);
  if (entry && entry.demoted && !loading.has(name)) {
    entry.demoted = false; // one promotion at a time
    const promotion = known.then(() => promote(name));
    registered.set(name, promotion);
    return promotion;
  }
  return known;
}

/**
 * Cap what binding tables may hold in DuckDB, in bytes (default 1.5 GiB,
 * half of the frame's 3.1 GiB heap: queries need the rest). Over it, the
 * least recently read tables become views over their compressed parquet.
 * `opts.blobBytes` caps those parquet copies (default 512 MiB); past it the
 * oldest are dropped and download again on their next read. `Infinity`
 * turns either off. Resolves once the engine is back under the new budget.
 */
export async function setBindingMemoryBudget(bytes, opts) {
  const valid = n => typeof n === "number" && n > 0 && !Number.isNaN(n);
  if (!valid(bytes)) throw new TypeError("setBindingMemoryBudget: a positive number of bytes");
  memoryBudget = bytes;
  pressureUntil = 0; // the caller has just said what tables may hold
  if (opts && opts.blobBytes !== undefined) {
    if (!valid(opts.blobBytes)) throw new TypeError("setBindingMemoryBudget: blobBytes must be a positive number");
    blobBudget = opts.blobBytes;
  }
  if (!dbPromise) return;
  const engine = await getDb();
  await catalog(() => trimNow(engine, null));
}

/**
 * What the binding tables hold now: DuckDB's own figure, the budgets, and
 * each loaded binding, least recently read first.
 */
export async function getBindingMemory() {
  const engine = await getDb();
  const usedBytes = await catalog(() => measureNow(engine));
  const bindings = [...entries]
    .sort(([a], [b]) => (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0))
    .map(([name, entry]) => ({
      name,
      storage: entry.storage,
      pinned: isPinned(name),
      parquetBytes: entry.blob ? entry.blob.size : null,
    }));
  return {
    usedBytes,
    budgetBytes: memoryBudget,
    blobBudgetBytes: blobBudget,
    pressure: Date.now() < pressureUntil,
    bindings,
  };
}

// ---------------------------------------------------------------------------
// Escape hatches — the same engine and the same loader the hooks use, for
// apps that need more than useQuery/useDuckDB. One DuckDB per page: an app
// that boots its own pays a second ~1 s boot and a second copy of the data.
// ---------------------------------------------------------------------------

/**
 * The page's shared DuckDB (an AsyncDuckDB), booted on first call. Never
 * close or terminate it: every hook on the page reads from it.
 */
export function getDuckDB() {
  return getDb();
}

/** Run `fn` with a fresh connection to the shared DuckDB; always closed after. */
export async function withConnection(fn) {
  const db = await getDb();
  const conn = await db.connect();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

/**
 * Make sure a binding's table exists in the shared DuckDB, loading it once
 * per page (concurrent callers share the download). Resolves with the table
 * name — the binding name; quote it in SQL when it is not a bare identifier.
 * Each call counts as a read. Under memory pressure the table may become a
 * view over its parquet (same name, same rows, slower); it is never dropped.
 */
export async function ensureBinding(name) {
  externalBindings.add(name);
  await registerBinding(name);
  return name;
}

/**
 * Forget a loaded binding: drops its table (or view) so its memory is freed.
 * The next query or ensureBinding() downloads it again.
 */
export async function unloadBinding(name) {
  const pending = registered.get(name);
  if (!pending) return;
  registered.delete(name);
  externalBindings.delete(name);
  await pending.catch(() => {});
  if (registered.has(name)) return; // read again meanwhile: it stays
  const engine = await getDb();
  await catalog(() => dropNow(engine, name));
}

/**
 * The binding's parquet bytes, for an app with its own reader (e.g.
 * read_parquet options such as file_row_number). Not registered anywhere.
 * `fresh` skips caches; `onProgress(loaded, total)` reports the download.
 */
export async function fetchBindingBytes(name, opts) {
  const fresh = !!(opts && opts.fresh) || staleBindings.has(name);
  const onProgress = opts && opts.onProgress;
  let record = null;
  try {
    return await downloadBinding(name, fresh, patch => {
      record = { ...record, ...patch };
      if (onProgress) onProgress(record);
    });
  } finally {
    if (onProgress) onProgress(null);
  }
}

/** Replace a binding's loaded bytes with what the server has now. */
async function reloadBinding(name) {
  const previous = registered.get(name);
  if (!previous) {
    // Nothing on this page reads it yet: load it fresh when a query does.
    staleBindings.add(name);
    return;
  }
  // Let a load in flight settle first, or its (older) bytes could land after
  // the fresh ones and win.
  await previous.catch(() => {});
  const load = loadBinding(name, true);
  registered.set(name, load);
  try {
    await load;
  } catch (error) {
    if (registered.get(name) === load) registered.delete(name);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Refresh — rematerialize a binding on demand. The runtime POSTs to the
// data URL's sibling, `__data/<name>/refresh`, and every server that answers
// `__data/<name>.parquet` (Mako's viewer, preview and share routes, the
// sandbox dev server, the laptop Vite plugin) rebuilds the binding behind
// it, with its own authorization. The runtime then reloads the bytes and
// bumps a version every query hook depends on, so the page re-renders with
// the new rows — and keeps the old ones on screen until they arrive.
// ---------------------------------------------------------------------------
const bindingListeners = new Set();
let bindingState = { version: 0, refreshing: new Set() };
function setBindingState(next) {
  bindingState = next;
  for (const l of [...bindingListeners]) l();
}
function subscribeBindings(l) {
  bindingListeners.add(l);
  return () => bindingListeners.delete(l);
}
function getBindingState() {
  return bindingState;
}
function useBindingState() {
  return React.useSyncExternalStore(subscribeBindings, getBindingState, getBindingState);
}

const refreshes = new Map(); // name -> Promise<RefreshResult>

/**
 * Rebuild one binding's data and reload it. Resolves with what the server
 * built; rejects with an Error carrying `status` (403: not allowed here,
 * 429: refreshed too recently — see `retryAfterMs`, 502: the query failed —
 * the message says why). Concurrent calls for the same binding share one
 * request. `opts.onProgress` hears every phase of it: the build, then the
 * reload (link, download, DuckDB), then `null` when it is done.
 */
export function refreshBinding(name, opts) {
  const onProgress = opts && opts.onProgress;
  const unwatch = onProgress ? watchProgress(name, onProgress) : null;
  const pending = refreshes.get(name);
  if (pending) {
    if (unwatch) pending.finally(unwatch).catch(() => {});
    return pending;
  }
  const what = 'Binding "' + name + '" could not be refreshed';
  const run = (async () => {
    setProgress(name, { phase: "requesting", rowsWritten: null, bytes: null, bytesTotal: null });
    const res = await fetch("__data/" + encodeURIComponent(name) + "/refresh", {
      method: "POST",
      headers: { accept: PROGRESS_ACCEPT },
    });
    let body;
    if (isProgressResponse(res)) {
      body = await readProgressStream(res, e => setProgress(name, progressPatch(e)));
      if (body.phase === "failed") throw progressError(body, what);
    } else {
      if (!res.ok) throw await responseError(res, what);
      body = await res.json();
    }
    await reloadBinding(name);
    setBindingState({ ...bindingState, version: bindingState.version + 1 });
    return {
      binding: name,
      materialization: body.materialization,
      rowCount: body.rowCount,
      byteSize: body.byteSize,
      materializedAt: body.materializedAt,
    };
  })();
  refreshes.set(name, run);
  setBindingState({ ...bindingState, refreshing: new Set([...bindingState.refreshing, name]) });
  run
    .finally(() => {
      refreshes.delete(name);
      setProgress(name, null);
      if (unwatch) unwatch();
      const refreshing = new Set(bindingState.refreshing);
      refreshing.delete(name);
      setBindingState({ ...bindingState, refreshing });
    })
    .catch(() => {
      /* the caller's copy of `run` carries the rejection */
    });
  return run;
}

/**
 * Refresh several bindings at once — every staged binding when no names are
 * given (what `useDuckDB(...).refresh()` does). All of them are attempted;
 * if any failed, rejects after the rest settle with `failures` listing them.
 */
export async function refreshBindings(names) {
  const list = names ?? (await bindingIndex());
  const settled = await Promise.allSettled(list.map(refreshBinding));
  const failures = settled
    .map((s, i) => (s.status === "rejected" ? { binding: list[i], error: s.reason } : null))
    .filter(Boolean);
  if (failures.length) {
    const error = new Error(
      failures.map(f => (f.error instanceof Error ? f.error.message : String(f.error))).join("; "),
    );
    error.failures = failures;
    throw error;
  }
  return settled.map(s => s.value);
}

// ---------------------------------------------------------------------------
// Viewer — who is looking. `__data/viewer.json` is answered per request by
// whoever serves the app (Mako's published/preview routes from the session
// or the signed token, the Vite plugin from the API), so the app cannot
// forge it. `null` on an anonymous share link, and on servers that predate
// it (404). Mako says only what it knows: id, email, the workspace and the
// person's ACCESS role in it, their role on this app. Anything else about
// the person is data the app looks up in the warehouse by email.
// ---------------------------------------------------------------------------
let viewerPromise = null;
function normalizeViewer(body) {
  if (!body || typeof body !== "object" || typeof body.email !== "string") return null;
  const ws = body.workspace && typeof body.workspace === "object" ? body.workspace : {};
  const app = body.app && typeof body.app === "object" ? body.app : {};
  return {
    id: typeof body.id === "string" ? body.id : "",
    email: body.email,
    workspace: {
      id: typeof ws.id === "string" ? ws.id : "",
      name: typeof ws.name === "string" ? ws.name : "",
      role: typeof ws.role === "string" ? ws.role : null,
    },
    app: {
      id: typeof app.id === "string" ? app.id : "",
      slug: typeof app.slug === "string" ? app.slug : null,
      role: typeof app.role === "string" ? app.role : null,
    },
  };
}

/** The viewer, once per page. Resolves to null when nobody is known. */
export function getViewer() {
  viewerPromise ??= fetch("__data/viewer.json").then(async r => {
    if (r.status === 404) return null;
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(
        body && body.error ? String(body.error) : "Viewer lookup failed (HTTP " + r.status + ")",
      );
    }
    return normalizeViewer(body);
  });
  viewerPromise.catch(() => {
    viewerPromise = null;
  });
  return viewerPromise;
}

/** Names of every staged binding — written by the dev server next to the
 * parquet files. Absent (older servers, published builds): empty list. */
let indexPromise = null;
function bindingIndex() {
  if (indexPromise) return indexPromise;
  const pending = fetchRetrying("__data/index.json").then(async r => {
    // A 404 is an older server or a published build: empty, for good. Anything
    // else that failed must not answer for the rest of the page's life.
    if (!r.ok && r.status !== 404 && indexPromise === pending) indexPromise = null;
    if (r.status === 429 || r.status === 503) throw await responseError(r, "The binding list could not be loaded");
    if (!r.ok) return [];
    const list = await r.json().catch(() => []);
    return Array.isArray(list) ? list : [];
  });
  indexPromise = pending;
  // A dropped request rejects, so the panel says so and tries again. An empty
  // list would read as "Not built yet" in every panel.
  pending.catch(() => {
    if (indexPromise === pending) indexPromise = null;
  });
  return pending;
}

// Out of Memory on a query: free tables, pinned ones last, and try again. Each
// pass demotes at least one table, so this ends. With no table left, the error
// surfaces and the hook tries again later (useAsyncQuery).
async function runSql(sql, rowLimit, format) {
  for (;;) {
    try {
      return await runSqlOnce(sql, rowLimit, format);
    } catch (error) {
      if (!isOutOfMemoryError(error)) throw error;
      const engine = await getDb();
      if (!(await catalog(() => relieveNow(engine, null, true)))) throw error;
    }
  }
}

async function runSqlOnce(sql, rowLimit, format) {
  const cap = rowLimit === null ? Infinity : (rowLimit ?? DEFAULT_ROW_LIMIT);
  const db = await getDb();
  const conn = await db.connect();
  try {
    const table = await conn.query(sql);
    const rowCount = table.numRows;
    if (format === "arrow") {
      // The Arrow Table as DuckDB returned it: no row objects, no
      // normalization, no row limit.
      return { rows: table, fields: table.schema.fields.map(f => f.name), rowCount, truncated: false };
    }
    const { rows, fields } = toPlainRows(table, cap);
    return { rows, fields, rowCount, truncated: rowCount > rows.length };
  } finally {
    await conn.close();
  }
}

const EMPTY = {
  data: null,
  fields: null,
  error: null,
  loading: true,
  truncated: false,
  rowCount: null,
  refreshing: false,
};

// Runs `run` when `deps` change (a fresh query: rows reset, `loading`), and
// again when a refresh lands (`refreshing`: the rows already on screen stay
// until the new ones arrive — a dashboard must not blink to empty on every
// refresh). `isRefreshing` says whether a refresh in flight concerns this
// query, so `refreshing` is true from the click, not only from the reload.
// `run(hold)` names each binding it reads through `hold`: those stay pinned
// against eviction while this hook shows that query (until the deps change
// or it unmounts, and never before its run settles).
//
// A query that failed on memory or the network runs again by itself: the panel
// must not need a page reload once it can succeed. The error stays up until a
// retry answers. Any other error (bad SQL, a server's refusal) stays as it is.
function useAsyncQuery(run, deps, isRefreshing) {
  const bindings = useBindingState();
  const [state, setState] = React.useState(EMPTY);
  const [attempt, setAttempt] = React.useState(0);
  const seenVersion = React.useRef(bindings.version);
  const seenAttempt = React.useRef(attempt);
  const retries = React.useRef(0);
  React.useEffect(() => {
    let active = true;
    let timer = null;
    const isRefresh = seenVersion.current !== bindings.version;
    const isRetry = seenAttempt.current !== attempt;
    seenVersion.current = bindings.version;
    seenAttempt.current = attempt;
    if (!isRetry) {
      retries.current = 0;
      setState(s => (isRefresh && s.data !== null ? { ...s, refreshing: true } : EMPTY));
    }
    const held = [];
    const settled = run(name => held.push(pin(name)));
    settled.then(
      result => {
        if (active) setState({ ...result, error: null, loading: false, refreshing: false });
      },
      error => {
        if (!active) return;
        setState({
          ...EMPTY,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
        const wait = retryDelayMs(error, retries.current);
        if (wait === null) return;
        retries.current++;
        timer = setTimeout(() => setAttempt(n => n + 1), wait);
      },
    );
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      settled.catch(() => {}).finally(() => {
        for (const release of held) release();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bindings.version, attempt]);
  return {
    ...state,
    refreshing: state.refreshing || isRefreshing(bindings.refreshing),
  };
}

// A hook's view of progress: the binding's own record while it loads, else
// `running_sql` while the hook's SQL runs, else nothing.
function hookProgress(record, state) {
  const p = record ?? (state.loading || state.refreshing ? { phase: "running_sql" } : null);
  return {
    phase: p ? p.phase : null,
    rowsWritten: p && typeof p.rowsWritten === "number" ? p.rowsWritten : null,
    bytes: p && typeof p.bytes === "number" ? p.bytes : null,
    bytesTotal: p && typeof p.bytesTotal === "number" ? p.bytesTotal : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot preview — opt-in with useQuery(name, { snapshot: true }). The
// server writes the first N rows of each build next to its parquet as
// `__data/<name>.snapshot.json`. It is the first N rows of the build stream
// in whatever order the query produced them, so it is a skeleton for the
// first paint, never data: `data` stays null and `loading` stays true until
// the table is in DuckDB (through every load phase), and `preview`
// disappears the moment either the rows or an error arrive. One request per
// binding per page, none once the table is already loaded; a binding
// without a snapshot is one cheap 404.
// ---------------------------------------------------------------------------
const snapshots = new Map(); // name -> Promise<body | null>
function loadSnapshot(name) {
  if (!snapshots.has(name)) {
    snapshots.set(
      name,
      fetch(snapshotUrl(name))
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return snapshots.get(name);
}

function useSnapshotPreview(name, enabled, rowLimit) {
  const [preview, setPreview] = React.useState(null);
  React.useEffect(() => {
    setPreview(null);
    if (!enabled || loadedBindings.has(name)) return;
    let active = true;
    loadSnapshot(name).then(body => {
      if (!active || loadedBindings.has(name)) return;
      const parsed = parseBindingSnapshot(body, rowLimit);
      if (parsed) setPreview(parsed);
    });
    return () => {
      active = false;
    };
  }, [name, enabled, rowLimit]);
  return preview;
}

export function useQuery(name, opts) {
  bootEngine();
  const rowLimit = opts ? opts.rowLimit : undefined;
  const withSnapshot = Boolean(opts && opts.snapshot);
  const preview = useSnapshotPreview(name, withSnapshot, rowLimit);
  const state = useAsyncQuery(
    async hold => {
      hold(name);
      await registerBinding(name);
      const r = await runSql("SELECT * FROM " + quoteIdent(name), rowLimit);
      return { data: r.rows, fields: r.fields, truncated: r.truncated, rowCount: r.rowCount };
    },
    [name, rowLimit],
    refreshing => refreshing.has(name),
  );
  const progress = useBindingProgress(name);
  const refresh = React.useCallback(() => refreshBinding(name), [name]);
  const result = { ...state, ...hookProgress(progress, state), progress, refresh };
  if (!withSnapshot) return result;
  // Only while nothing final is on screen: not next to rows, not next to an
  // error (a failed load must not leave preview rows looking final).
  result.preview = state.loading && state.data === null && state.error === null ? preview : null;
  return result;
}

/**
 * Who is looking at the app: `{ viewer, loading, error }`. `viewer` is null
 * while loading, on an anonymous share link, and when the server does not
 * know. Join `viewer.email` against your own roster binding for anything
 * beyond identity and access role — that is the app's call, not Mako's.
 */
export function useViewer() {
  const [state, setState] = React.useState({ viewer: null, loading: true, error: null });
  React.useEffect(() => {
    let active = true;
    getViewer().then(
      viewer => {
        if (active) setState({ viewer, loading: false, error: null });
      },
      error => {
        if (active) {
          setState({
            viewer: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/**
 * Run `sql` with the bindings it reads loaded — and only those. The ones
 * its text names start downloading together, alongside the engine boot; a
 * table the hint missed shows up as DuckDB's "Table with name X does not
 * exist", which loads X and runs the query again. Joins across bindings
 * work by name without declaring anything, as before, and an app with 34
 * bindings no longer downloads all 34 to draw one chart.
 *
 * A binding that fails to load must not sink the query silently: when the
 * SQL then fails, the load failure is what surfaces — it is the cause.
 */
async function runOverBindings(sql, rowLimit, format, hold) {
  const names = await bindingIndex();
  const failures = new Map();
  const attempted = new Set();
  const load = n => {
    attempted.add(n);
    hold(n);
    return registerBinding(n).catch(e => {
      failures.set(n, e);
    });
  };
  await Promise.all((readsCatalog(sql) ? names : mentionedBindings(sql, names)).map(load));
  for (;;) {
    try {
      return await runSql(sql, rowLimit, format);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = missingBinding(message, names);
      if (missing && !attempted.has(missing)) {
        await load(missing);
        if (failures.has(missing)) throw failures.get(missing);
        continue;
      }
      for (const [n, cause] of failures) {
        if (message.includes(n)) throw cause;
      }
      if (failures.size) {
        const details = [...failures.values()]
          .map(e => (e instanceof Error ? e.message : String(e)))
          .join("; ");
        throw new Error(message + " (bindings that failed to load: " + details + ")");
      }
      throw error;
    }
  }
}

export function useDuckDB(sql, opts) {
  bootEngine();
  const rowLimit = opts ? opts.rowLimit : undefined;
  const format = opts && opts.format === "arrow" ? "arrow" : "rows";
  const state = useAsyncQuery(async hold => {
    const r = await runOverBindings(sql, rowLimit, format, hold);
    return { data: r.rows, fields: r.fields, truncated: r.truncated, rowCount: r.rowCount };
  }, [sql, rowLimit, format], refreshing => refreshing.size > 0);
  // Every binding the query can read: the combined record says what the
  // slowest of them is waiting on; `bindings` has each one.
  const bindings = useBindingProgress();
  const combined = combineBindingProgress(bindings);
  // A query over every binding refreshes every binding (the ones this page
  // has not loaded yet are rebuilt and fetched fresh when first read).
  const refresh = React.useCallback(() => refreshBindings(), []);
  return {
    ...state,
    ...hookProgress(combined, state),
    progress: combined,
    bindings,
    refresh,
  };
}

// ---------------------------------------------------------------------------
// URL state — the real History API; v1 bridged this to the host URL, a v2
// app owns its own document.
// ---------------------------------------------------------------------------
const locationListeners = new Set();
function emitLocation() {
  for (const l of [...locationListeners]) l();
}
if (typeof window !== "undefined") {
  window.addEventListener("popstate", emitLocation);
}

function readLocation() {
  const { pathname, search, hash, href } = window.location;
  return {
    pathname,
    search,
    hash,
    href,
    searchParams: new URLSearchParams(search),
  };
}

export function navigate(to, opts) {
  const url = new URL(to, window.location.href);
  if (opts && opts.replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
  emitLocation();
  // Inside Mako's shell the app is a sandboxed iframe with an opaque origin,
  // so the line above moved a URL nobody can see or copy. Tell the host,
  // which projects the query onto its own address bar (/apps/<slug>?...)
  // and seeds it back into the iframe when that link is opened. Only the
  // query travels: the frame's pathname is the preview token, not the app's.
  if (window.parent !== window) {
    try {
      window.parent.postMessage(
        { type: "mako-app:navigate", search: url.search },
        "*",
      );
    } catch {
      // A host that is not Mako, or a frame that forbids it: nothing to tell.
    }
  }
}

// ---------------------------------------------------------------------------
// Host shortcuts — keys that belong to Mako, not the app.
//
// On its own origin (<appId>.makousercontent.com) the app is a cross-origin
// frame: a keydown while it has focus reaches only this document, so Mako's
// Cmd/Ctrl+K never fired. Hand the shortcut to the host instead, the same
// way navigate() hands over the query. Capture phase, so an app's own
// handlers cannot swallow it first.
// ---------------------------------------------------------------------------
export function hostShortcutFor(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
    return null;
  }
  return typeof event.key === "string" && event.key.toLowerCase() === "k"
    ? "mod+k"
    : null;
}

if (typeof window !== "undefined" && window.parent !== window) {
  window.addEventListener(
    "keydown",
    event => {
      const key = hostShortcutFor(event);
      if (!key) return;
      event.preventDefault();
      try {
        window.parent.postMessage({ type: "mako-app:shortcut", key }, "*");
      } catch {
        // A host that is not Mako: nothing to tell.
      }
    },
    true,
  );
}

export function useLocation() {
  const [loc, setLoc] = React.useState(readLocation);
  React.useEffect(() => {
    const listener = () => setLoc(readLocation());
    locationListeners.add(listener);
    listener();
    return () => {
      locationListeners.delete(listener);
    };
  }, []);
  return loc;
}

export function useSearchParams() {
  const loc = useLocation();
  const setSearchParams = (next, opts) => {
    const sp = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    const qs = sp.toString();
    navigate(window.location.pathname + (qs ? "?" + qs : ""), opts);
  };
  return [loc.searchParams, setSearchParams];
}

// ---------------------------------------------------------------------------
// Theme tokens — Mako's house palette, injected wherever the SDK loads.
//
// The NAMES are the shadcn-style contract the v1 runtime injected
// (app/src/app-runtime/preview.ts THEME_TOKENS_CSS): migrated apps write
// var(--background) / var(--border) / var(--chart-N) directly, so every name
// must keep existing. The VALUES are the house style the workspace converged
// on (INTL Sales → Spain Renewals → 0 Moments, Cohort MRR): stone, a warm
// canvas, #527df2 as the one brand colour. Before 2.7 these were shadcn's zinc
// defaults and every styled app pasted the same ~90-line override block.
//
// Added on top of the v1 names: --brand, --canvas (the page behind cards),
// --positive / --warning / --negative (status tones). --brand, --ring and
// --chart-N are the same in light and dark, exactly as the house apps had them. Prepended to <head> so
// any app stylesheet still overrides it, keyed by id so double-imports no-op,
// dark on :root.dark (the v1 toggle) plus the system preference.
// ---------------------------------------------------------------------------
export const MAKO_THEME_TOKENS_CSS = `:root {
  color-scheme: light;
  --radius: 0.5rem;
  --background: hsl(40 33% 98.5%);
  --foreground: hsl(24 14% 10%);
  --card: hsl(40 40% 99.5%);
  --card-foreground: hsl(24 14% 10%);
  --popover: hsl(40 40% 99.5%);
  --popover-foreground: hsl(24 14% 10%);
  --primary: hsl(24 14% 12%);
  --primary-foreground: hsl(40 33% 98.5%);
  --secondary: hsl(36 24% 92.5%);
  --secondary-foreground: hsl(24 14% 10%);
  --muted: hsl(36 24% 92.5%);
  --muted-foreground: hsl(28 10% 38%);
  --accent: hsl(36 24% 92.5%);
  --accent-foreground: hsl(24 14% 10%);
  --destructive: hsl(0 72% 51%);
  --destructive-foreground: hsl(0 0% 98%);
  --border: hsl(34 16% 83%);
  --input: hsl(34 16% 83%);
  --ring: #527df2;
  --brand: #527df2;
  --canvas: color-mix(in srgb, var(--foreground) 4%, var(--background));
  --positive: hsl(160 52% 36%);
  --warning: hsl(33 80% 42%);
  --negative: hsl(0 66% 48%);
  --chart-1: #527df2;
  --chart-2: hsl(160 52% 36%);
  --chart-3: hsl(33 80% 42%);
  --chart-4: hsl(262 52% 55%);
  --chart-5: hsl(0 66% 48%);
}
:root.dark {
  color-scheme: dark;
  --background: hsl(28 9% 7%);
  --foreground: hsl(38 22% 93%);
  --card: hsl(28 8% 10.5%);
  --card-foreground: hsl(38 22% 93%);
  --popover: hsl(28 8% 12%);
  --popover-foreground: hsl(38 22% 93%);
  --primary: hsl(38 22% 93%);
  --primary-foreground: hsl(28 9% 7%);
  --secondary: hsl(28 7% 17%);
  --secondary-foreground: hsl(38 22% 93%);
  --muted: hsl(28 7% 17%);
  --muted-foreground: hsl(34 10% 67%);
  --accent: hsl(28 7% 17%);
  --accent-foreground: hsl(38 22% 93%);
  --destructive: hsl(0 62% 50%);
  --destructive-foreground: hsl(0 0% 98%);
  --border: hsl(28 7% 24%);
  --input: hsl(28 7% 24%);
  --positive: hsl(158 48% 52%);
  --warning: hsl(36 85% 60%);
  --negative: hsl(0 75% 66%);
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    color-scheme: dark;
    --background: hsl(28 9% 7%);
    --foreground: hsl(38 22% 93%);
    --card: hsl(28 8% 10.5%);
    --card-foreground: hsl(38 22% 93%);
    --popover: hsl(28 8% 12%);
    --popover-foreground: hsl(38 22% 93%);
    --primary: hsl(38 22% 93%);
    --primary-foreground: hsl(28 9% 7%);
    --secondary: hsl(28 7% 17%);
    --secondary-foreground: hsl(38 22% 93%);
    --muted: hsl(28 7% 17%);
    --muted-foreground: hsl(34 10% 67%);
    --accent: hsl(28 7% 17%);
    --accent-foreground: hsl(38 22% 93%);
    --destructive: hsl(0 62% 50%);
    --destructive-foreground: hsl(0 0% 98%);
    --border: hsl(28 7% 24%);
    --input: hsl(28 7% 24%);
    --positive: hsl(158 48% 52%);
    --warning: hsl(36 85% 60%);
    --negative: hsl(0 75% 66%);
  }
}
body { background: var(--background); color: var(--foreground); }
`;
if (
  typeof document !== "undefined" &&
  !document.getElementById("mako-theme-tokens")
) {
  const el = document.createElement("style");
  el.id = "mako-theme-tokens";
  el.textContent = MAKO_THEME_TOKENS_CSS;
  if (document.head.firstChild) {
    document.head.insertBefore(el, document.head.firstChild);
  } else {
    document.head.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Theme — the OS preference; v1 mirrored the host's toggle, a standalone app
// follows the system.
// ---------------------------------------------------------------------------
export function useTheme() {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const listener = e => setDark(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);
  return { theme: dark ? "dark" : "light" };
}
