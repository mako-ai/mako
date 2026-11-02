#!/usr/bin/env node
// Real duckdb-wasm 1.29.0 in headless Chromium, driving real useDuckDB hooks
// over synthetic 23-column parquet shards. Never opens a visible window. Not
// part of `node --test`: it needs a browser, the CDN and several GiB of RAM.
//
//   node test-support/real-engine/measure.mjs <scenario> [--sdk dir] [--rows n] [--shards n]
//
// Scenarios: sequence (A then B, A+B over the heap), race (B while A is in
// flight), overlarge (one pinned set over the heap), failedfetch, recover (a full
// heap frees later), flip, speed, plus engine probes: calibrate, probe, blob,
// pointer, catalog. --sdk points at another SDK checkout, to compare.
// One JSON line per checkpoint on stdout.
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "../..");
const repo = path.resolve(pkg, "../..");
const args = process.argv.slice(2);
const scenario = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sdkDir = path.resolve(opt("sdk", pkg));
const cacheDir = opt("cache", path.join(os.tmpdir(), "mako-duckdb-parquets"));
fs.mkdirSync(cacheDir, { recursive: true });

function fromPnpm(name) {
  const root = path.join(repo, "node_modules/.pnpm");
  const dir = fs.readdirSync(root).filter(d => d.startsWith(name + "@")).sort().pop();
  if (!dir) throw new Error(name + " not found: run pnpm install at the repo root");
  return createRequire(path.join(root, dir, "node_modules", name, "package.json"))(path.join(root, dir, "node_modules", name));
}
const esbuild = fromPnpm("esbuild");
const { chromium } = fromPnpm("playwright-core");

const built = await esbuild.build({
  entryPoints: [path.join(here, "page.mjs")],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  external: ["https://*"],
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    SDK_UNDER_TEST: path.join(sdkDir, "index.js"),
    react: path.join(pkg, "node_modules/react"),
    "react-dom/client": path.join(pkg, "node_modules/react-dom/client.js"),
  },
  logLevel: "error",
});
const bundle = built.outputFiles[0].text;

