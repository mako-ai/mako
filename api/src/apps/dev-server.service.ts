/**
 * Apps live dev preview — `vite dev` INSIDE the sandbox (apps.md §12.4).
 *
 * The previous implementation spawned vite as a child process of the API host
 * and proxied to it. That could only ever work under the deleted local sandbox
 * provider, because it is exactly what N1 forbids: tenant code executing in the
 * API process. So the throwaway dev substrate had live preview and every real
 * environment had none.
 *
 * Now the dev server runs where the app's files already are. E2B exposes a
 * per-sandbox public origin for any port (`https://<port>-<sandboxId>.e2b.app`),
 * which the browser loads directly — no Mako proxy, no WebSocket relay of our
 * own (HMR rides that same origin), and nothing of the tenant's on our host.
 *
 * Two details the sandbox forces, both handled here rather than in the app's
 * own files:
 *
 * - Vite must bind `0.0.0.0`, and since 5.4 it rejects requests whose Host it
 *   does not recognise — the E2B origin is exactly such a Host. Both are server
 *   options, and we set them through Vite's JS API so they take precedence over
 *   whatever the app's `vite.config.ts` says WITHOUT editing a file the user
 *   owns and commits.
 * - The sandbox's idle timeout would pause the microVM out from under a dev
 *   server that is running but momentarily idle, so it is pushed out explicitly.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";
import {
  boxCtx,
  ensureBox,
  isMissingCwd,
  rehydrateBox,
  type WorktreeHandle,
  sessionKeyFor,
  handleProject,
} from "./worktree.service";
import { loggers } from "../logging";
import { boxEnvPath, sh } from "./box";
import { ensureBoxAgent } from "./box-agent";
import { getBoxState, probeReachable } from "./box-state.service";
import { readBindings, bindingArtifactKey } from "./bindings.service";
import { resolveAppEnv } from "./env.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

const logger = loggers.api("apps-dev-server");

/**
 * Every running app gets its own dev server on its own port — two apps can
 * be live side by side, and opening app B no longer kills app A's server
 * (the old single-port model needed an identity marker and a takeover;
 * per-app ports delete that whole problem). Ports are handed out from this
 * base by a registry file inside the sandbox, so the mapping lives with the
 * servers it describes and survives API restarts.
 */
const DEV_PORT_BASE = 5173;
const PORTS_REGISTRY = "/tmp/mako-dev-ports.json";

/** How long to hold the sandbox open past the last preview request. */
const DEV_SESSION_KEEPALIVE_MS = 30 * 60 * 1000;

/**
 * At most this many dev servers run at once per box (apps.md §13.9).
 *
 * A dozen vite servers fills a 2 GiB microVM; this is the hard ceiling that
 * keeps a heavy workspace from ever getting there. Starting a server beyond
 * the cap evicts the oldest to make room — the system may STOP to bound
 * resources, but it never auto-starts. Reaping idle servers below the cap is
 * the box agent's job.
 */
const MAX_RUNNING_DEV_SERVERS = 3;

/** One filesystem identity per app for launcher, log and staged data. */
function appSlug(handle: WorktreeHandle): string {
  const base = handle.appRoot.split("/").filter(Boolean).pop() ?? "app";
  return base.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60);
}

/**
 * Where everything this APP's boot writes its output — npm install (the
 * route appends it here before starting the server) and vite itself. One
 * file per app so each workbench's Dev server tab tails its own boot.
 */
export function devLogPath(handle: WorktreeHandle): string {
  // The dev server IS a terminal session (dtach socket mako-term-dev-<slug>,
  // recording mako-hist-dev-<slug>.raw — the same naming every interactive
  // session uses), so the workbench's dev tab attaches to it like any other
  // shell: colors, scrollback, prefill and Ctrl-C all come from the same
  // machinery. This file doubles as the boot log the route tees npm install
  // into, so the recording holds the WHOLE story of a boot.
  return `/tmp/mako-hist-dev-${appSlug(handle)}.raw`;
}

/**
 * Where the injected runtime-console bridge (the makoEyes vite plugin in the
 * launcher below) appends browser-side errors/warnings as JSONL. Read by
 * app_dev_log so an agent sees what the BROWSER said, not just vite.
 */
export function devConsolePath(handle: WorktreeHandle): string {
  return `/tmp/mako-console-${appSlug(handle)}.jsonl`;
}

/**
 * Port of this app's RUNNING dev server, or null. Never allocates and never
 * boots anything — a question, not an act (§13.9).
 */
export async function currentDevPort(
  handle: WorktreeHandle,
): Promise<number | null> {
  const provider = getSandboxProvider();
  const ctx = boxCtx(handle);
  if (!(await provider.hasSession(ctx))) return null;
  return devPort(handle, provider, ctx, { allocate: false });
}

/** The dev session's dtach socket — its existence is "the server has a session". */
function devSockPath(handle: WorktreeHandle): string {
  return `/tmp/mako-term-dev-${appSlug(handle)}.sock`;
}

function launcherPath(handle: WorktreeHandle): string {
  return `/tmp/mako-dev-${appSlug(handle)}.mjs`;
}

