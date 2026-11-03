// Binding memory through mounted hooks (SDK 2.12): a hook pins what it reads,
// eviction takes the least recently read of the rest, a dropped binding
// downloads again on its next read, and a query that runs out of memory frees
// unpinned tables and runs again. React + jsdom with the fake DuckDB; skips
// where react, react-dom or jsdom is not installed (the publish job installs
// nothing; jsdom comes from the monorepo's app package).
import assert from "node:assert/strict";
import module, { createRequire } from "node:module";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const realTimeout = globalThis.setTimeout; // tests below speed the SDK's timers
const realDateNow = Date.now;
const here = path.dirname(fileURLToPath(import.meta.url));
let env = null;
let why = "";
try {
  if (typeof module.registerHooks !== "function") throw new Error("Node without module.registerHooks");
  const fake = new URL("./test-support/fake-duckdb.mjs", import.meta.url).href;
  module.registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm")) {
        return { url: fake, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const { JSDOM } = createRequire(path.join(here, "../../app/package.json"))("jsdom");
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "https://app.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const sdk = await import("./index.js");
  env = { React, createRoot, act: React.act, sdk, dom };
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
const opts = { skip: env ? false : "hooks not renderable here: " + why };
const duck = () => globalThis.__fakeDuck;

const calls = [];
globalThis.fetch = async url => {
  const u = String(url);
  calls.push(u);
  if (u === "__data/index.json") return new Response(JSON.stringify(["h_a", "h_b", "h_c", "h_d"]));
  return new Response(new Uint8Array([80, 65, 82, 49, 80, 65, 82, 49]), { status: 200, headers: { "content-length": "8" } });
};
const baseFetch = globalThis.fetch;
afterEach(() => {
  // A failed test must not leave the next one on a fake clock or a dead server.
  globalThis.fetch = baseFetch;
  globalThis.setTimeout = realTimeout;
  Date.now = realDateNow;
  if (duck()) {
    duck().oom = null;
    duck().oomTimes = 1;
    duck().crash = null;
  }
});
const downloads = name => calls.filter(u => u.startsWith("__data/" + name + ".parquet")).length;

let container = 0;
async function mount(hook) {
  const seen = [];
  function Probe() {
    seen.push(hook());
    return null;
  }
  const el = env.dom.window.document.createElement("div");
  el.id = "r" + ++container;
  env.dom.window.document.body.appendChild(el);
  const root = env.createRoot(el);
  await env.act(async () => root.render(env.React.createElement(Probe)));
  await settle();
  return { seen, unmount: () => env.act(async () => root.unmount()) };
}
const settle = () => env.act(() => new Promise(r => realTimeout(r, 60)));
async function until(test, ms = 1500) {
  const t0 = realDateNow();
  while (!test() && realDateNow() - t0 < ms) await env.act(() => new Promise(r => realTimeout(r, 10)));
  return test();
}
const storage = async () =>
  Object.fromEntries((await env.sdk.getBindingMemory()).bindings.map(b => [b.name, b.storage]));

const calledWith = sql => duck().sql.filter(q => q === sql).length;
// Short act scopes: React holds a timer's state update until its scope ends.
async function wait(ms) {
  const t0 = realDateNow();
  while (realDateNow() - t0 < ms) await env.act(() => new Promise(r => realTimeout(r, 10)));
}
async function clearAll(budget = 250) {
  for (const b of (await env.sdk.getBindingMemory()).bindings) await env.sdk.unloadBinding(b.name);
  duck().oom = null;
  duck().oomTimes = 1;
  await env.sdk.setBindingMemoryBudget(budget, { blobBytes: Infinity });
}

test("a pinned table stays; what does not fit lands as a view; unmounted goes first", opts, async () => {
  await env.sdk.getDuckDB();
  duck().tableBytes = 100;
  await clearAll(250);
  const a = await mount(() => env.sdk.useQuery("h_a"));
  assert.equal(a.seen.at(-1).loading, false);
  const b = await mount(() => env.sdk.useDuckDB("SELECT count(*) FROM h_b"));
  assert.equal(b.seen.at(-1).error, null);
  const c = await mount(() => env.sdk.useQuery("h_c"));
  assert.equal(c.seen.at(-1).error, null);
  // A third table would break the 250 budget and both others are on screen.
  assert.deepEqual(await storage(), { h_a: "table", h_b: "table", h_c: "view" });
  const pinned = (await env.sdk.getBindingMemory()).bindings.filter(x => x.pinned).map(x => x.name);
  assert.deepEqual(pinned.sort(), ["h_a", "h_b", "h_c"]);

  await a.unmount();
  await c.unmount();
  const again = await mount(() => env.sdk.useQuery("h_c"));
  assert.deepEqual(await storage(), { h_a: "view", h_b: "table", h_c: "table" }, "the read promoted it");
  await b.unmount();
  await again.unmount();
});

test("a binding dropped past the Blob budget downloads again on its next read", opts, async () => {
  // Blobs are 8 bytes each: 24 > 20 drops the least recently read view, h_a.
  await env.sdk.setBindingMemoryBudget(150, { blobBytes: 20 });
  assert.equal((await storage()).h_a, undefined);
  const before = downloads("h_a");
  const a = await mount(() => env.sdk.useQuery("h_a"));
  assert.equal(a.seen.at(-1).loading, false);
  assert.equal(a.seen.at(-1).error, null);
  assert.equal(downloads("h_a"), before + 1, "reloaded through the normal path");
  await a.unmount();
});

test("a query that runs out of memory frees unpinned tables first", opts, async () => {
  await clearAll(Infinity);
  for (const n of ["h_a", "h_b"]) {
    const other = await mount(() => env.sdk.useQuery(n));
    await other.unmount();
  }
  duck().oom = /^SELECT sum\(x\) FROM h_d/;
  const d = await mount(() => env.sdk.useDuckDB("SELECT sum(x) FROM h_d"));
  const last = d.seen.at(-1);
  assert.equal(last.error, null);
  assert.equal(last.loading, false);
  assert.equal(calledWith("SELECT sum(x) FROM h_d"), 2);
  assert.deepEqual(await storage(), { h_a: "view", h_b: "view", h_d: "table" }, "the query's own table is pinned");
  await d.unmount();
});

test("Out of Memory with only pinned tables demotes them and answers", opts, async () => {
  await clearAll(Infinity);
  const a = await mount(() => env.sdk.useQuery("h_a"));
  const b = await mount(() => env.sdk.useQuery("h_b"));
  assert.deepEqual(await storage(), { h_a: "table", h_b: "table" });
  duck().oom = /^SELECT 7 FROM h_a, h_b/;
  const q = await mount(() => env.sdk.useDuckDB("SELECT 7 FROM h_a, h_b"));
  assert.equal(q.seen.at(-1).error, null);
  const s = await storage();
  assert.equal(s.h_a, "view", "the least recently read went first");
  assert.equal(duck().views.has("h_a"), true, "the name stays readable");
  await a.unmount();
  await b.unmount();
  await q.unmount();
});

test("a demoted view does not promote back during pressure, and does after", opts, async () => {
  assert.equal((await env.sdk.getBindingMemory()).pressure, true);
  const held = (await env.sdk.getBindingMemory()).usedBytes;
  const r = await mount(() => env.sdk.useQuery("h_a"));
  assert.equal(r.seen.at(-1).error, null);
  assert.equal((await storage()).h_a, "view", "a table would pass what relief left: " + held);
  await r.unmount();
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  try {
    assert.equal((await env.sdk.getBindingMemory()).pressure, false);
    const later = await mount(() => env.sdk.useQuery("h_a"));
    assert.equal((await storage()).h_a, "table");
    await later.unmount();
  } finally {
    Date.now = realNow;
  }
});

test("Out of Memory with no table left shows the error, then recovers by itself", opts, async () => {
  await clearAll(Infinity);
  const a = await mount(() => env.sdk.useQuery("h_a"));
  await a.unmount();
  await env.sdk.setBindingMemoryBudget(1, { blobBytes: Infinity }); // only views now
  assert.deepEqual(await storage(), { h_a: "view" });
  duck().oom = /^SELECT 42 FROM h_a/;
  duck().oomTimes = 1;
  const q = await mount(() => env.sdk.useDuckDB("SELECT 42 FROM h_a"));
  assert.match(q.seen.at(-1).error, /Out of Memory Error/);
  assert.equal(calledWith("SELECT 42 FROM h_a"), 1, "no immediate retry: nothing was freed");
  assert.equal(q.seen.at(-1).loading, false);
  assert.ok(await until(() => q.seen.at(-1).error === null), "no reload, no input");
  assert.equal(calledWith("SELECT 42 FROM h_a"), 2);
  assert.ok(!q.seen.some((r, i) => i > 0 && r.error === null && r.data === null && q.seen[i - 1].error), "the error never blinks to empty");
  await q.unmount();
  await env.sdk.setBindingMemoryBudget(env.sdk.DEFAULT_BINDING_MEMORY_BUDGET);
});

test("a retry stops when the hook unmounts or its query changes", opts, async () => {
  await clearAll(Infinity);
  duck().oom = /^SELECT 43/;
  duck().oomTimes = 1;
  const q = await mount(() => env.sdk.useDuckDB("SELECT 43"));
  assert.match(q.seen.at(-1).error, /Out of Memory/);
  await q.unmount();
  await wait(1100);
  assert.equal(calledWith("SELECT 43"), 1);
});

test("a SQL error stays put: only memory and the network are retried", opts, async () => {
  const q = await mount(() => env.sdk.useDuckDB("FAIL"));
  assert.equal(q.seen.at(-1).error, "boom");
  await wait(1100);
  assert.equal(calledWith("FAIL"), 1);
  await q.unmount();
});

// fetchRetrying, the gate and the hook wait real seconds. These tests run them at
// 1/20, on a fresh SDK module each: the gate is page-wide state.
let freshSeq = 0;
const freshSdk = () => import("./index.js?case=" + ++freshSeq);
function fastTimers() {
  const realSet = globalThis.setTimeout;
  const realNow = Date.now;
  const start = realNow();
  globalThis.setTimeout = (fn, ms, ...rest) => realSet(fn, (ms ?? 0) / 20, ...rest);
  Date.now = () => start + (realNow() - start) * 20;
  return () => {
    globalThis.setTimeout = realSet;
    Date.now = realNow;
  };
}
function fetchScript(prefix, answers) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(prefix)) {
      asked.push(String(url));
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
    }
    return real(url, init);
  };
  return { asked, restore: () => (globalThis.fetch = real) };
}
const rejected = () => new TypeError("Failed to fetch");
const busy = (status, body = {}) => new Response(JSON.stringify(body), { status });

