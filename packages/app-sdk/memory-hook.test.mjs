// Binding memory through mounted hooks (SDK 2.12): a hook pins what it reads,
// eviction takes the least recently read of the rest, a dropped binding
// downloads again on its next read, and a query that runs out of memory frees
// unpinned tables and runs again. React + jsdom with the fake DuckDB; skips
// where react, react-dom or jsdom is not installed (the publish job installs
// nothing; jsdom comes from the monorepo's app package).
import assert from "node:assert/strict";
import module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "https://app.test/" });
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
const realTimeout = globalThis.setTimeout; // tests below speed the SDK's timers
const settle = () => env.act(() => new Promise(r => realTimeout(r, 60)));
async function until(test, ms = 1500) {
  const t0 = Date.now();
  while (!test() && Date.now() - t0 < ms) await env.act(() => new Promise(r => realTimeout(r, 10)));
  return test();
}
const storage = async () =>
  Object.fromEntries((await env.sdk.getBindingMemory()).bindings.map(b => [b.name, b.storage]));

const calledWith = sql => duck().sql.filter(q => q === sql).length;
const wait = ms => env.act(() => new Promise(r => realTimeout(r, ms)));
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
  await wait(1100);
  assert.equal(q.seen.at(-1).error, null, "no reload, no input");
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

// fetchRetrying and the hook wait real seconds. These tests run them at 1/20.
function fastTimers() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => real(fn, (ms ?? 0) / 20, ...rest);
  return () => {
    globalThis.setTimeout = real;
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

test("a download retries a rejected fetch, a 429 and a 503: the panel never sees them", opts, async () => {
  await clearAll(Infinity);
  const slow = fastTimers();
  for (const first of [rejected(), new Response("{}", { status: 429 }), new Response("{}", { status: 503 })]) {
    await env.sdk.unloadBinding("h_a");
    const script = fetchScript("__data/h_a.parquet", [first]);
    const q = await mount(() => env.sdk.useQuery("h_a"));
    assert.ok(await until(() => q.seen.at(-1).loading === false));
    assert.equal(q.seen.at(-1).error, null);
    assert.ok(!q.seen.some(r => r.error));
    assert.equal(script.asked.length, 2);
    await q.unmount();
    script.restore();
  }
  slow();
});

test("a download gives up after 3 attempts; the hook runs it again and recovers", opts, async () => {
  await clearAll(Infinity);
  const slow = fastTimers();
  const script = fetchScript("__data/h_b.parquet", [rejected(), rejected(), rejected()]);
  const q = await mount(() => env.sdk.useQuery("h_b"));
  assert.ok(await until(() => q.seen.at(-1).error === "Failed to fetch"));
  assert.equal(script.asked.length, 3);
  assert.ok(await until(() => q.seen.at(-1).error === null && q.seen.at(-1).loading === false), "no reload");
  assert.equal(script.asked.length, 4);
  await q.unmount();
  script.restore();
  slow();
});

test("a 429's retryAfterMs sets the wait; past 30 s the caller gets the answer", opts, async () => {
  await clearAll(Infinity);
  const waits = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    waits.push(ms);
    return real(fn, Math.min(ms ?? 0, 30), ...rest);
  };
  const short = new Response(JSON.stringify({ retryAfterMs: 1234 }), { status: 429 });
  let script = fetchScript("__data/h_a.parquet", [short]);
  await env.sdk.fetchBindingBytes("h_a");
  assert.ok(waits.includes(1234));
  assert.equal(script.asked.length, 2);
  script.restore();
  const long = new Response(JSON.stringify({ retryAfterMs: 60000, error: "busy" }), { status: 429 });
  script = fetchScript("__data/h_a.parquet", [long]);
  await assert.rejects(env.sdk.fetchBindingBytes("h_a"), e => e.status === 429 && e.retryAfterMs === 60000);
  assert.equal(script.asked.length, 1);
  script.restore();
  globalThis.setTimeout = real;
});

