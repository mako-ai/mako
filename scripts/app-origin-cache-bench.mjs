// Second-load transfer bytes: today's opaque-origin app iframe vs a per-app
// origin iframe with allow-same-origin. Synthetic server that reproduces the
// headers Mako sends in each mode; real Chromium (Playwright's build, headless).
//
// usage: CHROMIUM_PATH=<chromium binary> node scripts/app-origin-cache-bench.mjs \
//          node_modules/.pnpm/playwright-core@<ver>/node_modules/playwright-core
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);

const PORT = 8099;
const APP_ID = "23d9b603172c133a8427e812";
const WASM = crypto.randomBytes(6 * 1024 * 1024); // duckdb-eh.wasm stand-in
const APP_JS_PAD = "x".repeat(200 * 1024); // the app bundle
const PARQUET = {
  a: crypto.randomBytes(3 * 1024 * 1024),
  b: crypto.randomBytes(3 * 1024 * 1024),
};
const ETAG = name => `"${name}-v1"`;

const stats = { bytes: 0, requests: 0, notModified: 0, cookieLeaks: [] };
let mode = "old";
let tokenCounter = 0;
let hourBucket = "bucket-1";

function send(res, status, headers, body = "") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  stats.bytes += buf.length;
  stats.requests += 1;
  if (status === 304) stats.notModified += 1;
  res.writeHead(status, { "Content-Length": buf.length, ...headers });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookie = req.headers.cookie || "";
  if (cookie.includes("mako_session") && host !== "app.mako.test") {
    stats.cookieLeaks.push(`${host}${url.pathname}`);
  }
  if (cookie.includes("mako_session") && url.pathname === "/api/whoami") {
    stats.cookieLeaks.push(`credentialed fetch to Mako from frame: ${host}`);
  }

  // Mako page
  if (host === "app.mako.test" && url.pathname === "/") {
    const token =
      mode === "old" ? `pub.${++tokenCounter}` : `pub.stable-${hourBucket}`;
    const src =
      mode === "old"
        ? `/api/apps-preview/${token}/`
        : `http://${APP_ID}.${mode === "samesite" ? "apps.mako.test" : "makoapps.test"}:${PORT}/api/apps-preview/${token}/`;
    const sandbox =
      "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" +
      (mode !== "old" ? " allow-same-origin" : "");
    return send(
      res,
      200,
      {
        "Content-Type": "text/html",
        "Set-Cookie": "mako_session=secret; Path=/; HttpOnly; SameSite=Lax",
      },
      `<!doctype html><title>mako</title><iframe id=f sandbox="${sandbox}" src="${src}"></iframe>
       <script>addEventListener("message", e => { if (e.data && e.data.done) document.title = "done:" + e.data.ok + ":" + e.origin; });</script>`,
    );
  }
  if (url.pathname === "/api/whoami") {
    return send(
      res,
      200,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      "{}",
    );
  }

  // App files (both hosts, under the token)
  const m = url.pathname.match(/^\/api\/apps-preview\/[^/]+\/(.*)$/);
  if (
    m &&
    (host === "app.mako.test" ||
      host === `${APP_ID}.makoapps.test` ||
      host === `${APP_ID}.apps.mako.test`)
  ) {
    const asset = m[1];
    const cache =
      mode === "old" ? "private, no-cache" : "private, max-age=3600, immutable";
    const common = {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cache,
    };
    if (asset === "") {
      return send(
        res,
        200,
        { ...common, "Content-Type": "text/html" },
        `<!doctype html><script type=module crossorigin src="./assets/app.js"></script>`,
      );
    }
    if (asset === "assets/app.js") {
      return send(
        res,
        200,
        { ...common, "Content-Type": "text/javascript" },
        `/*${APP_JS_PAD}*/
        const ok = [];
        const wasm = await fetch("http://cdn.jsdelivr.test:${PORT}/duckdb-eh.wasm");
        ok.push((await wasm.arrayBuffer()).byteLength);
        for (const n of ["a", "b"]) {
          const r = await fetch("__data/" + n + ".parquet");
          ok.push((await r.arrayBuffer()).byteLength);
        }
        try { await fetch("http://app.mako.test:${PORT}/api/whoami", { credentials: "include" }); } catch {}
        parent.postMessage({ done: true, ok: ok.join(",") }, "*");`,
      );
    }
    const d = asset.match(/^__data\/(\w+)\.parquet$/);
    if (d) {
      const signed =
        mode === "old"
          ? `Expires=${Date.now()}&Signature=${crypto.randomBytes(8).toString("hex")}`
          : `Expires=${hourBucket}&Signature=fixed`;
      return send(res, 302, {
        Location: `http://bucket.gcs.test:${PORT}/${d[1]}.parquet?${signed}`,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control":
          mode === "old" ? "private, no-store" : "private, max-age=600",
      });
    }
  }
  // jsDelivr stand-in
  if (host === "cdn.jsdelivr.test" && url.pathname === "/duckdb-eh.wasm") {
    return send(
      res,
      200,
      {
        "Content-Type": "application/wasm",
        "Cache-Control":
          "public, max-age=31536000, s-maxage=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
      WASM,
    );
  }
  // GCS stand-in: what a signed read of a non-public object answers.
  const g =
    host === "bucket.gcs.test" && url.pathname.match(/^\/(\w+)\.parquet$/);
  if (g) {
    const headers = {
      "Cache-Control": "private, max-age=0",
      ETag: ETAG(g[1]),
      "Access-Control-Allow-Origin": "*",
      Vary: "Origin",
    };
    if (req.headers["if-none-match"] === ETAG(g[1]))
      return send(res, 304, headers);
    return send(
      res,
      200,
      { ...headers, "Content-Type": "application/octet-stream" },
      PARQUET[g[1]],
    );
  }
  send(res, 404, {}, "nope");
});

await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: [`--host-resolver-rules=MAP *.test 127.0.0.1`],
});

async function run(which) {
  mode = which;
  const context = await browser.newContext();
  const page = await context.newPage();
  const loads = [];
  for (let i = 0; i < 2; i++) {
    stats.bytes = 0;
    stats.requests = 0;
    stats.notModified = 0;
    stats.cookieLeaks = [];
    await page.goto(`http://app.mako.test:${PORT}/`);
    await page.waitForFunction(() => document.title.startsWith("done"), null, {
      timeout: 30000,
    });
    loads.push({
      load: i + 1,
      title: await page.title(),
      ...structuredClone(stats),
    });
  }
  await context.close();
  return loads;
}

const results = {
  old: await run("old"),
  new: await run("new"),
  samesite: await run("samesite"),
};
await browser.close();
server.close();
for (const [name, loads] of Object.entries(results)) {
  for (const l of loads) {
    console.log(
      `${name.padEnd(8)} load ${l.load}: ${(l.bytes / 1048576).toFixed(2)} MiB served, ${l.requests} requests, ${l.notModified} x 304, cookie leaks: ${l.cookieLeaks.length ? l.cookieLeaks.join("; ") : "none"}, ${l.title}`,
    );
  }
}
