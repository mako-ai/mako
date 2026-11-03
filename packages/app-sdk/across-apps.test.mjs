// The SDK inside an app frame (SDK 2.13): it reports its DuckDB memory to the
// host, and on the host's ask it ends its worker, parks the parquet as Blobs
// and reloads from them on the next read, with no download. React + jsdom
// with the fake DuckDB, the SDK loaded into an iframe's window so
// window.parent is the host. Skips where react, react-dom or jsdom is not
// installed (the publish job installs nothing).
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
  const host = new JSDOM("<!doctype html><iframe></iframe>", { url: "https://app.test/" });
  const frame = host.window.document.querySelector("iframe").contentWindow;
  frame.document.body.innerHTML = "<div id=root></div>";
  globalThis.window = frame;
  globalThis.document = frame.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const sdk = await import("./index.js");
  env = { React, createRoot, act: React.act, sdk, host: host.window, frame };
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
const opts = { skip: env ? false : "hooks not renderable here: " + why };
const duck = () => globalThis.__fakeDuck;

const reports = [];
let lastReport = null;
let index = ["x_a", "x_b", "x_slow"];
let indexGate = null;
if (env) {
  env.host.addEventListener("message", e => {
    if (e.data && e.data.type === "mako-app:duckdb-memory") {
      reports.push(e.data.bytes);
      lastReport = e.data;
    }
  });
}
const calls = [];
let gate = null;
globalThis.fetch = async url => {
  const u = String(url);
  calls.push(u);
  if (u === "__data/index.json") {
    await indexGate;
    return new Response(JSON.stringify(index));
  }
  if (u.startsWith("__data/x_slow")) await gate;
  return new Response(new Uint8Array([80, 65, 82, 49, 80, 65, 82, 49]), { status: 200, headers: { "content-length": "8" } });
};
const downloads = name => calls.filter(u => u.startsWith("__data/" + name + ".parquet")).length;
const settle = () => env.act(() => new Promise(r => setTimeout(r, 60)));
async function mount(hook) {
  const seen = [];
  function Probe() {
    seen.push(hook());
    return null;
  }
  const root = env.createRoot(env.frame.document.getElementById("root"));
  await env.act(async () => root.render(env.React.createElement(Probe)));
  await settle();
  return { seen, unmount: () => env.act(async () => root.unmount()) };
}
// What Mako's shell posts. Built here so `source` is the host window, the
// one sender the SDK believes.
function hostAsks(type = "mako-host:duckdb-release", source = env.host) {
  env.frame.dispatchEvent(new env.frame.MessageEvent("message", { data: { type }, source }));
}

test("the frame reports what its DuckDB holds", opts, async () => {
  await env.sdk.getBindingMemory(); // boot the fake
  duck().tableBytes = 100;
  const a = await mount(() => env.sdk.useQuery("x_a"));
  assert.equal(a.seen.at(-1).loading, false);
  await settle();
  assert.equal(reports.at(-1), 100);
  assert.equal(lastReport.canRelease, true);
  await a.unmount();
});

test("a release ends the worker; the next read reboots from the parked Blob", opts, async () => {
  const boots = duck().boots;
  hostAsks();
  await settle();
  assert.equal(duck().terminated, 1);
  assert.equal(reports.at(-1), 0, "reports zero once the heap is gone");
  assert.equal(duck().tables.size, 0);

  const a = await mount(() => env.sdk.useQuery("x_a"));
  assert.equal(a.seen.at(-1).error, null);
  assert.equal(a.seen.at(-1).loading, false);
  assert.equal(duck().boots, boots + 1, "a fresh engine");
  assert.equal(downloads("x_a"), 1, "decoded from the parked Blob, not downloaded again");
  assert.ok(duck().tables.has("x_a"));
  await settle();
  assert.equal(reports.at(-1), 100);
  await a.unmount();
});

test("only the parent may ask, and only for a release", opts, async () => {
  hostAsks("mako-host:something-else");
  hostAsks("mako-host:duckdb-release", env.frame);
  await settle();
  assert.equal(duck().terminated, 1);
});

test("a release waits while a load is in flight", opts, async () => {
  let open;
  gate = new Promise(r => (open = r));
  const s = await mount(() => env.sdk.useQuery("x_slow"));
  assert.equal(s.seen.at(-1).loading, true);
  hostAsks();
  await settle();
  assert.equal(duck().terminated, 1, "not ended under a load");
  await env.act(async () => open());
  await settle();
  assert.equal(s.seen.at(-1).loading, false);
  await s.unmount();
});