test("a download retries a rejected fetch, a 429 and a 503: the panel never sees them", opts, async () => {
  const fast = fastTimers();
  for (const first of [rejected(), busy(429), busy(503)]) {
    const sdk = await freshSdk();
    const script = fetchScript("__data/h_a.parquet", [first]);
    const q = await mount(() => sdk.useQuery("h_a"));
    assert.ok(await until(() => q.seen.at(-1).loading === false));
    assert.equal(q.seen.at(-1).error, null);
    assert.ok(!q.seen.some(r => r.error));
    assert.equal(script.asked.length, 2);
    await q.unmount();
    script.restore();
  }
  fast();
});

test("a download gives up after 3 attempts; the hook runs it again and recovers", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  const script = fetchScript("__data/h_b.parquet", [rejected(), rejected(), rejected()]);
  const q = await mount(() => sdk.useQuery("h_b"));
  assert.ok(await until(() => q.seen.at(-1).error === "Failed to fetch"));
  assert.equal(script.asked.length, 3);
  assert.ok(await until(() => q.seen.at(-1).error === null && q.seen.at(-1).loading === false), "no reload");
  assert.equal(script.asked.length, 4);
  await q.unmount();
  script.restore();
  fast();
});

test("a 429's retryAfterMs sets the wait; past 30 s the hook waits it out with no request", opts, async () => {
  const fast = fastTimers();
  let sdk = await freshSdk();
  let script = fetchScript("__data/h_a.parquet", [busy(429, { retryAfterMs: 1234 })]);
  await sdk.fetchBindingBytes("h_a");
  assert.equal(script.asked.length, 2);
  script.restore();
  sdk = await freshSdk();
  const long = () => busy(429, { retryAfterMs: 900000, error: "cooling" });
  script = fetchScript("__data/h_c.parquet", [long(), long(), long()]);
  const q = await mount(() => sdk.useQuery("h_c"));
  assert.ok(await until(() => /cooling/.test(q.seen.at(-1).error ?? "")));
  assert.equal(script.asked.length, 1, "no attempt inside the window");
  await wait(1000); // 20 s here: the hook's usual first retry passed long ago
  assert.equal(script.asked.length, 1, "error.retryAfterMs holds at the hook layer");
  await q.unmount();
  script.restore();
  fast();
});

