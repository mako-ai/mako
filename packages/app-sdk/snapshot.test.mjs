import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBindingSnapshot, snapshotUrl } from "./data-core.js";

const body = extra => ({
  version: 1,
  builtAt: "2026-10-22T00:00:00.000Z",
  rowCount: 3,
  fields: [
    { name: "n", type: "BIGINT" },
    { name: "x", type: "DOUBLE" },
    { name: "d", type: "DATE" },
  ],
  rows: [
    { n: 1, x: 1.5, d: "2026-10-01" },
    { n: "9007199254740993", x: "NaN", d: null },
    { n: null, x: "-Infinity", d: "2026-10-03" },
  ],
  ...extra,
});

test("snapshotUrl is app-relative like the parquet path", () => {
  assert.equal(snapshotUrl("latest_sales"), "__data/latest_sales.snapshot.json");
});

test("parseBindingSnapshot restores what JSON cannot carry", () => {
  const s = parseBindingSnapshot(body());
  assert.deepEqual(s.fields, ["n", "x", "d"]);
  assert.equal(s.data[1].n, 9007199254740993n);
  assert.ok(Number.isNaN(s.data[1].x));
  assert.equal(s.data[2].x, -Infinity);
  assert.equal(s.data[2].n, null);
  assert.equal(s.data[0].d, "2026-10-01");
  assert.equal(s.truncated, false);
  assert.equal(s.rowCount, 3);
});

test("parseBindingSnapshot slices to rowLimit and reports truncation", () => {
  const s = parseBindingSnapshot(body(), 2);
  assert.equal(s.data.length, 2);
  assert.equal(s.truncated, true);
  assert.equal(parseBindingSnapshot(body(), null).data.length, 3);
});

test("parseBindingSnapshot rejects junk and unknown types", () => {
  assert.equal(parseBindingSnapshot(null), null);
  assert.equal(parseBindingSnapshot(body({ version: 2 })), null);
  assert.equal(parseBindingSnapshot(body({ rows: "x" })), null);
  assert.equal(parseBindingSnapshot(body({ rowCount: -1 })), null);
  assert.equal(parseBindingSnapshot(body({ fields: [{ name: "a", type: "DECIMAL(10,2)" }] })), null);
  assert.equal(parseBindingSnapshot(body({ fields: [{}] })), null);
});

test("SDK_VERSION in index.js is package.json's version", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.equal(/export const SDK_VERSION = "([^"]+)"/.exec(src)?.[1], pkg.version);
});
