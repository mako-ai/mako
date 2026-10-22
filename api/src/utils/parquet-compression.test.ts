/* eslint-disable no-console */
import assert from "node:assert/strict";
import {
  DEFAULT_PARQUET_CODEC,
  DEFAULT_PARQUET_ROW_GROUP_SIZE,
  DEFAULT_PARQUET_ZSTD_LEVEL,
  SNAPPY_WRITE_OPTIONS,
  appBindingParquetWriteOptions,
  buildParquetCopySql,
  initAppBindingParquetWriteOptions,
  parquetWriteArtifactMetadata,
  resetAppBindingParquetWriteOptionsForTest,
  resolveParquetWriteOptions,
} from "./parquet-compression";

function testDefaults() {
  console.log(
    "  resolveParquetWriteOptions: empty env defaults to ZSTD level 3",
  );
  const options = resolveParquetWriteOptions({});
  assert.equal(options.codec, "ZSTD");
  assert.equal(options.codec, DEFAULT_PARQUET_CODEC);
  assert.equal(options.zstdLevel, DEFAULT_PARQUET_ZSTD_LEVEL);
  assert.equal(DEFAULT_PARQUET_ZSTD_LEVEL, 3);
  assert.equal(options.rowGroupSize, undefined);
  assert.equal(DEFAULT_PARQUET_ROW_GROUP_SIZE, 122_880);
}

function testCodecAllowlist() {
  console.log("  resolveParquetWriteOptions: SNAPPY / ZSTD, case-insensitive");
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_COMPRESSION: "snappy" }).codec,
    "SNAPPY",
  );
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_COMPRESSION: "ZSTD" }).codec,
    "ZSTD",
  );
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_COMPRESSION: "  zstd  " }).codec,
    "ZSTD",
  );
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_COMPRESSION: "" }).codec,
    "ZSTD",
  );
}

function testRejectsInvalidCodec() {
  console.log(
    "  resolveParquetWriteOptions: rejects codecs outside the allowlist",
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_COMPRESSION: "GZIP" }),
    /Invalid PARQUET_COMPRESSION/,
  );
  assert.throws(
    () =>
      resolveParquetWriteOptions({
        PARQUET_COMPRESSION: "zstd; DROP TABLE _data",
      }),
    /Invalid PARQUET_COMPRESSION/,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_COMPRESSION: "UNCOMPRESSED" }),
    /Allowed: SNAPPY, ZSTD/,
  );
}

function testZstdLevelValidation() {
  console.log("  resolveParquetWriteOptions: ZSTD level 1–22");
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "1" }).zstdLevel,
    1,
  );
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "9" }).zstdLevel,
    9,
  );
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "22" }).zstdLevel,
    22,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "0" }),
    /Invalid PARQUET_ZSTD_LEVEL/,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "23" }),
    /Invalid PARQUET_ZSTD_LEVEL/,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "3.5" }),
    /Invalid PARQUET_ZSTD_LEVEL/,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "fast" }),
    /Invalid PARQUET_ZSTD_LEVEL/,
  );
}

function testRowGroupSizeValidation() {
  console.log("  resolveParquetWriteOptions: optional ROW_GROUP_SIZE >= 2048");
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_ROW_GROUP_SIZE: "122880" })
      .rowGroupSize,
    122880,
  );
  assert.equal(
    resolveParquetWriteOptions({ PARQUET_ROW_GROUP_SIZE: "2048" }).rowGroupSize,
    2048,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_ROW_GROUP_SIZE: "2047" }),
    /Invalid PARQUET_ROW_GROUP_SIZE/,
  );
  assert.throws(
    () => resolveParquetWriteOptions({ PARQUET_ROW_GROUP_SIZE: "lots" }),
    /Invalid PARQUET_ROW_GROUP_SIZE/,
  );
}

function testCopySqlGeneration() {
  console.log("  buildParquetCopySql: SNAPPY, ZSTD, optional ROW_GROUP_SIZE");
  assert.equal(
    buildParquetCopySql("/tmp/out.parquet", {
      codec: "SNAPPY",
      zstdLevel: 3,
    }),
    "COPY _data TO '/tmp/out.parquet' (FORMAT PARQUET, COMPRESSION SNAPPY)",
  );
  assert.equal(
    buildParquetCopySql("/tmp/out.parquet", {
      codec: "ZSTD",
      zstdLevel: 3,
    }),
    "COPY _data TO '/tmp/out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 3)",
  );
  assert.equal(
    buildParquetCopySql("/tmp/out.parquet", {
      codec: "ZSTD",
      zstdLevel: 9,
      rowGroupSize: 122880,
    }),
    "COPY _data TO '/tmp/out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 122880)",
  );
  assert.equal(
    buildParquetCopySql("/tmp/o'ut.parquet", { codec: "SNAPPY", zstdLevel: 3 }),
    "COPY _data TO '/tmp/o''ut.parquet' (FORMAT PARQUET, COMPRESSION SNAPPY)",
  );
}