/**
 * Where materialized binding parquet is staged inside the sandbox — per app,
 * so two apps with a same-named binding cannot serve each other's data.
 *
 * Deliberately outside the app's directory: this data is derived, sometimes
 * large, and must never end up in the user's git tree or their `public/`.
 */
function dataDir(handle: WorktreeHandle): string {
  return `/tmp/mako-data-${appSlug(handle)}`;
}

/**
 * The app's port, from the in-sandbox registry. `allocate` grants a new port
 * to an app that has none; reads that must not disturb state (is the server
 * up?) pass false and get null for an unregistered app.
 *
 * Allocation takes a LOCK (mkdir is atomic) around the read-modify-write:
 * two apps launched concurrently both read `{}`, both picked 5173, and the
 * loser's vite died on EADDRINUSE — while its "is it listening" poll saw the
 * winner answering and iframed the WRONG app. A lock held longer than 5s is
 * presumed dead (a killed allocator) and stolen.
 */
async function devPort(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  options: { allocate: boolean },
): Promise<number | null> {
  const script =
    `const fs=require("fs");const f=${JSON.stringify(PORTS_REGISTRY)};` +
    `const app=process.argv[1];` +
    (options.allocate
      ? `const lock=f+".lock";const t0=Date.now();` +
        `for(;;){try{fs.mkdirSync(lock);break}catch{` +
        `if(Date.now()-t0>5000){try{fs.rmdirSync(lock)}catch{}continue}` +
        `const w=Date.now()+15;while(Date.now()<w);}}` +
        `try{let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}` +
        `if(!m[app]){const used=new Set(Object.values(m));let p=${DEV_PORT_BASE};while(used.has(p))p++;m[app]=p;fs.writeFileSync(f,JSON.stringify(m));}` +
        `console.log(m[app]??"")}finally{try{fs.rmdirSync(lock)}catch{}}`
      : `let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}` +
        `console.log(m[app]??"");`);
  const result = await provider.exec(
    ctx,
    `node -e ${sh(script)} ${JSON.stringify(handle.appRoot)}`,
    { timeoutMs: 30_000 },
  );
  const port = Number(result.stdout.trim());
  return Number.isInteger(port) && port >= DEV_PORT_BASE ? port : null;
}

/**
 * Node launcher, run inside the sandbox. Uses Vite's JS API because inline
 * `server` options there beat the app's config file; the CLI has no flag for
 * `allowedHosts`, and editing the app's `vite.config.ts` to add one would be
 * committing our infrastructure into the user's repository.
 *
 * `.e2b.app` is matched as a suffix, so it covers the sandbox's own origin
 * without our having to know the sandbox id at write time.
 */
