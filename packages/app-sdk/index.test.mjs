import assert from "node:assert/strict";
import module from "node:module";
import test from "node:test";

// The runtime without a browser: the shared engine, the binding loader and
// the wire protocol (phases). index.js imports react and DuckDB from jsDelivr: point the CDN URL at a
// fake engine. Skips where react is not installed (the publish job).
let sdk = null;
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
  sdk = await import("./index.js");
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
const opts = { skip: sdk ? false : "index.js not loadable here: " + why };
const duck = () => globalThis.__fakeDuck;

const fetches = [];
globalThis.fetch = async url => {
  fetches.push(String(url));
  if (String(url).startsWith("__data/missing.parquet")) {
    return new Response(JSON.stringify({ error: "no such binding", hint: "check the name" }), { status: 404 });
  }
  return new Response(new Uint8Array([80, 65, 82, 49, 1, 2, 3, 80, 65, 82, 49]), {
    status: 200,
    headers: { "content-length": "11" },
  });
};

test("getDuckDB: one shared engine per page", opts, async () => {
  const [a, b] = await Promise.all([sdk.getDuckDB(), sdk.getDuckDB()]);
  assert.equal(a, b);
  assert.equal(duck().boots, 1);
  assert.ok(duck().sql.includes("LOAD parquet"));
});

test("withConnection closes the connection, also on error", opts, async () => {
  const before = duck().open;
  assert.equal(await sdk.withConnection(async conn => (await conn.query("select 1")).numRows), 0);
  await assert.rejects(sdk.withConnection(conn => conn.query("FAIL")), /boom/);
  assert.equal(duck().open, before);
});

test("ensureBinding loads a table once and returns its name", opts, async () => {
  fetches.length = 0;
  const names = await Promise.all([sdk.ensureBinding("sales"), sdk.ensureBinding("sales")]);
  assert.deepEqual(names, ["sales", "sales"]);
  assert.equal(await sdk.ensureBinding("sales"), "sales");
  assert.deepEqual(fetches, ["__data/sales.parquet"]);
  assert.ok(duck().tables.has("sales"));
  assert.ok(duck().sql.some(q => q.startsWith('CREATE OR REPLACE TABLE "sales" AS SELECT * FROM read_parquet(')));
  assert.equal(duck().files.size, 0, "the file buffer is dropped once the table exists");
});

test("unloadBinding drops the table; the next ensure downloads again", opts, async () => {
  await sdk.ensureBinding("orders");
  fetches.length = 0;
  await sdk.unloadBinding("orders");
  assert.ok(!duck().tables.has("orders"));
  await sdk.ensureBinding("orders");
  assert.deepEqual(fetches, ["__data/orders.parquet"]);
  await sdk.unloadBinding("never-loaded"); // a no-op
});

test("ensureBinding rejects with the server's error and retries next time", opts, async () => {
  await assert.rejects(sdk.ensureBinding("missing"), err => {
    assert.equal(err.status, 404);
    assert.match(err.message, /Data for binding "missing" could not be loaded \(HTTP 404\): no such binding — check the name/);
    return true;
  });
  fetches.length = 0;
  await assert.rejects(sdk.ensureBinding("missing"));
  assert.deepEqual(fetches, ["__data/missing.parquet"]);
});

test("fetchBindingBytes: raw parquet, progress, fresh, nothing registered", opts, async () => {
  fetches.length = 0;
  const seen = [];
  const bytes = await sdk.fetchBindingBytes("raw", { onProgress: p => seen.push(p && { ...p }) });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 11);
  assert.equal(seen.at(-1), null);
  const last = seen.at(-2);
  assert.equal(last.phase, "downloading");
  assert.equal(last.bytes, 11);
  assert.equal(last.bytesTotal, 11);
  assert.ok(!duck().tables.has("raw"));
  await sdk.fetchBindingBytes("raw", { fresh: true });
  assert.equal(fetches[0], "__data/raw.parquet");
  assert.match(fetches[1], /^__data\/raw\.parquet\?refresh=\d+$/);
  await assert.rejects(sdk.fetchBindingBytes("missing"), err => err.status === 404);
});

