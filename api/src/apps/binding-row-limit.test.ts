/**
 * An app binding is read as the WHOLE result — DuckDB in the page sums it —
 * so its parquet must never be a silent cut. The builder's default keeps the
 * first `rowLimit` rows and carries on (right for a caller with a declared
 * cap); every app binding build asks it to fail instead. On 2026-10-19 a
 * 526,470-row binding was served as exactly 500,000 rows and every total on
 * the app read ~5% short, with nothing recorded anywhere.
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
  name: "campaign_daily",
  connectionId: "c1",
  materialization: "parquet",
  sql,
  code: sql,
});

beforeEach(() => {
  build.mockReset();
  build.mockResolvedValue({
    filePath: "/tmp/x.parquet",
    rowCount: 1,
    byteSize: 1,
  });
});

describe("app binding builds and the parquet row limit", () => {
  it("asks the builder to fail past the limit, not to truncate", async () => {
    await buildResolvedBindingParquet(
      project,
      binding("select 1 as x"),
      { type: "bigquery" } as any,
      "select 1 as x",
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toMatchObject({ onRowLimit: "fail" });
  });

  it("does so for a Mongo binding too (the lenient-probe path)", async () => {
    await buildResolvedBindingParquet(
      project,
      binding("db.c.find({})"),
      { type: "mongodb" } as any,
      "db.c.find({})",
    );
    expect(build.mock.calls[0][0]).toMatchObject({
      onRowLimit: "fail",
      schemaProbe: "lenient",
    });
  });
});
