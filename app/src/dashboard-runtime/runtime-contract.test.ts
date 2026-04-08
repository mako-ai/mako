import { afterEach, describe, expect, it } from "vitest";
import { getDashboardStateSnapshot } from "./commands";
import { buildDataSourceLoadVersion, resolveActiveSource } from "./gateway";
import { useDashboardRuntimeStore } from "./store";
import { useDashboardStore } from "../store/dashboardStore";
import { serializeDashboardDefinition, type Dashboard } from "./types";
import { computeDashboardStateHash } from "../utils/stateHash";

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
        definitionHash: "def_v1",
        artifactRevision: "rev_v1",
        parquetBuildStatus: "ready" as const,
        parquetUrl: "https://example.com/orders-v1.parquet?rev=rev_v1",
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
          artifactRevision: "rev_v2",
          parquetBuiltAt: "2026-04-05T00:00:00.000Z",
          parquetUrl: "https://example.com/orders-v1.parquet?rev=rev_v2",
        },
      },
      skipParquet: false,
    });

    const viewerV3 = buildDataSourceLoadVersion({
      dataSource: {
        ...baseDashboard.dataSources[0],
        query: {
          ...baseDashboard.dataSources[0].query,
          code: "select order_id from orders",
        },
        cache: {
          ...baseDashboard.dataSources[0].cache,
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
          artifactRevision: "rev_v2",
          parquetUrl: "https://example.com/orders-v2.parquet?rev=rev_v2",
        },
      },
      skipParquet: true,
    });

    expect(resolveActiveSource({ skipParquet: false })).toBe(
      "published_artifact",
    );
    expect(resolveActiveSource({ skipParquet: true })).toBe("draft_stream");
    expect(viewerV2).not.toBe(viewerV1);
    expect(viewerV3).not.toBe(viewerV1);
    expect(draftV2).toBe(draftV1);
  });

  it("prefers a newer parquet build timestamp over a stale artifact revision", () => {
    const viewerBefore = buildDataSourceLoadVersion({
      dataSource: {
        ...baseDashboard.dataSources[0],
        cache: {
          ...baseDashboard.dataSources[0].cache,
          artifactRevision: "1775662508836",
          parquetBuiltAt: "2026-04-08T15:35:08.836Z",
        },
      },
      skipParquet: false,
    });

    const viewerAfter = buildDataSourceLoadVersion({
      dataSource: {
        ...baseDashboard.dataSources[0],
        cache: {
          ...baseDashboard.dataSources[0].cache,
          artifactRevision: "1775662508836",
          parquetBuiltAt: "2026-04-08T15:37:06.840Z",
        },
      },
      skipParquet: false,
    });

    expect(viewerAfter).not.toBe(viewerBefore);
    expect(viewerAfter).toContain(
      String(Date.parse("2026-04-08T15:37:06.840Z")),
    );
  });

  it("strips server-managed cache metadata from editable definitions", () => {
    const serialized = serializeDashboardDefinition({
      ...baseDashboard,
      cache: {
        lastRefreshedAt: "2026-04-06T00:00:00.000Z",
      },
      snapshots: {
        widget_1: {
          version: "snap_v1",
          generatedAt: "2026-04-06T00:00:00.000Z",
          rowCount: 1,
          rows: [{ id: 1 }],
          fields: [{ name: "id", type: "INTEGER" }],
        },
      },
      dataSources: [
        {
          ...baseDashboard.dataSources[0],
          cache: {
            ...baseDashboard.dataSources[0].cache,
            definitionHash: "server-only-definition-hash",
            artifactRevision: "server-only-revision",
          },
        },
      ],
    } as Dashboard);

    expect(serialized.cache).toEqual({});
    expect("snapshots" in serialized).toBe(false);
    expect(serialized.dataSources[0]).not.toHaveProperty("cache");
  });

  it("treats tableRef changes as unsaved dashboard changes", () => {
    const hashA = computeDashboardStateHash(baseDashboard);
    const hashB = computeDashboardStateHash({
      ...baseDashboard,
      dataSources: [
        {
          ...baseDashboard.dataSources[0],
          tableRef: "ds_orders_renamed",
        },
      ],
    });

    expect(hashB).not.toBe(hashA);
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
            artifactRevision: "rev_v2",
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
    expect(dataSource.artifactRevision).toBe("rev_v2");
    expect(dataSource.storageBackend).toBe("gcs");
  });
});
