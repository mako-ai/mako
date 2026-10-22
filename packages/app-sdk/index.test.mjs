import { test } from "node:test";
import assert from "node:assert/strict";

const { __parquet: parquet } = await import("./index.js");
const { DEFAULT_RANGE_THRESHOLD_BYTES } = parquet;

const {
  chooseParquetLoad,
  isExpiredUrlError,
  parquetForceMode,
  rangeThresholdBytes,
  fetchBindingMeta,
} = parquet;

const SIGNED = {
  url: "https://storage.googleapis.com/bucket/k.parquet?X-Goog-Signature=abc",
  size: DEFAULT_RANGE_THRESHOLD_BYTES,
  expiresAt: "2026-10-22T00:10:00.000Z",
};

test("DEFAULT_RANGE_THRESHOLD_BYTES is 8 MiB", () => {
  assert.equal(DEFAULT_RANGE_THRESHOLD_BYTES, 8 * 1024 * 1024);
});

test("chooseParquetLoad: missing meta, missing url, or small files stay on buffer", () => {
  assert.equal(chooseParquetLoad(null, null, 8), "buffer");
  assert.equal(chooseParquetLoad({ url: null, size: 99 }, null, 8), "buffer");
  assert.equal(chooseParquetLoad({ url: "", size: 99 }, null, 8), "buffer");
  assert.equal(
    chooseParquetLoad({ url: SIGNED.url, size: 7 }, null, 8),
    "buffer",
  );
  assert.equal(
    chooseParquetLoad({ url: SIGNED.url, size: 8 }, null, 8),
    "range",
  );
  assert.equal(
    chooseParquetLoad({ url: SIGNED.url, size: null }, null, 8),
    "buffer",
  );
});

test("chooseParquetLoad honors force buffer/range over the size gate", () => {
  assert.equal(chooseParquetLoad(SIGNED, "buffer", 0), "buffer");
  assert.equal(
    chooseParquetLoad({ url: SIGNED.url, size: 1 }, "range", 99),
    "range",
  );
  // Force range still needs a URL — there is nothing to register.
  assert.equal(chooseParquetLoad({ url: null, size: 99 }, "range", 0), "buffer");
});

test("isExpiredUrlError matches 403 / GCS signature expiry, not generic IO", () => {
  assert.equal(isExpiredUrlError({ status: 403, message: "nope" }), true);
  assert.equal(
    isExpiredUrlError(new Error("HTTP GET error on 'https://…' (HTTP 403)")),
    true,
  );
  assert.equal(isExpiredUrlError(new Error("403 Forbidden")), true);
  assert.equal(isExpiredUrlError(new Error("AccessDenied: expired")), true);
  assert.equal(isExpiredUrlError(new Error("SignatureDoesNotMatch")), true);
  assert.equal(isExpiredUrlError(new Error("Catalog Error: Table missing")), false);
  assert.equal(isExpiredUrlError(new Error("IO Error: Connection reset")), false);
});

test("parquetForceMode reads ?mako_parquet= then localStorage", () => {
  const prior = globalThis.window;
  const store = { mako_parquet: "buffer" };
  globalThis.window = {
    location: { search: "?mako_parquet=range&other=1" },
    localStorage: { getItem: k => store[k] ?? null },
  };
  try {
    assert.equal(parquetForceMode(), "range", "query wins");
    globalThis.window.location.search = "";
    assert.equal(parquetForceMode(), "buffer");
    store.mako_parquet = "nope";
    assert.equal(parquetForceMode(), null);
  } finally {
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  }
});

test("rangeThresholdBytes reads window.__MAKO_RANGE_THRESHOLD_BYTES", () => {
  const prior = globalThis.window;
  globalThis.window = { __MAKO_RANGE_THRESHOLD_BYTES: 1 };
  try {
    assert.equal(rangeThresholdBytes(), 1);
    globalThis.window.__MAKO_RANGE_THRESHOLD_BYTES = -1;
    assert.equal(rangeThresholdBytes(), DEFAULT_RANGE_THRESHOLD_BYTES);
    globalThis.window.__MAKO_RANGE_THRESHOLD_BYTES = "8";
    assert.equal(rangeThresholdBytes(), DEFAULT_RANGE_THRESHOLD_BYTES);
  } finally {
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  }
});

test("fetchBindingMeta: 404 / HTML / invalid body → null; https URL is kept", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("missing")) return new Response("nope", { status: 404 });
    if (String(url).includes("html")) {
      return new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (String(url).includes("relative")) {
      return new Response(JSON.stringify({ url: "__data/sales.parquet", size: 9 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(SIGNED), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    assert.equal(await fetchBindingMeta("missing", false), null);
    assert.equal(await fetchBindingMeta("html", false), null);
    const relative = await fetchBindingMeta("relative", false);
    assert.equal(relative.url, null);
    assert.equal(relative.size, 9);
    const ok = await fetchBindingMeta("sales", true);
    assert.equal(ok.url, SIGNED.url);
    assert.equal(ok.size, SIGNED.size);
    assert.ok(calls.some(u => u.includes(".meta.json?refresh=")));
  } finally {
    globalThis.fetch = realFetch;
  }
});
