/**
 * CDN preview runtime.
 *
 * Builds the sandboxed `<iframe srcdoc>` HTML that runs a Mako app without a
 * build server. The app's files are transpiled in-browser with Babel
 * standalone and executed through a tiny CommonJS registry; bare npm
 * dependencies (react, d3, …) are loaded as ESM from esm.sh via an import map.
 *
 * The injected `@mako/app-sdk` module exposes `useQuery(name)`, which bridges to
 * the parent window over `postMessage`; the parent runs the bound query through
 * Mako's workspace-scoped execute API and posts the rows back. The app never
 * receives database credentials.
 *
 * NOTE: This is the bootstrap runtime. The `webcontainer` runtime (real
 * Vite/npm toolchain, full shadcn/Tailwind build support) is the planned
 * upgrade and slots in behind the same `AppEntity` model + message bridge.
 */

import type { AppEntity } from "../store/appStore";

const ESM_HOST = "https://esm.sh";
const REACT_VERSION = "18.2.0";

const SCRIPT_EXT = /\.(tsx|ts|jsx|js|mjs)$/;

export const PREVIEW_MESSAGE = {
  ready: "mako-app:ready",
  runBinding: "mako-app:run-binding",
  bindingResult: "mako-app:binding-result",
  runDuckDb: "mako-app:run-duckdb",
  duckDbResult: "mako-app:duckdb-result",
  // host -> iframe: the app's materialized data changed (a refresh landed new
  // parquet snapshots in the parent's DuckDB). The booted app re-runs its data
  // hooks without a srcdoc rebuild, so the view updates while keeping UI state.
  dataRefresh: "mako-app:data-refresh",
  capture: "mako-app:capture",
  captureResult: "mako-app:capture-result",
  setTheme: "mako-app:set-theme",
  // iframe -> host: the app wants to change its (host-projected) URL.
  navigate: "mako-app:navigate",
  // host -> iframe: the app's location changed outside the app (deep link on
  // load, browser back/forward). The app updates without echoing back.
  location: "mako-app:location",
  error: "mako-app:error",
} as const;

/** Effective color mode delivered to the sandboxed app. */
export type PreviewTheme = "light" | "dark";

/**
 * DOM-capture library loaded *inside* the sandboxed iframe for self-capture.
 * The iframe is an opaque origin (`sandbox="allow-scripts"` without
 * `allow-same-origin`), so the parent cannot rasterize its DOM — instead the
 * parent asks the iframe to capture itself and composites the result.
 *
 * html-to-image (not modern-screenshot) is required here: modern-screenshot
 * computes default styles in a nested helper iframe, and nested browsing
 * contexts inside a sandboxed document get a *distinct* opaque origin, so
 * accessing the helper's document throws a cross-origin error. html-to-image
 * inlines computed styles directly with no helper iframe.
 */
const CAPTURE_LIB_URL = `${ESM_HOST}/html-to-image@1`;

/**
 * Design tokens injected into every app preview.
 *
 * Shadcn-style names with the same palette as the Mako shell
 * (`app/src/index.css`), but shipped as ready-to-use colors — app code writes
 * `var(--background)` directly (works in inline styles, CSS-in-JS, and SVG
 * fill/stroke) instead of the host's `hsl(var(--background))` triplet idiom.
 *
 * Light values live on `:root`, dark overrides on `:root.dark`. The bootstrap
 * toggles the `dark` class from the embedded payload theme, parent
 * `mako-app:set-theme` messages, or `prefers-color-scheme` when standalone.
 * Body background/text are pre-wired so apps inherit a correct theme with no
 * theme code at all. The (future) `webcontainer` runtime should keep this
 * same token + message contract.
 */
