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
  for (const name of ["useDuckDB", "useQuery", "getDuckDB", "withConnection", "ensureBinding", "unloadBinding", "fetchBindingBytes", "refreshBinding"]) {
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
