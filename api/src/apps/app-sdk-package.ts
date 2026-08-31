/**
 * The v2 `@mako/app-sdk` — a REAL package committed into every workspace
 * repo at `packages/app-sdk`, consumed by apps as a `file:` dependency.
 *
 * v1 injected this module at runtime: the host resolved the import from an
 * import map and bridged every call over postMessage. A v2 app is a real
 * Vite project on a real filesystem, so the SDK has to be a real package —
 * resolvable by `vite dev`, by `npm run build`, and by a laptop clone with
 * no Mako host anywhere in sight. Data comes from the same place the
 * runtime serves it: `__data/<name>.parquet`, read in the browser by
 * DuckDB-WASM (the identical engine the v1 host used, so query semantics
 * carry over).
 *
 * Shipped as plain ESM + a .d.ts — no build step, nothing to compile; the
 * app's own Vite treats it as source.
 */

export const APP_SDK_DIR = "packages/app-sdk";

/** The dependency entry an app needs to import the SDK. */
export const APP_SDK_DEPENDENCY: Record<string, string> = {
  "@mako/app-sdk": "file:../../packages/app-sdk",
};

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "@mako/app-sdk",
    version: "2.1.0",
    description:
      "Mako app SDK: data bindings (useQuery/useDuckDB), URL state, theme.",
    type: "module",
    main: "./index.js",
    types: "./index.d.ts",
    // `@mako/app-sdk/vite` is the laptop-side half: a Vite plugin that serves
    // `__data/*` from the Mako API when no Mako launcher is around (§15).
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./vite": { types: "./vite.d.ts", default: "./vite.js" },
    },
    // Deliberately dependency-free. npm's handling of a file: dependency's
    // own dependencies is version-lottery (observed: the symlink appears,
    // @duckdb does not), so the engine loads from jsDelivr's +esm at runtime
    // instead — the documented duckdb-wasm CDN pattern, and the same CDN its
    // worker bundles already come from.
    peerDependencies: { react: ">=18" },
  },
  null,
  2,
)}\n`;

const INDEX_D_TS = `import type * as React from "react";

export interface QueryState<Row = Record<string, unknown>> {
  data: Row[] | null;
  error: string | null;
  loading: boolean;
  truncated: boolean;
}
export interface DuckDBState<Row = Record<string, unknown>>
  extends QueryState<Row> {
  fields: string[] | null;
  rowCount: number | null;
}
export interface QueryOptions {
  rowLimit?: number | null;
}
export interface MakoLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
  searchParams: URLSearchParams;
}

/** Rows of a named data binding (bindings/<name>.sql, materialized). */
export function useQuery<Row = Record<string, unknown>>(
  name: string,
  opts?: QueryOptions,
): QueryState<Row>;

/** Analytical SQL over the app's bindings; table names are binding names. */
export function useDuckDB<Row = Record<string, unknown>>(
  sql: string,
  opts?: QueryOptions,
): DuckDBState<Row>;

