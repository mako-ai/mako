/**
 * The launcher a dev session runs: vite through its JS API, plus the
 * `makoData` / `makoEyes` plugins and the box's reports to Mako.
 */

/**
 * Node launcher, run inside the sandbox. Uses Vite's JS API because inline
 * `server` options there beat the app's config file; the CLI has no flag for
 * `allowedHosts`, and editing the app's `vite.config.ts` to add one would be
 * committing our infrastructure into the user's repository.
 *
 * `.e2b.app` is matched as a suffix, so it covers the sandbox's own origin
 * without our having to know the sandbox id at write time.
 */
export function launcherSource(
  appDir: string,
  port: number,
  stagedDataDir: string,
  slug: string,
  boxEnv: string,
  appEnv: Record<string, string>,
): string {
  return `
import { createServer } from "${appDir}/node_modules/vite/dist/node/index.js";
import { appendFileSync, createReadStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// The app's env vault (env.service, dev tier — secrets included), baked into
// the launcher rather than inherited: inheritance survives dtach and nohup
// but NOT the tmux fallback, whose sessions take the tmux server's
// environment instead of the client's. Assigned before createServer() runs,
// so Vite's env resolution sees it and VITE_* reaches import.meta.env.
Object.assign(process.env, ${JSON.stringify(appEnv)});

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
// Replace a staged parquet whole (write aside, then rename): a reader gets the
// old bytes or the new, never a half-written file. Mako's own restaging does
// the same (stageFileAtomically); the suffixes differ so they never collide.
function stageParquet(name, buf) {
  const file = path.join(${JSON.stringify(stagedDataDir)}, name + ".parquet");
  // A new build has no snapshot here: drop the old one BEFORE the parquet
  // moves, so no instant sees the old preview beside the new data.
  rmSync(path.join(${JSON.stringify(stagedDataDir)}, name + ".snapshot.json"), { force: true });
  writeFileSync(file + ".writing", buf);
  renameSync(file + ".writing", file);
  rmSync(path.join(${JSON.stringify(stagedDataDir)}, name + ".live"), { force: true });
}

// Did the page ask for phase events (binding-progress.ts) instead of a
// plain answer? The SDK sends Accept: application/x-ndjson from 2.7.4.
function wantsProgress(req) {
  return String(req.headers.accept || "")
    .split(",")
    .some(part => part.split(";")[0].trim().toLowerCase() === "application/x-ndjson");
}
// Start a phase stream on this response; returns the line writer.
function progressStream(res) {
  const started = Date.now();
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-store, no-transform");
  res.setHeader("x-accel-buffering", "no");
  return event => {
    try {
      res.write(JSON.stringify({ ...event, elapsedMs: Date.now() - started }) + "\\n");
    } catch {}
  };
}

const LIVE_STREAM = "application/vnd.mako.live-binding-stream";
// Ask Mako to build a binding now. Mako answers phase lines first, then a
// "ready" line with the byte count, then the parquet itself; an API that
// predates that answers the parquet alone, which works the same minus the
// phases. Rejects with { status, retryAfterMs } on a refused or failed build.
async function liveBuild(name, persist, onPhase) {
  const env = makoEnv();
  const token = readFileSync(env.MAKO_TOKEN_FILE, "utf8").trim();
  const upstream = await fetch(
    env.MAKO_API + "/api/apps-box/" + env.MAKO_WS + "/live-binding",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: LIVE_STREAM,
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({ slug: ${JSON.stringify(slug)}, name, ...(persist ? { persist: true } : {}) }),
      // A materialized query can be slow (a heavy dashboard mart runs
      // for a minute); give it room rather than failing the table.
      // Longer than the API's own query ceiling (300s), deliberately:
      // when this was SHORTER, every binding taking 180-300s was
      // unsatisfiable through this path — the box abandoned a request
      // the API was still serving, so the answer could never arrive,
      // while the warehouse job it started ran on and billed. The
      // client must outlast the server it is waiting for, or it turns
      // slow into impossible.
      signal: AbortSignal.timeout(330000),
    },
  );
  const failure = (message, status, retryAfterMs) =>
    Object.assign(new Error(message), { status, ...(retryAfterMs ? { retryAfterMs } : {}) });
  if (!String(upstream.headers.get("content-type") || "").startsWith(LIVE_STREAM)) {
    if (!upstream.ok) {
      let detail = {};
      try { detail = await upstream.json(); } catch {}
      throw failure(detail.error || ("Live binding failed (HTTP " + upstream.status + ")"), upstream.status, detail.retryAfterMs);
    }
    return {
      buf: Buffer.from(await upstream.arrayBuffer()),
      rowCount: Number(upstream.headers.get("x-mako-row-count")) || 0,
      materializedAt: upstream.headers.get("x-mako-materialized-at"),
    };
  }
  const reader = upstream.body.getReader();
  let head = Buffer.alloc(0);
  let ready = null;
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ready) { parts.push(Buffer.from(value)); continue; }
    head = Buffer.concat([head, Buffer.from(value)]);
    let nl;
    while (!ready && (nl = head.indexOf(10)) !== -1) {
      const line = head.subarray(0, nl).toString("utf8").trim();
      head = head.subarray(nl + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.phase === "failed") {
        throw failure(event.error || "Live binding failed", event.status || 502, event.retryAfterMs);
      }
      if (event.phase === "ready") {
        ready = event;
        if (head.length) parts.push(head);
      } else if (onPhase) {
        onPhase(event);
      }
    }
  }
  if (!ready) throw failure("The build stream ended before the build did", 502);
  const buf = Buffer.concat(parts);
  if (typeof ready.bytes === "number" && buf.length !== ready.bytes) {
    throw failure("The parquet arrived short (" + buf.length + " of " + ready.bytes + " bytes)", 502);
  }
  return { buf, rowCount: ready.rowCount || 0, materializedAt: ready.materializedAt || null };
}

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
      // POST __data/<name>/refresh — the SDK's refresh(): re-run the binding
      // through Mako as a real materialization (artifact stored, run
      // recorded), and keep the fresh bytes as this box's staged copy so the
      // very next __data/<name>.parquet read serves them. Same upstream as a
      // live binding, with persist on. A page that sent
      // Accept: application/x-ndjson hears each phase as it happens
      // (binding-progress.ts); any other caller gets the JSON answer.
      const refresh = /^\\/__data\\/([A-Za-z0-9_][A-Za-z0-9_-]*)\\/refresh$/.exec(url);
      if (refresh) {
        if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
        const name = refresh[1];
        const emit = wantsProgress(req) ? progressStream(res) : null;
        const reply = (status, body) => {
          if (emit) {
            const ok = status >= 200 && status < 300;
            emit({ ...body, phase: ok ? "ready" : "failed", ...(ok ? {} : { status }) });
            return res.end();
          }
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(body));
        };
        if (emit) emit({ phase: "checking" });
        (async () => {
          try {
            const built = await liveBuild(name, true, emit);
            // Write-through, like the live path below: serve these bytes
            // until the next refresh rather than re-querying on every read.
            try {
              stageParquet(name, built.buf);
            } catch {}
            reply(200, {
              success: true,
              binding: name,
              materialization: built.materializedAt ? "parquet" : "live",
              rowCount: built.rowCount,
              byteSize: built.buf.length,
              ...(built.materializedAt ? { materializedAt: built.materializedAt } : {}),
            });
          } catch (error) {
            const status = error && error.status;
            if (!status) {
              return reply(502, { success: false, error: "Refresh failed: " + String(error && error.message) });
            }
            reply(status === 503 ? 429 : status === 404 ? 404 : 502, {
              success: false,
              error: error.message || ("Refresh failed (HTTP " + status + ")"),
              ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
            });
          }
        })();
        return;
      }
      const snapMatch = /^\\/__data\\/([A-Za-z0-9_][A-Za-z0-9_-]*)\\.snapshot\\.json$/.exec(url);
      if (snapMatch) {
        const snapFile = path.join(${JSON.stringify(stagedDataDir)}, snapMatch[1] + ".snapshot.json");
        // A live binding is queried fresh: no stored build, so no preview.
        const isLive = existsSync(path.join(${JSON.stringify(stagedDataDir)}, snapMatch[1] + ".live"));
        if (isLive || !existsSync(snapFile)) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Snapshot not available", binding: snapMatch[1] }));
          return;
        }
        const snapBuf = readFileSync(snapFile);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("content-length", String(snapBuf.length));
        res.setHeader("cache-control", "no-store");
        res.end(snapBuf);
        return;
      }
      const match = /^\\/__data\\/([A-Za-z0-9_][A-Za-z0-9_-]*)\\.parquet$/.exec(url);
      if (!match) return next();
      const name = match[1];
      // Live binding: query it fresh through Mako, stream the parquet back.
      // dev/edit only — the box token authorizes it as this box's actor.
      if (existsSync(path.join(${JSON.stringify(stagedDataDir)}, name + ".live"))) {
        // A page that asked for phases gets them, then a "ready" with no
        // url: the bytes are staged by then, so its plain re-GET of this
        // same path is served the file below without querying again.
        const emit = wantsProgress(req) ? progressStream(res) : null;
        const fail = (body) => {
          if (emit) {
            emit({ ...body, phase: "failed", status: 502 });
            return res.end();
          }
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (emit) emit({ phase: "checking" });
        (async () => {
          let built;
          try {
            built = await liveBuild(name, false, emit);
          } catch (error) {
            return fail(
              error && error.status
                ? { error: "Live binding failed", binding: name, status: error.status, detail: error.message }
                : { error: "Live binding failed", binding: name, detail: String(error && error.message) },
            );
          }
          // Write-through cache: keep this result as a static parquet and drop
          // the live marker, so the binding is queried at most ONCE per dev
          // session — the next fetch (and every re-open) serves the file, not
          // a fresh 60s query. A rebuild/re-stage overwrites it.
          try {
            stageParquet(name, built.buf);
          } catch {}
          if (emit) {
            emit({ phase: "ready", binding: name, rowCount: built.rowCount });
            return res.end();
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/vnd.apache.parquet");
          res.setHeader("content-length", String(built.buf.length));
          res.setHeader("cache-control", "no-store");
          res.end(built.buf);
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
      // Parquet readers need the length to locate the footer. One read, so
      // the length and the bytes come from the same file even when a
      // restage renames a new one into place between a stat and an open.
      const buf = readFileSync(file);
      res.statusCode = 200;
      res.setHeader("content-type", "application/vnd.apache.parquet");
      res.setHeader("content-length", String(buf.length));
      res.setHeader("cache-control", "no-store");
      res.end(buf);
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