const THEME_TOKENS_CSS = `
      :root {
        color-scheme: light;
        --background: hsl(0 0% 100%);
        --foreground: hsl(240 10% 3.9%);
        --card: hsl(0 0% 100%);
        --card-foreground: hsl(240 10% 3.9%);
        --popover: hsl(0 0% 100%);
        --popover-foreground: hsl(240 10% 3.9%);
        --primary: hsl(240 5.9% 10%);
        --primary-foreground: hsl(0 0% 98%);
        --secondary: hsl(240 4.8% 95.9%);
        --secondary-foreground: hsl(240 5.9% 10%);
        --muted: hsl(240 4.8% 95.9%);
        --muted-foreground: hsl(240 3.8% 46.1%);
        --accent: hsl(240 4.8% 95.9%);
        --accent-foreground: hsl(240 5.9% 10%);
        --destructive: hsl(0 84.2% 60.2%);
        --destructive-foreground: hsl(0 0% 98%);
        --border: hsl(240 5.9% 90%);
        --input: hsl(240 5.9% 90%);
        --ring: hsl(240 5.9% 10%);
        --chart-1: hsl(12 76% 61%);
        --chart-2: hsl(173 58% 39%);
        --chart-3: hsl(197 37% 24%);
        --chart-4: hsl(43 74% 66%);
        --chart-5: hsl(27 87% 67%);
        --radius: 0.5rem;
      }
      :root.dark {
        color-scheme: dark;
        --background: hsl(240 10% 3.9%);
        --foreground: hsl(0 0% 98%);
        --card: hsl(240 10% 3.9%);
        --card-foreground: hsl(0 0% 98%);
        --popover: hsl(240 10% 3.9%);
        --popover-foreground: hsl(0 0% 98%);
        --primary: hsl(0 0% 98%);
        --primary-foreground: hsl(240 5.9% 10%);
        --secondary: hsl(240 3.7% 15.9%);
        --secondary-foreground: hsl(0 0% 98%);
        --muted: hsl(240 3.7% 15.9%);
        --muted-foreground: hsl(240 5% 64.9%);
        --accent: hsl(240 3.7% 15.9%);
        --accent-foreground: hsl(0 0% 98%);
        --destructive: hsl(0 62.8% 30.6%);
        --destructive-foreground: hsl(0 0% 98%);
        --border: hsl(240 3.7% 15.9%);
        --input: hsl(240 3.7% 15.9%);
        --ring: hsl(240 4.9% 83.9%);
        --chart-1: hsl(220 70% 50%);
        --chart-2: hsl(160 60% 45%);
        --chart-3: hsl(30 80% 55%);
        --chart-4: hsl(280 65% 60%);
        --chart-5: hsl(340 75% 55%);
      }
      body {
        background: var(--background);
        color: var(--foreground);
      }`;

function buildImportMap(dependencies: Record<string, string>): string {
  const imports: Record<string, string> = {
    react: `${ESM_HOST}/react@${REACT_VERSION}`,
    "react/jsx-runtime": `${ESM_HOST}/react@${REACT_VERSION}/jsx-runtime`,
    "react-dom": `${ESM_HOST}/react-dom@${REACT_VERSION}`,
    "react-dom/client": `${ESM_HOST}/react-dom@${REACT_VERSION}/client`,
  };
  const sharedDeps = `react@${REACT_VERSION},react-dom@${REACT_VERSION}`;
  for (const [name, version] of Object.entries(dependencies)) {
    if (name === "react" || name === "react-dom") continue;
    const ver = version && version !== "latest" ? `@${version}` : "@latest";
    // `?deps` makes libraries share the host React instance.
    imports[name] = `${ESM_HOST}/${name}${ver}?deps=${sharedDeps}`;
  }
  return JSON.stringify({ imports }, null, 2);
}

/** Bare specifiers (npm deps) that must be pre-imported as ESM in the iframe. */
function bareSpecifiers(dependencies: Record<string, string>): string[] {
  const set = new Set<string>([
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
  ]);
  for (const name of Object.keys(dependencies)) {
    if (name === "react" || name === "react-dom") continue;
    set.add(name);
  }
  return [...set];
}

