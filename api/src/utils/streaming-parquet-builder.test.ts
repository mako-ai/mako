/* eslint-disable no-console */
import assert from "node:assert/strict";
import { promises as fsPromises } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  inferDuckDBType,
  buildParquetFromBatches,
  ParquetRowLimitError,
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
// Integration test: zero rows keep the probed schema
// ---------------------------------------------------------------------------

async function describeParquet(filePath: string): Promise<string[][]> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const result = await conn.run(
      `DESCRIBE SELECT * FROM read_parquet('${filePath.replace(/'/g, "''")}')`,
    );
    return (await result.getRows()).map(row => [
      String(row[0]),
      String(row[1]),
    ]);
  } finally {
    conn.closeSync();
  }
}

async function testEmptyResultKeepsProbedSchema() {
  console.log(
    "  buildParquetFromBatches: zero rows are written with the probed schema",
  );
  const typed = await buildParquetFromBatches({
    filenameBase: "test-empty-typed",
    fields: [
      { name: "country", type: "STRING" },
      { name: "deals", type: "INT64" },
      { name: "closed_at", type: "TIMESTAMP" },
    ],
    streamBatches: async insertBatch => {
      await insertBatch([]);
    },
  });
  try {
    assert.equal(typed.rowCount, 0);
    assert.deepEqual(await describeParquet(typed.filePath), [
      ["country", "VARCHAR"],
      ["deals", "BIGINT"],
      ["closed_at", "TIMESTAMP"],
    ]);
  } finally {
    await fsPromises.rm(typed.filePath, { force: true });
  }

  console.log("  buildParquetFromBatches: no schema at all → _empty");
  const unknown = await buildParquetFromBatches({
    filenameBase: "test-empty-unknown",
    streamBatches: async () => undefined,
  });
  try {
    assert.deepEqual(await describeParquet(unknown.filePath), [
      ["_empty", "VARCHAR"],
    ]);
  } finally {
    await fsPromises.rm(unknown.filePath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Row limit: truncate (declared cap) vs fail (artifact read as the whole)
// ---------------------------------------------------------------------------

const ROW_FIELDS: FieldMeta[] = [{ name: "id", type: "INTEGER" }];
const idRows = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i }));

/** Stream `batches` batches of `size` rows each into a builder. */
function streamOf(batches: number, size: number) {
  return async (
    insertBatch: (rows: Record<string, unknown>[]) => Promise<void>,
  ) => {
    for (let b = 0; b < batches; b++) await insertBatch(idRows(b * size, size));
  };
}

async function testRowLimitTruncatesByDefaultAndSaysSo() {
  console.log(
    "  buildParquetFromBatches: past rowLimit, the default keeps the first rows and reports truncated",
  );
  const result = await buildParquetFromBatches({
    filenameBase: "test-row-limit-truncate",
    rowLimit: 250,
    fields: ROW_FIELDS,
    streamBatches: streamOf(3, 100),
  });
  try {
    assert.equal(result.rowCount, 250);
    assert.equal(result.truncated, true);
  } finally {
    await fsPromises.rm(result.filePath, { force: true });
  }
}

