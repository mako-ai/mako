// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAppBindings: vi.fn(),
  createDuckDBInstance: vi.fn(),
  collectStreamBytes: vi.fn(),
  loadParquetTable: vi.fn(),
  queryDuckDB: vi.fn(),
  terminateTrackedDuckDBInstance: vi.fn(),
  previewParquetArtifact: vi.fn(),
}));

vi.mock("../store/appsStore", () => ({
  useAppsStore: {
    getState: () => ({ fetchAppBindings: mocks.fetchAppBindings }),
  },
}));
vi.mock("../store/uiStore", () => ({
  useUIStore: { getState: () => ({ currentWorkspaceId: "workspace-1" }) },
}));
vi.mock("../store/dashboardStore", () => ({
  useDashboardStore: { getState: () => ({ openDashboards: {} }) },
}));
vi.mock("../dashboard-runtime/gateway", () => ({
  queryDashboardRuntime: vi.fn(),
}));
vi.mock("../dashboard-runtime/commands", () => ({
  previewDashboardQuery: vi.fn(),
}));
vi.mock("../lib/duckdb", () => ({
  collectStreamBytes: mocks.collectStreamBytes,
  createDuckDBInstance: mocks.createDuckDBInstance,
  loadParquetTable: mocks.loadParquetTable,
  queryDuckDB: mocks.queryDuckDB,
  terminateTrackedDuckDBInstance: mocks.terminateTrackedDuckDBInstance,
}));
vi.mock("../lib/parquet-preview", () => ({
  previewParquetArtifact: mocks.previewParquetArtifact,
}));

import { executeDataSourceTool } from "./data-source-tools";

const binding = {
  name: "renewal_min",
  connectionId: "connection-1",
  language: "sql",
  materialization: "parquet",
  code: "SELECT * FROM renewals",
  lastMaterializedAt: "2026-09-03T08:00:00.000Z",
  rowCount: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAppBindings.mockResolvedValue([binding]);
  mocks.terminateTrackedDuckDBInstance.mockResolvedValue(undefined);
});

describe("app data-source tools", () => {
  it("lists git-backed app bindings instead of rejecting app surfaces", async () => {
    const result = await executeDataSourceTool("list_data_sources", {
      surface: { kind: "app", id: "road-to-75" },
    });

    expect(result.success).toBe(true);
    expect(result.dataSources).toEqual([
      expect.objectContaining({
        name: "renewal_min",
        status: "ready",
        table: "renewal_min",
      }),
    ]);
    expect(mocks.fetchAppBindings).toHaveBeenCalledWith(
      "workspace-1",
      "road-to-75",
    );
  });

  it("previews one materialized app binding", async () => {
    mocks.previewParquetArtifact.mockResolvedValue({
      rows: [{ renewal_rate: 0.75 }],
      fields: [{ name: "renewal_rate", type: "DOUBLE" }],
      rowCount: 1,
      totalRows: 12,
    });

    const result = await executeDataSourceTool("inspect_data_source", {
      surface: { kind: "app", id: "road-to-75" },
      dataSource: "renewal_min",
    });

    expect(result.success).toBe(true);
    expect(result.dataSource).toEqual(
      expect.objectContaining({
        name: "renewal_min",
        sampleRows: [{ renewal_rate: 0.75 }],
      }),
    );
  });

  it("loads app artifacts and runs DuckDB SQL", async () => {
    const db = {};
    mocks.createDuckDBInstance.mockResolvedValue(db);
    mocks.collectStreamBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mocks.queryDuckDB.mockResolvedValue({
      rows: [{ n: 12 }],
      fields: [{ name: "n", type: "BIGINT" }],
      rowCount: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, body: {} })),
    );

    const result = await executeDataSourceTool("query_duckdb", {
      surface: { kind: "app", id: "road-to-75" },
      sql: 'SELECT count(*) AS n FROM "renewal_min"',
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, rows: [{ n: 12 }] }),
    );
    expect(mocks.loadParquetTable).toHaveBeenCalledWith(
      db,
      "renewal_min",
      new Uint8Array([1, 2, 3]),
    );
    expect(mocks.terminateTrackedDuckDBInstance).toHaveBeenCalled();
  });
});
