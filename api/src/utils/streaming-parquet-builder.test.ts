/* eslint-disable no-console */
import assert from "node:assert/strict";
import { promises as fsPromises } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  inferDuckDBType,
  buildParquetFromBatches,
  type FieldMeta,
} from "./streaming-parquet-builder";

// ---------------------------------------------------------------------------
// Unit tests: inferDuckDBType
// ---------------------------------------------------------------------------

function testInferDuckDBType() {
  console.log("  inferDuckDBType: driver type strings");

  assert.equal(inferDuckDBType("INTEGER", []), "BIGINT");
  assert.equal(inferDuckDBType("INT64", []), "BIGINT");
  assert.equal(inferDuckDBType("BIGINT", []), "BIGINT");
  assert.equal(inferDuckDBType("SMALLINT", []), "BIGINT");
  assert.equal(inferDuckDBType("serial", []), "BIGINT");
  assert.equal(inferDuckDBType("int4", []), "BIGINT");

  assert.equal(inferDuckDBType("FLOAT64", []), "DOUBLE");
  assert.equal(inferDuckDBType("DOUBLE PRECISION", []), "DOUBLE");
  assert.equal(inferDuckDBType("NUMERIC", []), "DOUBLE");
  assert.equal(inferDuckDBType("REAL", []), "DOUBLE");
  assert.equal(inferDuckDBType("decimal", []), "DOUBLE");
  assert.equal(inferDuckDBType("money", []), "DOUBLE");

  assert.equal(inferDuckDBType("BOOLEAN", []), "BOOLEAN");
  assert.equal(inferDuckDBType("bool", []), "BOOLEAN");

  assert.equal(inferDuckDBType("TIMESTAMP", []), "TIMESTAMP");
  assert.equal(inferDuckDBType("TIMESTAMPTZ", []), "TIMESTAMP");
  assert.equal(inferDuckDBType("DATE", []), "TIMESTAMP");
  assert.equal(inferDuckDBType("TIME", []), "TIMESTAMP");
  assert.equal(inferDuckDBType("timestamp without time zone", []), "TIMESTAMP");

  assert.equal(inferDuckDBType("VARCHAR", []), "VARCHAR");
  assert.equal(inferDuckDBType("TEXT", []), "VARCHAR");
  assert.equal(inferDuckDBType("JSONB", []), "VARCHAR");
  assert.equal(inferDuckDBType("UUID", []), "VARCHAR");
  assert.equal(inferDuckDBType("STRING", []), "VARCHAR");

  console.log("  inferDuckDBType: JS runtime values (no driver type)");

  assert.equal(inferDuckDBType(undefined, [42]), "BIGINT");
  assert.equal(inferDuckDBType(undefined, [3.14]), "DOUBLE");
  assert.equal(inferDuckDBType(undefined, [true]), "BOOLEAN");
  assert.equal(inferDuckDBType(undefined, [false]), "BOOLEAN");
  assert.equal(inferDuckDBType(undefined, [new Date()]), "TIMESTAMP");
  assert.equal(inferDuckDBType(undefined, ["hello"]), "VARCHAR");
  assert.equal(
    inferDuckDBType(undefined, ["2026-04-06T00:00:00Z"]),
    "TIMESTAMP",
  );
  assert.equal(
    inferDuckDBType(undefined, [BigInt("9007199254740993")]),
    "BIGINT",
  );

  console.log("  inferDuckDBType: null-only samples fall back to VARCHAR");
  assert.equal(inferDuckDBType(undefined, [null, null, undefined]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, []), "VARCHAR");

  console.log("  inferDuckDBType: skips nulls to find first real value");
  assert.equal(inferDuckDBType(undefined, [null, null, 42]), "BIGINT");
  assert.equal(inferDuckDBType(undefined, [null, true]), "BOOLEAN");
}

// ---------------------------------------------------------------------------
// Integration test: buildParquetFromBatches with typed columns
// ---------------------------------------------------------------------------

