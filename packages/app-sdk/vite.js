// @makoai/app-sdk/vite — data bindings for a LOCAL `vite dev`.
//
// Inside Mako's sandbox the dev server is launched by Mako, which answers
// `__data/<name>.parquet` itself. On a laptop nothing does, so Vite's SPA
// fallback returns index.html and DuckDB fails with "footer != PAR1". This
// plugin is the laptop's answer: it lists the app's bindings/*.sql as
// __data/index.json and serves each binding's parquet from the Mako API,
// authenticated with `mako login` or the workspace API key in the repo's .env.
//
// The LOCAL binding file is what gets built: its text goes to the API, which
// answers with the committed artifact when the text is the committed binding
// and with a throwaway draft build when it is not — so editing
// bindings/<name>.sql shows real data before anything is committed. The local
// cache is keyed by that text, so an edit never serves a parquet built from
// the old query.
//
// Plain ESM, Node built-ins only — like the rest of this package.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HOSTED_API_URL, findCredential, getAccessToken } from "./credentials.js";

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
  // Hosted Mako is the default: a fresh clone + `mako login` needs no .env.
  // MAKO_API_URL / workspace.json apiUrl exist for self-hosted or local dev.
  const apiUrl = (
    options.apiUrl ??
    env("MAKO_API_URL") ??
    ws.apiUrl ??
    HOSTED_API_URL
  ).replace(/\/+$/, "");
  return {
    repoRoot,
    apiUrl,
    apiKey: options.apiKey ?? env("MAKO_API_KEY") ?? "",
    workspaceId: options.workspaceId ?? env("MAKO_WORKSPACE_ID") ?? ws.workspaceId ?? "",
    // The manifest id is the app's identity (apps.md §29); the folder
    // basename is only a fallback for apps that predate ids — and is
    // ambiguous once apps nest.
    slug: options.slug ?? readManifestId(appDir) ?? path.basename(path.resolve(appDir)),
    bindingsDir: path.join(appDir, "bindings"),
    cacheDir: path.join(appDir, "node_modules", ".mako-data"),
    /** Preview the app as this viewer (email) — see makoData(). */
    viewAs: options.viewAs ?? env("MAKO_VIEWER_AS") ?? "",
    /** Render `{{ dbt_schema }}` against this dbt environment — see makoData(). */
    dbtEnvironment: options.dbtEnvironment ?? env("MAKO_DBT_ENV") ?? "",
  };
}

/** CRLF/CR → LF, no trailing whitespace at the end of the file. */
export function normalizeBindingSource(source) {
  return source.replace(/\r\n?/g, "\n").trimEnd();
}

/**
 * What a cached parquet was built from: the binding file's exact text plus
 * the dbt environment it was rendered against. A cache entry is only ever
 * served for the same fingerprint, whatever its age.
 */
export function bindingFingerprint(source, dbtEnvironment = "") {
  // Line endings and trailing whitespace are not the query: a Windows
  // checkout (core.autocrlf) must not look like an edit. The API normalises
  // the text it compares the same way.
  return createHash("sha256")
    .update(normalizeBindingSource(source))
    .update("\0")
    .update(dbtEnvironment)
    .digest("hex")
    .slice(0, 32);
}