async function testRowLimitFailBuildsNothing() {
  console.log(
    "  buildParquetFromBatches: onRowLimit fail throws ParquetRowLimitError and stops the stream",
  );
  let batchesOffered = 0;
  await assert.rejects(
    buildParquetFromBatches({
      filenameBase: "test-row-limit-fail",
      rowLimit: 250,
      onRowLimit: "fail",
      fields: ROW_FIELDS,
      streamBatches: async insertBatch => {
        for (let b = 0; b < 5; b++) {
          batchesOffered++;
          await insertBatch(idRows(b * 100, 100));
        }
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof ParquetRowLimitError);
      assert.equal(err.rowLimit, 250);
      assert.match(err.message, /more than 250 rows/);
      return true;
    },
  );
  // The third batch crosses the limit; the throw ends the stream there.
  assert.equal(batchesOffered, 3);
}

async function testRowLimitFailEvenWhenTheDriverSwallowsTheThrow() {
  console.log(
    "  buildParquetFromBatches: a stream that catches the limit error still fails the build",
  );
  await assert.rejects(
    buildParquetFromBatches({
      filenameBase: "test-row-limit-swallowed",
      rowLimit: 150,
      onRowLimit: "fail",
      fields: ROW_FIELDS,
      streamBatches: async insertBatch => {
        try {
          await streamOf(2, 100)(insertBatch);
        } catch {
          /* a driver that reports the failure some other way, or not at all */
        }
      },
    }),
    ParquetRowLimitError,
  );
}

async function testRowLimitExactlyAtLimitIsWhole() {
  console.log(
    "  buildParquetFromBatches: exactly rowLimit rows is the whole result, not a cut",
  );
  for (const onRowLimit of ["truncate", "fail"] as const) {
    const result = await buildParquetFromBatches({
      filenameBase: `test-row-limit-exact-${onRowLimit}`,
      rowLimit: 200,
      onRowLimit,
      fields: ROW_FIELDS,
      streamBatches: streamOf(2, 100),
    });
    try {
      assert.equal(result.rowCount, 200);
      assert.equal(result.truncated, false);
    } finally {
      await fsPromises.rm(result.filePath, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Integration test: codec. Default SNAPPY (the CDC/sync loaders), ZSTD only
// when the caller passes it (app bindings).
// ---------------------------------------------------------------------------

async function parquetCodecAndRows(
  filePath: string,
): Promise<{ codecs: string[]; rows: number; sum: number }> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const lit = filePath.replace(/'/g, "''");
  try {
    const codecs = (
      await (
        await conn.run(
          `SELECT DISTINCT compression FROM parquet_metadata('${lit}') ORDER BY 1`,
        )
      ).getRows()
    ).map(row => String(row[0]));
    const [agg] = await (
      await conn.run(
        `SELECT count(*)::INTEGER, sum(id)::INTEGER FROM read_parquet('${lit}')`,
      )
    ).getRows();
    return { codecs, rows: Number(agg?.[0]), sum: Number(agg?.[1]) };
  } finally {
    conn.closeSync();
  }
}

async function testDefaultCodecIsSnappy() {
  console.log(
    "  buildParquetFromBatches: no writeOptions writes SNAPPY (CDC/sync path)",
  );
  const result = await buildParquetFromBatches({
    filenameBase: "test-codec-default",
    fields: ROW_FIELDS,
    streamBatches: streamOf(2, 100),
  });
  try {
    assert.equal(result.compression, "SNAPPY");
    assert.equal(result.zstdLevel, undefined);
    assert.ok(result.encodeDurationMs >= 0);
    assert.deepEqual(await parquetCodecAndRows(result.filePath), {
      codecs: ["SNAPPY"],
      rows: 200,
      sum: 19900,
    });
  } finally {
    await fsPromises.rm(result.filePath, { force: true });
  }
}

async function testZstdRoundTrip() {
  console.log(
    "  buildParquetFromBatches: ZSTD writeOptions round-trip through read_parquet",
  );
  const result = await buildParquetFromBatches({
    filenameBase: "test-codec-zstd",
    fields: ROW_FIELDS,
    streamBatches: streamOf(2, 100),
    writeOptions: { codec: "ZSTD", zstdLevel: 1 },
  });
  try {
    assert.equal(result.compression, "ZSTD");
    assert.equal(result.zstdLevel, 1);
    assert.deepEqual(await parquetCodecAndRows(result.filePath), {
      codecs: ["ZSTD"],
      rows: 200,
      sum: 19900,
    });
  } finally {
    await fsPromises.rm(result.filePath, { force: true });
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
  console.log("  PASSED");
  await testEmptyResultKeepsProbedSchema();
  console.log("  PASSED");
  await testRowLimitTruncatesByDefaultAndSaysSo();
  console.log("  PASSED");
  await testRowLimitFailBuildsNothing();
  console.log("  PASSED");
  await testRowLimitFailEvenWhenTheDriverSwallowsTheThrow();
  console.log("  PASSED");
  await testRowLimitExactlyAtLimitIsWhole();
  console.log("  PASSED");
  await testDefaultCodecIsSnappy();
  console.log("  PASSED");
  await testZstdRoundTrip();
  console.log("  PASSED\n");

  console.log("All tests passed.");
}

main().catch(err => {
  console.error("TEST FAILURE:", err);
  throw err;
});
