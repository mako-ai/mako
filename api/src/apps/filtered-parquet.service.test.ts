/**
 * Filtered parquet: the viewer's rows and only theirs, with claim values
 * bound as parameters (a quote in an email must not break or widen the
 * filter), and an empty match still yielding a readable table.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { filterParquetFile } from "./filtered-parquet.service";
import { compileRowFilter } from "./viewers.service";

let dir: string;
let source: string;

async function readBack(file: string): Promise<Array<Record<string, unknown>>> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const result = await connection.run(
      `SELECT * FROM read_parquet('${file.replace(/'/g, "''")}') ORDER BY n`,
    );
    return (await result.getRowObjectsJson()) as Array<Record<string, unknown>>;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mako-rowfilter-test-"));
  source = path.join(dir, "source.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM (VALUES ('a@x.com', 1), ('b@x.com', 2), ('o''hara@x.com', 3)) t(sales_rep_email, n))
       TO '${source.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION SNAPPY)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const viewer = (email: string) => ({
  email,
  role: "bdr",
  claims: { email, role: "bdr" },
});

describe("filterParquetFile", () => {
  it("keeps only the viewer's rows, binding the claim as a parameter", async () => {
    const out = path.join(dir, "ohara.parquet");
    const filter = compileRowFilter(
      "sales_rep_email = {{ viewer.email }}",
      viewer("o'hara@x.com"),
    );
    const { rowCount } = await filterParquetFile({
      sourcePath: source,
      filter,
      outputPath: out,
    });
    expect(rowCount).toBe(1);
    expect(await readBack(out)).toEqual([
      { sales_rep_email: "o'hara@x.com", n: 3 },
    ]);
  });

  it("serves the schema with no rows when nothing matches", async () => {
    const out = path.join(dir, "nobody.parquet");
    const filter = compileRowFilter(
      "sales_rep_email = {{ viewer.email }}",
      viewer("nobody@x.com"),
    );
    const { rowCount } = await filterParquetFile({
      sourcePath: source,
      filter,
      outputPath: out,
    });
    expect(rowCount).toBe(0);
    expect(await readBack(out)).toEqual([]);
  });

  it("a FALSE filter (missing claim) yields no rows", async () => {
    const out = path.join(dir, "false.parquet");
    const filter = compileRowFilter(
      "team = {{ viewer.team }}",
      viewer("a@x.com"),
    );
    expect(filter).toEqual({ sql: "FALSE", params: [] });
    const { rowCount } = await filterParquetFile({
      sourcePath: source,
      filter,
      outputPath: out,
    });
    expect(rowCount).toBe(0);
  });
});
