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
  isReadOnlySql,
  readsCatalog,
  quoteString,
  crashedEngineError,
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
export const SDK_VERSION = "2.14.0";
if (typeof window !== "undefined") {
  try {
    window.__MAKO_APP_SDK__ = SDK_VERSION;
  } catch {
    /* a frozen window: nothing to stamp */
  }
}

const DEFAULT_ROW_LIMIT = 500000;
// A double-read UNION ALL of 55 to 60 bindings overflows the WASM stack and
// corrupts the engine for every panel (measured). 50 held.
const MAX_BINDINGS_IN_QUERY = 50;
const DUCKDB_ESM =
  "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

// ---------------------------------------------------------------------------
// DuckDB: one lazy instance per page, bindings registered on first use. The
// engine arrives from the CDN at runtime, so this package needs no install
// step and no dependencies of its own. The first data hook to render starts
// the boot (WASM download + instantiate, ~1 s) so it overlaps the first
// parquet download instead of waiting for it.
// ---------------------------------------------------------------------------
let dbPromise = null;
let liveEngine = null; // the resolved dbPromise: errors from an older one are history
// createWorker() makes a new object URL per call and never revokes it, so each
// reboot after a release would leak the worker script (about 742 KiB). One URL
// per page, also one download fewer in a frame with no HTTP cache. Not through
// the download gate: the CDN being down says nothing about Mako's server.
let workerUrl = null;
function startWorker(duckdb, script) {
  if (typeof Worker === "undefined") return duckdb.createWorker(script);
  workerUrl ??= fetch(script).then(async res => {
    if (!res.ok) throw new Error("The DuckDB worker could not be loaded (HTTP " + res.status + ")");
    return URL.createObjectURL(await res.blob());
  });
  workerUrl.catch(() => {
    workerUrl = null;
  });
  return workerUrl.then(url => new Worker(url));
}

function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const duckdb = await import(/* @vite-ignore */ DUCKDB_ESM);
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const worker = await startWorker(duckdb, bundle.mainWorker);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      // read_parquet lives in an extension DuckDB fetches on first use
      // (~660 kB from extensions.duckdb.org). Load it now, while the
      // binding bytes are still downloading, not after they arrive.
      try {
        const conn = await db.connect();
        try {
          try {
            await conn.query("LOAD parquet");
          } catch {
            /* autoload on first read_parquet still applies */
          }
          // 1.32 reads TIMESTAMPTZ in the browser's zone once ICU loads. Apps were
          // written against 1.29, which read UTC. Fetches ICU from
          // extensions.duckdb.org, like parquet above. A failure here fails the
          // boot on purpose: the next query retries, where a skipped SET would
          // shift every timestamp without a word.
          try {
            await conn.query("SET GLOBAL TimeZone='UTC'");
          } catch (error) {
            if (error instanceof Error) error.retry = "network"; // the XHR for ICU
            throw error;
          }
          // Binding tables live here, compressed at CHECKPOINT: 17 bytes a row
          // against 289 on Web Performance's 7d set. Tables an app creates stay in
          // the default database, uncompressed.
          await conn.query("ATTACH ':memory:' AS mako_tables (COMPRESS)");
        } finally {
          await conn.close();
        }
      } catch (error) {
        // A failed boot retries with a new worker: end this one.
        await db.terminate().catch(() => {});
        throw error;
      }
      liveEngine = db;
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
  // The one thing a mounted hook may ask again. Any other status said what it meant.
  if (res.status === 429 || res.status === 503) error.retry = "network";
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
// dropped as soon as the table exists. CREATE OR REPLACE VIEW swaps the new table
// in with one commit, so a query running during a reload reads the old rows
// or the new ones, never a missing table. Every load registers its bytes
// under its own file name, so a reload never drops a file another load is
// still reading.

// Cloud Run answers a queue timeout with a 429 and no CORS header, so an opaque
// app frame sees only "Failed to fetch": 12 of 5,087 published parquet requests
// on 2026-11-02, in 8 bursts. One page-wide gate keeps a page from making it worse.
// - At most 12 downloads at once; 1 while the gate is recovering from a failure.
// - A failure closes the gate for 1, 3, 9, 27, then 60 s, with jitter. Failures
//   in one closed window count once. Any answer that is not a 429 or 503 opens it.
// - Past 3 failures in a row, a request while it is closed fails at once with no
//   network, so a page down to one probe at a time does not keep panels spinning.
const FETCH_RETRY_MS = [1000, 3000];
const RETRY_AFTER_CAP_MS = 30000;
const DOWNLOAD_SLOTS = 12;
const GATE_MAX_MS = 60000;
const GATE_FAIL_FAST_AT = 3;
let gateStreak = 0;
let gateUntil = 0;
let gateError = null;
let slotsInUse = 0;
const slotQueue = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withJitter = ms => ms * (0.75 + Math.random() / 2);

function gateFailed(error) {
  gateError = error;
  if (Date.now() < gateUntil) return;
  gateStreak++;
  gateUntil = Date.now() + withJitter(Math.min(GATE_MAX_MS, 1000 * 3 ** (gateStreak - 1)));
}
function gateAnswered() {
  if (gateStreak === 0) return;
  gateStreak = 0;
  gateUntil = 0;
  gateError = null;
  pumpSlots();
  wakeRetries();
}
async function throughGate() {
  for (;;) {
    const wait = gateUntil - Date.now();
    if (wait <= 0) return;
    if (gateStreak >= GATE_FAIL_FAST_AT) throw gateError;
    await sleep(wait);
  }
}
function pumpSlots() {
  let room = (gateStreak ? 1 : DOWNLOAD_SLOTS) - slotsInUse;
  while (room-- > 0 && slotQueue.length) slotQueue.shift()();
}
async function withSlot(fn) {
  while (slotsInUse >= (gateStreak ? 1 : DOWNLOAD_SLOTS)) await new Promise(resolve => slotQueue.push(resolve));
  slotsInUse++;
  try {
    return await fn();
  } finally {
    slotsInUse--;
    pumpSlots();
  }
}