test("the report is the heap's high-water mark: a demotion frees no bytes", opts, async () => {
  duck().tableBytes = 100;
  const a = await mount(() => env.sdk.useQuery("x_b"));
  await a.unmount();
  await settle();
  const peak = reports.at(-1);
  assert.ok(peak >= 100);
  await env.sdk.setBindingMemoryBudget(1);
  assert.equal((await env.sdk.getBindingMemory()).bindings.find(b => b.name === "x_b").storage, "view");
  await settle();
  assert.equal(reports.at(-1), peak, "the heap stays reserved, so the report stays");
  await env.sdk.setBindingMemoryBudget(env.sdk.DEFAULT_BINDING_MEMORY_BUDGET);
  hostAsks();
  await settle();
  assert.equal(reports.at(-1), 0, "only a release gives it back");
  duck().tableBytes = 0;
});

// A fresh module per test below: a kept engine stays kept for a page's life.
// Every earlier module has already released or kept its engine, so an ask
// reaches only the one under test.
async function freshSdk(tag) {
  hostAsks();
  await settle();
  const sdk = await import("./index.js?" + tag);
  await sdk.getBindingMemory(); // boot the fake
  return sdk;
}

async function assertKeepsEngine(sdk) {
  await settle();
  assert.equal(lastReport.canRelease, false, "the shell must ask another frame");
  const before = duck().terminated;
  hostAsks();
  await settle();
  assert.equal(duck().terminated, before, "the worker stays");
}

test("SQL that writes keeps the engine: the app's own tables would die with it", opts, async () => {
  const sdk = await freshSdk("ddl");
  const r = await mount(() => sdk.useDuckDB("CREATE OR REPLACE TABLE mine AS SELECT 1"));
  assert.equal(r.seen.at(-1).loading, false);
  await assertKeepsEngine(sdk);
  await r.unmount();
});

test("SQL that writes is measured: no load follows to count what it made", opts, async () => {
  const sdk = await freshSdk("ddl2");
  duck().tableBytes = 1000;
  const r = await mount(() => sdk.useDuckDB('CREATE OR REPLACE TABLE "mine2" AS SELECT 1'));
  await settle();
  assert.ok(reports.at(-1) >= 1000, "the frame reports the table it just made");
  duck().tableBytes = 0;
  await r.unmount();
});

test("getDuckDB() keeps the engine", opts, async () => {
  const sdk = await freshSdk("get");
  await sdk.getDuckDB();
  await assertKeepsEngine(sdk);
});

test("withConnection() keeps the engine", opts, async () => {
  const sdk = await freshSdk("conn");
  await sdk.withConnection(async () => {});
  await assertKeepsEngine(sdk);
});

test("ensureBinding() keeps the engine", opts, async () => {
  const sdk = await freshSdk("ensure");
  await sdk.ensureBinding("x_a");
  await assertKeepsEngine(sdk);
});

test("a read-only hook leaves the engine releasable", opts, async () => {
  const sdk = await freshSdk("read");
  const r = await mount(() => sdk.useDuckDB("SELECT * FROM x_a"));
  await settle();
  assert.equal(lastReport.canRelease, true);
  await r.unmount();
  const before = duck().terminated;
  hostAsks();
  await settle();
  assert.equal(duck().terminated, before + 1);
});

test("with an empty index, a released binding comes back by name", opts, async () => {
  index = [];
  const sdk = await freshSdk("empty");
  const loader = await mount(() => sdk.useQuery("x_a"));
  await loader.unmount();
  const before = duck().terminated;
  hostAsks();
  await settle();
  assert.equal(duck().terminated, before + 1);
  assert.equal(duck().tables.size, 0);
  const shown = downloads("x_a");
  const q = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
  assert.equal(q.seen.at(-1).error, null);
  assert.ok(duck().tables.has("x_a"), "reloaded for the query that names it");
  assert.equal(downloads("x_a"), shown, "from the parked Blob");
  await q.unmount();
  index = ["x_a", "x_b", "x_slow"];
});

test("a release waits from a hook's first await to its last", opts, async () => {
  const sdk = await freshSdk("span");
  let open;
  indexGate = new Promise(r => (open = r));
  const q = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
  assert.equal(q.seen.at(-1).loading, true);
  const before = duck().terminated;
  hostAsks();
  await settle();
  assert.equal(duck().terminated, before, "nothing else is in flight, and the hook still reads");
  await env.act(async () => open());
  indexGate = null;
  await settle();
  assert.equal(q.seen.at(-1).error, null);
  await q.unmount();
});

test("reboots share one worker URL", opts, async () => {
  hostAsks();
  await settle();
  const urls = [];
  const createObjectURL = URL.createObjectURL;
  const workers = [];
  globalThis.Worker = class {
    constructor(url) {
      workers.push(url);
    }
  };
  URL.createObjectURL = () => {
    urls.push("blob:x");
    return "blob:x";
  };
  try {
    const sdk = await import("./index.js?worker");
    await sdk.getBindingMemory();
    hostAsks();
    await settle();
    await sdk.getBindingMemory();
    assert.equal(workers.length, 2, "two boots");
    assert.equal(urls.length, 1, "one object URL, however many reboots");
    hostAsks();
    await settle();
  } finally {
    URL.createObjectURL = createObjectURL;
    delete globalThis.Worker;
  }
});

