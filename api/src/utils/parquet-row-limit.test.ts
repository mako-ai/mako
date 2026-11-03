/**
 * Parquet row limits: the env-configured default and maximum, a binding's
 * `-- row_limit:` front matter, and the message a binding past its limit
 * fails with.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PARQUET_MAX_ROW_LIMIT,
  DEFAULT_PARQUET_ROW_LIMIT,
  bindingRowLimitMessage,
  initParquetRowLimits,
  parquetRowLimits,
  parseRowCount,
  resetParquetRowLimitsForTest,
  resolveBindingRowLimit,
  resolveParquetRowLimits,
  suggestedRowLimit,
} from "./parquet-row-limit";

afterEach(() => resetParquetRowLimitsForTest());

describe("parseRowCount", () => {
  it.each([
    ["2000000", 2_000_000],
    ["2_000_000", 2_000_000],
    ["2,000,000", 2_000_000],
    [" 3M ", 3_000_000],
    ["2.5m", 2_500_000],
    ["500k", 500_000],
    ["750K", 750_000],
  ])("reads %j as %d", (raw, expected) => {
    expect(parseRowCount(raw)).toBe(expected);
  });

  it.each(["", "0", "-5", "abc", "2G", "1.5", "1e6", "2 M rows", "0.0001k"])(
    "rejects %j",
    raw => {
      expect(parseRowCount(raw)).toBeNull();
    },
  );
});

describe("resolveParquetRowLimits (env)", () => {
  it("defaults to 2M per binding and a 5M maximum", () => {
    expect(resolveParquetRowLimits({})).toEqual({
      defaultRowLimit: DEFAULT_PARQUET_ROW_LIMIT,
      maxRowLimit: DEFAULT_PARQUET_MAX_ROW_LIMIT,
    });
    expect(DEFAULT_PARQUET_ROW_LIMIT).toBe(2_000_000);
    expect(DEFAULT_PARQUET_MAX_ROW_LIMIT).toBe(5_000_000);
  });

  it("reads both from the env", () => {
    expect(
      resolveParquetRowLimits({
        PARQUET_ROW_LIMIT: "3M",
        PARQUET_MAX_ROW_LIMIT: "20_000_000",
      }),
    ).toEqual({ defaultRowLimit: 3_000_000, maxRowLimit: 20_000_000 });
  });

  it("treats blank values as unset", () => {
    expect(
      resolveParquetRowLimits({
        PARQUET_ROW_LIMIT: " ",
        PARQUET_MAX_ROW_LIMIT: "",
      }),
    ).toEqual({
      defaultRowLimit: DEFAULT_PARQUET_ROW_LIMIT,
      maxRowLimit: DEFAULT_PARQUET_MAX_ROW_LIMIT,
    });
  });

  it("lowers the built-in default under a smaller maximum", () => {
    expect(resolveParquetRowLimits({ PARQUET_MAX_ROW_LIMIT: "1M" })).toEqual({
      defaultRowLimit: 1_000_000,
      maxRowLimit: 1_000_000,
    });
  });

  it("refuses a default above the maximum", () => {
    expect(() =>
      resolveParquetRowLimits({
        PARQUET_ROW_LIMIT: "5M",
        PARQUET_MAX_ROW_LIMIT: "4M",
      }),
    ).toThrow(
      /PARQUET_ROW_LIMIT \(5,000,000\) is above PARQUET_MAX_ROW_LIMIT \(4,000,000\)/,
    );
  });

  it("refuses a typo, naming the variable", () => {
    expect(() => resolveParquetRowLimits({ PARQUET_ROW_LIMIT: "2MM" })).toThrow(
      /Invalid PARQUET_ROW_LIMIT="2MM"/,
    );
    expect(() =>
      resolveParquetRowLimits({ PARQUET_MAX_ROW_LIMIT: "-1" }),
    ).toThrow(/Invalid PARQUET_MAX_ROW_LIMIT/);
  });

  it("initParquetRowLimits fails the boot on a typo and fixes the limits on success", () => {
    expect(() => initParquetRowLimits({ PARQUET_ROW_LIMIT: "lots" })).toThrow();
    initParquetRowLimits({ PARQUET_ROW_LIMIT: "4M" });
    expect(parquetRowLimits().defaultRowLimit).toBe(4_000_000);
  });

  it("parquetRowLimits falls back to the defaults on an invalid env instead of throwing", () => {
    const before = process.env.PARQUET_ROW_LIMIT;
    process.env.PARQUET_ROW_LIMIT = "nope";
    try {
      expect(parquetRowLimits()).toEqual({
        defaultRowLimit: DEFAULT_PARQUET_ROW_LIMIT,
        maxRowLimit: DEFAULT_PARQUET_MAX_ROW_LIMIT,
      });
    } finally {
      if (before === undefined) delete process.env.PARQUET_ROW_LIMIT;
      else process.env.PARQUET_ROW_LIMIT = before;
    }
  });
});

describe("resolveBindingRowLimit (front matter)", () => {
  const limits = { defaultRowLimit: 2_000_000, maxRowLimit: 5_000_000 };

  it("uses the default when the binding declares nothing", () => {
    expect(resolveBindingRowLimit("orders", undefined, limits)).toBe(2_000_000);
    expect(resolveBindingRowLimit("orders", "  ", limits)).toBe(2_000_000);
  });

  it("uses the declared limit, above or below the default", () => {
    expect(resolveBindingRowLimit("orders", "3M", limits)).toBe(3_000_000);
    expect(resolveBindingRowLimit("orders", "100000", limits)).toBe(100_000);
  });

  it("accepts exactly the maximum", () => {
    expect(resolveBindingRowLimit("orders", "5_000_000", limits)).toBe(
      5_000_000,
    );
  });

  it("refuses a limit above the maximum, naming the binding", () => {
    expect(() => resolveBindingRowLimit("orders", "20M", limits)).toThrow(
      /Binding "orders" asks for "-- row_limit: 20M" \(20,000,000 rows\), above the 5,000,000-row maximum/,
    );
  });

  it("refuses a value that is not a row count", () => {
    expect(() => resolveBindingRowLimit("orders", "lots", limits)).toThrow(
      /Binding "orders" has an invalid "-- row_limit: lots"/,
    );
  });
});

describe("the error at the limit", () => {
  it("names the binding, its row count, and the row_limit that would fit", () => {
    const msg = bindingRowLimitMessage({
      bindingName: "web_requests",
      rowLimit: 2_000_000,
      rowCount: 2_583_112,
      exact: true,
      maxRowLimit: 5_000_000,
    });
    expect(msg).toBe(
      'Binding "web_requests" returned 2,583,112 rows, over its row limit of 2,000,000. ' +
        "Nothing was stored, so the app keeps serving the previous build. " +
        'To raise the limit, add "-- row_limit: 3300000" to the front matter of ' +
        "bindings/web_requests.sql (at most 5,000,000). Or aggregate the query, or " +
        "shard it into several bindings (for example one per year or country).",
    );
  });

  it("says to shard when the query is past the maximum", () => {
    const msg = bindingRowLimitMessage({
      bindingName: "events",
      rowLimit: 2_000_000,
      rowCount: 5_000_000,
      exact: false,
      maxRowLimit: 5_000_000,
    });
    expect(msg).toMatch(/^Binding "events" returned more than 5,000,000 rows/);
    expect(msg).toMatch(/above the 5,000,000-row maximum for one binding/);
    expect(msg).toMatch(/shard it into several bindings/);
    expect(msg).not.toMatch(/row_limit/);
  });

  it("suggests 25% headroom, rounded up to 100k, capped at the maximum", () => {
    expect(suggestedRowLimit(583_000, 5_000_000)).toBe(800_000);
    expect(suggestedRowLimit(2_000_001, 5_000_000)).toBe(2_600_000);
    expect(suggestedRowLimit(9_500_000, 5_000_000)).toBe(5_000_000);
  });
});
