/**
 * A/B of the parquet codecs an app binding can be written with.
 *
 * For each variant (SNAPPY, ZSTD 1/3/6/9) it prints bytes, encode time and
 * full-scan decode time. The source is a real binding parquet (`--input`,
 * comma-separated) or a synthetic mixed-type table (`--rows`).
 *
 * Decode runs natively, and with `--wasm` also in DuckDB-WASM, the engine the
 * app SDK runs in the browser. Two WASM numbers:
 *   view_ms  — median `SELECT *` over a VIEW on read_parquet: the SDK today
 *              re-decodes the parquet on every query.
 *   table_ms — one `CREATE TABLE AS SELECT * FROM read_parquet`: a
 *              materialized load decodes once.
 *
 * Re-run:
 *   pnpm --filter api exec tsx src/scripts/parquet-compression-benchmark.ts
 *   pnpm --filter api exec tsx src/scripts/parquet-compression-benchmark.ts \
 *     --input /path/a.parquet,/path/b.parquet \
 *     --wasm /path/dir-with-node_modules   # npm i @duckdb/duckdb-wasm@1.29.0 there
 *
 * The WASM package is not an api dependency: install the SDK's pin
 * (1.29.0) in any scratch directory and pass that directory.
 */
import { promises as fsPromises } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  buildParquetCopySql,
  type ParquetWriteOptions,
} from "../utils/parquet-compression";

/* eslint-disable no-console */

