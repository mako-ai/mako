/**
 * Binding snapshot: a preview row must decode to EXACTLY what the parquet
 * path hands the app for the same row. Each case builds a parquet, takes
 * the server's snapshot of it, then reads the same file the way a browser
 * does — DuckDB-WASM (the app package's copy, run in Node) and the SDK's
 * own toPlainRows — and compares that with the SDK's decode of the
 * snapshot. Plus the caps, the unsupported-type refusal and the store order.
 *
 * Run: tsx src/services/binding-snapshot.test.ts
 */
/* eslint-disable no-console */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  snapshotArtifactKey,
  snapshotFromParquet,
  storeParquetWithSnapshot,
  type BindingSnapshot,
} from "./binding-snapshot";
import { buildParquetFromBatches } from "../utils/streaming-parquet-builder";
import type { ArtifactStore } from "./artifact-store.service";

const repoRoot = path.resolve(__dirname, "../../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "binding-snapshot-test-"));

interface SdkRows {
  toPlainRows: (
    table: unknown,
    cap?: number | null,
  ) => { rows: Record<string, unknown>[]; fields: string[] };
  parseBindingSnapshot: (
    body: unknown,
    rowLimit?: number | null,
  ) => { data: Record<string, unknown>[]; fields: string[] } | null;
}

async function sdkRows(): Promise<SdkRows> {
  return (await import(
    pathToFileURL(path.join(repoRoot, "packages/app-sdk/data-core.js")).href
  )) as SdkRows;
}

// DuckDB-WASM in Node: the engine the SDK runs in the browser.
type WasmDb = {
  registerFileBuffer(name: string, buf: Uint8Array): void;
  connect(): { query(sql: string): unknown; close(): void };
};
let wasm: Promise<WasmDb> | null = null;
function wasmDb(): Promise<WasmDb> {
  wasm ??= (async () => {
    const req = createRequire(path.join(repoRoot, "app/package.json"));
    const entry = req.resolve(
      "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs",
    );
    const duckdb = req(entry);
    const dist = path.dirname(entry);
    const db = await duckdb.createDuckDB(
      {
        mvp: {
          mainModule: path.join(dist, "duckdb-mvp.wasm"),
          mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
        },
        eh: {
          mainModule: path.join(dist, "duckdb-eh.wasm"),
          mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs"),
        },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    return db as WasmDb;
  })();
  return wasm;
}

let fileSeq = 0;
async function parquetRowsAsTheSdkSeesThem(
  parquetPath: string,
): Promise<{ rows: Record<string, unknown>[]; fields: string[] }> {
  const db = await wasmDb();
  const name = `f${fileSeq++}.parquet`;
  db.registerFileBuffer(name, new Uint8Array(fs.readFileSync(parquetPath)));
  const conn = db.connect();
  try {
    const table = conn.query(`SELECT * FROM read_parquet('${name}')`);
    return (await sdkRows()).toPlainRows(table, null);
  } finally {
    conn.close();
  }
}

async function assertSnapshotMatchesParquet(
  parquetPath: string,
  rowCount: number,
): Promise<BindingSnapshot> {
  const snapshot = await snapshotFromParquet(parquetPath, rowCount);
  assert.ok(snapshot, "expected a snapshot");
  // Through JSON, exactly as it travels.
  const wire = JSON.parse(JSON.stringify(snapshot));
  const decoded = (await sdkRows()).parseBindingSnapshot(wire, null);
  assert.ok(decoded, "the SDK must accept the server's snapshot");
  const parquet = await parquetRowsAsTheSdkSeesThem(parquetPath);
  assert.deepEqual(decoded.fields, parquet.fields);
  assert.deepEqual(decoded.data, parquet.rows.slice(0, decoded.data.length));
  return snapshot;
}

async function nativeParquet(sql: string): Promise<string> {
  const file = path.join(tmp, `native-${fileSeq++}.parquet`);
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `COPY (${sql}) TO '${file}' (FORMAT PARQUET, COMPRESSION SNAPPY)`,
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  return file;
}

function testArtifactKey() {
  assert.equal(
    snapshotArtifactKey("apps/bindings/conn/abc.parquet"),
    "apps/bindings/conn/abc.snapshot.json",
  );
  assert.equal(
    snapshotArtifactKey("apps/drafts/p/hash-id.parquet"),
    "apps/drafts/p/hash-id.snapshot.json",
  );
}

// What the binding builder writes from driver rows: dates, timestamps,
// decimals (driver NUMERIC → DOUBLE), 64-bit integers past 2^53, nulls, and
// nested values (written as JSON text).
async function testBuilderRowsMatchTheSdk() {
  const built = await buildParquetFromBatches({
    filenameBase: "snapshot-test",
    fields: [
      { name: "id", type: "INT64" },
      { name: "big", type: "INT64" },
      { name: "amount", type: "NUMERIC" },
      { name: "day", type: "DATE" },
      { name: "at", type: "TIMESTAMP" },
      { name: "flag", type: "BOOL" },
      { name: "name", type: "STRING" },
      { name: "tags", type: "ARRAY" },
      { name: "meta", type: "RECORD" },
    ],
    streamBatches: async insert => {
      await insert([
        {
          id: 1,
          big: 9007199254740993n,
          amount: "1234.56",
          day: "2026-10-01",
          at: new Date("2026-10-01T12:34:56.789Z"),
          flag: true,
          name: "Zürich",
          tags: ["a", "b"],
          meta: { k: 1, nested: { x: null } },
        },
        {
          id: -2,
          big: -9007199254740993n,
          amount: 0.1,
          day: new Date("1969-12-31T00:00:00Z"),
          at: "1969-12-31T23:59:59.999Z",
          flag: false,
          name: "",
          tags: [],
          meta: {},
        },
        {
          id: null,
          big: null,
          amount: null,
          day: null,
          at: null,
          flag: null,
          name: null,
          tags: null,
          meta: null,
        },
      ]);
    },
  });
  try {
    const snapshot = await assertSnapshotMatchesParquet(built.filePath, 3);
    assert.equal(snapshot.rowCount, 3);
    assert.equal(snapshot.truncated, false);
    // The values that would have drifted without the server-side decode.
    assert.equal(snapshot.rows[0].big, "9007199254740993");
    assert.equal(snapshot.rows[0].at, "2026-10-01T12:34:56.789Z");
    assert.equal(snapshot.rows[0].tags, '["a","b"]');
  } finally {
    fs.rmSync(built.filePath, { force: true });
  }
}

// Types the builder does not write today, but a parquet can hold: DATE,
// every TIMESTAMP precision and zone, FLOAT, non-finite DOUBLE, unsigned.
async function testNativeTypesMatchTheSdk() {
  const file = await nativeParquet(`
    SELECT * FROM (VALUES
      (DATE '2024-02-29', TIMESTAMP '2024-01-02 03:04:05.123456',
       TIMESTAMPTZ '2024-01-02 03:04:05+00', TIMESTAMP_NS '2024-01-02 03:04:05.123456789',
       TIMESTAMP_MS '2024-01-02 03:04:05.123', TIMESTAMP_S '2024-01-02 03:04:05',
       0.1::FLOAT, 'nan'::DOUBLE, 18446744073709551615::UBIGINT, 7::INTEGER, 3::TINYINT),
      (DATE '1960-01-01', TIMESTAMP '1969-12-31 23:59:59.9985',
       NULL, NULL, NULL, NULL,
       NULL, 'inf'::DOUBLE, 1::UBIGINT, NULL, NULL),
      (NULL, NULL, NULL, NULL, NULL, NULL, NULL, '-inf'::DOUBLE, NULL, NULL, NULL)
    ) t(d, ts, tz, tns, tms, tsec, f, x, u, i, ti)`);
  const snapshot = await assertSnapshotMatchesParquet(file, 3);
  assert.equal(snapshot.rows[0].d, "2024-02-29");
  assert.equal(snapshot.rows[0].x, "NaN");
  assert.equal(snapshot.rows[0].u, "18446744073709551615");
}

async function testUnsupportedTypesGetNoSnapshot() {
  for (const sql of [
    "SELECT 1.25::DECIMAL(10,2) AS d",
    "SELECT [1, 2] AS l",
    "SELECT {'a': 1} AS s",
    "SELECT 1 AS ok, MAP {'k': 1} AS m",
  ]) {
    const file = await nativeParquet(sql);
    assert.equal(await snapshotFromParquet(file, 1), null, sql);
  }
}

async function testCaps() {
  const file = await nativeParquet(
    "SELECT range AS n, repeat('x', 100) AS pad FROM range(50)",
  );
  const byRows = await snapshotFromParquet(file, 50, { maxRows: 10 });
  assert.equal(byRows?.rows.length, 10);
  assert.equal(byRows?.snapshotRowCount, 10);
  assert.equal(byRows?.rowCount, 50);
  assert.equal(byRows?.truncated, true);
  // First rows in file order: the build stream's order, no sorting.
  assert.deepEqual(
    byRows?.rows.map(r => r.n),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const byBytes = await snapshotFromParquet(file, 50, { maxBytes: 300 });
  assert.equal(byBytes?.rows.length, 2);
  // One row wider than the cap still paints.
  const oneWide = await snapshotFromParquet(file, 50, { maxBytes: 10 });
  assert.equal(oneWide?.rows.length, 1);
  const empty = await nativeParquet("SELECT 1 AS n WHERE false");
  const none = await snapshotFromParquet(empty, 0);
  assert.deepEqual(none?.rows, []);
  assert.deepEqual(none?.fields, [{ name: "n", type: "INTEGER" }]);
  assert.equal(none?.truncated, false);
}

function fakeStore(
  ops: string[],
  fail: { delete?: boolean; put?: boolean } = {},
): ArtifactStore {
  return {
    delete: async (key: string) => {
      ops.push(`delete ${key}`);
      if (fail.delete) throw new Error("delete failed");
    },
    putBuffer: async (_buf: Buffer | Uint8Array, key: string) => {
      ops.push(`put ${key}`);
      if (fail.put) throw new Error("put failed");
    },
  } as unknown as ArtifactStore;
}

const SNAP: BindingSnapshot = {
  version: 1,
  builtAt: "2026-10-22T00:00:00.000Z",
  rowCount: 0,
  snapshotRowCount: 0,
  truncated: false,
  fields: [],
  rows: [],
};

async function testStoreOrder() {
  const key = "apps/bindings/c/h.parquet";
  const snap = "apps/bindings/c/h.snapshot.json";

  const ops: string[] = [];
  await storeParquetWithSnapshot({
    parquetKey: key,
    snapshot: SNAP,
    store: fakeStore(ops),
    uploadParquet: async () => void ops.push(`upload ${key}`),
  });
  assert.deepEqual(ops, [`delete ${snap}`, `upload ${key}`, `put ${snap}`]);

  // The old snapshot cannot be removed: the parquet does not move either.
  const failedDelete: string[] = [];
  await assert.rejects(
    storeParquetWithSnapshot({
      parquetKey: key,
      snapshot: SNAP,
      store: fakeStore(failedDelete, { delete: true }),
      uploadParquet: async () => void failedDelete.push(`upload ${key}`),
    }),
    /delete failed/,
  );
  assert.deepEqual(failedDelete, [`delete ${snap}`]);

  // A failed snapshot write leaves the new parquet with no preview, not
  // with the old one, and does not fail the build.
  const failedPut: string[] = [];
  await storeParquetWithSnapshot({
    parquetKey: key,
    snapshot: SNAP,
    store: fakeStore(failedPut, { put: true }),
    uploadParquet: async () => void failedPut.push(`upload ${key}`),
  });
  assert.deepEqual(failedPut, [
    `delete ${snap}`,
    `upload ${key}`,
    `put ${snap}`,
  ]);

  // No snapshot for this build (unsupported types): the old one still goes.
  const noSnap: string[] = [];
  await storeParquetWithSnapshot({
    parquetKey: key,
    snapshot: null,
    store: fakeStore(noSnap),
    uploadParquet: async () => void noSnap.push(`upload ${key}`),
  });
  assert.deepEqual(noSnap, [`delete ${snap}`, `upload ${key}`]);

  // A failed parquet upload stops before any new snapshot is written.
  const failedUpload: string[] = [];
  await assert.rejects(
    storeParquetWithSnapshot({
      parquetKey: key,
      snapshot: SNAP,
      store: fakeStore(failedUpload),
      uploadParquet: async () => {
        throw new Error("upload failed");
      },
    }),
    /upload failed/,
  );
  assert.deepEqual(failedUpload, [`delete ${snap}`]);
}

async function main() {
  try {
    testArtifactKey();
    await testBuilderRowsMatchTheSdk();
    await testNativeTypesMatchTheSdk();
    await testUnsupportedTypesGetNoSnapshot();
    await testCaps();
    await testStoreOrder();
    console.log("binding-snapshot tests passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