test("a storm costs a handful of requests, and an answer heals every panel", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  const real = globalThis.fetch;
  let down = true;
  let parquet = 0;
  let inFlight = 0;
  let most = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === "__data/index.json") return new Response(JSON.stringify(Array.from({ length: 46 }, (_, i) => "st" + i)));
    if (!u.includes(".parquet")) return real(url, init);
    parquet++;
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise(r => realTimeout(r, 2));
    inFlight--;
    if (down) return busy(503, { error: "busy" });
    return real("__data/h_a.parquet", init);
  };
  const panels = [];
  for (let i = 0; i < 46; i++) panels.push(await mount(() => sdk.useQuery("st" + i)));
  assert.ok(await until(() => panels.every(p => p.seen.at(-1).error), 3000), "panels say so, they do not spin");
  await wait(5000); // 100 s here
  assert.ok(parquet <= 20, "2.11.1 asks 46 times; this asked " + parquet);
  assert.ok(most <= 6, "at most 6 at once, saw " + most);
  down = false;
  const asked = parquet;
  await wait(300);
  assert.equal(parquet, asked, "every panel is waiting: no request by itself");
  // The user comes back: one probe through the closed gate, and its answer heals the page.
  env.dom.window.document.dispatchEvent(new env.dom.window.Event("visibilitychange"));
  assert.ok(await until(() => panels.every(p => p.seen.at(-1).error === null && !p.seen.at(-1).loading), 8000), "healed");
  for (const p of panels) await p.unmount();
  globalThis.fetch = real;
  fast();
});

