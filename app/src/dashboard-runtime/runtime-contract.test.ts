import { afterEach, describe, expect, it } from "vitest";
import { getDashboardStateSnapshot } from "./commands";
import { buildDataSourceLoadVersion, resolveActiveSource } from "./gateway";
import { useDashboardRuntimeStore } from "./store";
import { useDashboardStore } from "../store/dashboardStore";
import type { Dashboard } from "./types";

const dashboardStoreBaseline = useDashboardStore.getState();
const runtimeStoreBaseline = useDashboardRuntimeStore.getState();

const baseDashboard = {
  _id: "dash_1",
  workspaceId: "ws_1",
  title: "Runtime Contract",
  description: "",
  dataSources: [
    {
      id: "ds_1",
      name: "Orders",
      tableRef: "ds_orders",
      query: {
        connectionId: "conn_1",
        language: "sql" as const,
        code: "select * from orders",
      },
      computedColumns: [],
      cache: {
        parquetVersion: "v1",
        parquetBuildStatus: "ready" as const,
        parquetUrl: "https://example.com/orders-v1.parquet",
        parquetBuiltAt: "2026-04-04T00:00:00.000Z",
      },
    },
  ],
  widgets: [],
  relationships: [],
  globalFilters: [],
  crossFilter: {
    enabled: true,
    resolution: "intersect" as const,
    engine: "mosaic" as const,
  },
  materializationSchedule: {
    enabled: true,
    cron: null,
  },
  layout: {
    columns: 12,
    rowHeight: 80,
  },
  version: 1,
  access: "private" as const,
  createdBy: "user_1",
  createdAt: "2026-04-04T00:00:00.000Z",
  updatedAt: "2026-04-04T00:00:00.000Z",
  cache: {},
} as unknown as Dashboard;

afterEach(() => {
  useDashboardStore.setState(dashboardStoreBaseline, true);
  useDashboardRuntimeStore.setState(runtimeStoreBaseline, true);
});

describe("dashboard runtime contract", () => {
  it("treats published artifact freshness as part of the viewer load version", () => {
    const viewerV1 = buildDataSourceLoadVersion({
      dataSource: baseDashboard.dataSources[0],
      skipParquet: false,
    });

    const viewerV2 = buildDataSourceLoadVersion({
      dataSource: {
        ...baseDashboard.dataSources[0],
        cache: {
          ...baseDashboard.dataSources[0].cache,
          parquetVersion: "v2",
          parquetUrl: "https://example.com/orders-v2.parquet",
        },
      },
      skipParquet: false,
    });

    const draftV1 = buildDataSourceLoadVersion({
      dataSource: baseDashboard.dataSources[0],
      skipParquet: true,
    });

    const draftV2 = buildDataSourceLoadVersion({
      dataSource: {
        ...baseDashboard.dataSources[0],
        cache: {
          ...baseDashboard.dataSources[0].cache,
          parquetVersion: "v2",
          parquetUrl: "https://example.com/orders-v2.parquet",
        },
      },
      skipParquet: true,
    });

    expect(resolveActiveSource({ skipParquet: false })).toBe(
      "published_artifact",
    );
    expect(resolveActiveSource({ skipParquet: true })).toBe("draft_stream");
    expect(viewerV2).not.toBe(viewerV1);
    expect(draftV2).toBe(draftV1);
  });

  it("exposes runtime source diagnostics in dashboard snapshots", () => {
    useDashboardStore.setState(state => {
      state.openDashboards[baseDashboard._id] = baseDashboard;
      state.activeDashboardId = baseDashboard._id;
    });

    useDashboardRuntimeStore.setState(state => {
      state.activeDashboardId = baseDashboard._id;
      state.sessions[baseDashboard._id] = {
        dashboardId: baseDashboard._id,
        sessionId: "session_1",
        queryGeneration: 4,
        widgets: {},
        eventLog: [],
        runtimeContext: "viewer",
        persistent: false,
        materializationPolling: false,
        freshDataAvailable: true,
        dataSources: {
          ds_1: {
            dataSourceId: "ds_1",
            tableRef: "ds_orders",
            version: "viewer-load-v2",
            dataVersion: 2,
            status: "ready",
            rowsLoaded: 42,
            bytesLoaded: 2048,
            totalBytes: 2048,
            rowCount: 42,
            schema: [{ name: "order_id", type: "VARCHAR" }],
            sampleRows: [{ order_id: "1" }],
            error: null,
            activeSource: "published_artifact",
            loadPath: "memory",
            loadingMessage: null,
            resolvedMode: "viewer",
            artifactUrl: "https://example.com/orders-v2.parquet",
            loadDurationMs: 17,
            materializationStatus: "ready",
            materializationVersion: "v2",
            materializedAt: "2026-04-04T01:00:00.000Z",
            storageBackend: "gcs",
          },
        },
      };
    });

    const snapshot = getDashboardStateSnapshot(baseDashboard._id);
    const dataSource = snapshot.dataSources[0];

    expect(dataSource.activeSource).toBe("published_artifact");
    expect(dataSource.loadPath).toBe("memory");
    expect(dataSource.loadingMessage).toBeNull();
    expect(dataSource.materializationVersion).toBe("v2");
    expect(dataSource.storageBackend).toBe("gcs");
  });
});