async function testBuildParquetWithFields() {
  console.log(
    "  buildParquetFromBatches: pre-supplied fields produce typed Parquet",
  );

  const fields: FieldMeta[] = [
    { name: "id", type: "INTEGER" },
    { name: "amount", type: "FLOAT64" },
    { name: "active", type: "BOOLEAN" },
    { name: "name" },
  ];

  const rows = [
    { id: 1, amount: 99.5, active: true, name: "Alice" },
    { id: 2, amount: 200.0, active: false, name: "Bob" },
    { id: 3, amount: null, active: null, name: "Charlie" },
  ];

  const result = await buildParquetFromBatches({
    filenameBase: "test-typed",
    fields,
    streamBatches: async insertBatch => {
      await insertBatch(rows);
    },
  });

  assert.equal(result.rowCount, 3);
  assert.ok(result.byteSize > 0);

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `CREATE TABLE _verify AS SELECT * FROM read_parquet('${result.filePath.replace(/'/g, "''")}')`,
    );

    const descResult = await conn.run("DESCRIBE _verify");
    const descRowsRaw = await descResult.getRows();
    const descRows: Record<string, string> = {};
    for (const row of descRowsRaw) {
      descRows[String(row[0])] = String(row[1]);
    }

    assert.equal(
      descRows["id"],
      "BIGINT",
      `id should be BIGINT, got ${descRows["id"]}`,
    );
    assert.equal(
      descRows["amount"],
      "DOUBLE",
      `amount should be DOUBLE, got ${descRows["amount"]}`,
    );
    assert.equal(
      descRows["active"],
      "BOOLEAN",
      `active should be BOOLEAN, got ${descRows["active"]}`,
    );
    assert.equal(
      descRows["name"],
      "VARCHAR",
      `name should be VARCHAR, got ${descRows["name"]}`,
    );

    const countResult = await conn.run("SELECT COUNT(*) AS cnt FROM _verify");
    const countRows = await countResult.getRows();
    assert.equal(Number(countRows[0]?.[0]), 3);
  } finally {
    conn.closeSync();
    await fsPromises
      .rm(result.filePath, { force: true })
      .catch(() => undefined);
  }
}

async function testBuildParquetWithoutFields() {
  console.log(
    "  buildParquetFromBatches: runtime inference (no fields) produces typed Parquet",
  );

  const rows = [
    { count: 100, rate: 95.5, day: "2026-04-01", label: "foo", flag: true },
    { count: 200, rate: 88.2, day: "2026-04-02", label: "bar", flag: false },
  ];

  const result = await buildParquetFromBatches({
    filenameBase: "test-inferred",
    streamBatches: async insertBatch => {
      await insertBatch(rows);
    },
  });

  assert.equal(result.rowCount, 2);

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `CREATE TABLE _verify AS SELECT * FROM read_parquet('${result.filePath.replace(/'/g, "''")}')`,
    );

    const descResult = await conn.run("DESCRIBE _verify");
    const descRowsRaw = await descResult.getRows();
    const descRows: Record<string, string> = {};
    for (const row of descRowsRaw) {
      descRows[String(row[0])] = String(row[1]);
    }

    assert.equal(
      descRows["count"],
      "BIGINT",
      `count should be BIGINT, got ${descRows["count"]}`,
    );
    assert.equal(
      descRows["rate"],
      "DOUBLE",
      `rate should be DOUBLE, got ${descRows["rate"]}`,
    );
    assert.equal(
      descRows["day"],
      "TIMESTAMP",
      `day should be TIMESTAMP, got ${descRows["day"]}`,
    );
    assert.equal(
      descRows["label"],
      "VARCHAR",
      `label should be VARCHAR, got ${descRows["label"]}`,
    );
    assert.equal(
      descRows["flag"],
      "BOOLEAN",
      `flag should be BOOLEAN, got ${descRows["flag"]}`,
    );
  } finally {
    conn.closeSync();
    await fsPromises
      .rm(result.filePath, { force: true })
      .catch(() => undefined);
  }
}

async function testBuildParquetPreservesNullsInTypedColumns() {
  console.log("  buildParquetFromBatches: NULL values work in typed columns");

  const fields: FieldMeta[] = [
    { name: "val", type: "BIGINT" },
    { name: "pct", type: "DOUBLE" },
  ];

  const rows = [
    { val: 10, pct: 50.0 },
    { val: null, pct: null },
    { val: 30, pct: 75.5 },
  ];

  const result = await buildParquetFromBatches({
    filenameBase: "test-nulls",
    fields,
    streamBatches: async insertBatch => {
      await insertBatch(rows);
    },
  });

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `CREATE TABLE _verify AS SELECT * FROM read_parquet('${result.filePath.replace(/'/g, "''")}')`,
    );

    const sumResult = await conn.run("SELECT SUM(val), SUM(pct) FROM _verify");
    const sumRows = await sumResult.getRows();
    assert.equal(Number(sumRows[0]?.[0]), 40, "SUM(val) should be 40");
    assert.equal(Number(sumRows[0]?.[1]), 125.5, "SUM(pct) should be 125.5");
  } finally {
    conn.closeSync();
    await fsPromises
      .rm(result.filePath, { force: true })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("Running streaming-parquet-builder tests...\n");

  console.log("Unit tests:");
  testInferDuckDBType();
  console.log("  PASSED\n");

  console.log("Integration tests:");
  await testBuildParquetWithFields();
  console.log("  PASSED");
  await testBuildParquetWithoutFields();
  console.log("  PASSED");
  await testBuildParquetPreservesNullsInTypedColumns();
  console.log("  PASSED\n");

  console.log("All tests passed.");
}

main().catch(err => {
  console.error("TEST FAILURE:", err);
  throw err;
});