export function buildPreviewHtml(
  appEntity: AppEntity,
  options?: {
    /**
     * Effective theme to boot with. Hosts embedding the preview pass their
     * current mode (and post `mako-app:set-theme` on later toggles); when
     * omitted/null the iframe follows `prefers-color-scheme` (standalone).
     */
    theme?: PreviewTheme | null;
    /**
     * App location (relative URL, e.g. `/customers/1?tab=open`) to boot with.
     * The host derives this from its own shareable URL so reload + share
     * restore the app's view; later changes flow over the message bridge
     * (`mako-app:navigate` / `mako-app:location`), never a srcdoc rebuild.
     */
    location?: string | null;
  },
): string {
  const scriptFiles: Record<string, string> = {};
  for (const file of appEntity.files) {
    if (SCRIPT_EXT.test(file.path)) {
      scriptFiles[file.path] = file.contents;
    }
  }

  const importMap = buildImportMap(appEntity.dependencies);
  const bareDeps = bareSpecifiers(appEntity.dependencies);
  const entrypoint = appEntity.entrypoint;

  const payload = JSON.stringify({
    files: scriptFiles,
    bareDeps,
    entrypoint,
    theme: options?.theme ?? null,
    location: options?.location ?? null,
  });

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- The frame is an opaque origin (no allow-same-origin), so a plain
         <a href> can't navigate the top frame. Default every link to a new
         tab so app links open externally instead of silently no-opping. -->
    <base target="_blank" />
    <script type="importmap">${importMap}</script>
    <script src="https://unpkg.com/@babel/standalone@7.25.6/babel.min.js"></script>
    <style>
      html, body, #root { margin: 0; height: 100%; }
${THEME_TOKENS_CSS}
      #mako-error {
        position: fixed; inset: 0; background: #1e1e1e; color: #f48771;
        font-family: ui-monospace, monospace; font-size: 13px; padding: 16px;
        white-space: pre-wrap; overflow: auto; display: none; z-index: 99999;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <pre id="mako-error"></pre>
    <script id="mako-payload" type="application/json">${payload.replace(
      /</g,
      "\\u003c",
    )}</script>
    <script type="module">
      const MAKO_CAPTURE_LIB_URL = ${JSON.stringify(CAPTURE_LIB_URL)};
      ${BOOTSTRAP_SOURCE}
    </script>
  </body>
</html>`;
}

// Runs inside the iframe. Kept as a string so it is embedded verbatim into the
// srcdoc module script (it must not be bundled/transformed by Vite).
const BOOTSTRAP_SOURCE = String.raw`
const POST = (msg) => parent.postMessage(msg, "*");

function showError(message, source) {
  const el = document.getElementById("mako-error");
  if (el) {
    el.textContent = message;
    el.style.display = "block";
  }
  POST({ type: "mako-app:error", message: String(message), source });
}

window.addEventListener("error", (e) => showError(e.message || "Runtime error", "runtime"));
window.addEventListener("unhandledrejection", (e) =>
  showError((e.reason && e.reason.message) || "Unhandled promise rejection", "runtime"),
);

// --- Theme: the injected CSS tokens flip via the 'dark' class on <html>.
// An explicit theme comes from the embedded payload (host's mode at build
// time) or parent "mako-app:set-theme" messages (live toggles); with no
// explicit theme the app follows prefers-color-scheme (standalone). ---
const themeListeners = new Set();
const systemDark = window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;
let explicitTheme = null; // "light" | "dark" | null (null = follow system)
let currentTheme = "light";

function resolveTheme() {
  if (explicitTheme === "light" || explicitTheme === "dark") return explicitTheme;
  return systemDark && systemDark.matches ? "dark" : "light";
}
function applyTheme() {
  const next = resolveTheme();
  document.documentElement.classList.toggle("dark", next === "dark");
  if (next !== currentTheme) {
    currentTheme = next;
    themeListeners.forEach((listener) => {
      try {
        listener(next);
      } catch (_) {
        /* listener errors must not break theming */
      }
    });
  }
}
function setExplicitTheme(theme) {
  explicitTheme = theme === "light" || theme === "dark" ? theme : null;
  applyTheme();
}
if (systemDark && systemDark.addEventListener) {
  systemDark.addEventListener("change", () => {
    if (explicitTheme == null) applyTheme();
  });
}
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "mako-app:set-theme") setExplicitTheme(data.theme);
});

// --- Location: the app's URL relative to its mount point. The sandboxed frame
// can't touch the real (shareable) browser URL, so the app reads/writes this
// virtual location via useLocation()/useSearchParams()/navigate() from
// "@mako/app-sdk"; the host projects it onto its own URL and seeds it back on
// load (payload.location) or on browser back/forward ("mako-app:location"). ---
const LOCATION_BASE = "http://mako.app.local";
let currentLocation = "/";
const locationListeners = new Set();

