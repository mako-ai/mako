// @mako/app-sdk/vite — data bindings for a LOCAL `vite dev`.
//
// Inside Mako's sandbox the dev server is launched by Mako, which answers
// `__data/<name>.parquet` itself. On a laptop nothing does, so Vite's SPA
// fallback returns index.html and DuckDB fails with "footer != PAR1". This
// plugin is the laptop's answer: it lists the app's bindings/*.sql as
// __data/index.json and streams each binding's materialized parquet from the
// Mako API, authenticated with the workspace API key in the repo's .env.
//
// Plain ESM, Node built-ins only — like the rest of this package.
import fs from "node:fs";
import path from "node:path";
import { findCredential, getAccessToken } from "./credentials.js";

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
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
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
  ).replace(/\/+$/, "");
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
      // Credentials: an API key (env or .env) wins; otherwise the token
      // `mako login` stored — refreshed on demand, so a laptop that signed in
      // once keeps working without ever pasting a key.
      const loggedIn = !ctx.apiKey && !!findCredential(ctx.apiUrl, ctx.workspaceId);
      const problems = [];
      if (!ctx.apiUrl) problems.push("MAKO_API_URL is not set");
      if (!ctx.apiKey && !loggedIn) problems.push("not signed in: run `mako login` (or set MAKO_API_KEY)");
      if (!ctx.workspaceId) problems.push("workspace id unknown (.mako/workspace.json or MAKO_WORKSPACE_ID)");
      const appBase = () =>
        `${ctx.apiUrl}/api/workspaces/${encodeURIComponent(ctx.workspaceId)}/apps/${encodeURIComponent(ctx.slug)}`;
      const headers = async () => ({
        authorization: `Bearer ${ctx.apiKey || (await getAccessToken(ctx.apiUrl, ctx.workspaceId))}`,
      });

      server.config.logger.info(
        `  mako-data: ${bindings.length} binding(s) for apps/${ctx.slug}` +
          (problems.length
            ? ` — NOT CONNECTED: ${problems.join("; ")} (see CLAUDE.md → Credentials)`
            : ` via ${ctx.apiUrl} (${ctx.apiKey ? "API key" : "mako login"})`),
      );

      async function fetchArtifact(name) {
        const url = `${appBase()}/bindings/${encodeURIComponent(name)}/artifact`;
        let res = await fetch(url, { headers: await headers() });
        if (res.status === 404 && options.materialize !== false) {
          // Never materialized (or a live binding): build it now, then read.
          const built = await fetch(
            `${appBase()}/bindings/${encodeURIComponent(name)}/materialize`,
            { method: "POST", headers: await headers() },
          );
          if (!built.ok) {
            const text = await built.text().catch(() => "");
            throw new Error(`materialize ${name}: HTTP ${built.status} ${text.slice(0, 300)}`);
          }
          res = await fetch(url, { headers: await headers() });
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`artifact ${name}: HTTP ${res.status} ${text.slice(0, 300)}`);
        }
        return Buffer.from(await res.arrayBuffer());
      }

      server.middlewares.use(async (req, res, next) => {
        const [pathname, query = ""] = (req.url || "").split("?");
        if (pathname === "/__data/index.json") {
          return json(res, 200, listBindings(ctx.bindingsDir));
        }
        const match = /^\/__data\/([^/]+)\.parquet$/.exec(pathname);
        if (!match) return next();
        const name = decodeURIComponent(match[1]);
        if (!BINDING_NAME.test(name)) return json(res, 400, { error: "invalid binding name" });
        if (problems.length) {
          return json(res, 503, {
            error: `mako-data is not connected: ${problems.join("; ")}`,
            hint: "Run `mako login` in this repo, or put MAKO_API_URL and MAKO_API_KEY in the repo's .env (see AGENTS.md).",
          });
        }
        const cached = path.join(ctx.cacheDir, `${name}.parquet`);
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
          server.config.logger.error(`  mako-data: ${message}`);
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