const DEFAULT_ROWS = 1_000_000;
const WASM_VIEW_RUNS = 5;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function parseRows(): number {
  const raw = flag("--rows");
  if (raw === undefined) return DEFAULT_ROWS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --rows ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const VARIANTS: Array<{ label: string } & ParquetWriteOptions> = [
  { label: "SNAPPY", codec: "SNAPPY", zstdLevel: 1 },
  { label: "ZSTD-1", codec: "ZSTD", zstdLevel: 1 },
  { label: "ZSTD-3", codec: "ZSTD", zstdLevel: 3 },
  { label: "ZSTD-6", codec: "ZSTD", zstdLevel: 6 },
  { label: "ZSTD-9", codec: "ZSTD", zstdLevel: 9 },
];

const lit = (p: string) => `'${p.replace(/'/g, "''")}'`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Minimal surface of @duckdb/duckdb-wasm's node-blocking build. */
interface WasmDb {
  connect(): { query(sql: string): unknown; close(): void };
  registerFileBuffer(name: string, buffer: Uint8Array): void;
  dropFile(name: string): void;
}

async function loadWasm(dir: string): Promise<WasmDb> {
  const require = createRequire(path.join(path.resolve(dir), "package.json"));
  const entry =
    require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const duckdb = require(entry);
  const dist = path.dirname(entry);
  const bundles = {
    mvp: {
      mainModule: path.join(dist, "duckdb-mvp.wasm"),
      mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
    },
    eh: {
      mainModule: path.join(dist, "duckdb-eh.wasm"),
      mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs"),
    },
  };
  const db = await duckdb.createDuckDB(
    bundles,
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate(() => undefined);
  const version = db.connect().query("SELECT version() AS v").toArray()[0].v;
  console.log(`DuckDB-WASM engine ${version} (node-blocking build)\n`);
  return db as WasmDb;
}

function wasmDecode(
  db: WasmDb,
  bytes: Uint8Array,
): { viewMs: number; tableMs: number } {
  const name = `bench_${Date.now()}.parquet`;
  db.registerFileBuffer(name, bytes);
  const conn = db.connect();
  try {
    conn.query(
      `CREATE OR REPLACE VIEW v AS SELECT * FROM read_parquet('${name}')`,
    );
    const views: number[] = [];
    for (let i = 0; i < WASM_VIEW_RUNS; i++) {
      const t = performance.now();
      conn.query("SELECT * FROM v");
      views.push(performance.now() - t);
    }
    const t = performance.now();
    conn.query(
      `CREATE OR REPLACE TABLE t AS SELECT * FROM read_parquet('${name}')`,
    );
    const tableMs = performance.now() - t;
    conn.query("DROP VIEW v");
    conn.query("DROP TABLE t");
    return { viewMs: median(views), tableMs };
  } finally {
    conn.close();
    db.dropFile(name);
  }
}

async function loadSource(
  connection: DuckDBConnection,
  input: string | undefined,
  rows: number,
): Promise<string> {
  await connection.run("DROP TABLE IF EXISTS _data");
  if (input) {
    await connection.run(
      `CREATE TABLE _data AS SELECT * FROM read_parquet(${lit(input)})`,
    );
    return path.basename(input);
  }
  await connection.run(`
    CREATE TABLE _data AS
    SELECT
      i AS id,
      (i % 10000)::BIGINT AS low_card_int,
      (i % 1000) * 0.137 + random() AS amount,
      TIMESTAMP '2020-01-01' + (i % (365 * 24 * 60)) * INTERVAL 1 MINUTE
        AS event_at,
      ['alpha','beta','gamma','delta','epsilon','zeta','eta','theta'][i % 8 + 1]
        AS low_card_str,
      md5(i::VARCHAR) AS high_card_str
    FROM generate_series(1, ${rows}) AS t(i)
  `);
  return `synthetic ${rows.toLocaleString()} rows`;
}

async function benchOne(
  connection: DuckDBConnection,
  workDir: string,
  label: string,
  wasm: WasmDb | undefined,
): Promise<void> {
  const [shape] = await (
    await connection.run(
      "SELECT (SELECT count(*) FROM _data)::BIGINT, (SELECT count(*) FROM duckdb_columns() WHERE table_name = '_data')::BIGINT",
    )
  ).getRows();
  console.log(`## ${label}: ${shape?.[0]} rows x ${shape?.[1]} columns`);
  console.log(
    "variant   bytes        vs SNAPPY  encode_ms  native_ms" +
      (wasm ? "  wasm_view_ms  wasm_table_ms" : ""),
  );
  let snappyBytes = 0;
  for (const variant of VARIANTS) {
    const parquetPath = path.join(workDir, `${variant.label}.parquet`);
    const encodeStartedAt = performance.now();
    await connection.run(buildParquetCopySql(parquetPath, variant));
    const encodeMs = performance.now() - encodeStartedAt;
    const bytes = (await fsPromises.stat(parquetPath)).size;
    if (variant.codec === "SNAPPY") snappyBytes = bytes;

    const decodeStartedAt = performance.now();
    await connection.run(
      `CREATE OR REPLACE TEMP TABLE _verify AS SELECT * FROM read_parquet(${lit(parquetPath)})`,
    );
    const nativeMs = performance.now() - decodeStartedAt;

    const vs =
      variant.codec === "SNAPPY"
        ? "baseline"
        : `${((bytes / snappyBytes - 1) * 100).toFixed(1)}%`;
    let line =
      `${variant.label.padEnd(8)}  ${String(bytes).padStart(11)}  ${vs.padStart(9)}` +
      `  ${encodeMs.toFixed(0).padStart(9)}  ${nativeMs.toFixed(0).padStart(9)}`;
    if (wasm) {
      const { viewMs, tableMs } = wasmDecode(
        wasm,
        new Uint8Array(await fsPromises.readFile(parquetPath)),
      );
      line += `  ${viewMs.toFixed(0).padStart(12)}  ${tableMs.toFixed(0).padStart(13)}`;
    }
    console.log(line);
    await fsPromises.rm(parquetPath, { force: true });
  }
  console.log("");
}

async function main() {
  const rows = parseRows();
  const inputs = flag("--input")?.split(",").filter(Boolean) ?? [];
  const wasmDir = flag("--wasm");
  const workDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "parquet-compression-bench-"),
  );
  const instance = await DuckDBInstance.create(path.join(workDir, "b.duckdb"));
  const connection = await instance.connect();
  try {
    // One thread, like the API's builder (SYNC_PARQUET_DUCKDB_THREADS=1).
    await connection.run("PRAGMA threads=1");
    await connection.run("PRAGMA memory_limit='2GB'");
    const wasm = wasmDir ? await loadWasm(wasmDir) : undefined;
    for (const input of inputs.length ? inputs : [undefined]) {
      const label = await loadSource(connection, input, rows);
      await benchOne(connection, workDir, label, wasm);
    }
    console.log(
      "encode/native: @duckdb/node-api, 1 thread, local disk. wasm: median of " +
        `${WASM_VIEW_RUNS} full scans via a VIEW, and one CREATE TABLE.`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
    await fsPromises.rm(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