test("the hooks and escape hatches are exported", opts, () => {
  for (const name of ["useDuckDB", "useQuery", "getDuckDB", "withConnection", "ensureBinding", "unloadBinding", "fetchBindingBytes", "refreshBinding", "setBindingMemoryBudget", "getBindingMemory"]) {
    assert.equal(typeof sdk[name], "function", name);
  }
});

// --- The phase protocol (SDK 2.7.4) ---

function ndjson(lines) {
  return new Response(lines.map(l => JSON.stringify(l)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });
}

test("refreshBinding asks for phases and reports each one", opts, async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url: String(url), method: init.method, accept: init.headers?.accept });
    return ndjson([
      { phase: "checking" },
      { phase: "querying_warehouse" },
      { phase: "writing_parquet", rowsWritten: 5000 },
      { phase: "failed", status: 502, error: "Syntax error at line 3" },
    ]);
  };
  const seen = [];
  try {
    await assert.rejects(
      sdk.refreshBinding("sales", { onProgress: p => seen.push(p && p.phase) }),
      e => e.status === 502 && /Syntax error/.test(e.message),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "__data/sales/refresh");
  assert.equal(asked[0].method, "POST");
  assert.match(asked[0].accept, /application\/x-ndjson/);
  assert.deepEqual(seen, ["requesting", "checking", "querying_warehouse", "writing_parquet", null]);
});

