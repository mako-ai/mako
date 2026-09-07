/**
 * Row-filtered parquet for role-scoped bindings (apps.md §27).
 *
 * A binding's artifact is one content-addressed object shared by every app
 * and every viewer that runs the same SQL. When a viewer's role carries a
 * `row_filter`, that object must NOT reach them: the whole file lands in
 * the browser's DuckDB, so anything served is readable however the UI
 * filters. Instead the artifact is pulled server-side, filtered in an
 * in-memory DuckDB with the viewer's claims bound as parameters, written
 * back out as Snappy parquet (what the browser readers decode) and
 * streamed — never redirected to the bucket, which only holds the
 * unfiltered object.
 *
 * Costs one DuckDB pass per request per filtered binding. Deliberately no
 * cache in this first cut: nothing in front caches `__data` today, and a
 * `(artifact, policy)`-keyed cache is a contained follow-up once the cost
 * shows up in practice.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import type { CompiledRowFilter } from "./viewers.service";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tempPath(suffix: string): string {
  return path.join(
    os.tmpdir(),
    `mako-rowfilter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`,
  );
}

/**
 * Write `sourcePath` filtered by `filter` to `outputPath`. The schema is
 * preserved even when no row matches, so the browser still gets a table.
 */
export async function filterParquetFile(input: {
  sourcePath: string;
  filter: CompiledRowFilter;
  outputPath: string;
}): Promise<{ rowCount: number }> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("PRAGMA threads=1");
    await connection.run("PRAGMA memory_limit='512MB'");
    const prepared = await connection.prepare(
      `CREATE TABLE _filtered AS SELECT * FROM read_parquet(${sqlString(input.sourcePath)}) WHERE (${input.filter.sql})`,
    );
    try {
      if (input.filter.params.length > 0) prepared.bind(input.filter.params);
      await prepared.run();
    } finally {
      prepared.destroySync();
    }
    const counted = await connection.run("SELECT count(*) AS n FROM _filtered");
    const [row] = (await counted.getRowObjectsJson()) as Array<{ n: unknown }>;
    await connection.run(
      `COPY _filtered TO ${sqlString(input.outputPath)} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
    );
    return { rowCount: Number(row?.n ?? 0) };
  } finally {
    try {
      connection.closeSync();
    } catch {
      /* best-effort */
    }
    try {
      instance.closeSync();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Pull the artifact at `key`, filter it, and return the filtered file.
 * Returns null when the artifact does not exist. The caller owns the
 * returned file and removes it once streamed.
 */
export async function filterArtifactToTempFile(
  store: DashboardArtifactStore,
  key: string,
  filter: CompiledRowFilter,
): Promise<{ path: string; size: number; rowCount: number } | null> {
  const stream = await store.openReadStream(key);
  if (!stream) return null;
  const sourcePath = tempPath(".source.parquet");
  const outputPath = tempPath(".parquet");
  try {
    await pipeline(stream as Readable, createWriteStream(sourcePath));
    const { rowCount } = await filterParquetFile({
      sourcePath,
      filter,
      outputPath,
    });
    const { size } = await fs.stat(outputPath);
    return { path: outputPath, size, rowCount };
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  } finally {
    await fs.rm(sourcePath, { force: true });
  }
}

/** Stream a temp parquet file and delete it once the stream closes. */
export function streamTempParquet(
  file: { path: string; size: number },
  opts: { cacheControl: string; extraHeaders?: Record<string, string> },
): Response {
  const stream = createReadStream(file.path);
  stream.on("close", () => void fs.rm(file.path, { force: true }));
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apache.parquet",
      "Content-Length": String(file.size),
      "Cache-Control": opts.cacheControl,
      ...opts.extraHeaders,
    },
  });
}