test("no other status is retried, and a failed build is never asked for again", opts, async () => {
  const fast = fastTimers();
  let sdk = await freshSdk();
  for (const status of [400, 403, 404, 500, 502]) {
    const script = fetchScript("__data/h_c.parquet", [new Response("{}", { status })]);
    await assert.rejects(sdk.fetchBindingBytes("h_c"), e => e.status === status);
    assert.equal(script.asked.length, 1, "status " + status);
    script.restore();
  }
  const ndjson = lines => new Response(lines.map(l => JSON.stringify(l) + "\n").join(""), { status: 200, headers: { "content-type": "application/x-ndjson" } });
  // Words a server may use, in a build's own failure: no hook retry, whatever they say.
  for (const error of ["Syntax error", "Out of Memory Error: on the server", "Airbyte: Failed to fetch https://x", "upstream HTTP 503"]) {
    sdk = await freshSdk();
    const script = fetchScript("__data/h_c.parquet", [ndjson([{ phase: "failed", error, status: 502 }])]);
    const q = await mount(() => sdk.useQuery("h_c"));
    assert.ok(await until(() => q.seen.at(-1).error?.includes(error)));
    await wait(1000); // 20 s here
    assert.equal(script.asked.length, 1, error);
    await q.unmount();
    script.restore();
  }
  fast();
});