function resolveLocation(to) {
  try {
    const base = new URL(currentLocation, LOCATION_BASE);
    const next = new URL(String(to), base);
    return (next.pathname || "/") + (next.search || "");
  } catch (_) {
    return currentLocation;
  }
}
function notifyLocation() {
  locationListeners.forEach((listener) => {
    try {
      listener(currentLocation);
    } catch (_) {
      /* listener errors must not break routing */
    }
  });
}
// Apply an external location change (host -> iframe). Does not post back.
function applyLocation(next) {
  const normalized = resolveLocation(next);
  if (normalized === currentLocation) return;
  currentLocation = normalized;
  notifyLocation();
}
// Apply an app-initiated change and report it to the host so the real URL
// (and any shared link) tracks the app's view.
function navigateTo(to, opts) {
  const normalized = resolveLocation(to);
  const changed = normalized !== currentLocation;
  currentLocation = normalized;
  if (changed) notifyLocation();
  POST({
    type: "mako-app:navigate",
    location: currentLocation,
    replace: !!(opts && opts.replace),
  });
}
function parseLocation(loc) {
  const url = new URL(loc, LOCATION_BASE);
  return {
    pathname: url.pathname || "/",
    search: url.search,
    hash: url.hash,
    href: (url.pathname || "/") + url.search + url.hash,
    searchParams: url.searchParams,
  };
}
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "mako-app:location" && typeof data.location === "string") {
    applyLocation(data.location);
  }
});

async function waitForBabel(timeoutMs = 10000) {
  const start = Date.now();
  while (!window.Babel) {
    if (Date.now() - start > timeoutMs) throw new Error("Babel failed to load");
    await new Promise((r) => setTimeout(r, 30));
  }
  return window.Babel;
}

// --- Data bridge: useQuery(name) -> parent execute API ---
const pending = new Map();
let reqSeq = 0;
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (
    (data.type === "mako-app:binding-result" ||
      data.type === "mako-app:duckdb-result") &&
    pending.has(data.requestId)
  ) {
    const resolve = pending.get(data.requestId);
    pending.delete(data.requestId);
    resolve(data);
  }
});

// --- Data epoch: bumps when the host swaps in a fresh materialized snapshot
// ("mako-app:data-refresh"). Data hooks depend on it, so they re-fetch when the
// underlying parquet changes without rebuilding the (slow) srcdoc or losing the
// running app's UI state. ---
const dataListeners = new Set();
let dataEpoch = 0;
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "mako-app:data-refresh") return;
  dataEpoch++;
  dataListeners.forEach((listener) => {
    try {
      listener(dataEpoch);
    } catch (_) {
      /* listener errors must not break other subscribers */
    }
  });
});
function runBinding(name, rowLimit) {
  return new Promise((resolve) => {
    const requestId = "req_" + ++reqSeq;
    pending.set(requestId, resolve);
    POST({ type: "mako-app:run-binding", requestId, binding: name, rowLimit: rowLimit });
  });
}
function runDuckDb(sql, rowLimit) {
  return new Promise((resolve) => {
    const requestId = "duck_" + ++reqSeq;
    pending.set(requestId, resolve);
    POST({ type: "mako-app:run-duckdb", requestId, sql: sql, rowLimit: rowLimit });
  });
}
function warnTruncated(source, res) {
  console.warn(
    "[mako/app-sdk] " + source + " hit the " + res.rowLimit + "-row cap" +
      (typeof res.rowCount === "number" ? "; the query produced " + res.rowCount + " rows" : "") +
      ". Rows beyond the cap were dropped, so derived numbers may be wrong. " +
      "Aggregate in SQL instead, or pass { rowLimit: <n> } to raise the cap " +
      "({ rowLimit: null } disables it).",
  );
}

// --- Self-capture: the parent cannot rasterize this opaque-origin iframe, so
// it asks us to screenshot ourselves and posts the PNG back. ---
function defaultCaptureBackground() {
  // Match the active theme (--background flips with the 'dark' class) so dark
  // apps aren't composited onto a white backdrop.
  try {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return bg || "#ffffff";
  } catch (_) {
    return "#ffffff";
  }
}
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "mako-app:capture" || !data.requestId) return;
  import(MAKO_CAPTURE_LIB_URL)
    .then((mod) =>
      mod.toPng(document.documentElement, {
        backgroundColor: data.backgroundColor == null ? defaultCaptureBackground() : data.backgroundColor,
        pixelRatio: typeof data.scale === "number" ? data.scale : 1,
      }),
    )
    .then((dataUrl) =>
      POST({
        type: "mako-app:capture-result",
        requestId: data.requestId,
        success: true,
        dataUrl,
      }),
    )
    .catch((err) =>
      POST({
        type: "mako-app:capture-result",
        requestId: data.requestId,
        success: false,
        error: String((err && err.message) || err),
      }),
    );
});