/**
 * fetch, until headers arrive: 3 attempts on a rejected fetch, a 429 or a 503,
 * through the gate. A response of any other status returns at once, and so does
 * a stream once it starts, so a build is never asked for again from here. Waits
 * out a `retryAfterMs` up to 30 s; past that the caller gets the answer. No
 * headers timeout: the Vite plugin may hold headers for a whole build.
 */
async function fetchRetrying(url, init) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= FETCH_RETRY_MS.length;
    await throughGate();
    let wait = last ? 0 : withJitter(FETCH_RETRY_MS[attempt]);
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status !== 503) {
        gateAnswered();
        return res;
      }
      const asked = await res
        .clone()
        .json()
        .then(body => body?.retryAfterMs)
        .catch(() => undefined);
      const busy = new Error("The server is busy (HTTP " + res.status + ")");
      busy.retry = "network";
      gateFailed(busy);
      if (last || asked > RETRY_AFTER_CAP_MS) return res;
      if (typeof asked === "number") wait = asked;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      error.retry = "network";
      gateFailed(error);
      if (last) throw error;
    }
    await sleep(wait);
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
  // A slot holds the connection, not the wait for a build: one slow warehouse
  // query must not hold up twelve bindings that are ready.
  let res = await withSlot(() =>
    fetchRetrying(path + (bust ? "?refresh=" + Date.now() : ""), {
      headers: { accept: PROGRESS_ACCEPT },
    }),
  );
  let signed = null;
  if (isProgressResponse(res)) {
    let final;
    try {
      final = await readProgressStream(res, e => report(progressPatch(e)));
    } catch (error) {
      // A cut build stream may have cost a warehouse query. Asking again costs another.
      throw new Error(what + ": the build's stream was cut (" + (error instanceof Error ? error.message : String(error)) + ")");
    }
    if (final.phase === "failed") throw progressError(final, what);
    report({ phase: "downloading", rowsWritten: null, bytes: 0 });
    // No url: the server streams the bytes itself — the same path, asked
    // plainly, serves them (the build already staged or cached them).
    signed = final.url || path;
    res = null;
  }
  return withSlot(async () => {
    res ??= await fetchRetrying(signed);
    if (!res.ok) throw await responseError(res, what);
    try {
      return await readBytes(res, (bytes, bytesTotal) =>
        report({ phase: "downloading", rowsWritten: null, bytes, bytesTotal }),
      );
    } catch (error) {
      if (error instanceof TypeError) error.retry = "network"; // the body cut off: no build behind it
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Memory (2.12). Every table lives in this frame's WASM heap, where DuckDB's
// memory_limit is 3.1 GiB. 2.8 to 2.11 never dropped one, so an app with many
// bindings (Web Performance: 106 shards) browsed its way to "Out of Memory".
//
// - Every read bumps its binding. Least recently used goes first.
// - The budget counts what the SDK placed: tables and the parquet copies views
//   read. An app's own tables do not shrink it. The real total still decides
//   whether a table can fit in the heap at all.
// - A table lands if the parquet's own metadata says it fits, after evicting what
//   no one holds. Measured tables can pass the estimate, so the budget can
//   overshoot (measured: 1,700 MiB against 1,536). With a mostly empty heap, one
//   table may try anyway: an ordinary app with one large parquet stays fast.
// - What does not fit lands as a view over its parquet in the heap
//   (registerFileBuffer): 7x to 14x smaller than its table. A later read, or the
//   end of pressure, promotes it if room has appeared.
// - Never a BROWSER_FILEREADER handle over a Blob: duckdb-wasm 1.29.0's openFile
//   writes the file size to HEAPF64[(ptr >> 3)], and `>>` turns a pointer past
//   2 GiB negative. Reads then fail with "too small to be a Parquet file" (4 of
//   8 reads with 3.0 GiB of tables, 0 of 8 with 1.6 GiB; heap buffers 0 of 8).
// - File copies have their own ceiling: 2.5 GiB, and 3.6 GiB with DuckDB's own
//   bytes. registerFileBuffer never checks its malloc: at 4.16 GiB of copies the
//   call never settled and hung the page. Over it the least recently read view
//   goes, pinned too, and downloads again on its next read.
// - The parquet stays in JS memory as a Blob only so a table can become a view
//   without a download. A Blob can stop being readable (NotReadableError on the
//   third 885 MiB in incognito). Its table then goes instead, and downloads again.
//   Past the Blob budget, the least recently used view is dropped outright.
// - A binding a mounted hook reads, or a query in flight, is pinned: it goes last.
//   Only loads in flight are never touched.
// - "Out of Memory" on a query demotes unpinned tables, then the pinned tables
//   that query reads, and retries until it answers or none is left. Other
//   panels' tables stay. For a minute (pressure) tables stay down, then pinned
//   views promote. Only DuckDB's own error counts (see markEngineError).
// - "Out of Memory" on a load demotes unpinned tables and retries once. A load
//   that still does not fit lands as a view.
//
// All catalog changes run one at a time (catalog()), so the bookkeeping here
// always matches DuckDB's catalog. The worker runs one statement at a time
// anyway, so this costs no parallelism.
// ---------------------------------------------------------------------------
const MIB = 1024 * 1024;
export const DEFAULT_BINDING_MEMORY_BUDGET = 1536 * MIB;
export const DEFAULT_BINDING_BLOB_BUDGET = 512 * MIB;
const DUCKDB_LIMIT = 3174 * MIB; // duckdb-wasm's default memory_limit: 3.1 GiB
const FILE_CEILING = 2560 * MIB;
const HEAP_CEILING = 3686 * MIB;
let memoryBudget = DEFAULT_BINDING_MEMORY_BUDGET;
let blobBudget = DEFAULT_BINDING_BLOB_BUDGET;

// name -> { storage: "table" | "view", blob: Blob | null, file: string | null,
// fileBytes: number, tableBytes: number | null, demoted: boolean }. `file` is the
// heap copy of the parquet a view reads, of `fileBytes`. `tableBytes`: what its
// table cost, measured. `demoted`: a view only because of memory: try to promote.
const entries = new Map();
const lastUse = new Map(); // name -> sequence number of its latest read
let useSeq = 0;
const pins = new Map(); // name -> how many hooks or queries hold it
const loading = new Set(); // names with a load in flight
// Loaded through ensureBinding(): app code may query them by name at any
// time, so they are demoted (still readable) but never dropped.
const externalBindings = new Set();
// Every binding this page ever loaded, for reading one the SDK evicted when the
// server's index does not list it (index [] apps name their bindings in useQuery).
const knownBindings = new Set();
let measuredBytes = 0;
// After an Out of Memory, tables stay at or under what relief left, for a minute.
const PRESSURE_MS = 60000;
let pressureCeiling = Infinity;
let pressureUntil = 0;
let pressureTimer = null;

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
  knownBindings.add(name);
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
  } catch (error) {
    throw markEngineError(error, engine);
  } finally {
    await conn.close();
  }
}

/**
 * An error from this engine's own conn.query. Only these can be Out of Memory:
 * a download or a server's build may quote the same words. A crash is noted here
 * and the engine restarts (restartEngine).
 */
function markEngineError(error, engine) {
  if (!(error instanceof Error)) return error;
  error.fromEngine = true;
  if (isOutOfMemoryError(error)) error.retry = "memory";
  if (crashedEngineError(error)) {
    error.message = "The data engine crashed (" + error.message + "). It restarts by itself; reload the page if this stays.";
    noteEngineCrash(engine);
  }
  return error;
}
const isEngineOom = error => Boolean(error?.fromEngine) && isOutOfMemoryError(error);

let fileSeq = 0;
// Every load registers its bytes under its own file name, so a reload never
// drops a file another load is still reading.
function nextFile() {
  return "mako-" + ++fileSeq + ".parquet";
}

// name -> its table in mako_tables. Each load gets a fresh table, so a view
// never points at a table whose columns changed under it.
const stores = new Map();
let storeSeq = 0;
function storeSql(store) {
  return "mako_tables.main." + quoteIdent(store);
}

/**
 * Drop the compressed table behind `name`, if any. Runs after the view has moved,
 * so a failure costs memory until the page reloads and never fails the load.
 */
async function dropStore(engine, name) {
  const store = stores.get(name);
  if (!store) return;
  stores.delete(name);
  await exec(engine, ["DROP TABLE IF EXISTS " + storeSql(store)]).catch(() => {});
}

/**
 * A registered parquet `file` decoded into a compressed table, and a view named
 * `name` over it. The name is always a view, so CREATE OR REPLACE VIEW swaps it
 * atomically. A transaction cannot write to two databases, so the order keeps it
 * readable: new table, then the view, then the old table goes.
 */
async function tableFromFile(engine, name, file) {
  const prev = entries.get(name);
  const before = await duckdbBytes(engine);
  const store = "t" + ++storeSeq;
  await exec(engine, ["CREATE TABLE " + storeSql(store) + " AS SELECT * FROM read_parquet(" + quoteString(file) + ")"]);
  try {
    // Only a CHECKPOINT compresses. It fails while a transaction is open on
    // another connection: the table stays readable, and the next load's
    // CHECKPOINT compresses it.
    await exec(engine, ["CHECKPOINT mako_tables"]).catch(() => {});
    await exec(engine, ["CREATE OR REPLACE VIEW " + quoteIdent(name) + " AS SELECT * FROM " + storeSql(store)]);
  } catch (error) {
    await exec(engine, ["DROP TABLE IF EXISTS " + storeSql(store)]).catch(() => {});
    throw error;
  }
  await dropStore(engine, name);
  stores.set(name, store);
  const after = await duckdbBytes(engine);
  if (before === null || after === null) return prev?.tableBytes ?? null;
  const grown = after - before + (prev?.storage === "table" ? (prev.tableBytes ?? 0) : 0);
  return grown > 0 ? grown : (prev?.tableBytes ?? null);
}

/** The view over a registered parquet `file`, in place of whatever `name` was. */
async function viewFromFile(engine, name, file) {
  const prev = entries.get(name);
  const create =
    "CREATE OR REPLACE VIEW " + quoteIdent(name) +
    " AS SELECT * FROM read_parquet(" + quoteString(file) + ")";
  await exec(engine, [create]);
  await dropStore(engine, name);
}

/**
 * What a registered parquet's table will cost, from its metadata: 16 bytes a cell,
 * or its uncompressed pages if long strings make that more. Measured on 6 parquets
 * from 2 to 402 MiB: the real table was 0.84x to 1.01x of the 16-byte figure.
 */
async function estimateTable(engine, file, parquetBytes) {
  const conn = await engine.connect();
  try {
    const f = quoteString(file);
    const result = await conn.query(
      "SELECT greatest(sum(total_uncompressed_size), " +
        "count(DISTINCT path_in_schema) * (SELECT num_rows FROM parquet_file_metadata(" + f + ")) * 16)::DOUBLE " +
        "FROM parquet_metadata(" + f + ")",
    );
    const value = Number(result.getChildAt(0)?.get(0));
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    /* no metadata to read: the file's own error surfaces when it is read */
  } finally {
    await conn.close();
  }
  return parquetBytes * 16;
}

/** What the SDK placed: tables, and the parquet copies views read. */
function ownedBytes() {
  let bytes = 0;
  for (const entry of entries.values()) {
    bytes += entry.storage === "table" ? (entry.tableBytes ?? (entry.blob?.size ?? 0) * 16) : entry.fileBytes;
  }
  return bytes;
}
function fileBytes() {
  let bytes = 0;
  for (const entry of entries.values()) if (entry.storage === "view") bytes += entry.fileBytes;
  return bytes;
}

/**
 * What this frame's heap holds right now, in bytes: DuckDB's figure, with app
 * tables and every binding table, plus the parquet copies views read, which sit
 * outside its accounting. Query scratch never shows: DuckDB returns it before the
 * next statement runs (measured, also after a failed query). The last figure if
 * it cannot say.
 */
async function measureNow(engine) {
  const value = await duckdbBytes(engine);
  if (value !== null) measuredBytes = value + fileBytes();
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
  } catch (error) {
    markEngineError(error, engine);
    return null; /* the OOM retry still applies */
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// Across apps (2.13). Each app frame has its own DuckDB and its own WASM heap,
// so evicting inside one frame frees nothing for the next app opened. The SDK
// tells Mako's shell what its heap holds; the shell keeps one budget across its
// app frames and asks the least recently shown ones to release. A WASM heap
// never shrinks: demoting a table frees DuckDB's accounting and leaves the bytes
// reserved. So release means ending the worker, and the report is the most this
// worker has held. It is measuredBytes, not bindingBytes: an app's own tables
// sit in the same renderer. Parquet stays here as Blobs ("parked"): the next read
// boots a new engine and decodes from them, with no download and no gate.
//
// A worker can end only when nothing lives in it but bindings. App code that may
// hold the engine or keep its own state there keeps it for the page's life
// (keepEngine), says so in its reports, and the shell asks another frame.
//
// A release is not a crash: it never counts against MAX_RESTARTS, never reruns a
// hook, and leaves the gate and the download slots alone. They describe the
// server. Nothing in flight also means no load holds a slot.
// ---------------------------------------------------------------------------
const MEMORY_MESSAGE = "mako-app:duckdb-memory";
const RELEASE_MESSAGE = "mako-host:duckdb-release";
const inFrame = typeof window !== "undefined" && window.parent != null && window.parent !== window;
const parked = new Map(); // name -> Blob of a binding whose engine was released
let engineKept = false;
let heapBytes = 0; // the most this worker has held: its heap never gives it back
let busy = 0; // hooks, withConnection calls and queries in flight
let reportedBytes = null;
let reportedKept = false;

function reportMemory() {
  heapBytes = Math.max(heapBytes, measuredBytes);
  if (!inFrame || (heapBytes === reportedBytes && engineKept === reportedKept)) return;
  reportedBytes = heapBytes;
  reportedKept = engineKept;
  try {
    window.parent.postMessage({ type: MEMORY_MESSAGE, bytes: heapBytes, canRelease: !engineKept }, "*");
  } catch {
    /* a host that is not Mako: nothing to tell */
  }
}

/** Something only this worker has may exist from now on: never end it. */
function keepEngine() {
  if (engineKept) return;
  engineKept = true;
  reportMemory();
}

/**
 * The host's ask: give the memory back. Nothing in flight: park every Blob and
 * end the worker. Rows already on screen stay (they are plain JS); the next
 * query reboots. Busy: skipped, and the host asks again. A kept engine stays. So
 * does one with a crash restart due: that ends it and reruns the panels that saw
 * the crash, which a release would not.
 */
async function releaseEngine() {
  const idle = () => !engineKept && !restartTimer && busy === 0 && loading.size === 0 && refreshes.size === 0;
  const current = dbPromise;
  if (!current || !idle()) return;
  const engine = await current;
  await catalog(async () => {
    if (dbPromise !== current || !idle()) return;
    // From here to dbPromise = null runs without a yield: no query can grab
    // the old engine in between. liveEngine goes too: a crash report from this
    // engine must not restart the next one.
    for (const [name, entry] of entries) if (entry.blob) parked.set(name, entry.blob);
    entries.clear();
    stores.clear();
    registered.clear();
    loadedBindings.clear();
    liveEngine = null;
    dbPromise = null;
    measuredBytes = 0;
    heapBytes = 0;
    pressureUntil = 0; // the next engine starts with an empty heap
    clearTimeout(pressureTimer);
    reportMemory();
    await engine.terminate().catch(() => {});
  });
}

if (inFrame) {
  window.addEventListener("message", event => {
    // Only the frame's own parent may ask. The ask can do no harm beyond a
    // slower next query, so the parent's origin (Mako's, whatever host it
    // runs on) is not pinned here.
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== RELEASE_MESSAGE) return;
    releaseEngine().catch(() => {
      /* the next ask, or the next load's trim, tries again */
    });
  });
}

/** The least recently read binding that passes `test` and nothing holds. */
function leastRecent(test, pinnedToo = false) {
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
  await exec(engine, ["DROP VIEW IF EXISTS " + quoteIdent(name)]);
  await dropStore(engine, name);
  if (entry.file) await engine.dropFile(entry.file).catch(() => {});
  entries.delete(name);
  loadedBindings.delete(name);
  registered.delete(name);
}

/**
 * Room in the heap for `incoming` bytes of parquet copy. registerFileBuffer does
 * not check its malloc, so past this point nothing would report the failure. Goes
 * through views least recently read first, pinned too: their next read downloads.
 */
async function roomForFile(engine, incoming, except) {
  for (;;) {
    const duckdb = (await duckdbBytes(engine)) ?? 0;
    const files = fileBytes();
    if (files + incoming <= FILE_CEILING && duckdb + files + incoming <= HEAP_CEILING) return;
    const victim = leastRecent(
      (name, entry) => name !== except && entry.storage === "view" && !externalBindings.has(name),
      true,
    );
    if (!victim) {
      const mib = Math.round(incoming / MIB);
      throw new Error("A " + mib + " MiB parquet does not fit in this page's DuckDB heap, which holds " + Math.round((duckdb + files) / MIB) + " MiB.");
    }
    await dropNow(engine, victim);
  }
}

/** One step down: a table becomes a view over a copy of its Blob, or goes. */
async function evictNow(engine, name) {
  const entry = entries.get(name);
  let file = null;
  if (entry.blob) {
    try {
      await roomForFile(engine, entry.blob.size, name);
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      file = nextFile();
      await engine.registerFileBuffer(file, bytes);
    } catch (error) {
      if (error?.fromEngine) throw error;
      file = null; // an unreadable Blob, or no room for its copy
    }
  }
  if (file) {
    try {
      await viewFromFile(engine, name, file);
    } catch (error) {
      await engine.dropFile(file).catch(() => {});
      throw error;
    }
    if (entry.file) await engine.dropFile(entry.file).catch(() => {});
    entries.set(name, { ...entry, storage: "view", file, fileBytes: entry.blob.size, demoted: true });
    return;
  }
  // App code may read this one by name at any time: it stays a table, and no
  // eviction asks again (evictableTable).
  if (externalBindings.has(name)) {
    entries.set(name, { ...entry, blob: null });
    return;
  }
  await dropNow(engine, name);
}

const evictableTable = except => (name, entry) =>
  name !== except &&
  entry.storage === "table" &&
  (entry.blob !== null || !externalBindings.has(name));

/** Evict least recently used tables until the bindings hold at most `target`. */
async function trimNow(engine, except, target = memoryBudget) {
  for (;;) {
    if (ownedBytes() <= target) break;
    const victim = leastRecent(evictableTable(except));
    if (!victim) break;
    await evictNow(engine, victim);
  }
  for (;;) {
    let blobs = 0;
    for (const entry of entries.values()) if (entry.blob) blobs += entry.blob.size;
    if (blobs <= blobBudget) break;
    const victim = leastRecent(
      (name, entry) =>
        name !== except && entry.blob !== null && !(entry.storage === "view" && externalBindings.has(name)),
    );
    if (!victim) break;
    const entry = entries.get(victim);
    if (entry.storage === "view") await dropNow(engine, victim);
    // A table keeps its rows; evicting it later drops it outright.
    else entries.set(victim, { ...entry, blob: null });
  }
  await measureNow(engine);
}

/**
 * After an Out of Memory error: demote tables, least recently used first, until
 * the bindings hold half of what they did (or half the budget). A load stops at
 * unpinned tables. A query goes on to pinned tables it reads itself (`reads`): a
 * query that can never fit must not take healthy panels down with it. Returns how
 * many it freed; 0: a retry would fail the same way.
 */
async function relieveNow(engine, except, reads = null) {
  const target = Math.min(memoryBudget, ownedBytes()) / 2;
  const evictable = evictableTable(except);
  let freed = 0;
  for (;;) {
    const victim =
      leastRecent(evictable) ??
      (reads ? leastRecent((name, entry) => reads.has(name) && entry.blob !== null && evictable(name, entry), true) : null);
    if (!victim) break;
    await evictNow(engine, victim);
    freed++;
    if (ownedBytes() <= target) break;
  }
  if (freed) startPressure();
  await measureNow(engine);
  return freed;
}

function startPressure() {
  pressureCeiling = ownedBytes();
  pressureUntil = Date.now() + PRESSURE_MS;
  clearTimeout(pressureTimer);
  pressureTimer = setTimeout(endPressure, PRESSURE_MS);
  pressureTimer.unref?.();
}

/** Pinned views come back on their own: a mounted panel may not read again soon. */
async function endPressure() {
  const waiting = [...entries]
    .filter(([name, entry]) => entry.demoted && isPinned(name) && !loading.has(name))
    .sort(([a], [b]) => (lastUse.get(b) ?? 0) - (lastUse.get(a) ?? 0));
  for (const [name] of waiting) {
    await promote(name);
    if (entries.get(name)?.storage !== "table") break; // full: the rest would not fit either
  }
}

/**
 * Whether a table costing `estimate` fits, evicting what no one holds to make
 * room. Checked before decoding: a table placed past the ceiling could only be
 * demoted again.
 */
async function roomForTable(engine, name, estimate) {
  const prev = entries.get(name);
  const replaced = !prev ? 0 : prev.storage === "table" ? (prev.tableBytes ?? estimate) : prev.fileBytes;
  const fitsHeap = async () => ((await duckdbBytes(engine)) ?? 0) + estimate <= DUCKDB_LIMIT;
  // A single table over the ceiling: never evict for it. With a mostly empty
  // heap, let it try: an OOM lands it as a view, and queries keep what is left.
  if (estimate > tableCeiling()) {
    return (
      estimate <= memoryBudget * 2 &&
      Date.now() >= pressureUntil &&
      ownedBytes() - replaced <= memoryBudget / 4 &&
      (await fitsHeap())
    );
  }
  for (;;) {
    if (ownedBytes() - replaced + estimate <= tableCeiling()) return fitsHeap();
    const victim = leastRecent(evictableTable(name));
    if (!victim) return false;
    await evictNow(engine, victim);
  }
}

/**
 * Decode a download into DuckDB: a table when it fits, else a view. Reads `buf`,
 * never the Blob: these bytes are in hand and a Blob can be unreadable.
 */
async function placeNow(engine, name, buf, blob) {
  const prev = entries.get(name);
  await roomForFile(engine, buf.length, name);
  const file = nextFile();
  const size = buf.length;
  await engine.registerFileBuffer(file, buf); // transfers `buf` to the worker
  const asView = async () => {
    await viewFromFile(engine, name, file);
    if (prev?.file) await engine.dropFile(prev.file).catch(() => {});
    return { storage: "view", file, fileBytes: size, demoted: true };
  };
  const asTable = async () => {
    // The table is decoded in full before it compresses, and a WASM heap never
    // gives that back. The commit compresses, so no later measure can see it.
    const decoded = await estimateTable(engine, file, blob.size);
    const tableBytes = await tableFromFile(engine, name, file);
    heapBytes = Math.max(heapBytes, measuredBytes + decoded);
    await engine.dropFile(file).catch(() => {});
    if (prev?.file) await engine.dropFile(prev.file).catch(() => {});
    return { storage: "table", file: null, fileBytes: 0, demoted: false, tableBytes };
  };
  try {
    const estimate = prev?.tableBytes ?? (await estimateTable(engine, file, blob.size));
    if (!(await roomForTable(engine, name, estimate))) return await asView();
    try {
      return await asTable();
    } catch (error) {
      if (!isEngineOom(error)) throw error;
    }
    if (await relieveNow(engine, name)) {
      try {
        return await asTable();
      } catch (error) {
        if (!isEngineOom(error)) throw error;
      }
    }
    return await asView();
  } catch (error) {
    await engine.dropFile(file).catch(() => {});
    throw error;
  }
}

async function loadBinding(name, bust) {
  const db = getDb(); // boot in parallel with the download
  db.catch(() => {});
  loading.add(name);
  try {
    // Parked by a release: the same bytes, no download (unless a refresh made
    // them stale). A Blob can stop being readable: then it downloads.
    const kept = parked.get(name);
    parked.delete(name);
    const parkedBytes = kept && !bust ? await kept.arrayBuffer().catch(() => null) : null;
    const buf = parkedBytes
      ? new Uint8Array(parkedBytes)
      : await downloadBinding(name, bust, patch => setProgress(name, patch));
    setProgress(name, { phase: "loading_duckdb" });
    const engine = await db;
    // Made before the buffer goes to the worker: the copy a demotion reads.
    const blob = new Blob([buf]);
    await catalog(async () => {
      const placed = await placeNow(engine, name, buf, blob);
      const tableBytes = placed.tableBytes ?? entries.get(name)?.tableBytes ?? null;
      entries.set(name, { ...placed, blob, tableBytes });
      knownBindings.add(name);
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
 * A demoted view read again: back to a table from its heap copy, no download, if
 * it fits. Otherwise it stays a view, and the next read asks again: a view that
 * promoted itself into a full heap would only be demoted again.
 */
async function promote(name) {
  const engine = await getDb();
  await catalog(async () => {
    const entry = entries.get(name);
    if (!entry || entry.storage !== "view" || !entry.file) return;
    if (!(await roomForTable(engine, name, entry.tableBytes ?? (await estimateTable(engine, entry.file, entry.fileBytes))))) {
      entry.demoted = true;
      return;
    }
    const decoded = await estimateTable(engine, entry.file, entry.fileBytes ?? 0);
    const tableBytes = await tableFromFile(engine, name, entry.file);
    heapBytes = Math.max(heapBytes, measuredBytes + decoded); // decoded before it compressed
    await engine.dropFile(entry.file).catch(() => {});
    entries.set(name, { ...entry, storage: "table", file: null, fileBytes: 0, demoted: false, tableBytes });
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
  knownBindings.add(name);
  const known = registered.get(name);
  if (!known) {
    const load = loadBinding(name, staleBindings.delete(name));
    return trackRegistered(name, load);
  }
  const entry = entries.get(name);
  if (entry && entry.demoted && !loading.has(name)) {
    entry.demoted = false; // one promotion at a time
    // The view reads fine whatever became of the promise before this one.
    return trackRegistered(name, known.catch(() => {}).then(() => promote(name)));
  }
  return known;
}

/** The promise a next read waits on. A rejected one never stays: it would answer for good. */
function trackRegistered(name, promise) {
  registered.set(name, promise);
  promise.catch(() => {
    if (registered.get(name) === promise) registered.delete(name);
  });
  return promise;
}

/**
 * Cap what bindings may hold in DuckDB, in bytes (default 1.5 GiB, half of the
 * frame's 3.1 GiB heap: queries need the rest). Checked with an estimate before
 * each load, so it can overshoot. Past it, the least recently read tables become
 * views over a heap copy of their parquet. `opts.blobBytes` caps the parquet kept
 * in JS memory (default 512 MiB); past it the oldest are dropped and download
 * again on their next read. `Infinity` turns either off. Resolves once the engine
 * is back under the new budget, and ends any memory pressure.
 */
export async function setBindingMemoryBudget(bytes, opts) {
  const valid = n => typeof n === "number" && n > 0 && !Number.isNaN(n);
  if (!valid(bytes)) throw new TypeError("setBindingMemoryBudget: a positive number of bytes");
  memoryBudget = bytes;
  pressureUntil = 0; // the caller has just said what tables may hold
  clearTimeout(pressureTimer);
  if (opts && opts.blobBytes !== undefined) {
    if (!valid(opts.blobBytes)) throw new TypeError("setBindingMemoryBudget: blobBytes must be a positive number");
    blobBudget = opts.blobBytes;
  }
  wakeRetries();
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
    bindingBytes: ownedBytes(),
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
  keepEngine();
  return getDb();
}

/** Run `fn` with a fresh connection to the shared DuckDB; always closed after. */
export async function withConnection(fn) {
  keepEngine();
  busy++;
  try {
    const db = await getDb();
    const conn = await db.connect();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  } finally {
    busy--;
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
  keepEngine(); // its contract: the name stays readable, by code the SDK cannot see
  externalBindings.add(name);
  await registerBinding(name);
  return name;
}

/**
 * Forget a loaded binding: drops its table (or view) so its memory is freed.
 * The next query or ensureBinding() downloads it again.
 */
export async function unloadBinding(name) {
  parked.delete(name);
  knownBindings.delete(name);
  const pending = registered.get(name);
  if (!pending) return;
  registered.delete(name);
  externalBindings.delete(name);
  await pending.catch(() => {});
  if (registered.has(name)) return; // read again meanwhile: it stays
  const engine = await getDb();
  await catalog(() => dropNow(engine, name));
  wakeRetries();
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
  await trackRegistered(name, loadBinding(name, true));
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
const INDEX_RETRY_MS = 10000;
function bindingIndex() {
  if (indexPromise) return indexPromise;
  // 20 panels asking at once share one answer, a failed one for 10 s too.
  const forget = () => {
    const t = setTimeout(() => {
      if (indexPromise === pending) indexPromise = null;
    }, INDEX_RETRY_MS);
    t.unref?.();
  };
  const pending = fetchRetrying("__data/index.json").then(async r => {
    // A 404 is an older server or a published build: empty, for good.
    if (!r.ok && r.status !== 404) forget();
    if (r.status === 429 || r.status === 503) throw await responseError(r, "The binding list could not be loaded");
    if (!r.ok) return [];
    const list = await r.json().catch(() => []);
    return Array.isArray(list) ? list : [];
  });
  indexPromise = pending;
  pending.catch(forget);
  return pending;
}

// Out of Memory on a query: free tables, pinned ones the query reads last, and
// try again. Each pass demotes at least one table, so this ends. With nothing left
// to free, DuckDB's error surfaces and the hook decides (useAsyncQuery).
async function runSql(sql, rowLimit, format, reads) {
  for (;;) {
    try {
      return await runSqlOnce(sql, rowLimit, format);
    } catch (error) {
      if (!isEngineOom(error)) throw error;
      const engine = await getDb();
      const freed = await catalog(() => relieveNow(engine, null, reads)).catch(() => 0);
      if (!freed) throw error;
    }
  }
}

async function runSqlOnce(sql, rowLimit, format) {
  const cap = rowLimit === null ? Infinity : (rowLimit ?? DEFAULT_ROW_LIMIT);
  const writes = !isReadOnlySql(sql);
  if (writes) keepEngine(); // CREATE TABLE journal_t: only this worker has it
  busy++; // before the await: a release must not end the engine under it
  try {
    const db = await getDb();
    const conn = await db.connect();
    try {
      const table = await conn.query(sql);
      // No load follows to measure what the app just made, and the report owes it.
      if (writes) catalog(() => measureNow(db)).catch(() => {});
      const rowCount = table.numRows;
      if (format === "arrow") {
        // The Arrow Table as DuckDB returned it: no row objects, no
        // normalization, no row limit.
        return { rows: table, fields: table.schema.fields.map(f => f.name), rowCount, truncated: false };
      }
      const { rows, fields } = toPlainRows(table, cap);
      return { rows, fields, rowCount, truncated: rowCount > rows.length };
    } catch (error) {
      throw markEngineError(error, db);
    } finally {
      await conn.close();
    }
  } finally {
    busy--;
  }
}

// A crashed engine stays crashed: the SQL that broke it can answer, then every
// later query fails with a raw WASM trap. So the page starts a new engine.
// Bindings download again. Pins stay: they belong to mounted hooks.
const RESTART_EVERY_MS = 60000;
const MAX_RESTARTS = 3;
let lastRestart = -Infinity;
let restarts = 0;
let restartTimer = null;
function noteEngineCrash(engine) {
  if (engine !== liveEngine || restartTimer || restarts >= MAX_RESTARTS) return;
  restartTimer = setTimeout(restartEngine, Math.max(0, lastRestart + RESTART_EVERY_MS - Date.now()));
}
function restartEngine() {
  restartTimer = null;
  const old = liveEngine;
  if (!old) return;
  restarts++;
  lastRestart = Date.now();
  liveEngine = null;
  dbPromise = null;
  catalogQueue = Promise.resolve();
  entries.clear();
  stores.clear();
  registered.clear();
  loadedBindings.clear();
  measuredBytes = 0;
  heapBytes = 0;
  pressureUntil = 0;
  reportMemory();
  old.terminate().catch(() => {});
  setBindingState({ ...bindingState, version: bindingState.version + 1 });
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
// A query that failed on memory or the network runs again by itself, a few times
// (retryDelayMs). After that it waits for a reason to expect a different answer:
// another hook let go of its bindings, the budget changed, the server answered
// again, the tab came back, the network came back. The error stays up until a run
// answers. A hidden tab waits too. Anything else stays as it is.
const retryWaiters = new Set();
function wakeRetries() {
  const waiting = [...retryWaiters];
  retryWaiters.clear();
  for (const fire of waiting) fire();
}
// The user or the network is back: let one probe through a closed gate, too.
function tryAgainNow() {
  gateUntil = 0;
  wakeRetries();
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", tryAgainNow);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tryAgainNow();
    });
  }
}

function useAsyncQuery(run, deps, isRefreshing) {
  const bindings = useBindingState();
  const [state, setState] = React.useState(EMPTY);
  const [attempt, setAttempt] = React.useState(0);
  const seenVersion = React.useRef(bindings.version);
  const seenAttempt = React.useRef(attempt);
  const retries = React.useRef(0);
  const retrying = React.useRef(false);
  React.useEffect(() => {
    let active = true;
    let timer = null;
    let waiter = null;
    const isRefresh = seenVersion.current !== bindings.version;
    const isRetry = seenAttempt.current !== attempt;
    seenVersion.current = bindings.version;
    seenAttempt.current = attempt;
    retrying.current = false;
    if (!isRetry) {
      retries.current = 0;
      setState(s => (isRefresh && s.data !== null ? { ...s, refreshing: true } : EMPTY));
    }
    const held = [];
    // From the first await to the last. Between a hook's load and its query
    // nothing else is in flight, and a release there would end the engine
    // holding the table the query is about to read.
    busy++;
    const settled = run(name => held.push(pin(name)));
    settled.catch(() => {}).finally(() => {
      busy--;
    });
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
        waiter = () => {
          if (typeof document !== "undefined" && document.hidden) {
            retryWaiters.add(waiter);
            return;
          }
          retrying.current = true;
          setAttempt(n => n + 1);
        };
        if (wait === Infinity) retryWaiters.add(waiter);
        else timer = setTimeout(waiter, wait);
      },
    );
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      if (waiter) retryWaiters.delete(waiter);
      const letsGo = !retrying.current;
      settled.catch(() => {}).finally(() => {
        for (const release of held) release();
        // Its own retry frees nothing, or two failing panels would wake each other.
        if (letsGo && held.length) wakeRetries();
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
      const r = await runSql("SELECT * FROM " + quoteIdent(name), rowLimit, undefined, new Set([name]));
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
  // No index still answers `select 1`. It matters only if the query then fails.
  let indexFailure = null;
  const index = await bindingIndex().catch(error => {
    indexFailure = error;
    return [];
  });
  const names = [...new Set([...index, ...knownBindings])];
  const failures = new Map();
  const attempted = new Set();
  const reloaded = new Set();
  const load = n => {
    attempted.add(n);
    hold(n);
    return registerBinding(n).catch(e => {
      failures.set(n, e);
    });
  };
  const wanted = readsCatalog(sql) ? names : mentionedBindings(sql, names);
  if (!readsCatalog(sql) && wanted.length > MAX_BINDINGS_IN_QUERY) {
    throw new Error(
      "This query names " + wanted.length + " bindings. One query can read at most " + MAX_BINDINGS_IN_QUERY +
        ": around 60 overflow DuckDB's WASM stack and break the engine for every panel. Read fewer shards, or combine them in the warehouse.",
    );
  }
  await Promise.all(wanted.map(load));
  for (;;) {
    try {
      return await runSql(sql, rowLimit, format, attempted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = missingBinding(message, names);
      // Never asked for, or the SDK evicted it under this query. Once per run.
      if (missing && !failures.has(missing) && !reloaded.has(missing) && (!attempted.has(missing) || !registered.has(missing))) {
        reloaded.add(missing);
        await load(missing);
        if (failures.has(missing)) throw failures.get(missing);
        continue;
      }
      for (const [n, cause] of failures) {
        if (message.includes(n)) throw cause;
      }
      if (failures.size) {
        const causes = [...failures.values()];
        const details = causes.map(e => (e instanceof Error ? e.message : String(e))).join("; ");
        const wrapped = new Error(message + " (bindings that failed to load: " + details + ")");
        const retryable = causes.find(e => e?.retry);
        wrapped.retry = error?.retry ?? retryable?.retry;
        wrapped.retryAfterMs = retryable?.retryAfterMs;
        throw wrapped;
      }
      if (indexFailure && !error?.retry) throw indexFailure;
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