function testCopySqlNeverInterpolatesRawEnv() {
  console.log(
    "  buildParquetCopySql: codec comes from the allowlist type, not env",
  );
  const options = resolveParquetWriteOptions({ PARQUET_COMPRESSION: "snappy" });
  const sql = buildParquetCopySql("/tmp/x.parquet", options);
  assert.match(sql, /COMPRESSION SNAPPY/);
  assert.doesNotMatch(sql, /snappy/);
}

function testSnappyOptionsKeepTheCdcSql() {
  console.log(
    "  SNAPPY_WRITE_OPTIONS: the exact COPY the CDC/sync loaders always ran",
  );
  assert.equal(
    buildParquetCopySql("/tmp/x.parquet", SNAPPY_WRITE_OPTIONS),
    "COPY _data TO '/tmp/x.parquet' (FORMAT PARQUET, COMPRESSION SNAPPY)",
  );
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAppBindingParquetWriteOptionsForTest();
  }
}

function testBootValidation() {
  console.log("  initAppBindingParquetWriteOptions: a typo fails the boot");
  assert.throws(
    () => initAppBindingParquetWriteOptions({ PARQUET_COMPRESSION: "zstdd" }),
    /Invalid PARQUET_COMPRESSION/,
  );
  assert.throws(
    () => initAppBindingParquetWriteOptions({ PARQUET_ZSTD_LEVEL: "30" }),
    /Invalid PARQUET_ZSTD_LEVEL/,
  );
  resetAppBindingParquetWriteOptionsForTest();

  console.log(
    "  initAppBindingParquetWriteOptions: fixes the options for the process",
  );
  const booted = initAppBindingParquetWriteOptions({
    PARQUET_COMPRESSION: "zstd",
    PARQUET_ZSTD_LEVEL: "6",
  });
  withEnv({ PARQUET_COMPRESSION: "SNAPPY" }, () => {
    // A later env change does not reach builds: the boot value stands.
    assert.equal(appBindingParquetWriteOptions(), booted);
  });
}

function testLazyFallback() {
  console.log(
    "  appBindingParquetWriteOptions: without boot, bad env → SNAPPY, no throw",
  );
  withEnv(
    { PARQUET_COMPRESSION: "GZIP", PARQUET_ZSTD_LEVEL: undefined },
    () => {
      const first = appBindingParquetWriteOptions();
      assert.equal(first.codec, "SNAPPY");
      // Resolved once: the second build reuses it rather than re-parsing.
      assert.equal(appBindingParquetWriteOptions(), first);
    },
  );
  withEnv(
    {
      PARQUET_COMPRESSION: undefined,
      PARQUET_ZSTD_LEVEL: undefined,
      PARQUET_ROW_GROUP_SIZE: undefined,
    },
    () => {
      assert.deepEqual(appBindingParquetWriteOptions(), {
        codec: "ZSTD",
        zstdLevel: DEFAULT_PARQUET_ZSTD_LEVEL,
      });
    },
  );
}

function testArtifactMetadata() {
  console.log(
    "  parquetWriteArtifactMetadata: string values for object stores",
  );
  assert.deepEqual(
    parquetWriteArtifactMetadata({
      compression: "ZSTD",
      byteSize: 4096,
      zstdLevel: 3,
      encodeDurationMs: 12,
    }),
    {
      parquetCompression: "ZSTD",
      parquetByteSize: "4096",
      parquetEncodeDurationMs: "12",
      parquetZstdLevel: "3",
    },
  );
  assert.deepEqual(
    parquetWriteArtifactMetadata({
      compression: "SNAPPY",
      byteSize: 100,
      encodeDurationMs: 4,
    }),
    {
      parquetCompression: "SNAPPY",
      parquetByteSize: "100",
      parquetEncodeDurationMs: "4",
    },
  );
}

function main() {
  console.log("Running parquet-compression tests...\n");
  testDefaults();
  testCodecAllowlist();
  testRejectsInvalidCodec();
  testZstdLevelValidation();
  testRowGroupSizeValidation();
  testCopySqlGeneration();
  testCopySqlNeverInterpolatesRawEnv();
  testSnappyOptionsKeepTheCdcSql();
  testBootValidation();
  testLazyFallback();
  testArtifactMetadata();
  console.log("\nAll tests passed.");
}

main();