async function main() {
  const payload = JSON.parse(document.getElementById("mako-payload").textContent);

  // Apply the host-provided theme (or the system fallback) before anything
  // renders so the first paint already uses the right tokens.
  setExplicitTheme(payload.theme);

  // Seed the location the host derived from its shareable URL so the very
  // first render already reflects a deep link / reloaded view.
  if (typeof payload.location === "string" && payload.location) {
    currentLocation = payload.location;
  }

  const Babel = await waitForBabel();

  // Pre-import bare npm dependencies as ESM (via the import map).
  const deps = {};
  for (const spec of payload.bareDeps) {
    try {
      deps[spec] = await import(spec);
    } catch (err) {
      showError("Failed to load dependency '" + spec + "': " + err.message, "build");
      return;
    }
  }

  const React = deps["react"] && (deps["react"].default || deps["react"]);

  // Injected SDK module.
  const makoSdk = {
    // Read a named binding. Live bindings run server-side; parquet bindings
    // return the materialized table rows from DuckDB-WASM (parent decides).
    // opts: { rowLimit?: number | null } — max rows delivered for parquet
    // bindings (default 500k; null disables the cap). When rows beyond the
    // cap were dropped, "truncated" is true and a console warning is logged.
    useQuery(name, opts) {
      const rowLimit = opts ? opts.rowLimit : undefined;
      const [state, setState] = React.useState({ data: null, error: null, loading: true, truncated: false });
      const [epoch, setEpoch] = React.useState(dataEpoch);
      React.useEffect(() => {
        const listener = (next) => setEpoch(next);
        dataListeners.add(listener);
        // Re-sync in case a refresh landed between render and subscribe.
        setEpoch(dataEpoch);
        return () => { dataListeners.delete(listener); };
      }, []);
      React.useEffect(() => {
        let active = true;
        setState({ data: null, error: null, loading: true, truncated: false });
        runBinding(name, rowLimit).then((res) => {
          if (!active) return;
          if (res.success) {
            if (res.truncated) warnTruncated('useQuery("' + name + '")', res);
            setState({ data: res.rows, error: null, loading: false, truncated: !!res.truncated });
          } else {
            setState({ data: null, error: res.error || "Query failed", loading: false, truncated: false });
          }
        });
        return () => { active = false; };
      }, [name, rowLimit, epoch]);
      return state;
    },
    // Run analytical SQL over the app's materialized (parquet) tables in
    // DuckDB-WASM. Table names are the binding names.
    // opts: { rowLimit?: number | null } — max rows delivered (default 500k;
    // null disables the cap). Returns { data, fields, rowCount, truncated }:
    // "rowCount" is the full result size before the cap, "truncated" is true
    // when rows beyond the cap were dropped (also logs a console warning).
    useDuckDB(sql, opts) {
      const rowLimit = opts ? opts.rowLimit : undefined;
      const [state, setState] = React.useState({ data: null, fields: null, error: null, loading: true, truncated: false, rowCount: null });
      const [epoch, setEpoch] = React.useState(dataEpoch);
      React.useEffect(() => {
        const listener = (next) => setEpoch(next);
        dataListeners.add(listener);
        // Re-sync in case a refresh landed between render and subscribe.
        setEpoch(dataEpoch);
        return () => { dataListeners.delete(listener); };
      }, []);
      React.useEffect(() => {
        let active = true;
        setState({ data: null, fields: null, error: null, loading: true, truncated: false, rowCount: null });
        runDuckDb(sql, rowLimit).then((res) => {
          if (!active) return;
          if (res.success) {
            if (res.truncated) warnTruncated("useDuckDB", res);
            setState({
              data: res.rows,
              fields: res.fields,
              error: null,
              loading: false,
              truncated: !!res.truncated,
              rowCount: typeof res.rowCount === "number" ? res.rowCount : (res.rows ? res.rows.length : null),
            });
          } else {
            setState({ data: null, fields: null, error: res.error || "DuckDB query failed", loading: false, truncated: false, rowCount: null });
          }
        });
        return () => { active = false; };
      }, [sql, rowLimit, epoch]);
      return state;
    },
    // Effective color mode: { theme: "light" | "dark" }. Tracks the host app
    // theme when embedded in Mako and the OS preference when standalone. Use
    // it for chart configs or conditional logic that needs a literal value;
    // for styling prefer the injected CSS variables (var(--background),
    // var(--card), var(--chart-1), ...) which switch automatically.
    useTheme() {
      const [theme, setTheme] = React.useState(currentTheme);
      React.useEffect(() => {
        const listener = (next) => setTheme(next);
        themeListeners.add(listener);
        // Re-sync in case the theme changed between render and subscribe.
        setTheme(currentTheme);
        return () => { themeListeners.delete(listener); };
      }, []);
      return { theme: theme };
    },
    // The app's current location, projected onto (and shareable via) the host
    // URL. Returns { pathname, search, hash, href, searchParams } and
    // re-renders on every navigate() or external (back/forward) change.
    useLocation() {
      const [loc, setLoc] = React.useState(() => parseLocation(currentLocation));
      React.useEffect(() => {
        const listener = (next) => setLoc(parseLocation(next));
        locationListeners.add(listener);
        // Re-sync in case the location changed between render and subscribe.
        setLoc(parseLocation(currentLocation));
        return () => { locationListeners.delete(listener); };
      }, []);
      return loc;
    },
    // React-Router-style query param access: [URLSearchParams, setSearchParams].
    // setSearchParams(next, { replace }) keeps the current pathname and updates
    // only the query string (next may be a URLSearchParams, object, or string).
    useSearchParams() {
      const read = () => new URL(currentLocation, LOCATION_BASE).search;
      const [search, setSearch] = React.useState(read);
      React.useEffect(() => {
        const listener = () => setSearch(read());
        locationListeners.add(listener);
        setSearch(read());
        return () => { locationListeners.delete(listener); };
      }, []);
      const setSearchParams = (next, opts) => {
        const sp =
          next instanceof URLSearchParams ? next : new URLSearchParams(next);
        const qs = sp.toString();
        const pathname = new URL(currentLocation, LOCATION_BASE).pathname || "/";
        navigateTo(pathname + (qs ? "?" + qs : ""), opts);
      };
      return [new URLSearchParams(search), setSearchParams];
    },
    // Imperatively change the app's location. The target may be absolute
    // ("/x"), relative ("x", "../x") or query-only ("?q=1"). Pass
    // { replace: true } to overwrite the current history entry (use it for
    // transient filter tweaks so back/forward isn't flooded); default pushes.
    navigate(to, opts) {
      navigateTo(to, opts);
    },
  };

  // --- Minimal CommonJS registry over the app's transpiled files ---
  const registry = payload.files;
  const cache = {};

  function normalize(path) {
    return path.replace(/^\.?\/+/, "");
  }
  function resolveRelative(fromPath, spec) {
    const baseParts = normalize(fromPath).split("/").slice(0, -1);
    const specParts = spec.split("/");
    for (const part of specParts) {
      if (part === "." || part === "") continue;
      if (part === "..") baseParts.pop();
      else baseParts.push(part);
    }
    const candidate = baseParts.join("/");
    const tryPaths = [
      candidate,
      candidate + ".tsx",
      candidate + ".ts",
      candidate + ".jsx",
      candidate + ".js",
      candidate + "/index.tsx",
      candidate + "/index.ts",
      candidate + "/index.jsx",
      candidate + "/index.js",
    ];
    return tryPaths.find((p) => registry[p] != null);
  }

  function requireModule(spec, fromPath) {
    if (spec === "@mako/app-sdk") return makoSdk;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const resolved = resolveRelative(fromPath, spec);
      if (!resolved) throw new Error("Cannot resolve '" + spec + "' from '" + fromPath + "'");
      return evaluate(resolved);
    }
    if (deps[spec]) return interop(deps[spec]);
    throw new Error("Module not found: '" + spec + "'. Add it as a dependency.");
  }

  function interop(mod) {
    return mod;
  }

  function evaluate(path) {
    if (cache[path]) return cache[path].exports;
    const code = registry[path];
    const transformed = Babel.transform(code, {
      filename: path,
      presets: ["typescript", ["react", { runtime: "classic" }]],
      plugins: ["transform-modules-commonjs"],
    }).code;
    const module = { exports: {} };
    cache[path] = module;
    const factory = new Function("module", "exports", "require", "React", transformed);
    factory(module, module.exports, (spec) => requireModule(spec, path), React);
    return module.exports;
  }

  try {
    const entry = evaluate(normalize(payload.entrypoint));
    const App = entry.default || entry.App;
    if (!App) throw new Error("Entrypoint '" + payload.entrypoint + "' has no default export.");
    const ReactDOMClient = deps["react-dom/client"];
    const root = ReactDOMClient.createRoot(document.getElementById("root"));
    root.render(React.createElement(App));
    POST({ type: "mako-app:ready" });
  } catch (err) {
    showError(err && err.stack ? err.stack : String(err), "build");
  }
}

main();
`;
