import assert from "node:assert/strict";
import module, { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The seam lets the test hold a conversion after its signal is cancelled.
// Without a mock it calls the production converter.
const core = new URL("./data-core.js", import.meta.url).href;
const fake = new URL("./test-support/fake-duckdb.mjs", import.meta.url).href;
const dependencyRoot = process.env.SDK_TEST_DEPENDENCIES;
const installed = createRequire(dependencyRoot ? dependencyRoot + "/packages/app-sdk/package.json" : import.meta.url);
const appRequire = createRequire(dependencyRoot ? dependencyRoot + "/app/package.json" : new URL("../../app/package.json", import.meta.url));
let reactUrls;
let React;
let createRoot;
let sdk;
let dom;
let arrow;
let why = "";
try {
  if (typeof module.registerHooks !== "function") throw new Error("Node without module.registerHooks");
  reactUrls = Object.fromEntries(["react", "react-dom/client"].map(name => [name, pathToFileURL(installed.resolve(name)).href]));
  appRequire("jsdom");
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
const dataUrl = source => "data:text/javascript," + encodeURIComponent(source);
const coreMock = dataUrl(`export * from ${JSON.stringify(core)}; import { toPlainRowsCooperative as real } from ${JSON.stringify(core)}; export const toPlainRowsCooperative = (...args) => globalThis.__cooperativeTest ? globalThis.__cooperativeTest(...args) : real(...args);`);
const fakeMock = dataUrl(`
  export * from ${JSON.stringify(fake)};
  import { AsyncDuckDB as Base } from ${JSON.stringify(fake)};
  export class AsyncDuckDB extends Base {
    async connect() {
      const conn = await super.connect();
      const query = conn.query;
      conn.query = async sql => {
        if (sql === 'SELECT test_real') return globalThis.__cooperativeArrow;
        if (!sql.startsWith('SELECT test_')) return query(sql);
        const n = Number(sql.slice(12));
        return { numRows: n, schema: { fields: [{ name: 'field' + n, type: 'Int32' }] },
          getChildAt: () => ({ *[Symbol.iterator]() { for (let i = 0; i < n; i++) yield n; } }), [Symbol.iterator]: [][Symbol.iterator] };
      };
      return conn;
    }
  }
`);
if (!why) try {
module.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./data-core.js" && context.parentURL === new URL("./index.js", import.meta.url).href) return { url: coreMock, shortCircuit: true };
    if (specifier.startsWith("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm")) return { url: fakeMock, shortCircuit: true };
    if (reactUrls[specifier]) return { url: reactUrls[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});
const { JSDOM } = appRequire("jsdom");
dom = new JSDOM("<!doctype html><div id=root></div>", { url: "https://app.test/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response("[]");
React = await import("react");
({ createRoot } = await import("react-dom/client"));
sdk = await import("./index.js");
try { arrow = installed("apache-arrow"); } catch { /* Optional in the no-install test job. */ }
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
const opts = { skip: why ? "hooks not renderable here: " + why : false };
const arrowOpts = { skip: why ? "hooks not renderable here: " + why : !arrow ? "apache-arrow not installed" : false };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) {
  for (let i = 0; i < 150 && !predicate(); i++) await React.act(pause);
  assert.ok(predicate(), "timed out waiting for hook");
}

test("superseded index lookup takes no binding pins or downloads", opts, async () => {
  let release;
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (String(url) === "__data/index.json") return new Promise(resolve => { release = () => resolve(new Response('["abandoned"]')); });
    return new Response("[]");
  };
  globalThis.__cooperativeTest = async () => ({ rows: [{ value: 1 }], fields: ["value"] });
  const seen = [];
  function Probe({ sql }) { seen.push(sdk.useDuckDB(sql, { cooperative: true })); return null; }
  const root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Probe, { sql: "SELECT * FROM abandoned" })));
  await until(() => Boolean(release));
  await React.act(async () => root.render(React.createElement(Probe, { sql: "SELECT test_1" })));
  await React.act(async () => release());
  await until(() => seen.at(-1).data?.[0]?.value === 1);
  assert.equal(requests.some(url => url.includes("abandoned.parquet")), false);
  assert.equal((await sdk.getBindingMemory()).bindings.some(binding => binding.name === "abandoned"), false);
  await React.act(async () => root.unmount());
  globalThis.fetch = async () => new Response("[]");
});

