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
const settle = () => env.act(() => new Promise(r => setTimeout(r, 60)));
const storage = async () =>
  Object.fromEntries((await env.sdk.getBindingMemory()).bindings.map(b => [b.name, b.storage]));

test("a mounted hook pins its table; once it unmounts, it is the first to go", opts, async () => {
  await env.sdk.getDuckDB();
  duck().tableBytes = 100;
  await env.sdk.setBindingMemoryBudget(150, { blobBytes: Infinity });
  const a = await mount(() => env.sdk.useQuery("h_a"));
  assert.equal(a.seen.at(-1).loading, false);
  const b = await mount(() => env.sdk.useDuckDB("SELECT count(*) FROM h_b"));
  assert.equal(b.seen.at(-1).error, null);
  // 200 bytes against a budget of 150, but both are on screen.
  assert.deepEqual(await storage(), { h_a: "table", h_b: "table" });
  const pinned = (await env.sdk.getBindingMemory()).bindings.filter(x => x.pinned).map(x => x.name);
  assert.deepEqual(pinned.sort(), ["h_a", "h_b"]);

  await a.unmount();
  const c = await mount(() => env.sdk.useQuery("h_c"));
  assert.deepEqual(await storage(), { h_a: "view", h_b: "table", h_c: "table" });
  await b.unmount();
  await c.unmount();
});

test("a binding dropped past the Blob budget downloads again on its next read", opts, async () => {
  // Blobs are 8 bytes each: 24 > 20 drops the least recently read view, h_a.
  await env.sdk.setBindingMemoryBudget(150, { blobBytes: 20 });
  assert.deepEqual(await storage(), { h_b: "view", h_c: "table" });
  assert.equal(downloads("h_a"), 1);
  const a = await mount(() => env.sdk.useQuery("h_a"));
  assert.equal(a.seen.at(-1).loading, false);
  assert.equal(a.seen.at(-1).error, null);
  assert.equal(downloads("h_a"), 2, "reloaded through the normal path");
  assert.equal((await storage()).h_a, "table");
  await a.unmount();
});

test("a query that runs out of memory frees unpinned tables and runs once more", opts, async () => {
  await env.sdk.setBindingMemoryBudget(Infinity, { blobBytes: Infinity });
  const before = await storage();
  assert.ok(Object.values(before).includes("table"));
  duck().oom = /^SELECT sum\(x\) FROM h_d/;
  const d = await mount(() => env.sdk.useDuckDB("SELECT sum(x) FROM h_d"));
  const last = d.seen.at(-1);
  assert.equal(last.error, null);
  assert.equal(last.loading, false);
  assert.equal(duck().sql.filter(q => q === "SELECT sum(x) FROM h_d").length, 2);
  const after = await storage();
  assert.equal(after.h_d, "table", "the query's own table is pinned");
  assert.ok(Object.entries(after).some(([n, s]) => n !== "h_d" && s === "view"));
  await d.unmount();
});

test("Out of Memory with nothing left to free surfaces as the hook's error", opts, async () => {
  for (const b of (await env.sdk.getBindingMemory()).bindings) {
    if (b.name !== "h_d") await env.sdk.unloadBinding(b.name);
  }
  duck().oom = /^SELECT 42 FROM h_d/;
  const d = await mount(() => env.sdk.useDuckDB("SELECT 42 FROM h_d"));
  assert.match(d.seen.at(-1).error, /Out of Memory Error/);
  assert.equal(duck().sql.filter(q => q === "SELECT 42 FROM h_d").length, 1, "no retry: it would fail the same way");
  await d.unmount();
});
