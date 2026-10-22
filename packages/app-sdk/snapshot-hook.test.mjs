// useQuery's opt-in snapshot preview, rendered for real: React + jsdom, the
// fake DuckDB from test-support standing in for the CDN engine. Skips where
// react, react-dom or jsdom is not installed (the publish job installs
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

const SNAPSHOT = {
  version: 1,
  builtAt: "2026-10-22T08:00:00.000Z",
  rowCount: 1000,
  snapshotRowCount: 2,
  truncated: true,
  fields: [
    { name: "id", type: "BIGINT" },
    { name: "day", type: "DATE" },
  ],
  rows: [
    { id: 1, day: "2026-10-01" },
    { id: "9007199254740993", day: null },
  ],
};

// Each binding's parquet answers when the test says so.
const calls = [];
const gates = new Map();
function gate(name) {
  if (!gates.has(name)) {
    let open;
    const p = new Promise(r => (open = r));
    gates.set(name, { p, open });
  }
  return gates.get(name);
}
globalThis.fetch = async url => {
  const u = String(url);
  calls.push(u);
  if (u.endsWith(".snapshot.json")) return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
  const name = /__data\/([^.?]+)\.parquet/.exec(u)?.[1];
  return gate(name).p;
};
const parquetOk = () =>
  new Response(new Uint8Array([80, 65, 82, 49, 80, 65, 82, 49]), { status: 200, headers: { "content-length": "8" } });

async function render(hooks) {
  const seen = [];
  function Probe() {
    seen.push(hooks.map(h => h()));
    return null;
  }
  const root = env.createRoot(env.dom.window.document.getElementById("root"));
  await env.act(async () => root.render(env.React.createElement(Probe)));
  return { root, seen };
}
const settle = () => env.act(() => new Promise(r => setTimeout(r, 120)));
const count = (suffix, name) => calls.filter(u => u.startsWith("__data/" + name + suffix)).length;

test("SDK_VERSION matches package.json and is stamped on window", opts, async () => {
  const pkg = createRequire(import.meta.url)("./package.json");
  assert.equal(env.sdk.SDK_VERSION, pkg.version);
  assert.equal(globalThis.window.__MAKO_APP_SDK__, pkg.version);
});

test("default useQuery is unchanged: no snapshot request, no preview key", opts, async () => {
  const { seen, root } = await render([() => env.sdk.useQuery("plain")]);
  await settle();
  const last = seen.at(-1)[0];
  assert.equal("preview" in last, false);
  assert.equal(last.loading, true);
  assert.equal(count(".snapshot.json", "plain"), 0);
  assert.equal(count(".parquet", "plain"), 1);
  await env.act(async () => root.unmount());
});

test("snapshot: preview while loading, gone once the table is in", opts, async () => {
  const { seen, root } = await render([
    () => env.sdk.useQuery("sales", { snapshot: true }),
    () => env.sdk.useQuery("sales", { snapshot: true }),
  ]);
  await settle();
  const [a, b] = seen.at(-1);
  assert.equal(a.loading, true);
  assert.equal(a.data, null);
  assert.ok(a.phase, "the phase-aware loader still reports a phase");
  assert.deepEqual(a.preview, {
    data: [
      { id: 1, day: "2026-10-01" },
      { id: 9007199254740993n, day: null },
    ],
    fields: ["id", "day"],
    rowCount: 1000,
    truncated: true,
    builtAt: "2026-10-22T08:00:00.000Z",
  });
  assert.deepEqual(b.preview, a.preview);
  // Two hooks on one binding: one snapshot request, one parquet request.
  assert.equal(count(".snapshot.json", "sales"), 1);
  assert.equal(count(".parquet", "sales"), 1);

  await env.act(async () => gate("sales").open(parquetOk()));
  await settle();
  const done = seen.at(-1)[0];
  assert.equal(done.loading, false);
  assert.deepEqual(done.data, []);
  assert.equal(done.preview, null);
  await env.act(async () => root.unmount());

  // Already loaded on this page: a new hook fetches no snapshot.
  const again = await render([() => env.sdk.useQuery("sales", { snapshot: true })]);
  await settle();
  assert.equal(count(".snapshot.json", "sales"), 1);
  assert.equal(again.seen.at(-1)[0].preview, null);
  await env.act(async () => again.root.unmount());
});

test("snapshot: a failed parquet clears the preview and shows the error", opts, async () => {
  const { seen, root } = await render([() => env.sdk.useQuery("broken", { snapshot: true })]);
  await settle();
  assert.ok(seen.at(-1)[0].preview);
  await env.act(async () => gate("broken").open(new Response('{"error":"boom"}', { status: 502 })));
  await settle();
  const last = seen.at(-1)[0];
  assert.equal(last.loading, false);
  assert.equal(last.data, null);
  assert.equal(last.preview, null);
  assert.match(last.error, /HTTP 502/);
  await env.act(async () => root.unmount());
});
