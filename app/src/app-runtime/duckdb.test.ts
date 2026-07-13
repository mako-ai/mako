import { describe, expect, it, vi } from "vitest";

// duckdb.ts imports the DuckDB-WASM helpers at module scope; stub them so the
// pure sandbox-cap helpers can be tested in a node environment.
const connQuery = vi.fn();
const connClose = vi.fn();
vi.mock("../lib/duckdb", () => ({
  createDuckDBInstance: vi.fn(async () => ({
    connect: async () => ({ query: connQuery, close: connClose }),
  })),
  loadParquetTable: vi.fn(),
  loadJsonTable: vi.fn(),
  queryDuckDB: vi.fn(),
  collectStreamBytes: vi.fn(),
  terminateTrackedDuckDBInstance: vi.fn(),
}));

import type { AppDataBinding } from "@mako/schemas";
import {
  SANDBOX_DUCKDB_ROW_LIMIT,
  resolveSandboxRowLimit,
  applySandboxRowLimit,
  loadBindingRowsTable,
  dropBindingTableByRevisionPrefix,
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

describe("dropBindingTableByRevisionPrefix", () => {
  const binding = (name: string): AppDataBinding =>
    ({
      id: name,
      name,
      connectionId: "conn1",
      language: "sql",
      code: "SELECT 1",
      materialization: "parquet",
    }) as AppDataBinding;

  it("no-ops when the app has no DuckDB instance", async () => {
    await expect(
      dropBindingTableByRevisionPrefix("no-such-app", "orders", "dbt-preview:"),
    ).resolves.toBeUndefined();
    expect(connQuery).not.toHaveBeenCalled();
  });

  it("evicts a table loaded under a matching override revision", async () => {
    const fetchRows = vi.fn(async () => [{ a: 1 }]);
    await loadBindingRowsTable(
      "app-a",
      binding("orders"),
      "dbt-preview:dev",
      fetchRows,
    );
    expect(fetchRows).toHaveBeenCalledTimes(1);

    await dropBindingTableByRevisionPrefix("app-a", "orders", "dbt-preview:");
    expect(connQuery).toHaveBeenCalledWith('DROP TABLE IF EXISTS "orders"');
    expect(connClose).toHaveBeenCalled();

    // The revision was cleared, so re-loading the same snapshot fetches again
    // instead of hitting the "already loaded" fast path.
    await loadBindingRowsTable(
      "app-a",
      binding("orders"),
      "dbt-preview:dev",
      fetchRows,
    );
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it("leaves tables alone when the revision does not match the prefix", async () => {
    const fetchRows = vi.fn(async () => [{ a: 1 }]);
    await loadBindingRowsTable(
      "app-b",
      binding("orders"),
      "artifact-rev-1",
      fetchRows,
    );
    connQuery.mockClear();

    await dropBindingTableByRevisionPrefix("app-b", "orders", "dbt-preview:");
    expect(connQuery).not.toHaveBeenCalled();

    // Still loaded: the same revision short-circuits without re-fetching.
    await loadBindingRowsTable(
      "app-b",
      binding("orders"),
      "artifact-rev-1",
      fetchRows,
    );
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });
});