test("a cut build stream is terminal: the warehouse query is not run again", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  const cut = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ phase: "querying_warehouse" }) + "\n"));
        realTimeout(() => c.error(new TypeError("network error")), 5);
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
  const script = fetchScript("__data/h_c.parquet", [cut]);
  const q = await mount(() => sdk.useQuery("h_c"));
  assert.ok(await until(() => /stream was cut/.test(q.seen.at(-1).error ?? "")));
  await wait(1000);
  assert.equal(script.asked.length, 1);
  await q.unmount();
  script.restore();
  fast();
});

test("the signed download retries on its own, without asking the build again", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  const real = globalThis.fetch;
  const asked = [];
  const ready = JSON.stringify({ phase: "ready", url: "https://storage.test/signed" }) + "\n";
  const answers = [new Response(ready, { status: 200, headers: { "content-type": "application/x-ndjson" } })];
  const signed = [busy(503), rejected(), new Response(new Uint8Array([1, 2, 3]))];
  globalThis.fetch = async url => {
    asked.push(String(url));
    if (String(url).startsWith("__data/h_d.parquet")) return answers.shift();
    const next = signed.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const bytes = await sdk.fetchBindingBytes("h_d");
  assert.equal(bytes.length, 3);
  assert.equal(asked.filter(u => u.startsWith("__data/")).length, 1);
  assert.equal(asked.filter(u => u.startsWith("https://storage")).length, 3);
  globalThis.fetch = real;
  fast();
});

test("a server's refusal is not retried", opts, async () => {
  const sdk = await freshSdk();
  const script = fetchScript("__data/h_c.parquet", [busy(403, { error: "not allowed" })]);
  const q = await mount(() => sdk.useQuery("h_c"));
  assert.match(q.seen.at(-1).error, /not allowed/);
  await wait(1100);
  assert.equal(script.asked.length, 1);
  await q.unmount();
  script.restore();
});

test("index.json down: `select 1` still answers; a query that fails says why", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  const script = fetchScript("__data/index.json", Array.from({ length: 30 }, rejected));
  const fine = await mount(() => sdk.useDuckDB("select 1"));
  assert.ok(await until(() => fine.seen.at(-1).loading === false));
  assert.equal(fine.seen.at(-1).error, null);
  assert.ok(script.asked.length >= 3);
  const bad = await mount(() => sdk.useDuckDB("FAIL"));
  assert.ok(await until(() => bad.seen.at(-1).error === "Failed to fetch"), "the cause, not a baffling Catalog Error");
  await fine.unmount();
  await bad.unmount();
  script.restore();
  fast();
});

test("index.json 404 stays empty; a 500 is shared by 20 panels, then asked again", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  const script = fetchScript("__data/index.json", [busy(500), busy(404)]);
  await Promise.all(Array.from({ length: 20 }, () => sdk.refreshBindings().catch(() => {})));
  assert.equal(script.asked.length, 1, "20 at once share one answer");
  await wait(600); // 12 s here
  await sdk.refreshBindings().catch(() => {});
  assert.equal(script.asked.length, 2, "the 500 did not stick");
  await wait(600);
  await sdk.refreshBindings().catch(() => {});
  assert.equal(script.asked.length, 2, "the 404 did");
  script.restore();
  fast();
});

test("index []: a binding the SDK evicted downloads again, and a useDuckDB read bumps it", opts, async () => {
  const sdk = await freshSdk();
  const script = fetchScript("__data/index.json", [new Response("[]")]);
  await sdk.getDuckDB();
  duck().tableBytes = 100;
  await sdk.setBindingMemoryBudget(150, { blobBytes: 1 });
  const a = await mount(() => sdk.useQuery("ix_a"));
  await a.unmount();
  const b = await mount(() => sdk.useQuery("ix_b"));
  const names = async () => (await sdk.getBindingMemory()).bindings.map(x => x.name);
  assert.deepEqual(await names(), ["ix_b"], "ix_a is gone: Blob budget 1");
  duck().missing = "ix_a";
  const before = downloads("ix_a");
  const q = await mount(() => sdk.useDuckDB("SELECT count(*) FROM ix_a"));
  assert.equal(q.seen.at(-1).error, null);
  assert.equal(downloads("ix_a"), before + 1);
  assert.ok((await names()).includes("ix_a"));
  await b.unmount();
  await q.unmount();
  script.restore();
  duck().missing = undefined;
  await sdk.setBindingMemoryBudget(sdk.DEFAULT_BINDING_MEMORY_BUDGET);
});