test("no other status is retried, and a failed build's stream is never run again", opts, async () => {
  for (const status of [400, 403, 404, 500, 502]) {
    const script = fetchScript("__data/h_c.parquet", [new Response("{}", { status })]);
    await assert.rejects(env.sdk.fetchBindingBytes("h_c"), e => e.status === status);
    assert.equal(script.asked.length, 1, "status " + status);
    script.restore();
  }
  const failed = JSON.stringify({ phase: "failed", error: "Syntax error", status: 502 }) + "\n";
  const stream = new Response(failed, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  const script = fetchScript("__data/h_c.parquet", [stream]);
  await assert.rejects(env.sdk.fetchBindingBytes("h_c"), /Syntax error/);
  assert.equal(script.asked.length, 1);
  script.restore();
});

test("the signed download retries on its own, without asking the build again", opts, async () => {
  const real = globalThis.fetch;
  const asked = [];
  const ready = JSON.stringify({ phase: "ready", url: "https://storage.test/signed" }) + "\n";
  const answers = [new Response(ready, { status: 200, headers: { "content-type": "application/x-ndjson" } })];
  const signed = [new Response("{}", { status: 503 }), rejected(), new Response(new Uint8Array([1, 2, 3]))];
  const slow = fastTimers();
  globalThis.fetch = async url => {
    asked.push(String(url));
    if (String(url).startsWith("__data/h_d.parquet")) return answers.shift();
    const next = signed.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const bytes = await env.sdk.fetchBindingBytes("h_d");
  assert.equal(bytes.length, 3);
  assert.equal(asked.filter(u => u.startsWith("__data/")).length, 1);
  assert.equal(asked.filter(u => u.startsWith("https://storage")).length, 3);
  globalThis.fetch = real;
  slow();
});

test("a server's refusal is not retried", opts, async () => {
  await clearAll(Infinity);
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("__data/h_c.parquet")) {
      asked++;
      return new Response(JSON.stringify({ error: "not allowed" }), { status: 403 });
    }
    return real(url, init);
  };
  const q = await mount(() => env.sdk.useQuery("h_c"));
  assert.match(q.seen.at(-1).error, /not allowed/);
  await wait(1100);
  assert.equal(asked, 1);
  await q.unmount();
  globalThis.fetch = real;
});

test("a failed index.json is not cached: the panel says so, retries, and loads", { skip: opts.skip }, async () => {
  // A fresh SDK module: the page-level cache is what this test is about.
  const fresh = await import("./index.js?index-failure");
  const slow = fastTimers();
  const script = fetchScript("__data/index.json", [rejected(), rejected(), rejected()]);
  const seen = [];
  function Probe() {
    seen.push(fresh.useDuckDB("SELECT 1 FROM h_a"));
    return null;
  }
  const el = env.dom.window.document.createElement("div");
  env.dom.window.document.body.appendChild(el);
  const root = env.createRoot(el);
  await env.act(async () => root.render(env.React.createElement(Probe)));
  assert.ok(await until(() => seen.at(-1).error === "Failed to fetch"), "not an empty list");
  assert.equal(script.asked.length, 3);
  assert.ok(await until(() => seen.at(-1).error === null && seen.at(-1).loading === false), "recovers");
  assert.equal(script.asked.length, 4);
  assert.deepEqual((await fresh.getBindingMemory()).bindings.map(b => b.name), ["h_a"], "the hint worked: the list arrived");
  await env.act(async () => root.unmount());
  script.restore();
  slow();
});

test("index.json 404 is cached as empty; a 500 is empty once and asks again", { skip: opts.skip }, async () => {
  const fresh = await import("./index.js?index-status");
  const slow = fastTimers();
  const script = fetchScript("__data/index.json", [new Response("{}", { status: 500 }), new Response("{}", { status: 404 })]);
  await fresh.refreshBindings().catch(() => {});
  assert.equal(script.asked.length, 1);
  await fresh.refreshBindings().catch(() => {});
  assert.equal(script.asked.length, 2, "the 500 did not stick");
  await fresh.refreshBindings().catch(() => {});
  assert.equal(script.asked.length, 2, "the 404 did");
  script.restore();
  slow();
});