// ---- the app server: page, bundle, __data/ (with an injectable failure) -----
const served = new Map(); // shard name -> downloads
const failOnce = new Map(); // shard name -> downloads left to fail
const index = () => fs.readdirSync(cacheDir).filter(f => f.endsWith(".parquet")).map(f => f.slice(0, -8));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><div id="root"></div><script type="module" src="/bundle.js"></script>');
  } else if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle);
  } else if (url.pathname === "/__data/index.json") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(index()));
  } else if (url.pathname.startsWith("/__store/")) {
    const out = fs.createWriteStream(path.join(cacheDir, url.pathname.slice(9) + ".parquet"));
    req.pipe(out).on("finish", () => res.end("ok"));
  } else if (url.pathname.startsWith("/__data/") && url.pathname.endsWith(".parquet")) {
    const name = decodeURIComponent(url.pathname.slice(8, -8));
    served.set(name, (served.get(name) ?? 0) + 1);
    if (failOnce.get(name) > 0) {
      failOnce.set(name, failOnce.get(name) - 1);
      req.socket.destroy(); // the browser reports TypeError: Failed to fetch
      return;
    }
    const file = path.join(cacheDir, name + ".parquet");
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    res.setHeader("content-length", fs.statSync(file).size);
    fs.createReadStream(file).pipe(res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port + "/";

// ---- the browser ------------------------------------------------------------
const browserServer = await chromium.launchServer({ headless: true, args: ["--js-flags=--max-old-space-size=8192"] });
const browser = await chromium.connect(browserServer.wsEndpoint());
const rootPid = browserServer.process().pid;
function maxRssMiB() {
  const rows = execSync("ps -axo pid=,ppid=,rss=").toString().trim().split("\n").map(l => l.trim().split(/\s+/).map(Number));
  const inTree = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of rows) if (inTree.has(ppid) && !inTree.has(pid)) { inTree.add(pid); grew = true; }
  }
  return Math.round(Math.max(...rows.filter(r => inTree.has(r[0])).map(r => r[2])) / 1024);
}
async function newPage() {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", e => console.error("pageerror", e.message));
  page.on("console", m => {
    if (m.type() !== "log" && !/favicon|404/.test(m.text())) console.error(m.type(), m.text().slice(0, 300));
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.H);
  return page;
}

// ---- synthetic shards -------------------------------------------------------
// 23 columns, the shape of the Web Performance marts: time, 12 text, 10 ints.
const DAY = 86400000;
const shardSql = (k, rows) => `select
  ${1761955200000 - k * DAY} + (i * ${DAY} // ${rows}) as t,
  'zone-' || (i * 7 % 9) as zone, 'app-' || (i * 11 % 17) as app,
  '/route/group/' || (i * 13 % 211) as route_group, 'kind-' || (i * 17 % 6) as request_kind,
  'traffic-' || (i * 19 % 8) as traffic, 'origin-' || (i * 23 % 12) as origin,
  'bucket-' || (i * 29 % 40) as latency_bucket, 'country-' || (i * 31 % 90) as country,
  'device-' || (i * 37 % 5) as device, 'browser-name-' || (i * 41 % 30) as browser,
  'https://example.com/a/rather/long/path/' || (i * 43 % 50021) as url,
  'status-' || (i * 47 % 25) as status,
  (i * 53 % 1009)::BIGINT as requests, (i * 59 % 1013)::BIGINT as cache_hits,
  (i * 61 % 1019)::BIGINT as cache_status_requests, (i * 67 % 53)::BIGINT as errors_5xx,
  (i * 71 % 59)::BIGINT as not_found_404, (i * 73 % 61)::BIGINT as over_3s,
  (i * 79 % 67)::BIGINT as over_30s, (i * 83 % 71)::BIGINT as aborted_499,
  (i * 89 % 100003)::BIGINT as bytes_out, (i * 97 % 100019)::BIGINT as ms_total
from range(${rows}) r(i)`;

async function ensureShards(names, rows) {
  const tag = "r" + rows;
  const out = names.map(n => n + tag);
  const missing = out.filter(n => !fs.existsSync(path.join(cacheDir, n + ".parquet")));
  if (missing.length) {
    const page = await newPage();
    for (const n of missing) {
      const k = Number(/(\d+)r\d+$/.exec(n)[1]);
      await page.evaluate(([name, sql]) => window.H.generate(name, sql), [n, shardSql(k, rows)]);
    }
    await page.close();
  }
  return out;
}

// The dedupe the app's query does: a row in a newer shard's time span loses.
const source = names => `(with u as (${names.map((n, k) => `select *, ${k} as _shard from "${n}"`).join(" union all ")}),
  r as (select _shard, min(t) as mn, max(t) as mx from u group by _shard)
  select * exclude (_shard) from u where not exists (select 1 from r where r._shard < u._shard and u.t between r.mn and r.mx))`;

// Eight panels, as Web Performance's Web page mounts. All aggregates.
const panelsOver = names => {
  const s = source(names);
  return [
    `select t // 3600000 as h, sum(requests)::double r, sum(errors_5xx)::double e from ${s} group by 1 order by 1`,
    `select t // 86400000 as d, quantile_cont(ms_total, 0.75) p75, sum(requests)::double r from ${s} group by 1`,
    `select t // 3600000 as h, origin, sum(requests)::double r from ${s} group by all order by 1`,
    `select t // 3600000 as h, zone, sum(cache_hits)::double / nullif(sum(cache_status_requests), 0) hit from ${s} group by all`,
    `select route_group, sum(requests)::double r, approx_quantile(ms_total, 0.95) p95 from ${s} group by 1 order by 2 desc limit 50`,
    `select url, sum(requests)::double r, sum(bytes_out)::double b from ${s} group by 1 order by 2 desc limit 100`,
    `select traffic, request_kind, sum(requests)::double r from ${s} group by all`,
    `select max(t) mx, count(*)::double n from ${s}`,
  ];
};

const log = o => console.log(JSON.stringify({ sdk: path.basename(path.dirname(sdkDir)) === "packages" ? "worktree" : sdkDir.split("/").at(-3), ...o }));

async function settle(page, label, timeoutMs = 240000) {
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 300)); // the effect that resets `loading`
  let states = [];
  let timedOut = false;
  for (;;) {
    let crashed = null;
    states = await page.evaluate(() => window.H.panels()).catch(e => ((crashed = e), []));
    if (crashed) {
      log({ at: label, crashed: String(crashed.message).slice(0, 200), ms: Date.now() - t0 });
      return { crashed: true };
    }
    if (states.length && states.every(s => !s.loading)) break;
    if (Date.now() - t0 > timeoutMs) {
      timedOut = true;
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const ms = Date.now() - t0;
  const errors = states.filter(s => s.error);
  const memory = await page.evaluate(() => window.H.memory()).catch(e => ({ failed: String(e.message) }));
  const out = {
    at: label,
    ms,
    timedOut,
    ok: states.filter(s => !s.loading && !s.error).length,
    errored: errors.length,
    loading: states.filter(s => s.loading).length,
    firstError: errors[0]?.error?.slice(0, 160) ?? null,
    lastPanel: states.at(-1)?.first ?? null,
    memoryFailed: memory.failed?.slice(0, 200),
    heldMiB: memory.heldMiB,
    tables: memory.tables,
    views: memory.views,
    pinned: memory.pinned,
    pressure: memory.pressure,
    tags: memory.tags,
    rendererRssMiB: maxRssMiB(),
  };
  log(out);
  return out;
}

const names = (prefix, n) => Array.from({ length: n }, (_, k) => prefix + k);
const ROWS = Number(opt("rows", 400000));
const SHARDS = Number(opt("shards", 15));

try {
  if (scenario === "calibrate") {
    const [n] = await ensureShards(["cal0"], ROWS);
    const page = await newPage();
    await page.evaluate(sql => window.H.mount([sql]), `select count(*) from "${n}"`);
    await settle(page, "one shard, " + ROWS + " rows, parquet " + Math.round(fs.statSync(path.join(cacheDir, n + ".parquet")).size / 1048576) + " MiB");
    for (const sql of panelsOver([n])) {
      const r = await page.evaluate(q => window.H.sql(q), sql);
      log({ at: "panel over one table", ms: r.ms, error: r.error });
    }
  } else if (scenario === "sequence") {
    const a = await ensureShards(names("a", SHARDS), ROWS);
    const b = await ensureShards(names("b", SHARDS), ROWS);
    const page = await newPage();
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(a));
    const first = await settle(page, "A settled (" + SHARDS + " shards x " + ROWS + " rows)");
    if (!first.crashed) {
      await page.evaluate(sqls => window.H.setSqls(sqls), panelsOver(b));
      const second = await settle(page, "A -> B settled");
      if (!second.crashed) {
        await page.evaluate(sqls => window.H.setSqls(sqls), panelsOver(a));
        await settle(page, "B -> A settled");
      }
    }
  } else if (scenario === "probe") {
    // What the engine does when its heap is full, with no SDK logic in the way.
    const c = await ensureShards(names("c", 30), ROWS);
    const page = await newPage();
    const held = async at => {
      const m = await page.evaluate(() => window.H.memory());
      log({ at, heldMiB: m.heldMiB, tags: m.tags, tables: m.tables, rssMiB: maxRssMiB() });
    };
    const q = (sql, at) => page.evaluate(x => window.H.sql(x), sql).then(r => (log({ at, ...r, error: r.error?.slice(0, 200) }), r));
    const url = n => "/__data/" + n + ".parquet";
    await held("empty");
    let filled = 0;
    for (const n of c) {
      const f = await page.evaluate(([a, b]) => window.H.fileBufferFromUrl(a, b), ["buf-" + n, url(n)]);
      if (f.error) log({ at: "registerFileBuffer " + n, error: f.error.slice(0, 200) });
      const r = await page.evaluate(x => window.H.sql(x), `create table "${n}" as select * from read_parquet('buf-${n}')`);
      await page.evaluate(() => 0);
      if (r.error) {
        log({ at: "CTAS " + n + " failed after " + filled + " tables", error: r.error.slice(0, 200) });
        break;
      }
      filled++;
    }
    await held("after filling");
    await q(`select count(*) from read_parquet('buf-${c[29]}')`, "read a registered buffer, heap full");
    const blob = await page.evaluate(([a, b]) => window.H.fileHandleFromUrl(a, b), ["blob-1", url(c[29])]);
    log({ at: "registerFileHandle, heap full", ...blob });
    await q(`select count(*) from read_parquet('blob-1')`, "read a Blob, heap full");
    await q(`select url, sum(requests) from read_parquet('blob-1') group by 1`, "aggregate a Blob, heap full");
    const fresh = await page.evaluate(([a, b]) => window.H.fileBufferFromUrl(a, b), ["buf-after", url(c[28])]);
    log({ at: "registerFileBuffer, heap full", ...fresh, error: fresh.error?.slice(0, 200) });
    await q(`select count(*) from read_parquet('buf-after')`, "read that buffer, heap full");
    await held("after failed reads: scratch of the failed queries");
    for (let k = 0; k < filled; k++) await page.evaluate(x => window.H.sql(x), `drop table "${c[k]}"`);
    await held("after dropping every table");
    for (let cycle = 1; cycle <= 3; cycle++) {
      let n = 0;
      for (const name of c.slice(0, filled)) {
        const r = await page.evaluate(x => window.H.sql(x), `create table "${name}" as select * from read_parquet('blob-1')`);
        if (r.error) {
          log({ at: "cycle " + cycle + " CTAS failed after " + n, error: r.error.slice(0, 200) });
          break;
        }
        n++;
      }
      await held("cycle " + cycle + " refilled " + n + " tables");
      for (let k = 0; k < n; k++) await page.evaluate(x => window.H.sql(x), `drop table "${c[k]}"`);
      await held("cycle " + cycle + " dropped");
    }
    const big = await page.evaluate(x => window.H.sql(x), `select url, sum(requests) r from read_parquet('blob-1') group by 1`);
    log({ at: "aggregate after 3 cycles", ...big, first: undefined });
  } else if (scenario === "blob") {
    // A view over a Blob: empty heap, then a full heap, then freed.
    const c = await ensureShards(names("c", 30), ROWS);
    const page = await newPage();
    const url = n => "/__data/" + n + ".parquet";
    const reg = f => page.evaluate(([a, b]) => window.H.fileHandleFromUrl(a, b), [f, url(c[29])]);
    const q = (sql, at) => page.evaluate(x => window.H.sql(x), sql).then(r => (log({ at, ms: r.ms, error: r.error?.slice(0, 160) }), r));
    await reg("empty.parquet");
    await q("select count(*) from read_parquet('empty.parquet')", "Blob registered and read on an empty heap");
    await q("create view v_empty as select * from read_parquet('empty.parquet')", "view on an empty heap");
    await page.evaluate(([a, b]) => window.H.fileHandleFromUrl(a, b), ["fetched-blob", url(c[28])]);
    await q("select count(*) from read_parquet('fetched-blob')", "no .parquet suffix, empty heap");
    let filled = 0;
    const fillTo = Number(opt("fill", 30));
    for (const n of c.slice(0, fillTo)) {
      await page.evaluate(([a, b]) => window.H.fileBufferFromUrl(a, b), ["b-" + n, url(n)]);
      const r = await page.evaluate(x => window.H.sql(x), `create table "${n}" as select * from read_parquet('b-${n}')`);
      await page.evaluate(x => window.H.drop(x), "b-" + n);
      if (r.error) break;
      filled++;
    }
    log({ at: "filled", tables: filled, rssMiB: maxRssMiB() });
    await q("select count(*) from v_empty", "the old view, heap full");
    await reg("full.parquet");
    await q("select count(*) from read_parquet('full.parquet')", "new Blob read, heap full");
    await q("select count(*) from read_parquet('full.parquet')", "same Blob again, heap full");
    for (let k = 0; k < 12; k++) await page.evaluate(x => window.H.sql(x), `drop table "${c[k]}"`);
    log({ at: "dropped 12 tables" });
    await q("select count(*) from read_parquet('full.parquet')", "same Blob, heap half free");
    await reg("freed.parquet");
    await q("select count(*) from read_parquet('freed.parquet')", "new Blob, heap half free");
    await q("select count(*) from v_empty", "old view, heap half free");
  } else if (scenario === "pointer") {
    // Why a Blob read says "too small": log what openFile returns in the worker.
    const c = await ensureShards(names("c", 30), ROWS);
    const page = await newPage();
    const url = n => "/__data/" + n + ".parquet";
    await page.evaluate(() => window.H.sql("select 1"));
    const worker = page.workers().at(-1);
    await worker.evaluate(() => {
      const rt = globalThis.DUCKDB_RUNTIME;
      const open = rt.openFile;
      globalThis.__opens = [];
      rt.openFile = (mod, id, flags) => {
        const p = open(mod, id, flags);
        globalThis.__opens.push({ p, size: p ? mod.HEAPF64[p / 8] : null, heapMiB: Math.round(mod.HEAPU8.length / 1048576) });
        return p;
      };
    });
    const fill = Number(opt("fill", 22));
    for (const n of c.slice(0, fill)) {
      await page.evaluate(([a, b]) => window.H.fileBufferFromUrl(a, b), ["b-" + n, url(n)]);
      await page.evaluate(x => window.H.sql(x), `create table "${n}" as select * from read_parquet('b-${n}')`);
      await page.evaluate(x => window.H.drop(x), "b-" + n);
    }
    log({ at: "filled", tables: fill, rssMiB: maxRssMiB() });
    await worker.evaluate(() => (globalThis.__opens.length = 0));
    let failed = 0;
    for (let k = 0; k < 8; k++) {
      await page.evaluate(([a, b]) => window.H.fileHandleFromUrl(a, b), ["blob" + k + ".parquet", url(c[29])]);
      const r = await page.evaluate(x => window.H.sql(x), `select url, sum(requests) from read_parquet('blob${k}.parquet') group by 1`);
      if (r.error) failed++;
      log({ at: "Blob " + k, ms: r.ms, error: r.error?.slice(0, 80) });
    }
    log({ at: "openFile returned", blobFailures: failed, opens: await worker.evaluate(() => globalThis.__opens) });
    let bufferFailed = 0;
    for (let k = 0; k < 8; k++) {
      await page.evaluate(([a, b]) => window.H.fileBufferFromUrl(a, b), ["buf" + k + ".parquet", url(c[29])]);
      const r = await page.evaluate(x => window.H.sql(x), `select url, sum(requests), max(t), count(*) from read_parquet('buf${k}.parquet') group by 1 order by 1 limit 1`);
      if (r.error) bufferFailed++;
      log({ at: "Buffer " + k, ms: r.ms, first: r.first, error: r.error?.slice(0, 80) });
    }
    log({ at: "buffer reads", bufferFailures: bufferFailed });
  } else if (scenario === "catalog") {
    // No SDK loads, no parquet: how many tables can the catalog hold?
    const page = await newPage();
    for (let n = 1; n <= Number(opt("max", 130)); n++) {
      const made = await page.evaluate(x => window.H.sql(x), "create table t" + n + " as select 1 x");
      if (made.error) { log({ at: "create " + n, error: made.error.slice(0, 120) }); break; }
      if (n % 10) continue;
      const r = await page.evaluate(() => window.H.sql("select count(*) from duckdb_tables()"));
      const q = await page.evaluate(x => window.H.sql(x), "select x from t" + n);
      log({ at: n + " tables", catalog: r.error?.slice(0, 80) ?? "ok", read: q.error?.slice(0, 80) ?? "ok" });
    }
  } else if (scenario === "race") {
    // The range changes while A's loads or queries are still in flight, so
    // A's pins are still held when B's loads need the space.
    const delay = Number(opt("delay", 3000));
    const a = await ensureShards(names("a", SHARDS), ROWS);
    const b = await ensureShards(names("b", SHARDS), ROWS);
    const page = await newPage();
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(a));
    await new Promise(r => setTimeout(r, delay));
    log({ at: "changing to B after " + delay + " ms", panelsOpen: (await page.evaluate(() => window.H.panels())).filter(p => p.loading).length });
    await page.evaluate(sqls => window.H.setSqls(sqls), panelsOver(b));
    const second = await settle(page, "A -> B settled");
    if (!second.crashed) {
      await page.evaluate(() => new Promise(r => setTimeout(r, 30000)));
      await settle(page, "30 s later, with no input");
    }
  } else if (scenario === "speed") {
    // The same 8 panels over 15 shards: all tables, then all views.
    const a = await ensureShards(names("a", SHARDS), ROWS);
    const page = await newPage();
    const run = async at => {
      const times = [];
      for (const sql of panelsOver(a)) {
        const r = await page.evaluate(q => window.H.sql(q), sql);
        times.push(r.error ? "OOM" : r.ms);
      }
      log({ at, panelMs: times, totalMs: times.reduce((x, y) => x + (y === "OOM" ? 0 : y), 0), rssMiB: maxRssMiB() });
    };
    await page.evaluate(() => window.H.setBudget(1e12, 1e12));
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(a));
    await settle(page, "tables loaded");
    await run("tables");
    await run("tables again");
    await page.evaluate(() => window.H.setBudget(1, 1e12));
    await page.evaluate(() => window.H.unmount());
    await page.evaluate(() => window.H.setBudget(1, 1e12));
    log({ at: "memory", ...(await page.evaluate(() => window.H.memory())) });
    await run("views over heap buffers");
    await run("views again");
  } else if (scenario === "recover") {
    // The SDK cannot see this table, so it cannot free it: every panel stays on
    // Out of Memory until something else drops it.
    const a = await ensureShards(names("a", 4), ROWS);
    const page = await newPage();
    await page.evaluate(() => window.H.setBudget(1, 1e12));
    const filler = "select i, repeat('x', 40) || i as s, i * 2 as a, i * 3 as b from range(1000000) r(i)";
    await page.evaluate(x => window.H.sql(x), "create table junk as " + filler);
    for (let n = 0; n < 200; n++) {
      const r = await page.evaluate(x => window.H.sql(x), "insert into junk " + filler);
      if (r.error) break;
    }
    log({ at: "junk table filled the heap", ...(await page.evaluate(() => window.H.memory())), tags: undefined });
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(a));
    const stuck = await settle(page, "panels over a full heap");
    await page.evaluate(() => window.H.sql("drop table junk"));
    const t0 = Date.now();
    for (;;) {
      const st = await page.evaluate(() => window.H.panels());
      if (st.every(s => !s.error && !s.loading) || Date.now() - t0 > 90000) break;
      await new Promise(r => setTimeout(r, 250));
    }
    await settle(page, "after the junk table dropped, recovered in " + (Date.now() - t0) + " ms, had errors: " + stuck.errored);
  } else if (scenario === "flip") {
    // Range changes faster than anything settles, then a read after pressure lifts.
    const a = await ensureShards(names("c", SHARDS), ROWS);
    const b = await ensureShards(names("c", SHARDS).map((n, i) => "c" + (SHARDS + i)), ROWS);
    const page = await newPage();
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(a));
    for (let k = 0; k < 6; k++) {
      await new Promise(r => setTimeout(r, 700));
      await page.evaluate(sqls => window.H.setSqls(sqls), panelsOver(k % 2 ? a : b));
    }
    await settle(page, "after 6 flips");
    for (let k = 0; k < 4; k++) {
      await page.evaluate(sqls => window.H.setSqls(sqls), panelsOver(k % 2 ? a : b));
      await settle(page, "settled flip " + k);
    }
    await page.evaluate(sqls => window.H.setSqls(sqls), panelsOver([...a, ...b]));
    await settle(page, "union of both, over the heap");
    await page.evaluate(() => new Promise(r => setTimeout(r, 62000)));
    await page.evaluate(sqls => window.H.setSqls(sqls.map(s => s + " -- again")), panelsOver([...a, ...b]));
    await settle(page, "same set after pressure lifted");
  } else if (scenario === "overlarge") {
    const c = await ensureShards(names("c", SHARDS), ROWS);
    const page = await newPage();
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(c));
    const first = await settle(page, "over-large set settled (" + SHARDS + " shards x " + ROWS + " rows)", 480000);
    if (args.includes("--diag")) {
      for (const q of ["select 1", "select count(*) from duckdb_tables()", "select count(*) from duckdb_views()", "select count(*) from duckdb_memory()", 'select count(*) from "c0r' + ROWS + '"', 'select count(*) from "c59r' + ROWS + '"', 'select count(*), max(t) from "c59r' + ROWS + '"']) {
        const r = await page.evaluate(x => window.H.sql(x), q);
        log({ at: q, ms: r.ms, first: r.first, error: r.error?.slice(0, 160) });
      }
      const info = await page.evaluate(() => window.H.bindings());
      log({ at: "bindings", storage: info });
      for (let n = 10; n <= 60; n += 10) {
        const r = await page.evaluate(x => window.H.sql(x), "select count(*) from " + source(c.slice(0, n)));
        log({ at: "union of " + n, ms: r.ms, first: r.first, error: r.error?.slice(0, 120) });
      }
    }
    if (!first.crashed) {
      await page.evaluate(() => new Promise(r => setTimeout(r, 60000)));
      await settle(page, "60 s later");
    }
  } else if (scenario === "failedfetch") {
    const a = await ensureShards(names("f", 4), 50000);
    failOnce.set(a[2], Number(opt("fails", 1)));
    const page = await newPage();
    await page.evaluate(sqls => window.H.mount(sqls), panelsOver(a).slice(0, 3));
    await settle(page, "first load with one failed shard");
    await page.evaluate(() => new Promise(r => setTimeout(r, 35000)));
    await settle(page, "35 s later, with no input");
    log({ at: "downloads", failed: a[2], count: served.get(a[2]) ?? 0 });
  } else {
    throw new Error("unknown scenario " + scenario);
  }
} finally {
  await browser.close().catch(() => {});
  await browserServer.close().catch(() => {});
  server.close();
}
process.exit(0);