test("a binding whose download failed is asked for once in that run", opts, async () => {
  const sdk = await freshSdk();
  const list = fetchScript("__data/index.json", [new Response(JSON.stringify(["once"]))]);
  list.restore();
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "__data/index.json") return new Response(JSON.stringify(["once"]));
    if (String(url).startsWith("__data/once.parquet")) {
      asked++;
      return busy(404);
    }
    return real(url, init);
  };
  duck().missing = "once";
  const q = await mount(() => sdk.useDuckDB("SELECT count(*) FROM once"));
  assert.match(q.seen.at(-1).error, /HTTP 404/);
  assert.equal(asked, 1);
  duck().missing = undefined;
  await q.unmount();
});

test("a query naming more than 50 bindings is refused, with no load", opts, async () => {
  const sdk = await freshSdk();
  const many = Array.from({ length: 51 }, (_, i) => "m" + i);
  const script = fetchScript("__data/index.json", [new Response(JSON.stringify(many))]);
  const before = calls.length;
  const q = await mount(() => sdk.useDuckDB(many.map(n => "select * from " + n).join(" union all ")));
  assert.match(q.seen.at(-1).error, /names 51 bindings/);
  assert.equal(calls.filter(u => u.includes(".parquet")).slice(before).length, 0);
  await q.unmount();
  script.restore();
});

test("an unreadable Blob: the table goes and downloads again; a real OOM stays itself", opts, async () => {
  const realRead = Blob.prototype.arrayBuffer;
  const sdk = await freshSdk();
  await sdk.getDuckDB();
  duck().tableBytes = 100;
  await sdk.setBindingMemoryBudget(150, { blobBytes: Infinity });
  const a = await mount(() => sdk.useQuery("nr_a"));
  await a.unmount();
  Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException("could not be read", "NotReadableError"));
  const names = async () => (await sdk.getBindingMemory()).bindings.map(x => x.name);
  try {
    const b = await mount(() => sdk.useQuery("nr_b"));
    assert.equal(b.seen.at(-1).error, null, "an unrelated load is not blocked");
    assert.deepEqual(await names(), ["nr_b"], "nr_a went for re-download");
    const before = downloads("nr_a");
    await b.unmount();
    duck().oom = /^SELECT oom FROM nr_b/;
    duck().oomTimes = Infinity;
    const q = await mount(() => sdk.useDuckDB("SELECT oom FROM nr_b"));
    assert.match(q.seen.at(-1).error, /^Out of Memory Error/, "the cause, not the Blob's error");
    duck().oom = null;
    duck().oomTimes = 1;
    await q.unmount();
    const again = await mount(() => sdk.useQuery("nr_a"));
    assert.equal(again.seen.at(-1).error, null);
    assert.equal(downloads("nr_a"), before + 1);
    await again.unmount();
  } finally {
    Blob.prototype.arrayBuffer = realRead;
  }
});

test("a crashed engine restarts: every panel reruns, at most once a minute, 3 times", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  await sdk.getDuckDB();
  const boots = duck().boots;
  duck().crash = /^SELECT 'boom'/;
  duck().crashTimes = 1;
  const sibling = await mount(() => sdk.useDuckDB("SELECT 'fine'"));
  const q = await mount(() => sdk.useDuckDB("SELECT 'boom'"));
  assert.ok(await until(() => duck().boots === boots + 1), "a new engine");
  assert.ok(await until(() => q.seen.at(-1).error === null && !q.seen.at(-1).loading));
  assert.equal(sibling.seen.at(-1).error, null);
  await q.unmount();
  // The quoted word in a user's error is not a crash.
  const before = duck().boots;
  duck().wordy = true;
  const w = await mount(() => sdk.useDuckDB("FAIL"));
  await wait(100);
  assert.equal(duck().boots, before);
  await w.unmount();
  // A second crash waits out the minute: one restart in 40 s.
  duck().crash = /^SELECT 'boom2'/;
  duck().crashTimes = Infinity;
  const again = await mount(() => sdk.useDuckDB("SELECT 'boom2'"));
  assert.match(again.seen.at(-1).error, /data engine crashed/);
  await wait(2000);
  assert.ok(duck().boots <= before + 2, "at most one a minute, saw " + (duck().boots - before));
  duck().crash = null;
  await again.unmount();
  await sibling.unmount();
  fast();
});