test("a server without phases still refreshes the old way", opts, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, error: "Refreshed recently", retryAfterMs: 9000 }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  try {
    await assert.rejects(sdk.refreshBinding("sales"), e => e.status === 429 && e.retryAfterMs === 9000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchBindingBytes follows the phase protocol and reports each phase", opts, async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url: String(url), accept: init.headers?.accept });
    if (asked.length === 1) {
      return ndjson([{ phase: "resolving" }, { phase: "signing" }, { phase: "ready", url: "https://gcs.test/signed" }]);
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-length": "4" } });
  };
  const seen = [];
  try {
    const bytes = await sdk.fetchBindingBytes("signed", { onProgress: p => seen.push(p && p.phase) });
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(asked[0].url, "__data/signed.parquet");
  assert.match(asked[0].accept, /application\/x-ndjson/);
  assert.equal(asked[1].url, "https://gcs.test/signed");
  assert.equal(seen[0], "requesting");
  assert.ok(seen.includes("resolving") && seen.includes("signing") && seen.includes("downloading"));
  assert.equal(seen.at(-1), null);
});

test("fetchBindingBytes relays a failed build", opts, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ndjson([{ phase: "querying_warehouse" }, { phase: "failed", status: 502, error: "Syntax error" }]);
  try {
    await assert.rejects(sdk.fetchBindingBytes("bad"), e => e.status === 502 && /Syntax error/.test(e.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("hostShortcutFor hands Cmd/Ctrl+K to the host and nothing else", opts, () => {
  const key = (k, mods = {}) => sdk.hostShortcutFor({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(key("k", { metaKey: true }), "mod+k");
  assert.equal(key("K", { ctrlKey: true }), "mod+k");
  assert.equal(key("k"), null);
  assert.equal(key("k", { metaKey: true, shiftKey: true }), null);
  assert.equal(key("k", { ctrlKey: true, altKey: true }), null);
  assert.equal(key("j", { metaKey: true }), null);
});

// --- Memory: LRU eviction of binding tables (SDK 2.12) ---
// Each fake table holds `tableBytes`; duckdb_memory() reports the sum.

async function freshMemory(budget, opts) {
  for (const b of (await sdk.getBindingMemory()).bindings) await sdk.unloadBinding(b.name);
  duck().tableBytes = 100;
  duck().oom = null;
  await sdk.setBindingMemoryBudget(budget, { blobBytes: Infinity, ...opts });
}
const storage = async () =>
  Object.fromEntries((await sdk.getBindingMemory()).bindings.map(b => [b.name, b.storage]));

test("over budget, the least recently used table becomes a view over its heap copy", opts, async () => {
  await freshMemory(250);
  await sdk.ensureBinding("m_a");
  await sdk.ensureBinding("m_b");
  await sdk.ensureBinding("m_c");
  assert.deepEqual(await storage(), { m_a: "view", m_b: "table", m_c: "table" });
  assert.ok(!duck().tables.has("m_a"));
  const file = duck().views.get("m_a");
  assert.equal(duck().files.get(file).length, 11, "a registered buffer, never a Blob handle");
  assert.equal(duck().handles.size, 0, "openFile on a Blob handle breaks past 2 GiB of heap");
  const mem = await sdk.getBindingMemory();
  assert.equal(mem.usedBytes, 211, "two tables and the view's parquet copy");
  assert.equal(mem.budgetBytes, 250);
  assert.deepEqual(mem.bindings.map(b => b.name), ["m_a", "m_b", "m_c"], "least recently read first");
});

test("a read bumps a binding: a demoted one comes back as a table, no download", opts, async () => {
  fetches.length = 0;
  await sdk.ensureBinding("m_a");
  assert.deepEqual(fetches, [], "promoted from its Blob");
  assert.deepEqual(await storage(), { m_a: "table", m_b: "view", m_c: "table" });
  assert.ok(duck().tables.has("m_a") && !duck().views.has("m_a"));
  const swap = duck().sql.findIndex(q => q === 'DROP VIEW IF EXISTS "m_a"');
  assert.equal(duck().sql[swap - 1], "BEGIN TRANSACTION", "the view is swapped for the table in one commit");
  assert.match(duck().sql[swap + 1], /^CREATE OR REPLACE TABLE "m_a"/);
  assert.equal(duck().sql[swap + 2], "COMMIT");
  // Bumping m_c makes m_a the oldest table: the next load demotes it.
  await sdk.ensureBinding("m_c");
  await sdk.ensureBinding("m_d");
  assert.deepEqual(await storage(), { m_b: "view", m_a: "view", m_c: "table", m_d: "table" });
});

test("a view's heap copy is released when it becomes a table again", opts, async () => {
  const file = duck().views.get("m_b");
  assert.ok(duck().files.has(file));
  await sdk.ensureBinding("m_b");
  assert.ok(!duck().files.has(file));
});

test("a lower budget trims at once; a higher one lets tables come back on read", opts, async () => {
  await freshMemory(Infinity);
  for (const n of ["m_e", "m_f", "m_g"]) await sdk.ensureBinding(n);
  assert.deepEqual(await storage(), { m_e: "table", m_f: "table", m_g: "table" });
  await sdk.setBindingMemoryBudget(130); // the table and two 11-byte parquet copies
  assert.deepEqual(await storage(), { m_e: "view", m_f: "view", m_g: "table" });
  await assert.rejects(sdk.setBindingMemoryBudget(0), TypeError);
  await assert.rejects(sdk.setBindingMemoryBudget(100, { blobBytes: -1 }), TypeError);
});

test("ensureBinding's views are never dropped, even past the Blob budget", opts, async () => {
  await freshMemory(150, { blobBytes: 15 });
  await sdk.ensureBinding("m_h");
  await sdk.ensureBinding("m_i");
  const s = await storage();
  assert.deepEqual(Object.keys(s).sort(), ["m_h", "m_i"], "still readable by name");
});

test("Out of Memory on a load demotes older tables and retries once", opts, async () => {
  await freshMemory(Infinity);
  await sdk.ensureBinding("m_j");
  await sdk.ensureBinding("m_k");
  duck().oom = /^CREATE OR REPLACE TABLE "m_l"/;
  await sdk.ensureBinding("m_l");
  const s = await storage();
  assert.equal(s.m_l, "table");
  assert.equal(s.m_j, "view", "the oldest went first");
  assert.equal(duck().sql.filter(q => q.startsWith('CREATE OR REPLACE TABLE "m_l"')).length, 2);
});

test("Out of Memory with nothing to free: the load lands as a view", opts, async () => {
  await freshMemory(Infinity);
  duck().oom = /^CREATE OR REPLACE TABLE "m_m"/;
  assert.equal(await sdk.ensureBinding("m_m"), "m_m");
  assert.deepEqual(await storage(), { m_m: "view" });
});

test("metadata says a table cannot fit: a view, with no decode", opts, async () => {
  await freshMemory(1000);
  duck().estimate = 1e12;
  await sdk.ensureBinding("m_n");
  assert.deepEqual(await storage(), { m_n: "view" });
  assert.ok(!duck().sql.some(q => q.startsWith('CREATE OR REPLACE TABLE "m_n"')));
  duck().estimate = undefined;
  await freshMemory(sdk.DEFAULT_BINDING_MEMORY_BUDGET);
});

test("one table past the budget may try when the heap is mostly empty, not when it is not", opts, async () => {
  await freshMemory(1000);
  duck().estimate = 1500;
  duck().tableBytes = 1500;
  await sdk.ensureBinding("m_big");
  assert.deepEqual(await storage(), { m_big: "table" }, "an ordinary app with one large parquet stays fast");
  await sdk.ensureBinding("m_big2");
  assert.equal((await storage()).m_big2, "view", "the heap is not empty any more");
  duck().estimate = undefined;
  await freshMemory(sdk.DEFAULT_BINDING_MEMORY_BUDGET);
});

test("an app's own tables do not shrink the budget, but do decide what fits the heap", opts, async () => {
  await freshMemory(250);
  duck().appBytes = 1000;
  await sdk.ensureBinding("m_app1");
  await sdk.ensureBinding("m_app2");
  assert.deepEqual(await storage(), { m_app1: "table", m_app2: "table" });
  const mem = await sdk.getBindingMemory();
  assert.equal(mem.bindingBytes, 200);
  assert.equal(mem.usedBytes, 1200);
  duck().appBytes = 3200 * 1024 * 1024;
  await sdk.ensureBinding("m_app3");
  assert.equal((await storage()).m_app3, "view");
  duck().appBytes = 0;
  await freshMemory(sdk.DEFAULT_BINDING_MEMORY_BUDGET);
});

test("parquet copies stop at 2.5 GiB: the oldest view goes, pinned or not", opts, async () => {
  const fresh = await import("./index.js?file-ceiling");
  await fresh.getDuckDB();
  duck().estimate = 1e12;
  const gib = new Uint8Array(1024 * 1024 * 1024);
  const real = globalThis.fetch;
  globalThis.fetch = async url =>
    String(url).startsWith("__data/m_gb") ? new Response(gib, { status: 200, headers: { "content-length": String(gib.length) } }) : real(url);
  for (const n of ["m_gb1", "m_gb2"]) await fresh.ensureBinding(n).then(() => fresh.unloadBinding("nothing"));
  const before = duck().files.size;
  assert.ok(before >= 2);
  // ensureBinding's views are never dropped, so: nothing to free, a clear error.
  await assert.rejects(fresh.ensureBinding("m_gb3"), /does not fit in this page's DuckDB heap/);
  await fresh.unloadBinding("m_gb1");
  await fresh.unloadBinding("m_gb2");
  globalThis.fetch = real;
  duck().estimate = undefined;
});

test("an unreadable Blob does not block eviction, and first placement never reads it", opts, async () => {
  const realRead = Blob.prototype.arrayBuffer;
  await freshMemory(150);
  Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException("could not be read", "NotReadableError"));
  try {
    await sdk.ensureBinding("m_nr");
    assert.equal((await storage()).m_nr, "table", "placement used the bytes in hand");
    await sdk.ensureBinding("m_nr2");
    assert.deepEqual(await storage(), { m_nr: "table", m_nr2: "view" }, "an ensureBinding table stays, and the new one lands from its bytes");
  } finally {
    Blob.prototype.arrayBuffer = realRead;
  }
  await freshMemory(sdk.DEFAULT_BINDING_MEMORY_BUDGET);
});

test("unloadBinding drops a view and its heap copy too", opts, async () => {
  await freshMemory(40);
  await sdk.ensureBinding("m_o");
  const file = duck().views.get("m_o");
  await sdk.unloadBinding("m_o");
  assert.ok(!duck().views.has("m_o") && !duck().files.has(file));
  await freshMemory(sdk.DEFAULT_BINDING_MEMORY_BUDGET);
  assert.equal(sdk.DEFAULT_BINDING_MEMORY_BUDGET, 1.5 * 1024 ** 3);
});
