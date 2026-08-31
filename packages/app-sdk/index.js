// @mako/app-sdk — see package.json. Plain ESM on purpose: no build step.
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

const registered = new Map(); // name -> Promise<void>
function registerBinding(name) {
  if (!registered.has(name)) {
    registered.set(
      name,
      (async () => {
        const res = await fetch("__data/" + encodeURIComponent(name) + ".parquet");
        if (!res.ok) {
          registered.delete(name);
          throw new Error(
            'Binding "' + name + '" is not materialized (HTTP ' + res.status + ")",
          );
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        const db = await getDb();
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
      })(),
    );
  }
  return registered.get(name);
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

function toPlainRows(table, cap) {
  const rows = [];
  const fields = table.schema.fields.map(f => f.name);
  for (const batchRow of table) {
    if (rows.length >= cap) break;
    const row = {};
    for (const f of fields) {
      let v = batchRow[f];
      // DuckDB counts come back as BigInt; charts and JSON both choke on it.
      if (typeof v === "bigint") v = Number(v);
      row[f] = v;
    }
    rows.push(row);
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

function useAsyncQuery(run, deps) {
  const [state, setState] = React.useState({
    data: null,
    fields: null,
    error: null,
    loading: true,
    truncated: false,
    rowCount: null,
  });
  React.useEffect(() => {
    let active = true;
    setState({
      data: null,
      fields: null,
      error: null,
      loading: true,
      truncated: false,
      rowCount: null,
    });
    run().then(
      result => {
        if (active) setState({ ...result, error: null, loading: false });
      },
      error => {
        if (active)
          setState({
            data: null,
            fields: null,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
            truncated: false,
            rowCount: null,
          });
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function useQuery(name, opts) {
  const rowLimit = opts ? opts.rowLimit : undefined;
  return useAsyncQuery(async () => {
    await registerBinding(name);
    const r = await runSql(
      'SELECT * FROM "' + name.replace(/"/g, '""') + '"',
      rowLimit,
    );
    return { data: r.rows, fields: r.fields, truncated: r.truncated, rowCount: r.rowCount };
  }, [name, rowLimit]);
}

export function useDuckDB(sql, opts) {
  const rowLimit = opts ? opts.rowLimit : undefined;
  return useAsyncQuery(async () => {
    // Register everything the server staged, so SQL can join across
    // bindings by name without declaring them first.
    const names = await bindingIndex();
    await Promise.all(names.map(n => registerBinding(n).catch(() => {})));
    const r = await runSql(sql, rowLimit);
    return { data: r.rows, fields: r.fields, truncated: r.truncated, rowCount: r.rowCount };
  }, [sql, rowLimit]);
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