function launcherSource(
  appDir: string,
  port: number,
  stagedDataDir: string,
  slug: string,
  boxEnv: string,
): string {
  return `
import { createServer } from "${appDir}/node_modules/vite/dist/node/index.js";
import { appendFileSync, createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// Tell Mako the moment this server is up or gone, instead of leaving the UI
// to discover it on a poll. Best effort: the API address and token are read
// from the box's env file at send time (a tunnel restart rewrites it), and a
// failure here never affects the server itself.
function makoEnv() {
  try {
    return Object.fromEntries(
      readFileSync(${JSON.stringify(boxEnv)}, "utf8")
        .split("\\n")
        .filter(Boolean)
        .map(line => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  } catch {
    return {};
  }
}
// Retried: the API sits behind a tunnel in development and quick tunnels
// drop the odd request (a 530 with nothing wrong on either end). A missed
// "serving" would leave the UI on its slow poll, so try a few times; a
// missed "down" matters less (the box agent's next snapshot covers it) and
// must not hold up exit, so it gets fewer, faster attempts.
async function tellMako(state, attempts, delaysMs) {
  const env = makoEnv();
  if (!env.MAKO_API || !env.MAKO_WS || !env.MAKO_TOKEN_FILE) return;
  let token;
  try {
    token = readFileSync(env.MAKO_TOKEN_FILE, "utf8").trim();
  } catch {
    return;
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(env.MAKO_API + "/api/apps-box/" + env.MAKO_WS + "/events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          source: "launcher",
          devServer: { slug: ${JSON.stringify(slug)}, port: ${port}, state },
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return;
      console.log("mako: notify " + state + " got http " + res.status + " (attempt " + (attempt + 1) + ")");
    } catch (error) {
      console.log("mako: notify " + state + " failed: " + (error && error.message) + " (attempt " + (attempt + 1) + ")");
    }
    if (attempt + 1 < attempts) {
      await new Promise(resolve => setTimeout(resolve, delaysMs[attempt] || 1000));
    }
  }
}
let farewellSent = false;
async function farewell(code) {
  if (farewellSent) return;
  farewellSent = true;
  await tellMako("down", 2, [800]);
  process.exit(code);
}
process.on("SIGINT", () => void farewell(130));
process.on("SIGTERM", () => void farewell(143));
process.on("SIGHUP", () => void farewell(129));

// Serve materialized data bindings at __data/<name>.parquet.
//
// The app fetches this path relatively, and it used to be answered by Mako's
// preview route, which sat in front of the dev server as a proxy. Now the
// browser talks to the sandbox directly (apps.md §12.4), so nothing was
// answering it: Vite fell through to its SPA fallback and returned index.html,
// and the parquet reader failed with "footer != PAR1" on the HTML.
const makoData = {
  name: "mako-data",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/__data/index.json") {
        // The staged-binding list, for the SDK's useDuckDB. Missing file
        // (no bindings staged yet) is an empty list, not an error.
        const file = path.join(${JSON.stringify(stagedDataDir)}, "index.json");
        res.setHeader("content-type", "application/json");
        if (existsSync(file)) {
          createReadStream(file).pipe(res);
        } else {
          res.end("[]");
        }
        return;
      }
      const match = /^\\/__data\\/([A-Za-z0-9_][A-Za-z0-9_-]*)\\.parquet$/.exec(url);
      if (!match) return next();
      const name = match[1];
      // Live binding: query it fresh through Mako, stream the parquet back.
      // dev/edit only — the box token authorizes it as this box's actor.
      if (existsSync(path.join(${JSON.stringify(stagedDataDir)}, name + ".live"))) {
        const env = makoEnv();
        (async () => {
          try {
            const token = readFileSync(env.MAKO_TOKEN_FILE, "utf8").trim();
            const upstream = await fetch(
              env.MAKO_API + "/api/apps-box/" + env.MAKO_WS + "/live-binding",
              {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer " + token },
                body: JSON.stringify({ slug: ${JSON.stringify(slug)}, name }),
                // A materialized query can be slow (a heavy dashboard mart runs
                // for a minute); give it room rather than failing the table.
                signal: AbortSignal.timeout(180000),
              },
            );
            if (!upstream.ok) {
              res.statusCode = 502;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: "Live binding failed", binding: name, status: upstream.status }));
              return;
            }
            const buf = Buffer.from(await upstream.arrayBuffer());
            // Write-through cache: keep this result as a static parquet and drop
            // the live marker, so the binding is queried at most ONCE per dev
            // session — the next fetch (and every re-open) serves the file, not
            // a fresh 60s query. A rebuild/re-stage overwrites it.
            try {
              writeFileSync(path.join(${JSON.stringify(stagedDataDir)}, name + ".parquet"), buf);
              rmSync(path.join(${JSON.stringify(stagedDataDir)}, name + ".live"), { force: true });
            } catch {}
            res.statusCode = 200;
            res.setHeader("content-type", "application/vnd.apache.parquet");
            res.setHeader("content-length", String(buf.length));
            res.setHeader("cache-control", "no-store");
            res.end(buf);
          } catch (error) {
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Live binding failed", binding: name, detail: String(error && error.message) }));
          }
        })();
        return;
      }
      const file = path.join(${JSON.stringify(stagedDataDir)}, name + ".parquet");
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: "Binding not materialized",
          binding: name,
        }));
        return;
      }
      // Parquet readers need the length to locate the footer.
      res.statusCode = 200;
      res.setHeader("content-type", "application/vnd.apache.parquet");
      res.setHeader("content-length", String(statSync(file).size));
      res.setHeader("cache-control", "no-store");
      createReadStream(file).pipe(res);
    });
  },
};

// Runtime eyes (apps.md §13.15): the app itself reports browser-side
// errors. A tiny client hook (served below, injected into index.html)
// batches console.error/warn, window errors and unhandled rejections to a
// same-origin endpoint, which appends them to a capped JSONL file the
// agent reads via app_dev_log. Same-origin, so no CORS and it works in
// the workbench iframe AND in the in-box headless browser alike.
const CONSOLE_FILE = ${JSON.stringify(`/tmp/mako-console-${slug}.jsonl`)};
const EYES_CLIENT = \`(() => {
  const q = [];
  let t = null;
  let dropped = 0;
  const flush = () => {
    t = null;
    if (!q.length) return Promise.resolve();
    const batch = q.splice(0);
    const shed = dropped; dropped = 0;
    return fetch("/__mako/console", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: batch, dropped: shed }), keepalive: true }).catch(() => {});
  };
  // Deterministic flush for the headless browser: hidden pages throttle
  // timers, so the 500ms batch timer can fire only as the runner closes the
  // browser — aborting the POST mid-flight. app_browse awaits this instead.
  window.__makoEyesFlush = flush;
  const push = (level, parts) => {
    try {
      const text = parts.map(a => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 500);
      q.push({ t: Date.now(), level, text });
      if (q.length > 40) { dropped += q.length - 40; q.splice(0, q.length - 40); }
      if (!t) t = setTimeout(flush, 500);
    } catch {}
  };
  const orig = { error: console.error, warn: console.warn };
  console.error = (...a) => { push("error", a); orig.error.apply(console, a); };
  console.warn = (...a) => { push("warn", a); orig.warn.apply(console, a); };
  window.addEventListener("error", e => push("error", [(e.message || "error") + " @" + (e.filename || "") + ":" + (e.lineno || 0)]));
  window.addEventListener("unhandledrejection", e => push("error", ["unhandledrejection: " + (e.reason && (e.reason.stack || e.reason.message) || String(e.reason))]));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
})();\`;
const makoEyes = {
  name: "mako-eyes",
  transformIndexHtml() {
    return [{ tag: "script", attrs: { src: "/__mako_eyes.js" }, injectTo: "head" }];
  },
  configureServer(server) {
    server.middlewares.use("/__mako_eyes.js", (req, res) => {
      res.setHeader("content-type", "text/javascript");
      res.end(EYES_CLIENT);
    });
    server.middlewares.use("/__mako/console", (req, res) => {
      if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
      let body = "";
      req.on("data", c => { body += c; if (body.length > 100000) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
          const shed = Array.isArray(parsed) ? 0 : Number(parsed.dropped) || 0;
          if (entries.length) {
            // Capped, not unbounded: a render loop spamming console.error
            // must not fill the box's disk. Truncate-and-restart is fine —
            // this is a debugging buffer, not an archive.
            try { if (existsSync(CONSOLE_FILE) && statSync(CONSOLE_FILE).size > 512000) writeFileSync(CONSOLE_FILE, JSON.stringify({ t: Date.now(), level: "warn", text: "[bridge] console file exceeded 512KB and was truncated; earlier events lost" }) + "\\n"); } catch {}
            const lines = entries.slice(0, 60).map(e => JSON.stringify({ t: Number(e.t) || Date.now(), level: e.level === "warn" ? "warn" : "error", text: String(e.text).slice(0, 500) }));
            if (shed > 0) lines.push(JSON.stringify({ t: Date.now(), level: "warn", text: "[bridge] " + shed + " earlier console events dropped (flood) - only the most recent are kept" }));
            appendFileSync(CONSOLE_FILE, lines.join("\\n") + "\\n");
          }
        } catch {}
        res.statusCode = 204;
        res.end();
      });
    });
  },
};

const server = await createServer({
  root: ${JSON.stringify(appDir)},
  plugins: [makoData, makoEyes],
  server: {
    host: "0.0.0.0",
    port: ${port},
    strictPort: true,
    // The browser reaches us on the sandbox's public origin; without this
    // Vite answers 403 "Blocked request. This host is not allowed."
    allowedHosts: [".e2b.app"],
    // inotify does not fire in the E2B microVM (verified: fs.watch gets no
    // event even for a same-process append), so without polling the module
    // graph never invalidates: edits commit and land on disk but the served
    // transform — and HMR — stay frozen on the boot-time contents.
    watch: { usePolling: true, interval: 300 },
  },
});
await server.listen();
// The same banner \`vite dev\` prints from a terminal — version, ready
// time, URLs — so the boot log reads like the real thing, because it is.
server.printUrls();
console.log("mako dev server listening on ${port}");
// Honest viewer signal for the box agent's idle reaper: E2B's ingress fleet
// parks keep-alive TCP connections on this port with NO browser anywhere
// (observed: 16 distinct peers, zero viewers), so an ESTABLISHED conn does
// not mean "someone is watching". Only a real browser completes the HMR
// websocket handshake — report those. ws:-1 = unknown (agent falls back).
const viewersFile = "/tmp/mako-dev-${slug}.viewers";
const reportViewers = () => {
  let ws = -1;
  try {
    const c = server.ws && server.ws.clients;
    if (c && typeof c.size === "number") ws = c.size;
  } catch {}
  try { writeFileSync(viewersFile, JSON.stringify({ ws, at: Date.now() })); } catch {}
};
reportViewers();
const viewersTimer = setInterval(reportViewers, 10000);
if (viewersTimer.unref) viewersTimer.unref();
// Cull half-open HMR sockets: a laptop sleeping mid-session leaves its
// websocket ESTABLISHED here for hours (observed: a dev server surviving
// 3h with zero real viewers), and vite's client set never shrinks on its
// own — so the viewer count above stays >=1 and the idle reaper never
// fires. Ping every 20s; no pong for 60s = dead, terminate it.
const lastPong = new WeakMap();
const cullTimer = setInterval(() => {
  try {
    const clients = server.ws && server.ws.clients;
    if (!clients) return;
    for (const client of clients) {
      const sock = (client && client.socket) || client;
      if (!sock || typeof sock.ping !== "function") continue;
      if (!lastPong.has(sock)) {
        lastPong.set(sock, Date.now());
        sock.on("pong", () => lastPong.set(sock, Date.now()));
      }
      if (Date.now() - lastPong.get(sock) > 60000) {
        try { sock.terminate(); } catch {}
      } else {
        try { sock.ping(); } catch {}
      }
    }
  } catch {}
}, 20000);
if (cullTimer.unref) cullTimer.unref();
void tellMako("serving", 7, [1000, 3000, 8000, 15000, 30000, 60000]);
// Watcher lifecycle in the boot log: "ready" proves the polling scan
// finished (inotify is dead in this VM, so a silent watcher means frozen
// transforms), and errors here are otherwise invisible.
server.watcher.on("ready", () => console.log("file watcher ready (polling)"));
server.watcher.on("error", (e) => console.log("file watcher error:", e.message));
`.trimStart();
}