function readManifestId(appDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appDir, "mako.json"), "utf8"));
    return typeof raw.id === "string" && /^[0-9a-f]{24}$/i.test(raw.id) ? raw.id : null;
  } catch {
    return null;
  }
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
      if (!ctx.apiUrl) problems.push("MAKO_API_URL is set but empty");
      if (!ctx.apiKey && !loggedIn)
        problems.push(
          `not signed in to ${ctx.apiUrl || "Mako"}: run \`npx @makoai/cli login\` in this repo (or set MAKO_API_KEY in .env)`,
        );
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
            : ` via ${ctx.apiUrl} (${ctx.apiKey ? "API key" : "mako login"})` +
              (ctx.dbtEnvironment ? `, dbt environment "${ctx.dbtEnvironment}"` : "")),
      );

      // fetch() with network failures translated into something a person can
      // act on — "fetch failed" alone has sent people debugging the wrong end.
      async function apiFetch(url, init) {
        try {
          return await fetch(url, init);
        } catch (error) {
          const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
          throw new Error(
            `cannot reach the Mako API at ${ctx.apiUrl} (${cause})` +
              (ctx.apiUrl === HOSTED_API_URL
                ? " — check your network connection"
                : ` — is that server running? Unset MAKO_API_URL (repo .env or environment) to use ${HOSTED_API_URL}`),
          );
        }
      }

      // Long builds run as jobs: the API answers 202 + a job id (it would
      // otherwise hit the edge's 100 s limit and fail with a 524 while the
      // build carried on), and this polls the job until it lands. An API
      // without jobs just answers synchronously, which works as before.
      const pollMs = options.pollIntervalMs ?? 1000;
      const buildTimeoutMs = options.buildTimeoutMs ?? 30 * 60 * 1000;
      async function awaitJob(name, jobId) {
        const url = `${appBase()}/binding-jobs/${encodeURIComponent(jobId)}`;
        const deadline = Date.now() + buildTimeoutMs;
        let wait = pollMs;
        for (;;) {
          const res = await apiFetch(url, { headers: await headers() });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            const error = new Error(body.error || `build ${name}: job HTTP ${res.status}`);
            error.status = res.status;
            throw error;
          }
          if (body.status === "ready") return body;
          if (body.status === "error") {
            const error = new Error(body.error || `build ${name} failed`);
            error.status = body.errorStatus ?? 502;
            throw error;
          }
          if (Date.now() > deadline) {
            const error = new Error(`build ${name} still running after ${Math.round(buildTimeoutMs / 1000)} s (job ${jobId})`);
            error.status = 504;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
          wait = Math.min(wait * 2, pollMs * 5);
        }
      }
      async function jobArtifact(name, jobId) {
        const res = await apiFetch(`${appBase()}/binding-jobs/${encodeURIComponent(jobId)}/artifact`, {
          headers: await headers(),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const error = new Error(`build ${name}: result HTTP ${res.status} ${text.slice(0, 300)}`);
          error.status = res.status;
          throw error;
        }
        return Buffer.from(await res.arrayBuffer());
      }
      // POST …/materialize, asynchronously when the API supports it.
      // Resolves to the materialize answer ({ rowCount, byteSize, materializedAt }).
      async function materialize(name) {
        const res = await apiFetch(
          `${appBase()}/bindings/${encodeURIComponent(name)}/materialize?async=1`,
          { method: "POST", headers: await headers() },
        );
        const body = await res.json().catch(() => ({}));
        if (res.status === 202 && body.jobId) return awaitJob(name, body.jobId);
        if (!res.ok) {
          const error = new Error(body.error || `materialize ${name}: HTTP ${res.status}`);
          error.status = res.status;
          throw error;
        }
        return body;
      }

      async function fetchArtifact(name) {
        const url = `${appBase()}/bindings/${encodeURIComponent(name)}/artifact`;
        let res = await apiFetch(url, { headers: await headers() });
        if (res.status === 404 && options.materialize !== false) {
          // Never materialized (or a live binding): build it now, then read.
          await materialize(name);
          res = await apiFetch(url, { headers: await headers() });
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              `the Mako API at ${ctx.apiUrl} refused the credential (HTTP ${res.status}) — ` +
                (ctx.apiKey
                  ? "the MAKO_API_KEY in .env is invalid for this host/workspace"
                  : "run `npx @makoai/cli login` in this repo again") +
                (text ? ` (${text.slice(0, 200)})` : ""),
            );
          }
          throw new Error(`artifact ${name}: HTTP ${res.status} ${text.slice(0, 300)}`);
        }
        return Buffer.from(await res.arrayBuffer());
      }

      // The local binding file, or null when the app has none by that name
      // (then the committed binding is all there is to serve).
      function readSource(name) {
        try {
          return fs.readFileSync(path.join(ctx.bindingsDir, `${name}.sql`), "utf8");
        } catch {
          return null;
        }
      }

      const cachePath = (name) => path.join(ctx.cacheDir, `${name}.parquet`);
      const metaPath = (name) => path.join(ctx.cacheDir, `${name}.parquet.json`);

      function cachedFingerprint(name) {
        try {
          return JSON.parse(fs.readFileSync(metaPath(name), "utf8")).fingerprint ?? null;
        } catch {
          return null;
        }
      }

      function writeCache(name, buf, meta) {
        fs.mkdirSync(ctx.cacheDir, { recursive: true });
        fs.writeFileSync(cachePath(name), buf);
        if (meta) fs.writeFileSync(metaPath(name), JSON.stringify(meta));
        else fs.rmSync(metaPath(name), { force: true });
      }

      // An API that predates dev builds answers the route with its not-found
      // handler (`{"success":false,"error":"Not Found"}`, or plain text from
      // a proxy) — or, for a `mako login` token or scoped key, with the
      // scoped-credential refusal, since the route is not on its allowlist
      // yet. Remembered, so the rest of the session asks for the committed
      // artifact directly (the behaviour before dev builds existed). Any
      // other 404 (no such app) falls back for that request only, so the
      // artifact route reports it.
      let devBuildUnsupported = false;
      const inflight = new Map();

      // Build the LOCAL binding text through the API. Concurrent asks for the
      // same text share one request (a page mounting several tables at once).
      function devBuild(name, source, refresh) {
        const fingerprint = bindingFingerprint(source, ctx.dbtEnvironment);
        const key = `${name}:${fingerprint}:${refresh ? 1 : 0}`;
        let pending = inflight.get(key);
        if (pending) return pending;
        pending = (async () => {
          const res = await apiFetch(`${appBase()}/bindings/${encodeURIComponent(name)}/dev-build`, {
            method: "POST",
            headers: { ...(await headers()), "content-type": "application/json" },
            body: JSON.stringify({
              source,
              ...(ctx.dbtEnvironment ? { dbtEnvironment: ctx.dbtEnvironment } : {}),
              ...(refresh ? { refresh: true } : {}),
              async: true,
            }),
          });
          let jobDone = null;
          if (res.status === 202) {
            const queued = await res.json().catch(() => ({}));
            if (!queued.jobId) throw new Error(`build ${name}: HTTP 202 without a job id`);
            jobDone = await awaitJob(name, queued.jobId);
          }
          if (!jobDone && !res.ok) {
            const text = await res.text().catch(() => "");
            let body = null;
            try {
              body = JSON.parse(text);
            } catch {
              // Not the API's JSON error envelope.
            }
            const predatesDevBuild =
              (res.status === 404 && (!body || body.error === "Not Found")) ||
              (res.status === 403 && /restricted to the (\/api\/mcp|Mako MCP) endpoint/.test(body?.error ?? ""));
            if (predatesDevBuild || res.status === 404) {
              if (!predatesDevBuild) return null;
              devBuildUnsupported = true;
              server.config.logger.warn?.(
                `  mako-data: ${ctx.apiUrl} does not build local binding edits yet; serving committed bindings`,
              );
              return null;
            }
            const error = new Error(
              res.status === 401
                ? `the Mako API at ${ctx.apiUrl} refused the credential (HTTP 401) — ` +
                    (ctx.apiKey
                      ? "the MAKO_API_KEY in .env is invalid for this host/workspace"
                      : "run `npx @makoai/cli login` in this repo again")
                : body?.error || `build ${name}: HTTP ${res.status}`,
            );
            error.status = res.status;
            throw error;
          }
          const buf = jobDone
            ? await jobArtifact(name, jobDone.jobId)
            : Buffer.from(await res.arrayBuffer());
          const meta = jobDone
            ? {
                fingerprint,
                dbtEnvironment: ctx.dbtEnvironment || null,
                build: jobDone.build ?? "artifact",
                rowCount: jobDone.rowCount ?? null,
                builtAt: jobDone.materializedAt ?? new Date().toISOString(),
              }
            : {
                fingerprint,
                dbtEnvironment: ctx.dbtEnvironment || null,
                // A redirect to the stored artifact loses the API's headers;
                // that answer is always the committed artifact.
                build: res.headers.get("x-mako-build") ?? "artifact",
                rowCount: Number(res.headers.get("x-mako-row-count") ?? "") || null,
                builtAt: res.headers.get("x-mako-materialized-at") ?? new Date().toISOString(),
              };
          writeCache(name, buf, meta);
          return { buf, meta };
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
        return pending;
      }

      // POST __data/<name>/refresh — the SDK's refresh(): rebuild the LOCAL
      // binding through the API (the committed one is re-materialized and
      // stored, an edited one is built as a draft), and cache what came back.
      async function refreshBinding(name, res) {
        const source = options.materialize === false || devBuildUnsupported ? null : readSource(name);
        try {
          const built = source === null ? null : await devBuild(name, source, true);
          if (built) {
            return json(res, 200, {
              success: true,
              binding: name,
              materialization: "parquet",
              rowCount: built.meta.rowCount ?? undefined,
              byteSize: built.buf.length,
              materializedAt: built.meta.builtAt,
            });
          }
          let body;
          try {
            body = await materialize(name);
          } catch (error) {
            return json(res, error?.status ?? 502, {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          fs.rmSync(cachePath(name), { force: true });
          json(res, 200, {
            success: true,
            binding: name,
            materialization: "parquet",
            rowCount: body.rowCount,
            byteSize: body.byteSize,
            materializedAt: body.materializedAt,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`  mako-data: ${message}`);
          json(res, error?.status ?? 502, { success: false, error: message });
        }
      }

      // `__data/viewer.json` — the SDK's useViewer(): the developer's own
      // identity, or, with MAKO_VIEWER_AS=<email> (env or .env), another
      // member's, exactly as Mako would answer for them.
      const viewAsQuery = ctx.viewAs ? `?as=${encodeURIComponent(ctx.viewAs)}` : "";
      async function serveViewer(res) {
        if (problems.length) return json(res, 200, null);
        try {
          const r = await apiFetch(`${appBase()}/viewer${viewAsQuery}`, {
            headers: await headers(),
          });
          const body = await r.json().catch(() => ({}));
          if (r.status === 404) return json(res, 200, null);
          if (!r.ok) return json(res, r.status, { error: body.error ?? `viewer: HTTP ${r.status}` });
          return json(res, 200, body.viewer ?? null);
        } catch (error) {
          return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      server.middlewares.use(async (req, res, next) => {
        const [pathname, query = ""] = (req.url || "").split("?");
        if (pathname === "/__data/index.json") {
          return json(res, 200, listBindings(ctx.bindingsDir));
        }
        if (pathname === "/__data/viewer.json") return serveViewer(res);
        const match = /^\/__data\/([^/]+)(\.parquet|\/refresh)$/.exec(pathname);
        if (!match) return next();
        const name = decodeURIComponent(match[1]);
        const isRefresh = match[2] === "/refresh";
        if (!BINDING_NAME.test(name)) return json(res, 400, { error: "invalid binding name" });
        if (isRefresh && req.method !== "POST") {
          return json(res, 405, { error: "POST to refresh a binding" });
        }
        if (problems.length) {
          return json(res, 503, {
            error: `mako-data is not connected: ${problems.join("; ")}`,
            hint: "Run `mako login` in this repo, or put MAKO_API_URL and MAKO_API_KEY in the repo's .env (see AGENTS.md).",
          });
        }
        if (isRefresh) return refreshBinding(name, res);
        const cached = cachePath(name);
        const refresh = /(^|&)refresh(=|&|$)/.test(query);
        const source = options.materialize === false || devBuildUnsupported ? null : readSource(name);
        // Null without a local file: the committed artifact, cached by age alone.
        const fingerprint = source === null ? null : bindingFingerprint(source, ctx.dbtEnvironment);
        // A cache built from other text (or another dbt environment) is not
        // this binding's data, however fresh — serving it is how an edited
        // query ended up read with the old query's columns.
        const cacheMatches = () => fingerprint === null || cachedFingerprint(name) === fingerprint;
        const serveCached = (how) => {
          res.setHeader("content-type", "application/vnd.apache.parquet");
          res.setHeader("x-mako-data", how);
          return fs.createReadStream(cached).pipe(res);
        };
        try {
          const stat = fs.statSync(cached, { throwIfNoEntry: false });
          const fresh = stat && Date.now() - stat.mtimeMs < revalidateMs;
          if (!refresh && fresh && cacheMatches()) return serveCached("cache");
          let buf = null;
          if (source !== null) buf = (await devBuild(name, source, false))?.buf ?? null;
          if (!buf) {
            buf = await fetchArtifact(name);
            writeCache(name, buf, null);
          }
          res.setHeader("content-type", "application/vnd.apache.parquet");
          res.setHeader("content-length", String(buf.length));
          res.setHeader("x-mako-data", "api");
          res.end(buf);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`  mako-data: ${message}`);
          // Stale beats nothing while offline — but only data built from THIS
          // text; an old query's parquet is not a stale copy of a new one.
          if (fs.existsSync(cached) && cacheMatches()) return serveCached("stale");
          json(res, error?.status ?? 502, { error: message });
        }
      });
    },
  };
}

export default makoData;
