/**
 * An app binding is read as the WHOLE result — DuckDB in the page sums it —
 * so its parquet must never be a silent cut. The builder's default keeps the
 * first `rowLimit` rows and carries on (right for a caller with a declared
 * cap); every app binding build asks it to fail instead. On 2026-10-19 a
 * 526,470-row binding was served as exactly 500,000 rows and every total on
 * the app read ~5% short, with nothing recorded anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const build = vi.fn();
vi.mock("../services/parquet-build.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../services/parquet-build.service")
  >()),
  buildQueryParquetFile: (input: unknown) => build(input),
}));

import {
  BindingRowLimitError,
  bindingFromSource,
  buildResolvedBindingParquet,
  sameBindingDefinition,
  type AppBinding,
} from "./bindings.service";
import { ParquetRowLimitError } from "../utils/streaming-parquet-builder";
import { draftHash } from "./binding-draft-cache";
import {
  initParquetRowLimits,
  resetParquetRowLimitsForTest,
} from "../utils/parquet-row-limit";

const project = { _id: { toString: () => "6577f0f0f0f0f0f0f0f0f0f0" } } as any;
const binding = (sql: string, rowLimit?: string): AppBinding => ({
  name: "campaign_daily",
  connectionId: "c1",
  materialization: "parquet",
  sql,
  code: sql,
  ...(rowLimit !== undefined ? { rowLimit } : {}),
});

const bq = { type: "bigquery" } as any;

afterEach(() => resetParquetRowLimitsForTest());

beforeEach(() => {
  initParquetRowLimits({});
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

describe("-- row_limit: front matter", () => {
  it("is read from the binding file, in either spelling", () => {
    const src = (line: string) => `-- connection: c1\n${line}\nselect 1 as x`;
    expect(bindingFromSource("b", src("-- row_limit: 3M"))?.rowLimit).toBe(
      "3M",
    );
    expect(bindingFromSource("b", src("-- rowLimit: 3000000"))?.rowLimit).toBe(
      "3000000",
    );
    expect(bindingFromSource("b", src(""))?.rowLimit).toBeUndefined();
  });

  it("builds with the default limit and counts up to the maximum", async () => {
    await buildResolvedBindingParquet(
      project,
      binding("select 1"),
      bq,
      "select 1",
    );
    expect(build.mock.calls[0][0]).toMatchObject({
      rowLimit: 2_000_000,
      countRowsUpTo: 5_000_000,
      onRowLimit: "fail",
    });
  });

  it("builds with the declared limit", async () => {
    await buildResolvedBindingParquet(
      project,
      binding("select 1", "3_500_000"),
      bq,
      "select 1",
    );
    expect(build.mock.calls[0][0]).toMatchObject({ rowLimit: 3_500_000 });
  });

  it("takes the default and maximum from the env", async () => {
    initParquetRowLimits({
      PARQUET_ROW_LIMIT: "1M",
      PARQUET_MAX_ROW_LIMIT: "4M",
    });
    await buildResolvedBindingParquet(
      project,
      binding("select 1"),
      bq,
      "select 1",
    );
    expect(build.mock.calls[0][0]).toMatchObject({
      rowLimit: 1_000_000,
      countRowsUpTo: 4_000_000,
    });
    await expect(
      buildResolvedBindingParquet(
        project,
        binding("select 1", "5M"),
        bq,
        "select 1",
      ),
    ).rejects.toThrow(/above the 4,000,000-row maximum/);
  });

  it("refuses a limit above the maximum before running the query", async () => {
    await expect(
      buildResolvedBindingParquet(
        project,
        binding("select 1", "50M"),
        bq,
        "select 1",
      ),
    ).rejects.toThrow(
      /Binding "campaign_daily" asks for "-- row_limit: 50M" \(50,000,000 rows\), above the 5,000,000-row maximum/,
    );
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a row count before running the query", async () => {
    await expect(
      buildResolvedBindingParquet(
        project,
        binding("select 1", "all of them"),
        bq,
        "select 1",
      ),
    ).rejects.toThrow(/invalid "-- row_limit: all of them"/);
    expect(build).not.toHaveBeenCalled();
  });
});

describe("a binding past its limit", () => {
  it("fails with its name, its row count and the row_limit that fits", async () => {
    build.mockRejectedValue(
      new ParquetRowLimitError(2_000_000, { rowCount: 2_583_112, exact: true }),
    );
    const err = await buildResolvedBindingParquet(
      project,
      binding("select 1"),
      bq,
      "select 1",
    ).catch(e => e);
    expect(err).toBeInstanceOf(BindingRowLimitError);
    expect(err.rowCount).toBe(2_583_112);
    expect(err.message).toMatch(
      /^Binding "campaign_daily" returned 2,583,112 rows, over its row limit of 2,000,000\./,
    );
    expect(err.message).toMatch(
      /add "-- row_limit: 3300000" to the front matter of bindings\/campaign_daily\.sql \(at most 5,000,000\)/,
    );
    expect(err.message).toMatch(/shard it into several bindings/);
  });

  it("says to shard when the query is past the maximum", async () => {
    build.mockRejectedValue(
      new ParquetRowLimitError(2_000_000, {
        rowCount: 5_000_000,
        exact: false,
      }),
    );
    await expect(
      buildResolvedBindingParquet(project, binding("select 1"), bq, "select 1"),
    ).rejects.toThrow(
      /^Binding "campaign_daily" returned more than 5,000,000 rows, above the 5,000,000-row maximum for one binding/,
    );
  });

  it("passes other build errors through untouched", async () => {
    const boom = new Error("Syntax error at [1:8]");
    build.mockRejectedValue(boom);
    await expect(
      buildResolvedBindingParquet(project, binding("select 1"), bq, "select 1"),
    ).rejects.toBe(boom);
  });
});

describe("raising the limit after a failure rebuilds", () => {
  const def = {
    connectionId: "c1",
    renderedCode: "select 1",
    devModifiedAt: null,
  };

  it("a draft that sets row_limit is a new draft (no failure backoff)", () => {
    expect(draftHash({ ...def, rowLimit: "3M" })).not.toBe(draftHash(def));
    expect(draftHash({ ...def, rowLimit: "3M" })).not.toBe(
      draftHash({ ...def, rowLimit: "4M" }),
    );
  });

  it("a draft without row_limit keeps its hash", () => {
    expect(draftHash({ ...def, rowLimit: undefined })).toBe(draftHash(def));
    expect(draftHash({ ...def, rowLimit: " " })).toBe(draftHash(def));
  });

  it("a draft that only changes row_limit is not the committed binding", () => {
    expect(
      sameBindingDefinition(binding("select 1"), binding("select 1", "3M")),
    ).toBe(false);
    expect(
      sameBindingDefinition(
        binding("select 1", "3M"),
        binding("select 1", "3M "),
      ),
    ).toBe(true);
  });
});