export interface DevPreview {
  /** Public origin the browser should iframe. */
  url: string;
  /** Binding names whose data was staged into the session. */
  stagedBindings: string[];
  /** Other apps' dev servers stopped to stay within the running cap, if any. */
  evicted?: string[];
}

/**
 * Copy each materialized binding's parquet into the sandbox so the dev server
 * can answer `__data/<name>.parquet` locally.
 *
 * Pushing the bytes in (rather than having the sandbox call back to Mako)
 * keeps this working identically in local development and in deployed
 * environments: a sandbox can always reach the public internet, but it can
 * never reach a developer's localhost API.
 *
 * Bindings that have never been materialized are skipped, and the dev server
 * answers 404 with a readable reason rather than serving HTML as parquet.
 */
async function stageBindingData(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
): Promise<string[]> {
  const project = handleProject(handle);
  const projectId = project._id.toString();
  let bindings: Awaited<ReturnType<typeof readBindings>>;
  try {
    bindings = await readBindings(project, handle.doc.userId);
  } catch {
    return [];
  }
  if (bindings.length === 0) return [];

  const stageDir = dataDir(handle);
  await provider.exec(ctx, `mkdir -p ${stageDir}`, { timeoutMs: 30_000 });

  const store = getDashboardArtifactStore();
  const staged: string[] = [];
  // A marker (no parquet) tells the dev server's data middleware to fetch this
  // binding FRESH from Mako on each request. Listed in index.json so the SDK
  // still registers the table.
  const stageLive = async (name: string) => {
    await provider.writeFile(
      ctx,
      `${stageDir}/${name}.live`,
      new TextEncoder().encode("1"),
    );
    staged.push(name);
  };
  for (const binding of bindings) {
    if (binding.materialization === "live") {
      await stageLive(binding.name);
      continue;
    }
    const key = bindingArtifactKey(binding);
    const stream = await store.openReadStream(key);
    if (!stream) {
      // A scheduled binding with no materialized artifact yet (never built, or
      // its data lives only in the prod store). Rather than leave the app with
      // a missing DuckDB table, fall back to LIVE — query it fresh on demand —
      // so dev mode always shows data. A real build later replaces the marker
      // with a static parquet (the stale-marker rm below handles that). Dev
      // only: the box token authorizes the live query; a published app never
      // reaches this path.
      await stageLive(binding.name);
      continue;
    }
    // A stale marker from a previous life mustn't shadow a now-static binding.
    await provider
      .exec(ctx, `rm -f ${stageDir}/${binding.name}.live`, {
        timeoutMs: 15_000,
      })
      .catch(() => undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    await provider.writeFile(
      ctx,
      `${stageDir}/${binding.name}.parquet`,
      new Uint8Array(Buffer.concat(chunks)),
    );
    staged.push(binding.name);
  }

  // The staged names as a file beside the data, so the app-side SDK's
  // useDuckDB can register every binding without a Mako API in reach —
  // the same relative fetch that gets it the parquet gets it the list.
  await provider.writeFile(
    ctx,
    `${stageDir}/index.json`,
    new TextEncoder().encode(JSON.stringify(staged)),
  );
  if (staged.length > 0) {
    logger.info("Apps staged binding data into the sandbox", {
      projectId,
      bindings: staged,
    });
  }
  return staged;
}

/**
 * Is THIS app's dev server up? Per-app ports make identity trivial: the port
 * came from the registry keyed by app, so "the port answers" IS the check —
 * the marker file and takeover of the single-port era are gone.
 */
async function listening(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  port: number,
): Promise<boolean> {
  const probe = await provider.exec(
    ctx,
    `curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${port}/ && echo up || echo down`,
    { timeoutMs: 15_000 },
  );
  return probe.stdout.includes("up");
}

/**
 * Is the dev server SERVING — with its session intact?
 *
 * "The port answers" stopped being the whole truth once the server became a
 * session: an orphaned older-generation process can hold the port while the
 * dtach session is gone. Reusing that orphan looks fine in the iframe but
 * is exactly wrong everywhere else — the new session dies on EADDRINUSE,
 * the dev window waits forever, and Ctrl-C kills a session that was not
 * the thing serving. Three answers:
 *   serving — port up and (where dtach exists) the session socket with it
 *   orphan  — port up but the session is gone: kill and relaunch
 *   down    — nothing listening
 */
async function servingState(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  handle: WorktreeHandle,
  port: number,
): Promise<"serving" | "orphan" | "down"> {
  const probe = await provider.exec(
    ctx,
    `if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${port}/; then ` +
      `if command -v dtach >/dev/null; then test -S ${devSockPath(handle)} && echo serving || echo orphan; ` +
      `else echo serving; fi; else echo down; fi`,
    { timeoutMs: 15_000 },
  );
  if (probe.stdout.includes("serving")) return "serving";
  if (probe.stdout.includes("orphan")) return "orphan";
  return "down";
}

/**
 * Is this app's dev server already up in an existing sandbox? Never creates
 * a sandbox and never allocates a port. The reattach path uses this to keep
 * its hands off the boot log: truncating it and then skipping the launch
 * (because the server was already running) left the Dev server tab
 * permanently blank after a page reload.
 */
export async function isServingApp(handle: WorktreeHandle): Promise<boolean> {
  return (await devServerStatus(handle)).serving;
}

/**
 * Every dev server serving in the box right now, by discovery. One exec.
 * Used to seed a cold box-state snapshot, so that the first launcher delta
 * to arrive does not pose as the full list and mark every OTHER running
 * server down.
 *
 * Truth is the PORT, exactly as the box agent defines it: each registered
 * port is probed with a raw TCP connect inside the box. The old heuristic —
 * "a dtach socket file exists" — survived the death of the server it named
 * (sockets are not cleaned up by a crash or a resume), so a box could show
 * green dots for servers that had been dead for hours.
 */
export async function discoverDevServers(
  ctx: SandboxExecContext,
): Promise<Array<{ slug: string; port: number }>> {
  const provider = getSandboxProvider();
  if (!(await provider.hasSession(ctx))) return [];
  // Any touch of a box is a chance to refresh its agent: a resumed box can
  // sit for hours with a stale (or silently dead) agent otherwise, because
  // nothing but the ensureBox flows ever reinstalled it. Throttled inside.
  void ensureBoxAgent(ctx);
  const script =
    `const fs=require("fs"),net=require("net");` +
    `let m={};try{m=JSON.parse(fs.readFileSync(${JSON.stringify(PORTS_REGISTRY)},"utf8"))}catch{}` +
    `const entries=Object.entries(m).filter(e=>Number.isInteger(e[1]));` +
    `let left=entries.length;const out=[];` +
    `if(!left){console.log("[]");process.exit(0)}` +
    `entries.forEach(([k,p])=>{let d=false;const s=net.connect(p,"127.0.0.1");` +
    `const done=ok=>{if(d)return;d=true;try{s.destroy()}catch{}` +
    `if(ok)out.push({slug:k.replace(/^apps\\//,""),port:p});` +
    `if(--left===0)console.log(JSON.stringify(out))};` +
    `s.setTimeout(800);s.once("connect",()=>done(true));` +
    `s.once("error",()=>done(false));s.once("timeout",()=>done(false));});`;
  const result = await provider.exec(ctx, `node -e ${sh(script)}`, {
    timeoutMs: 15_000,
  });
  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]") as Array<{
      slug: string;
      port: number;
    }>;
    return parsed.filter(
      d => d && typeof d.slug === "string" && Number.isInteger(d.port),
    );
  } catch {
    return [];
  }
}

