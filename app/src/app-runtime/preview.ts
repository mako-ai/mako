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
  error: "mako-app:error",
} as const;

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

export function buildPreviewHtml(appEntity: AppEntity): string {
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
  });

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="importmap">${importMap}</script>
    <script src="https://unpkg.com/@babel/standalone@7.25.6/babel.min.js"></script>
    <style>
      html, body, #root { margin: 0; height: 100%; }
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
function runBinding(name) {
  return new Promise((resolve) => {
    const requestId = "req_" + ++reqSeq;
    pending.set(requestId, resolve);
    POST({ type: "mako-app:run-binding", requestId, binding: name });
  });
}
function runDuckDb(sql) {
  return new Promise((resolve) => {
    const requestId = "duck_" + ++reqSeq;
    pending.set(requestId, resolve);
    POST({ type: "mako-app:run-duckdb", requestId, sql: sql });
  });
}

async function main() {
  const Babel = await waitForBabel();
  const payload = JSON.parse(document.getElementById("mako-payload").textContent);

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
    useQuery(name) {
      const [state, setState] = React.useState({ data: null, error: null, loading: true });
      React.useEffect(() => {
        let active = true;
        setState({ data: null, error: null, loading: true });
        runBinding(name).then((res) => {
          if (!active) return;
          if (res.success) setState({ data: res.rows, error: null, loading: false });
          else setState({ data: null, error: res.error || "Query failed", loading: false });
        });
        return () => { active = false; };
      }, [name]);
      return state;
    },
    // Run analytical SQL over the app's materialized (parquet) tables in
    // DuckDB-WASM. Table names are the binding names. Returns { data, fields }.
    useDuckDB(sql) {
      const [state, setState] = React.useState({ data: null, fields: null, error: null, loading: true });
      React.useEffect(() => {
        let active = true;
        setState({ data: null, fields: null, error: null, loading: true });
        runDuckDb(sql).then((res) => {
          if (!active) return;
          if (res.success) setState({ data: res.rows, fields: res.fields, error: null, loading: false });
          else setState({ data: null, fields: null, error: res.error || "DuckDB query failed", loading: false });
        });
        return () => { active = false; };
      }, [sql]);
      return state;
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
