/**
 * Every binding build passes the read-only gate with its connection's own
 * quoting rules. On 2026-11-18 the gate ran with no dialect, which demands
 * one statement under every reading, so valid BigQuery with a
 * backslash-escaped quote before a semicolon was refused and 2
 * pro-funnel-health bindings served stale numbers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.fn();
vi.mock("../services/parquet-build.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../services/parquet-build.service")
  >()),
  buildQueryParquetFile: (input: unknown) => build(input),
}));

import {
  buildResolvedBindingParquet,
  type AppBinding,
} from "./bindings.service";

const project = { _id: { toString: () => "6577f0f0f0f0f0f0f0f0f0f0" } } as any;
const binding = (sql: string): AppBinding => ({
  name: "inv_content_cio",
  connectionId: "c1",
  materialization: "parquet",
  sql,
  code: sql,
});
const bq = { type: "bigquery" } as any;
const pg = { type: "postgresql" } as any;

beforeEach(() => {
  build.mockReset();
  build.mockResolvedValue({
    filePath: "/tmp/x.parquet",
    rowCount: 1,
    byteSize: 1,
  });
});

describe("the binding read-only gate reads quotes by the connection's rules", () => {
  const sql = String.raw`SELECT 'it\'s; ok' AS a FROM t`;

  it("builds BigQuery with a backslash-escaped quote before a semicolon", async () => {
    await buildResolvedBindingParquet(project, binding(sql), bq, sql);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("still refuses a second statement on BigQuery", async () => {
    const two = "SELECT 1; DROP TABLE t";
    await expect(
      buildResolvedBindingParquet(project, binding(two), bq, two),
    ).rejects.toThrow(/read-only safety checks/);
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses the same text on PostgreSQL, where a backslash escapes nothing", async () => {
    await expect(
      buildResolvedBindingParquet(project, binding(sql), pg, sql),
    ).rejects.toThrow(/read-only safety checks/);
  });
});