/**
 * Discovery, not memory: is this app's dev server serving, and where?
 * The url lets a fresh browser (no client-side state at all) walk up to an
 * app whose server is already running and just show it.
 */
export async function devServerStatus(
  handle: WorktreeHandle,
): Promise<{ serving: boolean; url?: string; reachable?: boolean }> {
  const provider = getSandboxProvider();
  const ctx = boxCtx(handle);
  // Snapshot first (pushed by the box; expires unless refreshed): no exec.
  const snapshot = await getBoxState(ctx.sessionKey);
  if (snapshot?.devServers) {
    const entry = snapshot.devServers.find(d => d.slug === appSlug(handle));
    if (!entry) return { serving: false };
    // Peek, never create: status must not boot a machine (§13.9).
    const url =
      entry.url ?? (await provider.peekPublicUrlForPort(ctx, entry.port));
    if (!url) return { serving: false };
    return { serving: true, url, reachable: entry.reachable };
  }
  if (!(await provider.hasSession(ctx))) return { serving: false };
  const port = await devPort(handle, provider, ctx, { allocate: false });
  if (!port) return { serving: false };
  if ((await servingState(provider, ctx, handle, port)) !== "serving") {
    return { serving: false };
  }
  const url = await provider.peekPublicUrlForPort(ctx, port);
  if (!url) return { serving: false };
  return { serving: true, url };
}