export function useTheme(): { theme: "light" | "dark" };
export function useLocation(): MakoLocation;
export function useSearchParams(): [
  URLSearchParams,
  (
    next: URLSearchParams | Record<string, string> | string,
    opts?: { replace?: boolean },
  ) => void,
];
export function navigate(to: string, opts?: { replace?: boolean }): void;
`;

const THEME_CSS_JSON =
  '":root {\\n  color-scheme: light;\\n  --background: hsl(0 0% 100%);\\n  --foreground: hsl(240 10% 3.9%);\\n  --card: hsl(0 0% 100%);\\n  --card-foreground: hsl(240 10% 3.9%);\\n  --popover: hsl(0 0% 100%);\\n  --popover-foreground: hsl(240 10% 3.9%);\\n  --primary: hsl(240 5.9% 10%);\\n  --primary-foreground: hsl(0 0% 98%);\\n  --secondary: hsl(240 4.8% 95.9%);\\n  --secondary-foreground: hsl(240 5.9% 10%);\\n  --muted: hsl(240 4.8% 95.9%);\\n  --muted-foreground: hsl(240 3.8% 46.1%);\\n  --accent: hsl(240 4.8% 95.9%);\\n  --accent-foreground: hsl(240 5.9% 10%);\\n  --destructive: hsl(0 84.2% 60.2%);\\n  --destructive-foreground: hsl(0 0% 98%);\\n  --border: hsl(240 5.9% 90%);\\n  --input: hsl(240 5.9% 90%);\\n  --ring: hsl(240 5.9% 10%);\\n  --chart-1: hsl(12 76% 61%);\\n  --chart-2: hsl(173 58% 39%);\\n  --chart-3: hsl(197 37% 24%);\\n  --chart-4: hsl(43 74% 66%);\\n  --chart-5: hsl(27 87% 67%);\\n  --radius: 0.5rem;\\n}\\n:root.dark {\\n  color-scheme: dark;\\n  --background: hsl(240 10% 3.9%);\\n  --foreground: hsl(0 0% 98%);\\n  --card: hsl(240 10% 3.9%);\\n  --card-foreground: hsl(0 0% 98%);\\n  --popover: hsl(240 10% 3.9%);\\n  --popover-foreground: hsl(0 0% 98%);\\n  --primary: hsl(0 0% 98%);\\n  --primary-foreground: hsl(240 5.9% 10%);\\n  --secondary: hsl(240 3.7% 15.9%);\\n  --secondary-foreground: hsl(0 0% 98%);\\n  --muted: hsl(240 3.7% 15.9%);\\n  --muted-foreground: hsl(240 5% 64.9%);\\n  --accent: hsl(240 3.7% 15.9%);\\n  --accent-foreground: hsl(0 0% 98%);\\n  --destructive: hsl(0 62.8% 30.6%);\\n  --destructive-foreground: hsl(0 0% 98%);\\n  --border: hsl(240 3.7% 15.9%);\\n  --input: hsl(240 3.7% 15.9%);\\n  --ring: hsl(240 4.9% 83.9%);\\n  --chart-1: hsl(220 70% 50%);\\n  --chart-2: hsl(160 60% 45%);\\n  --chart-3: hsl(30 80% 55%);\\n  --chart-4: hsl(280 65% 60%);\\n  --chart-5: hsl(340 75% 55%);\\n}\\n@media (prefers-color-scheme: dark) {\\n  :root:not(.light) {\\n    color-scheme: dark;\\n    --background: hsl(240 10% 3.9%);\\n    --foreground: hsl(0 0% 98%);\\n    --card: hsl(240 10% 3.9%);\\n    --card-foreground: hsl(0 0% 98%);\\n    --popover: hsl(240 10% 3.9%);\\n    --popover-foreground: hsl(0 0% 98%);\\n    --primary: hsl(0 0% 98%);\\n    --primary-foreground: hsl(240 5.9% 10%);\\n    --secondary: hsl(240 3.7% 15.9%);\\n    --secondary-foreground: hsl(0 0% 98%);\\n    --muted: hsl(240 3.7% 15.9%);\\n    --muted-foreground: hsl(240 5% 64.9%);\\n    --accent: hsl(240 3.7% 15.9%);\\n    --accent-foreground: hsl(0 0% 98%);\\n    --destructive: hsl(0 62.8% 30.6%);\\n    --destructive-foreground: hsl(0 0% 98%);\\n    --border: hsl(240 3.7% 15.9%);\\n    --input: hsl(240 3.7% 15.9%);\\n    --ring: hsl(240 4.9% 83.9%);\\n    --chart-1: hsl(220 70% 50%);\\n    --chart-2: hsl(160 60% 45%);\\n    --chart-3: hsl(30 80% 55%);\\n    --chart-4: hsl(280 65% 60%);\\n    --chart-5: hsl(340 75% 55%);\\n  }\\n}\\nbody { background: var(--background); color: var(--foreground); }"';

const INDEX_JS = `// @mako/app-sdk — see package.json. Plain ESM on purpose: no build step.
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
              "\\" AS SELECT * FROM read_parquet('" + name + ".parquet')",
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
const MAKO_THEME_TOKENS_CSS = ${THEME_CSS_JSON};
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
`;

// ---------------------------------------------------------------------------
// @mako/app-sdk/vite — the laptop half. Inside Mako's sandbox the launcher
// answers `__data/*`; in a plain checkout this plugin does, from the Mako API.
// ---------------------------------------------------------------------------
const VITE_D_TS = `import type { Plugin } from "vite";

export interface MakoDataOptions {
  /** Mako API origin. Default: MAKO_API_URL (process.env, then the repo's .env). */
  apiUrl?: string;
  /** Workspace API key with the query:read scope. Default: MAKO_API_KEY. */
  apiKey?: string;
  /** Default: MAKO_WORKSPACE_ID, then .mako/workspace.json at the repo root. */
  workspaceId?: string;
  /** App slug. Default: the app directory's basename. */
  slug?: string;
  /** Repo root. Default: the nearest ancestor holding .mako/ or .git. */
  repoRoot?: string;
  /** Re-fetch a cached parquet after this long (ms). Default: 5 minutes. */
  revalidateMs?: number;
  /** Build a never-materialized binding on first request. Default: true. */
  materialize?: boolean;
}

