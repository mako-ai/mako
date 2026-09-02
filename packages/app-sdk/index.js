// @makoai/app-sdk — see package.json. Plain ESM on purpose: no build step.
import * as React from "react";

const DEFAULT_ROW_LIMIT = 500000;
const DUCKDB_ESM =
  "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

// ---------------------------------------------------------------------------
// DuckDB: one lazy instance per page, bindings registered on first use. The
// engine arrives from the CDN at runtime, so this package needs no install
// step and no dependencies of its own.
// ---------------------------------------------------------------------------
let dbPromise = null;
function getDb() {
  dbPromise ??= (async () => {
    const duckdb = await import(/* @vite-ignore */ DUCKDB_ESM);
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const worker = await duckdb.createWorker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
  })();
  return dbPromise;
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

async function loadBinding(name, bust) {
  const res = await fetch(
    "__data/" + encodeURIComponent(name) + ".parquet" + (bust ? "?refresh=" + Date.now() : ""),
  );
  if (!res.ok) {
    throw await responseError(res, 'Data for binding "' + name + '" could not be loaded');
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const db = await getDb();
  if (bust) await db.dropFile(name + ".parquet").catch(() => {});
  await db.registerFileBuffer(name + ".parquet", buf);
  const conn = await db.connect();
  try {
    // A view per binding so SQL can name tables by binding name.
    await conn.query(
      'CREATE OR REPLACE VIEW "' + name.replace(/"/g, '""') +
        "\" AS SELECT * FROM read_parquet('" + name + ".parquet')",
    );
  } finally {
    await conn.close();
  }
}

const registered = new Map(); // name -> Promise<void>
function registerBinding(name) {
  if (!registered.has(name)) {
    const load = loadBinding(name, false);
    registered.set(name, load);
    load.catch(() => registered.delete(name));
  }
  return registered.get(name);
}

/** Replace a binding's loaded bytes with what the server has now. */
async function reloadBinding(name) {
  // Let a load in flight settle first, or its (older) bytes could land after
  // the fresh ones and win.
  const previous = registered.get(name);
  if (previous) await previous.catch(() => {});
  const load = loadBinding(name, true);
  registered.set(name, load);
  try {
    await load;
  } catch (error) {
    registered.delete(name);
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
 * request.
 */
export function refreshBinding(name) {
  const pending = refreshes.get(name);
  if (pending) return pending;
  const run = (async () => {
    const res = await fetch("__data/" + encodeURIComponent(name) + "/refresh", { method: "POST" });
    if (!res.ok) {
      throw await responseError(res, 'Binding "' + name + '" could not be refreshed');
    }
    const body = await res.json();
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

/** Names of every staged binding — written by the dev server next to the
 * parquet files. Absent (older servers, published builds): empty list. */
let indexPromise = null;
function bindingIndex() {
  indexPromise ??= fetch("__data/index.json")
    .then(r => (r.ok ? r.json() : []))
    .then(list => (Array.isArray(list) ? list : []))
    .catch(() => []);
  return indexPromise;
}

// Arrow → plain JS, with the types apps actually want. DuckDB hands DATE and
// TIMESTAMP columns to JS as epoch milliseconds; v1 apps (JSON over the wire)
// always saw strings, and a migrated formatDate() that did
// new Date(`${d}T00:00:00`) on a number threw and unmounted the whole app
// (apps.md §15.4). So: DATE → "YYYY-MM-DD", TIMESTAMP → ISO 8601, BigInt →
// Number when it fits. Everything else passes through untouched.
function columnDecoder(field) {
  const type = String(field.type);
  if (type.startsWith("Date")) {
    return v => (v == null ? v : new Date(Number(v)).toISOString().slice(0, 10));
  }
  if (type.startsWith("Timestamp")) {
    return v => (v == null ? v : new Date(Number(v)).toISOString());
  }
  return v =>
    typeof v === "bigint" && v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER
      ? Number(v)
      : v;
}

function toPlainRows(table, cap) {
  const rows = [];
  const fields = table.schema.fields.map(f => f.name);
  const decoders = table.schema.fields.map(columnDecoder);
  const limit = cap == null ? Infinity : cap;
  for (const row of table) {
    if (rows.length >= limit) break;
    const out = {};
    for (let i = 0; i < fields.length; i++) {
      out[fields[i]] = decoders[i](row[fields[i]]);
    }
    rows.push(out);
  }
  return { rows, fields };
}

async function runSql(sql, rowLimit) {
  const cap = rowLimit === null ? Infinity : (rowLimit ?? DEFAULT_ROW_LIMIT);
  const db = await getDb();
  const conn = await db.connect();
  try {
    const table = await conn.query(sql);
    const rowCount = table.numRows;
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
function useAsyncQuery(run, deps, isRefreshing) {
  const bindings = useBindingState();
  const [state, setState] = React.useState(EMPTY);
  const seenVersion = React.useRef(bindings.version);
  React.useEffect(() => {
    let active = true;
    const isRefresh = seenVersion.current !== bindings.version;
    seenVersion.current = bindings.version;
    setState(s => (isRefresh && s.data !== null ? { ...s, refreshing: true } : EMPTY));
    run().then(
      result => {
        if (active) setState({ ...result, error: null, loading: false, refreshing: false });
      },
      error => {
        if (active)
          setState({
            ...EMPTY,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          });
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bindings.version]);
  return {
    ...state,
    refreshing: state.refreshing || isRefreshing(bindings.refreshing),
  };
}

export function useQuery(name, opts) {
  const rowLimit = opts ? opts.rowLimit : undefined;
  const state = useAsyncQuery(
    async () => {
      await registerBinding(name);
      const r = await runSql(
        'SELECT * FROM "' + name.replace(/"/g, '""') + '"',
        rowLimit,
      );
      return { data: r.rows, fields: r.fields, truncated: r.truncated, rowCount: r.rowCount };
    },
    [name, rowLimit],
    refreshing => refreshing.has(name),
  );
  const refresh = React.useCallback(() => refreshBinding(name), [name]);
  return { ...state, refresh };
}

export function useDuckDB(sql, opts) {
  const rowLimit = opts ? opts.rowLimit : undefined;
  const state = useAsyncQuery(async () => {
    // Register everything the server staged, so SQL can join across
    // bindings by name without declaring them first. A binding that fails to
    // load must not sink the whole query set silently: remember why, and when
    // the SQL then fails (typically DuckDB's "Table … does not exist"),
    // surface the load failure — it is the actual cause.
    const names = await bindingIndex();
    const failures = new Map();
    await Promise.all(
      names.map(n => registerBinding(n).catch(e => failures.set(n, e))),
    );
    try {
      const r = await runSql(sql, rowLimit);
      return { data: r.rows, fields: r.fields, truncated: r.truncated, rowCount: r.rowCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
  }, [sql, rowLimit], refreshing => refreshing.size > 0);
  // A query over every binding refreshes every binding.
  const refresh = React.useCallback(() => refreshBindings(), []);
  return { ...state, refresh };
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
// Theme tokens — the same shadcn-style palette the v1 runtime injected around
// every app (app/src/app-runtime/preview.ts THEME_TOKENS_CSS). The v1 skill
// taught agents to write var(--background) / var(--border) / var(--chart-N)
// directly, so migrated apps DEPEND on these names existing; without them a
// v2 build renders with no backgrounds or borders at all. The SDK restores
// the contract wherever it loads: prepended to <head> so any app stylesheet
// overrides it, keyed by id so double-imports no-op, dark on :root.dark (the
// v1 toggle) plus the system preference for standalone.
// ---------------------------------------------------------------------------
const MAKO_THEME_TOKENS_CSS = ":root {\n  color-scheme: light;\n  --background: hsl(0 0% 100%);\n  --foreground: hsl(240 10% 3.9%);\n  --card: hsl(0 0% 100%);\n  --card-foreground: hsl(240 10% 3.9%);\n  --popover: hsl(0 0% 100%);\n  --popover-foreground: hsl(240 10% 3.9%);\n  --primary: hsl(240 5.9% 10%);\n  --primary-foreground: hsl(0 0% 98%);\n  --secondary: hsl(240 4.8% 95.9%);\n  --secondary-foreground: hsl(240 5.9% 10%);\n  --muted: hsl(240 4.8% 95.9%);\n  --muted-foreground: hsl(240 3.8% 46.1%);\n  --accent: hsl(240 4.8% 95.9%);\n  --accent-foreground: hsl(240 5.9% 10%);\n  --destructive: hsl(0 84.2% 60.2%);\n  --destructive-foreground: hsl(0 0% 98%);\n  --border: hsl(240 5.9% 90%);\n  --input: hsl(240 5.9% 90%);\n  --ring: hsl(240 5.9% 10%);\n  --chart-1: hsl(12 76% 61%);\n  --chart-2: hsl(173 58% 39%);\n  --chart-3: hsl(197 37% 24%);\n  --chart-4: hsl(43 74% 66%);\n  --chart-5: hsl(27 87% 67%);\n  --radius: 0.5rem;\n}\n:root.dark {\n  color-scheme: dark;\n  --background: hsl(240 10% 3.9%);\n  --foreground: hsl(0 0% 98%);\n  --card: hsl(240 10% 3.9%);\n  --card-foreground: hsl(0 0% 98%);\n  --popover: hsl(240 10% 3.9%);\n  --popover-foreground: hsl(0 0% 98%);\n  --primary: hsl(0 0% 98%);\n  --primary-foreground: hsl(240 5.9% 10%);\n  --secondary: hsl(240 3.7% 15.9%);\n  --secondary-foreground: hsl(0 0% 98%);\n  --muted: hsl(240 3.7% 15.9%);\n  --muted-foreground: hsl(240 5% 64.9%);\n  --accent: hsl(240 3.7% 15.9%);\n  --accent-foreground: hsl(0 0% 98%);\n  --destructive: hsl(0 62.8% 30.6%);\n  --destructive-foreground: hsl(0 0% 98%);\n  --border: hsl(240 3.7% 15.9%);\n  --input: hsl(240 3.7% 15.9%);\n  --ring: hsl(240 4.9% 83.9%);\n  --chart-1: hsl(220 70% 50%);\n  --chart-2: hsl(160 60% 45%);\n  --chart-3: hsl(30 80% 55%);\n  --chart-4: hsl(280 65% 60%);\n  --chart-5: hsl(340 75% 55%);\n}\n@media (prefers-color-scheme: dark) {\n  :root:not(.light) {\n    color-scheme: dark;\n    --background: hsl(240 10% 3.9%);\n    --foreground: hsl(0 0% 98%);\n    --card: hsl(240 10% 3.9%);\n    --card-foreground: hsl(0 0% 98%);\n    --popover: hsl(240 10% 3.9%);\n    --popover-foreground: hsl(0 0% 98%);\n    --primary: hsl(0 0% 98%);\n    --primary-foreground: hsl(240 5.9% 10%);\n    --secondary: hsl(240 3.7% 15.9%);\n    --secondary-foreground: hsl(0 0% 98%);\n    --muted: hsl(240 3.7% 15.9%);\n    --muted-foreground: hsl(240 5% 64.9%);\n    --accent: hsl(240 3.7% 15.9%);\n    --accent-foreground: hsl(0 0% 98%);\n    --destructive: hsl(0 62.8% 30.6%);\n    --destructive-foreground: hsl(0 0% 98%);\n    --border: hsl(240 3.7% 15.9%);\n    --input: hsl(240 3.7% 15.9%);\n    --ring: hsl(240 4.9% 83.9%);\n    --chart-1: hsl(220 70% 50%);\n    --chart-2: hsl(160 60% 45%);\n    --chart-3: hsl(30 80% 55%);\n    --chart-4: hsl(280 65% 60%);\n    --chart-5: hsl(340 75% 55%);\n  }\n}\nbody { background: var(--background); color: var(--foreground); }";
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