// --- Crash reboots and releases share teardown ---
async function loadedSdk(tag) {
  const sdk = await freshSdk(tag);
  const a = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
  assert.equal(a.seen.at(-1).error, null);
  await a.unmount();
  return sdk;
}
const pause = ms => env.act(() => new Promise(r => setTimeout(r, ms)));

test("a crash report from a released engine leaves the next engine alone", opts, async () => {
  const sdk = await loadedSdk("stale");
  const before = duck().terminated;
  duck().crash = /duckdb_memory/;
  hostAsks(); // the release goes first in the catalog queue...
  const late = sdk.getBindingMemory(); // ...then a measure that still holds its engine
  await settle();
  await late;
  duck().crash = null;
  assert.equal(duck().terminated, before + 1, "the release");
  const boots = duck().boots;
  const next = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
  await pause(30);
  assert.equal(next.seen.at(-1).error, null);
  assert.equal(duck().boots, boots + 1, "that query's boot, and no restart took it");
  assert.equal(duck().terminated, before + 1);
  await next.unmount();
});

test("a crash during a release ends the engine once, and panels rerun", opts, async () => {
  const sdk = await loadedSdk("during");
  const panel = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
  const seenBefore = panel.seen.length;
  await panel.unmount();
  const stays = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
  const runs = stays.seen.length;
  const before = duck().terminated;
  duck().crash = /duckdb_memory/;
  const crashing = sdk.getBindingMemory(); // queued ahead of the release
  await Promise.resolve();
  hostAsks();
  await crashing;
  duck().crash = null;
  await pause(30);
  assert.equal(duck().terminated, before + 1, "the restart alone ended it");
  assert.ok(stays.seen.length > runs, "the restart reran the mounted panel");
  assert.equal(stays.seen.at(-1).error, null);
  assert.ok(seenBefore > 0);
  await stays.unmount();
});

test("a release during a reboot waits for the panels", opts, async () => {
  const sdk = await loadedSdk("reboot");
  const panel = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_slow"));
  assert.equal(panel.seen.at(-1).error, null);
  let open;
  gate = new Promise(r => (open = r));
  const before = duck().terminated;
  duck().crash = /crash_now/;
  const broken = await mount(() => sdk.useDuckDB("SELECT crash_now FROM x_a"));
  await pause(30); // the restart fired: the panel reruns, x_slow is held at the gate
  assert.equal(duck().terminated, before + 1, "the restart");
  assert.equal(panel.seen.at(-1).refreshing, true);
  hostAsks();
  await settle();
  assert.equal(duck().terminated, before + 1, "no release under the reload");
  await env.act(async () => open());
  gate = null;
  await settle();
  assert.equal(panel.seen.at(-1).error, null);
  assert.equal(panel.seen.at(-1).refreshing, false);
  await broken.unmount();
  await panel.unmount();
});

test("releases never spend the page's 3 crash restarts", opts, async () => {
  const sdk = await loadedSdk("cap");
  for (let i = 0; i < 5; i++) {
    const before = duck().terminated;
    hostAsks();
    await settle();
    assert.equal(duck().terminated, before + 1, "release " + (i + 1));
    const r = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
    assert.equal(r.seen.at(-1).error, null, "query after release " + (i + 1));
    await r.unmount();
  }
  const before = duck().terminated;
  duck().crash = /crash_cap/;
  const broken = await mount(() => sdk.useDuckDB("SELECT crash_cap FROM x_a"));
  await pause(30);
  assert.equal(duck().terminated, before + 1, "the first crash still restarts");
  await broken.unmount();
});

test("a parked binding reads with no download while the gate is closed", opts, async () => {
  const sdk = await loadedSdk("gate");
  const shown = downloads("x_a");
  hostAsks();
  await settle();
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(String(url));
    throw new TypeError("Failed to fetch");
  };
  try {
    const failing = await mount(() => sdk.useQuery("x_b")); // closes the gate
    await pause(20);
    const parkedRead = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
    assert.equal(parkedRead.seen.at(-1).error, null);
    assert.equal(downloads("x_a"), shown, "from the Blob");
    await parkedRead.unmount();
    await failing.unmount();
  } finally {
    globalThis.fetch = real;
  }
});

test("an unreadable parked Blob downloads again", opts, async () => {
  const sdk = await loadedSdk("blob");
  hostAsks();
  await settle();
  const shown = downloads("x_a");
  const read = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotReadableError"));
  try {
    const r = await mount(() => sdk.useDuckDB("SELECT count(*) FROM x_a"));
    assert.equal(r.seen.at(-1).error, null);
    assert.equal(downloads("x_a"), shown + 1);
    await r.unmount();
  } finally {
    Blob.prototype.arrayBuffer = read;
  }
});
