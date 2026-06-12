import { describe, expect, it, vi } from "vitest";

// duckdb.ts imports the DuckDB-WASM helpers at module scope; stub them so the
// pure sandbox-cap helpers can be tested in a node environment.
vi.mock("../lib/duckdb", () => ({
  createDuckDBInstance: vi.fn(),
  loadParquetTable: vi.fn(),
  queryDuckDB: vi.fn(),
  collectStreamBytes: vi.fn(),
  terminateTrackedDuckDBInstance: vi.fn(),
}));

import {
  SANDBOX_DUCKDB_ROW_LIMIT,
  resolveSandboxRowLimit,
  applySandboxRowLimit,
} from "./duckdb";

describe("resolveSandboxRowLimit", () => {
  it("uses the default cap when the iframe sends no limit", () => {
    expect(resolveSandboxRowLimit(undefined)).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
  });

  it("treats null and Infinity as an explicit opt-out (no cap)", () => {
    expect(resolveSandboxRowLimit(null)).toBeNull();
    expect(resolveSandboxRowLimit(Infinity)).toBeNull();
  });

  it("accepts positive finite limits, flooring fractions", () => {
    expect(resolveSandboxRowLimit(1)).toBe(1);
    expect(resolveSandboxRowLimit(2_000_000)).toBe(2_000_000);
    expect(resolveSandboxRowLimit(99.9)).toBe(99);
  });

  it("falls back to the default cap for invalid input", () => {
    expect(resolveSandboxRowLimit(0)).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
    expect(resolveSandboxRowLimit(-5)).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
    expect(resolveSandboxRowLimit(NaN)).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
    expect(resolveSandboxRowLimit(-Infinity)).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
    expect(resolveSandboxRowLimit("100")).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
    expect(resolveSandboxRowLimit({})).toBe(SANDBOX_DUCKDB_ROW_LIMIT);
  });
});

describe("applySandboxRowLimit", () => {
  const rows = [1, 2, 3, 4, 5];

  it("passes results through untouched when below the cap", () => {
    expect(applySandboxRowLimit(rows, 10)).toEqual({
      rows,
      truncated: false,
    });
    expect(applySandboxRowLimit(rows, 5)).toEqual({
      rows,
      truncated: false,
    });
  });

  it("slices and flags results above the cap", () => {
    expect(applySandboxRowLimit(rows, 3)).toEqual({
      rows: [1, 2, 3],
      truncated: true,
    });
  });

  it("never truncates when the cap is disabled", () => {
    expect(applySandboxRowLimit(rows, null)).toEqual({
      rows,
      truncated: false,
    });
  });
});
