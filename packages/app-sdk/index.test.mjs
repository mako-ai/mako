// The runtime's wire protocol, without DuckDB: what refreshBinding asks
// for and how it reports a server's phases. (The reload after a successful
// refresh needs DuckDB-WASM from the CDN, so these stop at a failure.)
import assert from "node:assert/strict";
import test from "node:test";

// Skips where react is not installed (the publish job installs nothing).
let refreshBinding = null;
let why = "";
try {
  ({ refreshBinding } = await import("./index.js"));
} catch (error) {
  why = error instanceof Error ? error.message : String(error);
}
const opts = { skip: refreshBinding ? false : "index.js not loadable here: " + why };

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
      refreshBinding("sales", { onProgress: p => seen.push(p && p.phase) }),
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
    await assert.rejects(refreshBinding("sales"), e => e.status === 429 && e.retryAfterMs === 9000);
  } finally {
    globalThis.fetch = realFetch;
  }
});
