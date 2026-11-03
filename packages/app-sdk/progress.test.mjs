import assert from "node:assert/strict";
import test from "node:test";
import {
  BINDING_PHASES,
  BINDING_PHASE_LABELS,
  bindingPhaseLabel,
  bindingPhaseStage,
  combineBindingProgress,
  isProgressResponse,
  progressError,
  readBytes,
  readProgressStream,
} from "./progress.js";

function ndjson(chunks) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

test("stages tell a build from a link from the browser's own work", () => {
  assert.equal(bindingPhaseStage("querying_warehouse"), "building");
  assert.equal(bindingPhaseStage("writing_parquet"), "building");
  assert.equal(bindingPhaseStage("signing"), "linking");
  assert.equal(bindingPhaseStage("resolving"), "linking");
  assert.equal(bindingPhaseStage("downloading"), "downloading");
  assert.equal(bindingPhaseStage("loading_duckdb"), "loading");
  assert.equal(bindingPhaseStage("ready"), null);
  for (const phase of BINDING_PHASES) {
    assert.ok(bindingPhaseStage(phase), phase + " has a stage");
    assert.ok(BINDING_PHASE_LABELS[phase], phase + " has a label");
  }
});

test("labels name the wait, with rows or bytes when known", () => {
  assert.equal(bindingPhaseLabel("signing"), "Getting download link");
  assert.equal(
    bindingPhaseLabel({ phase: "writing_parquet", rowsWritten: 120000 }),
    "Building from warehouse · 120,000 rows",
  );
  assert.equal(
    bindingPhaseLabel({ phase: "downloading", bytes: 3 * 1048576, bytesTotal: 10 * 1048576 }),
    "Downloading · 3.0 MB of 10.0 MB",
  );
  assert.equal(bindingPhaseLabel({ phase: "loading_duckdb" }), "Loading into DuckDB");
  assert.equal(bindingPhaseLabel(null), "");
});

test("several pending bindings show the slowest wait, summed", () => {
  assert.equal(combineBindingProgress({}), null);
  const combined = combineBindingProgress({
    a: { phase: "downloading", bytes: 100, bytesTotal: 400 },
    b: { phase: "querying_warehouse" },
    c: { phase: "writing_parquet", rowsWritten: 5000 },
    d: { phase: "signing" },
  });
  assert.equal(bindingPhaseStage(combined.phase), "building");
  assert.equal(combined.rowsWritten, 5000);
  assert.equal(combined.pending, 4);
  const downloads = combineBindingProgress({
    a: { phase: "downloading", bytes: 100, bytesTotal: 400 },
    b: { phase: "downloading", bytes: 50, bytesTotal: 100 },
    c: { phase: "loading_duckdb" },
  });
  assert.equal(downloads.phase, "downloading");
  assert.equal(downloads.bytes, 150);
  assert.equal(downloads.bytesTotal, 500);
});

test("a phase stream: every event, then the terminal one, across chunk splits", async () => {
  const seen = [];
  const res = ndjson([
    '{"phase":"resolving"}\n{"pha',
    'se":"signing"}\n',
    '{"phase":"ready","url":"https://storage.test/x?sig=1","timings":{"resolveMs":3}}\n',
  ]);
  assert.ok(isProgressResponse(res));
  const final = await readProgressStream(res, e => seen.push(e.phase));
  assert.deepEqual(seen, ["resolving", "signing"]);
  assert.equal(final.phase, "ready");
  assert.equal(final.url, "https://storage.test/x?sig=1");
});

test("a stream that ends without a terminal event is a 502 failure", async () => {
  const final = await readProgressStream(ndjson(['{"phase":"querying_warehouse"}\n']), () => {});
  assert.equal(final.phase, "failed");
  assert.equal(final.status, 502);
});

test("a failed event becomes the same Error an HTTP failure does", () => {
  const error = progressError(
    { phase: "failed", status: 429, error: "Refreshed recently", retryAfterMs: 5000 },
    'Binding "sales" could not be refreshed',
  );
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 5000);
  assert.match(error.message, /\(HTTP 429\): Refreshed recently/);
});

test("plain parquet is not a phase stream", () => {
  const res = new Response("PAR1", { headers: { "content-type": "application/vnd.apache.parquet" } });
  assert.equal(isProgressResponse(res), false);
});

test("readBytes reports progress against Content-Length", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.enqueue(new Uint8Array([4, 5]));
      c.close();
    },
  });
  const res = new Response(body, { headers: { "content-length": "5" } });
  const seen = [];
  const buf = await readBytes(res, (n, total) => seen.push([n, total]));
  assert.deepEqual([...buf], [1, 2, 3, 4, 5]);
  assert.deepEqual(seen, [[0, 5], [3, 5], [5, 5]]);
});