export interface MakoContext {
  repoRoot: string;
  apiUrl: string;
  apiKey: string;
  workspaceId: string;
  slug: string;
  bindingsDir: string;
  cacheDir: string;
}

/** Resolve credentials and identity the way \`makoData\` does. */
export function resolveMakoContext(
  appDir: string,
  options?: MakoDataOptions,
): MakoContext;

/**
 * Serve the app's data bindings (\`__data/index.json\`, \`__data/<name>.parquet\`)
 * during a local \`vite dev\` by streaming materialized artifacts from Mako.
 */
export function makoData(options?: MakoDataOptions): Plugin;
export default makoData;
`;

const VITE_JS = `// @mako/app-sdk/vite — data bindings for a LOCAL \`vite dev\`.
//
// Inside Mako's sandbox the dev server is launched by Mako, which answers
// \`__data/<name>.parquet\` itself. On a laptop nothing does, so Vite's SPA
// fallback returns index.html and DuckDB fails with "footer != PAR1". This
// plugin is the laptop's answer: it lists the app's bindings/*.sql as
// __data/index.json and streams each binding's materialized parquet from the
// Mako API, authenticated with the workspace API key in the repo's .env.
//
// Plain ESM, Node built-ins only — like the rest of this package.
import fs from "node:fs";
import path from "node:path";

const BINDING_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const DEFAULT_REVALIDATE_MS = 5 * 60 * 1000;

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, ".mako", "workspace.json")) ||
      fs.existsSync(path.join(dir, ".git"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, "..", "..");
    dir = parent;
  }
}

