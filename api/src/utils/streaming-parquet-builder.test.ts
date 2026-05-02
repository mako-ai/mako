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

  console.log("  inferDuckDBType: no driver type always returns VARCHAR");

  assert.equal(inferDuckDBType(undefined, [42]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, [3.14]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, [true]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, [new Date()]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, ["hello"]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, [null, null, undefined]), "VARCHAR");
  assert.equal(inferDuckDBType(undefined, []), "VARCHAR");
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
    "  buildParquetFromBatches: no fields — all columns default to VARCHAR",
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

    for (const col of ["count", "rate", "day", "label", "flag"]) {
      assert.equal(
        descRows[col],
        "VARCHAR",
        `${col} should be VARCHAR, got ${descRows[col]}`,
      );
    }
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

async function testBuildParquetStripsNulBytesInVarcharColumns() {
  console.log(
    "  buildParquetFromBatches: NUL bytes in VARCHAR values do not break the batch",
  );

  // Connector payloads occasionally contain raw binary bytes (e.g. Close email
  // bodies with inlined PNG attachments — magic header `\x89PNG\r\n\x1a\n`
  // followed by `\x00 \x00 \x00 \x0d`). Without NUL stripping the embedded
  // `\u0000` truncates the SQL at the napi/C++ boundary and DuckDB throws
  // `Parser Error: unterminated quoted string`.
  const png = "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR";
  const body = `Bonjour\nje n'ai aucun numéro\n\n${png}\nPowered by [**Intercom**](https://www.intercom.com/)`;

  const rows = [
    { id: "row-with-nul", body },
    { id: "row-also-nul", body: `prefix\u0000suffix` },
    { id: "row-nested-json", body: { nested: `inner\u0000value` } },
    { id: "row-clean", body: "no nul here" },
  ];

  const result = await buildParquetFromBatches({
    filenameBase: "test-nul-bytes",
    streamBatches: async insertBatch => {
      await insertBatch(rows);
    },
  });

  assert.equal(result.rowCount, 4);

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    await conn.run(
      `CREATE TABLE _verify AS SELECT * FROM read_parquet('${result.filePath.replace(/'/g, "''")}')`,
    );

    const readback = await conn.run("SELECT id, body FROM _verify ORDER BY id");
    const readbackRows = await readback.getRows();
    assert.equal(readbackRows.length, 4);

    for (const row of readbackRows) {
      const value = String(row[1] ?? "");
      assert.ok(
        !value.includes("\u0000"),
        `row ${row[0]} should have no NUL bytes after stripping`,
      );
    }
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
  console.log("  PASSED");
  await testBuildParquetStripsNulBytesInVarcharColumns();
  console.log("  PASSED\n");

  console.log("All tests passed.");
}

main().catch(err => {
  console.error("TEST FAILURE:", err);
  throw err;
});