test("cooperative conversion cancels old work and publishes complete results together", opts, async () => {
  const seen = [];
  const pending = [];
  globalThis.__cooperativeTest = (table, cap, { signal }) => new Promise((resolve, reject) => {
    pending.push({ table, cap, signal, resolve, reject });
  });
  function Probe({ sql }) {
    seen.push(sdk.useDuckDB(sql, { cooperative: true, rowLimit: 3 }));
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  const render = sql => React.act(async () => root.render(React.createElement(Probe, { sql })));
  await render("SELECT test_1");
  await until(() => pending.length === 1);
  await React.act(async () => pending[0].resolve({ rows: [{ v: 1 }], fields: ["field1"] }));
  await until(() => seen.at(-1).rowCount === 1);
  await render("SELECT test_2");
  await until(() => pending.length === 2);
  assert.deepEqual(seen.at(-1).data, [{ v: 1 }]);
  await render("SELECT test_3");
  await until(() => pending.length === 3);
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(pending[2].cap, 3);
  await React.act(async () => pending[2].resolve({ rows: [{ v: 3 }, { v: 3 }, { v: 3 }], fields: ["field3"] }));
  await until(() => seen.at(-1).rowCount === 3);
  const published = seen.length;
  await React.act(async () => pending[1].resolve({ rows: [{ v: 2 }], fields: ["field2"] }));
  await React.act(pause);
  for (const state of seen.slice(published - 1)) {
    assert.deepEqual({ data: state.data, fields: state.fields, rowCount: state.rowCount, truncated: state.truncated, error: state.error, loading: state.loading, refreshing: state.refreshing }, {
      data: [{ v: 3 }, { v: 3 }, { v: 3 }], fields: ["field3"], rowCount: 3, truncated: false, error: null, loading: false, refreshing: false,
    });
  }
  await render("SELECT test_4");
  await until(() => pending.length === 4);
  await React.act(async () => pending[3].reject(new Error("conversion failed")));
  await until(() => seen.at(-1).error === "conversion failed");
  const failed = seen.at(-1);
  assert.deepEqual({ data: failed.data, fields: failed.fields, rowCount: failed.rowCount, truncated: failed.truncated, error: failed.error, loading: failed.loading, refreshing: failed.refreshing }, {
    data: [{ v: 3 }, { v: 3 }, { v: 3 }], fields: ["field3"], rowCount: 3, truncated: false, error: "conversion failed", loading: false, refreshing: false,
  });
  await React.act(async () => root.unmount());
});

test("same SQL refresh cancels the old conversion", opts, async () => {
  const seen = [];
  const pending = [];
  globalThis.__cooperativeTest = (table, cap, { signal }) => new Promise(resolve => pending.push({ signal, resolve }));
  function Probe() {
    seen.push(sdk.useDuckDB("SELECT test_1", { cooperative: true }));
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Probe)));
  await until(() => pending.length === 1);
  await React.act(async () => { await sdk.refreshBinding("unused_test_binding"); });
  await until(() => pending.length === 2);
  assert.equal(pending[0].signal.aborted, true);
  await React.act(async () => pending[1].resolve({ rows: [{ value: "new" }], fields: ["new"] }));
  await until(() => seen.at(-1).data?.[0]?.value === "new");
  const published = seen.length;
  await React.act(async () => pending[0].resolve({ rows: [], fields: ["old"] }));
  await React.act(pause);
  for (const state of seen.slice(published - 1)) {
    assert.deepEqual({ data: state.data, fields: state.fields, rowCount: state.rowCount, truncated: state.truncated, error: state.error, loading: state.loading, refreshing: state.refreshing }, {
      data: [{ value: "new" }], fields: ["new"], rowCount: 1, truncated: false, error: null, loading: false, refreshing: false,
    });
  }
  await React.act(async () => root.unmount());
});