/**
 * Stop one app's dev server and free its registry slot — a STOP, never a
 * start. Kills the launcher process (which is vite), removes the session
 * socket, and deletes the app's port from the registry so a fresh launch
 * reallocates cleanly. Used by the running-cap here and, in-box, by the
 * agent's idle reaper.
 */
async function reapDevServerBySlug(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  slug: string,
): Promise<void> {
  // Slugs are sanitized app-folder names; refuse anything else rather than
  // interpolate it into a shell.
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return;
  await provider
    .exec(
      ctx,
      `pkill -f "[m]ako-dev-${slug}.mjs" 2>/dev/null; rm -f /tmp/mako-term-dev-${slug}.sock; ` +
        `node -e 'const fs=require("fs");const f=${JSON.stringify(PORTS_REGISTRY)};let m={};try{m=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}delete m["apps/"+process.argv[1]];try{fs.writeFileSync(f,JSON.stringify(m))}catch{}' ${JSON.stringify(slug)}; echo reaped`,
      { timeoutMs: 30_000 },
    )
    .catch(() => undefined);
}

/**
 * Enforce the per-box running cap before launching a NEW server: evict the
 * oldest others (lowest port ≈ earliest allocated) until this one fits under
 * MAX_RUNNING_DEV_SERVERS. Returns the slugs it stopped, so the caller can
 * tell the user what was closed to make room.
 */
async function enforceRunningCap(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  selfSlug: string,
): Promise<string[]> {
  const running = await discoverDevServers(ctx);
  if (running.some(d => d.slug === selfSlug)) return [];
  const others = running
    .filter(d => d.slug !== selfSlug)
    .sort((a, b) => a.port - b.port);
  const overflow = others.length - (MAX_RUNNING_DEV_SERVERS - 1);
  if (overflow <= 0) return [];
  const victims = others.slice(0, overflow);
  for (const v of victims) {
    await reapDevServerBySlug(provider, ctx, v.slug);
    logger.info("Apps dev server evicted to honor the running cap", {
      evicted: v.slug,
      cap: MAX_RUNNING_DEV_SERVERS,
    });
  }
  return victims.map(v => v.slug);
}