/** Minimal .env reader: KEY=VALUE lines, # comments, optional quotes. */
function readDotenv(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readWorkspaceJson(repoRoot) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".mako", "workspace.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

export function resolveMakoContext(appDir, options = {}) {
  const repoRoot = options.repoRoot ?? findRepoRoot(appDir);
  const dotenv = readDotenv(path.join(repoRoot, ".env"));
  const ws = readWorkspaceJson(repoRoot);
  const env = (name) => process.env[name] ?? dotenv[name];
  const apiUrl = (
    options.apiUrl ??
    env("MAKO_API_URL") ??
    ws.apiUrl ??
    ""
  ).replace(/\\/+$/, "");
  return {
    repoRoot,
    apiUrl,
    apiKey: options.apiKey ?? env("MAKO_API_KEY") ?? "",
    workspaceId: options.workspaceId ?? env("MAKO_WORKSPACE_ID") ?? ws.workspaceId ?? "",
    slug: options.slug ?? path.basename(path.resolve(appDir)),
    bindingsDir: path.join(appDir, "bindings"),
    cacheDir: path.join(appDir, "node_modules", ".mako-data"),
  };
}

function listBindings(bindingsDir) {
  try {
    return fs
      .readdirSync(bindingsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -4))
      .filter((n) => BINDING_NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function makoData(options = {}) {
  return {
    name: "mako-data",
    apply: "serve",
    configureServer(server) {
      const appDir = server.config.root;
      const ctx = resolveMakoContext(appDir, options);
      const revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
      const bindings = listBindings(ctx.bindingsDir);
      const problems = [];
      if (!ctx.apiUrl) problems.push("MAKO_API_URL is not set");
      if (!ctx.apiKey) problems.push("MAKO_API_KEY is not set");
      if (!ctx.workspaceId) problems.push("workspace id unknown (.mako/workspace.json or MAKO_WORKSPACE_ID)");
      const appBase = () =>
        \`\${ctx.apiUrl}/api/workspaces/\${encodeURIComponent(ctx.workspaceId)}/apps/\${encodeURIComponent(ctx.slug)}\`;
      const headers = () => ({ authorization: \`Bearer \${ctx.apiKey}\` });

      server.config.logger.info(
        \`  mako-data: \${bindings.length} binding(s) for apps/\${ctx.slug}\` +
          (problems.length
            ? \` — NOT CONNECTED: \${problems.join("; ")} (see CLAUDE.md → Credentials)\`
            : \` via \${ctx.apiUrl}\`),
      );

      async function fetchArtifact(name) {
        const url = \`\${appBase()}/bindings/\${encodeURIComponent(name)}/artifact\`;
        let res = await fetch(url, { headers: headers() });
        if (res.status === 404 && options.materialize !== false) {
          // Never materialized (or a live binding): build it now, then read.
          const built = await fetch(
            \`\${appBase()}/bindings/\${encodeURIComponent(name)}/materialize\`,
            { method: "POST", headers: headers() },
          );
          if (!built.ok) {
            const text = await built.text().catch(() => "");
            throw new Error(\`materialize \${name}: HTTP \${built.status} \${text.slice(0, 300)}\`);
          }
          res = await fetch(url, { headers: headers() });
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(\`artifact \${name}: HTTP \${res.status} \${text.slice(0, 300)}\`);
        }
        return Buffer.from(await res.arrayBuffer());
      }

      server.middlewares.use(async (req, res, next) => {
        const [pathname, query = ""] = (req.url || "").split("?");
        if (pathname === "/__data/index.json") {
          return json(res, 200, listBindings(ctx.bindingsDir));
        }
        const match = /^\\/__data\\/([^/]+)\\.parquet$/.exec(pathname);
        if (!match) return next();
        const name = decodeURIComponent(match[1]);
        if (!BINDING_NAME.test(name)) return json(res, 400, { error: "invalid binding name" });
        if (problems.length) {
          return json(res, 503, {
            error: \`mako-data is not connected: \${problems.join("; ")}\`,
            hint: "Put MAKO_API_URL and MAKO_API_KEY in the repo's .env (see CLAUDE.md).",
          });
        }
        const cached = path.join(ctx.cacheDir, \`\${name}.parquet\`);
        const refresh = /(^|&)refresh(=|&|$)/.test(query);
        try {
          const stat = fs.statSync(cached, { throwIfNoEntry: false });
          const fresh = stat && Date.now() - stat.mtimeMs < revalidateMs;
          if (!refresh && fresh) {
            res.setHeader("content-type", "application/vnd.apache.parquet");
            res.setHeader("x-mako-data", "cache");
            return fs.createReadStream(cached).pipe(res);
          }
          const buf = await fetchArtifact(name);
          fs.mkdirSync(ctx.cacheDir, { recursive: true });
          fs.writeFileSync(cached, buf);
          res.setHeader("content-type", "application/vnd.apache.parquet");
          res.setHeader("content-length", String(buf.length));
          res.setHeader("x-mako-data", "api");
          res.end(buf);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(\`  mako-data: \${message}\`);
          if (fs.existsSync(cached)) {
            // Stale beats nothing while offline.
            res.setHeader("content-type", "application/vnd.apache.parquet");
            res.setHeader("x-mako-data", "stale");
            return fs.createReadStream(cached).pipe(res);
          }
          json(res, 502, { error: message });
        }
      });
    },
  };
}

export default makoData;
`;

/** Every file of the packaged SDK, ready for a commit. */
export function appSdkFiles(): Record<string, string> {
  return {
    [`${APP_SDK_DIR}/package.json`]: PACKAGE_JSON,
    [`${APP_SDK_DIR}/index.js`]: INDEX_JS,
    [`${APP_SDK_DIR}/index.d.ts`]: INDEX_D_TS,
    [`${APP_SDK_DIR}/vite.js`]: VITE_JS,
    [`${APP_SDK_DIR}/vite.d.ts`]: VITE_D_TS,
  };
}