test("a query that can never fit stops after 5 retries and takes only its own tables", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  await sdk.getDuckDB();
  duck().tableBytes = 100;
  duck().oom = null;
  await sdk.setBindingMemoryBudget(Infinity, { blobBytes: Infinity });
  const healthy = await mount(() => sdk.useQuery("k_healthy"));
  const own = await mount(() => sdk.useQuery("k_own"));
  duck().oom = /^SELECT killer FROM k_own/;
  duck().oomTimes = Infinity;
  const q = await mount(() => sdk.useDuckDB("SELECT killer FROM k_own"));
  const storage = async () => Object.fromEntries((await sdk.getBindingMemory()).bindings.map(b => [b.name, b.storage]));
  assert.ok(await until(() => /Out of Memory/.test(q.seen.at(-1).error ?? "")));
  assert.equal((await storage()).k_healthy, "table", "a healthy panel's table stays");
  assert.equal((await storage()).k_own, "view");
  await wait(3000); // 60 s here, past all 5 retries
  const runs = () => duck().sql.filter(s => s === "SELECT killer FROM k_own").length;
  const settled = runs();
  assert.ok(settled <= 7, "1 + one after relief + 5 retries, saw " + settled);
  await wait(1000);
  assert.equal(runs(), settled, "it waits now");
  // Another panel letting go is a reason to try again, once.
  await healthy.unmount();
  assert.ok(await until(() => runs() > settled));
  await wait(500);
  assert.ok(runs() <= settled + 2, "once, plus one after relief if the table came back");
  duck().oom = null;
  duck().oomTimes = 1;
  await q.unmount();
  await own.unmount();
  fast();
});

test("a hidden tab does not retry until it is shown", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  await sdk.getDuckDB();
  duck().oom = /^SELECT hidden/;
  duck().oomTimes = Infinity;
  const q = await mount(() => sdk.useDuckDB("SELECT hidden"));
  assert.ok(await until(() => /Out of Memory/.test(q.seen.at(-1).error ?? "")));
  const doc = env.dom.window.document;
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => true });
  await wait(600);
  const runs = () => duck().sql.filter(s => s === "SELECT hidden").length;
  const paused = runs();
  await wait(500);
  assert.equal(runs(), paused);
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => false });
  duck().oom = null;
  duck().oomTimes = 1;
  doc.dispatchEvent(new env.dom.window.Event("visibilitychange"));
  assert.ok(await until(() => q.seen.at(-1).error === null));
  assert.ok(runs() > paused);
  await q.unmount();
  fast();
});

test("pinned views promote when pressure ends, with no new read", opts, async () => {
  const fast = fastTimers();
  const sdk = await freshSdk();
  await sdk.getDuckDB();
  duck().tableBytes = 100;
  await sdk.setBindingMemoryBudget(Infinity, { blobBytes: Infinity });
  const a = await mount(() => sdk.useQuery("pr_a"));
  duck().oom = /^SELECT 9 FROM pr_a/;
  duck().oomTimes = 1;
  const q = await mount(() => sdk.useDuckDB("SELECT 9 FROM pr_a"));
  const storage = async () => Object.fromEntries((await sdk.getBindingMemory()).bindings.map(b => [b.name, b.storage]));
  assert.equal((await storage()).pr_a, "view");
  await wait(3200); // 64 s here
  assert.equal((await storage()).pr_a, "table");
  await a.unmount();
  await q.unmount();
  fast();
});