test("cancelled OOM query cannot evict or retry after queued relief", opts, async () => {
  const engine = await sdk.getDuckDB();
  const fakeDuck = globalThis.__fakeDuck;
  const originalConnect = engine.connect;
  const originalFetch = globalThis.fetch;
  const originalThen = Promise.prototype.then;
  let releaseMeasurement;
  let measurementStarted;
  let reliefQueued;
  const started = new Promise(resolve => { measurementStarted = resolve; });
  const queued = new Promise(resolve => { reliefQueued = resolve; });
  const blocker = new Promise(resolve => { releaseMeasurement = resolve; });
  let root;
  try {
    fakeDuck.tableBytes = 100;
    globalThis.fetch = async url => String(url).includes("oom_victim.parquet")
      ? new Response(new Uint8Array([80, 65, 82, 49, 80, 65, 82, 49]), { headers: { "content-length": "8" } })
      : new Response("[]");
    await sdk.setBindingMemoryBudget(Infinity, { blobBytes: Infinity });
    await sdk.ensureBinding("oom_victim");
    assert.equal((await sdk.getBindingMemory()).bindings.find(b => b.name === "oom_victim").storage, "table");

    // Hold one catalog operation in DuckDB while the OOM path queues behind it.
    let hold = true;
    engine.connect = async function () {
      const conn = await originalConnect.call(this);
      const query = conn.query;
      conn.query = async sql => {
        if (hold && sql.includes("FROM duckdb_memory()")) {
          hold = false;
          measurementStarted();
          await blocker;
        }
        return query(sql);
      };
      return conn;
    };
    const measurement = sdk.getBindingMemory();
    await started;
    Promise.prototype.then = function (onFulfilled, onRejected) {
      // Observe the actual callback enqueued by runSql, rather than sleeping
      // and assuming it has reached the catalog queue.
      if (typeof onFulfilled === "function" && String(onFulfilled).includes("return relieveNow(engine, null, reads)")) reliefQueued();
      return originalThen.call(this, onFulfilled, onRejected);
    };
    const sql = "SELECT oom_queued";
    const before = fakeDuck.sql.filter(q => q === sql).length;
    fakeDuck.oom = /^SELECT oom_queued$/;
    fakeDuck.oomTimes = 1;
    globalThis.__cooperativeTest = async () => ({ rows: [{ value: 1 }], fields: ["value"] });
    const seen = [];
    function Probe({ query }) { seen.push(sdk.useDuckDB(query, { cooperative: true })); return null; }
    root = createRoot(document.getElementById("root"));
    await React.act(async () => root.render(React.createElement(Probe, { query: sql })));
    await React.act(async () => { await queued; });
    assert.equal(fakeDuck.sql.filter(q => q === sql).length, before + 1);
    await React.act(async () => root.render(React.createElement(Probe, { query: "SELECT test_1" })));
    await until(() => seen.at(-1).data?.[0]?.value === 1);
    Promise.prototype.then = originalThen;
    await React.act(async () => { releaseMeasurement(); await measurement; });
    // This measurement queues after relief and proves that the queue drained.
    const memory = await sdk.getBindingMemory();
    assert.equal(memory.bindings.find(b => b.name === "oom_victim").storage, "table");
    assert.equal(fakeDuck.sql.filter(q => q === sql).length, before + 1);
  } finally {
    Promise.prototype.then = originalThen;
    releaseMeasurement();
    engine.connect = originalConnect;
    fakeDuck.oom = null;
    fakeDuck.tableBytes = 0;
    globalThis.fetch = originalFetch;
    if (root) await React.act(async () => root.unmount());
    await sdk.unloadBinding("oom_victim");
  }
});

test("hook converts a real Arrow table with the production converter", arrowOpts, async () => {
  const values = Array.from({ length: 700 }, (_, i) => i === 1 ? "Zürich" : `row ${i}`);
  globalThis.__cooperativeArrow = arrow.tableFromArrays({ value: values });
  globalThis.__cooperativeTest = null;
  const seen = [];
  function Probe() {
    seen.push(sdk.useDuckDB("SELECT test_real", { cooperative: true, rowLimit: 600 }));
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Probe)));
  await until(() => seen.at(-1).loading === false);
  const state = seen.at(-1);
  assert.equal(state.error, null);
  assert.deepEqual(state.data, values.slice(0, 600).map(value => ({ value })));
  assert.deepEqual(state.fields, ["value"]);
  assert.equal(state.rowCount, 700);
  assert.equal(state.truncated, true);
  await React.act(async () => root.unmount());
  delete globalThis.__cooperativeArrow;
});

test("format changes hide the previous incompatible result", opts, async () => {
  const seen = [];
  let finish;
  globalThis.__cooperativeTest = () => new Promise(resolve => { finish = resolve; });
  function Probe({ rows }) {
    seen.push(sdk.useDuckDB("SELECT test_1", rows ? { cooperative: true } : { format: "arrow" }));
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Probe, { rows: false })));
  await until(() => seen.at(-1).data?.numRows === 1);
  const start = seen.length;
  await React.act(async () => root.render(React.createElement(Probe, { rows: true })));
  await until(() => Boolean(finish));
  for (const state of seen.slice(start)) assert.equal(state.data, null);
  await React.act(async () => finish({ rows: [{ value: 1 }], fields: ["value"] }));
  await until(() => seen.at(-1).data?.[0]?.value === 1);
  await React.act(async () => root.unmount());
});

test("default rows and arrow bypass cooperative conversion", opts, async () => {
  const seen = [];
  globalThis.__cooperativeTest = () => { throw new Error("unexpected cooperative conversion"); };
  function Probe({ arrow }) {
    seen.push(sdk.useDuckDB("SELECT test_1", arrow ? { format: "arrow", cooperative: true } : undefined));
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  await React.act(async () => root.render(React.createElement(Probe, { arrow: false })));
  await until(() => seen.at(-1).loading === false);
  assert.deepEqual(seen.at(-1).data, [{ field1: 1 }]);
  await React.act(async () => root.render(React.createElement(Probe, { arrow: true })));
  await until(() => seen.at(-1).data?.numRows === 1);
  assert.equal(seen.at(-1).data.schema.fields[0].name, "field1");
  await React.act(async () => root.unmount());
});