/**
 * Ensure a dev server is running for this app and return its public URL.
 *
 * Idempotent: a server that is already listening is reused, so repeated
 * previews do not restart vite and lose its module graph. Other apps' dev
 * servers are left alone — each has its own port.
 */
const launching = new Map<string, Promise<DevPreview>>();

/**
 * Release an app's dev-server registry slot after its session was killed
 * out-of-band (leaving dev mode kills the pty tree, but the port registry is
 * a file the kill never touches). Without this the dead entry retires its
 * port FOREVER: allocation treats every registry value as taken
 * (`used.has(p) → p++`), and the box agent never ticks idle time for a
 * server it cannot probe alive — so nothing else cleans it either (§13.20).
 *
 * Addresses the box directly by session key, never ensureBox: cleaning a
 * registry must not boot a machine, and a box that is gone took its
 * registry with it (best effort, logged).
 */
export async function releaseDevServerSlot(
  workspaceId: string,
  userId: string,
  slug: string | null,
): Promise<void> {
  if (!slug) return;
  const provider = getSandboxProvider();
  const ctx = { sessionKey: sessionKeyFor(workspaceId, userId) };
  await reapDevServerBySlug(provider, ctx, slug).catch(error => {
    logger.debug("Apps dev-server release skipped (box unreachable?)", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function ensureDevServer(
  handle: WorktreeHandle,
  options: { restart?: boolean } = {},
): Promise<DevPreview> {
  // Single-flight per (session, app): the workbench can ask for the dev
  // server from more than one place at once (mount effect + status poll +
  // StrictMode double-invoke), and two concurrent launches race — the loser
  // binds a busy port and dies, taking shared state down with it. All
  // concurrent callers share one launch instead.
  const key = `${boxCtx(handle).sessionKey}:${handle.appRoot}`;
  const inflight = launching.get(key);
  if (inflight) return inflight;
  const run = ensureDevServerLaunch(handle, options).finally(() => {
    launching.delete(key);
  });
  launching.set(key, run);
  return run;
}

async function ensureDevServerLaunch(
  handle: WorktreeHandle,
  options: { restart?: boolean } = {},
): Promise<DevPreview> {
  const provider = getSandboxProvider();
  const ctx = await ensureBox(handle);
  const appDir = `/home/user/app/${handle.appRoot}`;

  await provider.keepAlive(ctx, DEV_SESSION_KEEPALIVE_MS);

  // A requested RESTART must not be short-circuited by the idempotent
  // reuse below — that made the UI's Restart button a silent no-op. And it
  // must happen BEFORE the port allocation: the reap deletes this app's
  // registry entry, so reaping after allocating orphaned the fresh server
  // from the registry — every discovery (browse, dots, status) then swore
  // no server existed while vite served happily.
  if (options.restart) {
    logger.info("Apps dev server restart requested; stopping the old one", {
      appRoot: handle.appRoot,
    });
    await reapDevServerBySlug(provider, ctx, appSlug(handle));
  }

  const port = await devPort(handle, provider, ctx, { allocate: true });
  if (!port) throw new Error("Could not allocate a dev-server port");
  const logPath = devLogPath(handle);
  const launcher = launcherPath(handle);

  const state = await servingState(provider, ctx, handle, port);
  if (state === "orphan") {
    // An older-generation server holds the port without a session. Kill it
    // by its launcher paths (this app's, plus the pre-per-app global name)
    // — never by port pattern, other apps' servers are innocent.
    await provider.exec(
      ctx,
      `pkill -f "[m]ako-dev-${appSlug(handle)}.mjs" 2>/dev/null; pkill -f "[m]ako-dev-server.mjs" 2>/dev/null; sleep 1; echo reaped`,
      { timeoutMs: 30_000 },
    );
    logger.warn("Apps dev server orphan reaped", {
      projectId: handleProject(handle)._id.toString(),
      appRoot: handle.appRoot,
    });
  }
  // Still answering after the reap means the server is not ours to kill —
  // someone started it from a shell (npm run dev). Adopt it: show it, do
  // not launch a second vite into the same port.
  let adopted = state === "orphan" && (await listening(provider, ctx, port));
  if (adopted) {
    // Only adopt a server the browser can actually reach. A vite started
    // from a shell without `server.allowedHosts` 403s the preview host;
    // "restart" of such a server means exactly this: replace it with one
    // that Mako runs. Kill by port — the launcher-path reap cannot see it.
    const url = await provider.publicUrlForPort(ctx, port);
    if (await probeReachable(url)) {
      logger.info("Apps adopting a dev server started outside Mako", {
        appRoot: handle.appRoot,
        port,
      });
    } else {
      logger.warn("Apps replacing a dev server that rejects the preview host", {
        appRoot: handle.appRoot,
        port,
      });
      await provider.exec(
        ctx,
        `pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill "$pid" 2>/dev/null; sleep 1; echo replaced`,
        { timeoutMs: 30_000 },
      );
      adopted = false;
    }
  }
  const wasListening = state === "serving" || adopted;
  let evicted: string[] = [];
  if (!wasListening) {
    // Make room BEFORE launching: never let this box exceed the running cap.
    evicted = await enforceRunningCap(provider, ctx, appSlug(handle));
    // The app's own env vars (env.service), applied at LAUNCH: dtach → script
    // → node → vite inherit them, so `VITE_*` reaches import.meta.env and the
    // rest reaches the dev-server process. dev target = secrets included;
    // this launch env is the only place a secret ever exists in the box.
    // Edits made while a server runs apply on its next (re)start.
    let appEnv: Record<string, string> = {};
    try {
      appEnv = await resolveAppEnv(handleProject(handle), "dev");
    } catch (error) {
      // A missing vault must not take dev mode down with it.
      logger.warn("Apps env resolution failed; launching without app env", {
        appRoot: handle.appRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const write = await provider.exec(
      ctx,
      `cat > ${launcher} <<'MAKO_LAUNCHER_EOF'\n${launcherSource(appDir, port, dataDir(handle), appSlug(handle), boxEnvPath(ctx))}\nMAKO_LAUNCHER_EOF\necho written`,
      { timeoutMs: 30_000 },
    );
    if (write.exitCode !== 0) {
      throw new Error(
        `Could not write the dev-server launcher: ${write.stderr}`,
      );
    }

    // The dev server is a SESSION the workbench attaches to like any shell:
    // dtach -n creates it headless on the standard socket, script(1) gives
    // vite a REAL PTY (so it prints colors) and records everything to the
    // same file the install step teed into — one recording holds the whole
    // boot, and the dev terminal's prefill replays it. Ctrl-C typed in the
    // attached window reaches vite and ends the session; the stale-socket
    // rm covers a SIGKILLed predecessor. Fallbacks: tmux (headless, no
    // attach UI), then plain nohup.
    const devSock = devSockPath(handle);
    const devSession = `mako-dev-${appSlug(handle)}`;
    const launchCmd =
      // The stale-socket rm is guarded: rm ONLY when no dtach master holds
      // the socket. Two racing launches used to both pass the serving check,
      // and the loser's unconditional rm unlinked the WINNER's socket before
      // crashing on the busy port — leaving a healthy server that discovery
      // reported as down forever. With the guard, the loser's dtach -n just
      // fails against the existing socket and the winner is untouched.
      `if command -v dtach >/dev/null && command -v script >/dev/null; then if ! pgrep -f "dtach -n ${devSock}" >/dev/null 2>&1; then rm -f ${devSock}; fi; dtach -n ${devSock} script -qfa -c 'node ${launcher} 2>&1' ${logPath} || true; ` +
      `elif command -v tmux >/dev/null; then tmux new-session -d -s ${devSession} 'node ${launcher} 2>&1 | tee -a ${logPath}' 2>/dev/null || true; ` +
      `else nohup node ${launcher} >> ${logPath} 2>&1 & fi; echo started`;
    try {
      await provider.execDetached(ctx, launchCmd, {
        cwd: handle.appRoot,
        timeoutMs: 60_000,
        env: appEnv,
      });
    } catch (error) {
      if (!isMissingCwd(error)) throw error;
      // A recycle swapped machines under this request; hydrate and retry.
      await rehydrateBox(handle, ctx);
      await provider.execDetached(ctx, launchCmd, {
        cwd: handle.appRoot,
        timeoutMs: 60_000,
        env: appEnv,
      });
    }

    // Vite is usually listening within seconds, but a cold boot on E2B can
    // take over a minute (cold ESM import of vite off microVM disk, plus the
    // polling watcher's initial scan) — and a window that gives up early
    // 500s the request while the server comes up fine moments later. Poll
    // with a real pause, generously, and surface the log if it truly dies.
    let up = false;
    for (let attempt = 0; attempt < 45 && !up; attempt++) {
      up = await listening(provider, ctx, port);
      if (!up) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!up) {
      const log = await provider.exec(ctx, `tail -20 ${logPath}`, {
        timeoutMs: 15_000,
      });
      throw new Error(
        `Dev server did not start. Vite output:\n${log.stdout.slice(-1500)}`,
      );
    }
  }

  // Refresh staged data on every call, so re-materializing a binding and
  // hitting preview again picks up the new rows without a restart. On a
  // REATTACH, though, the previous staging is still on disk and almost
  // always current — restage in the background instead of adding seconds
  // of exec round-trips to a page reload that should feel instant.
  let stagedBindings: string[] = [];
  if (wasListening) {
    void stageBindingData(handle, provider, ctx).catch(error => {
      logger.warn("Apps background binding restage failed", {
        projectId: handleProject(handle)._id.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    stagedBindings = await stageBindingData(handle, provider, ctx);
  }

  const url = await provider.publicUrlForPort(ctx, port);
  logger.info("Apps dev preview ready", {
    projectId: handleProject(handle)._id.toString(),
    appRoot: handle.appRoot,
    stagedBindings,
    ...(evicted.length ? { evicted } : {}),
  });
  return { url, stagedBindings, ...(evicted.length ? { evicted } : {}) };
}
