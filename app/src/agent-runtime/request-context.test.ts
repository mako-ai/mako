import { afterEach, describe, expect, it } from "vitest";
import { buildChatRequestBody } from "./request-context";
import { useDashboardStore } from "../store/dashboardStore";
import { useDashboardRuntimeStore } from "../dashboard-runtime/store";
import type { Dashboard } from "../dashboard-runtime/types";

const dashboardStoreBaseline = useDashboardStore.getState();
const runtimeStoreBaseline = useDashboardRuntimeStore.getState();

const baseDashboard = {
  _id: "dash_1",
  workspaceId: "ws_1",
  title: "Revenue Dashboard",
  description: "Quarterly revenue overview",
  dataSources: [
    {
      id: "ds_1",
      name: "Revenue",
      tableRef: "revenue",
      query: {
        connectionId: "conn_1",
        language: "sql" as const,
        code: "select * from revenue",
      },
      sampleRows: [{ month: "2026-01", revenue: 100 }],
    },
  ],
  widgets: [],
  relationships: [],
  globalFilters: [],
  crossFilter: { enabled: true, resolution: "intersect", engine: "mosaic" },
  materializationSchedule: { enabled: false, cron: null },
  layout: { columns: 12, rowHeight: 80 },
  version: 1,
  access: "private",
  createdBy: "user_1",
  createdAt: "2026-04-12T00:00:00.000Z",
  updatedAt: "2026-04-12T00:00:00.000Z",
  cache: {},
} as unknown as Dashboard;

afterEach(() => {
  useDashboardStore.setState(dashboardStoreBaseline, true);
  useDashboardRuntimeStore.setState(runtimeStoreBaseline, true);
});

describe("buildChatRequestBody", () => {
  it("omits dashboard context on console turns", () => {
    useDashboardStore.setState(state => {
      state.openDashboards = { [baseDashboard._id]: baseDashboard };
      state.activeDashboardId = baseDashboard._id;
    }, false);

    const requestBody = buildChatRequestBody({
      messages: [],
      workspaceId: "ws_1",
      modelId: "model_1",
      chatId: "chat_1",
      tabs: [
        {
          id: "console_1",
          title: "Revenue Query",
          content: "select * from revenue",
          kind: "console",
          connectionId: "conn_1",
          databaseName: "analytics",
        },
      ] as any,
      activeTabId: "console_1",
      activeTab: {
        id: "console_1",
        title: "Revenue Query",
        content: "select * from revenue",
        kind: "console",
        connectionId: "conn_1",
        databaseName: "analytics",
      } as any,
      activeView: "console",
      activeConsoleId: "console_1",
      activeConsoleResults: {
        viewMode: "table",
        hasResults: true,
        rowCount: 1,
        columns: ["month", "revenue"],
        sampleRows: [{ month: "2026-01", revenue: 100 }],
        chartSpec: null,
      },
      workspaceConnections: [{ id: "conn_1", type: "postgresql" }] as any,
      pinnedDashboardId: baseDashboard._id,
    });

    expect(requestBody.openTabs).toHaveLength(1);
    expect(requestBody).not.toHaveProperty("openDashboards");
    expect(requestBody).not.toHaveProperty("activeDashboardContext");
  });

  it("includes pinned dashboard context on dashboard turns", () => {
    useDashboardStore.setState(state => {
      state.openDashboards = { [baseDashboard._id]: baseDashboard };
      state.activeDashboardId = baseDashboard._id;
    }, false);

    const requestBody = buildChatRequestBody({
      messages: [],
      workspaceId: "ws_1",
      modelId: "model_1",
      chatId: "chat_1",
      tabs: [
        {
          id: "dash_tab_1",
          title: "Revenue Dashboard",
          content: "",
          kind: "dashboard",
          metadata: { dashboardId: baseDashboard._id },
        },
      ] as any,
      activeTabId: "dash_tab_1",
      activeTab: {
        id: "dash_tab_1",
        title: "Revenue Dashboard",
        content: "",
        kind: "dashboard",
        metadata: { dashboardId: baseDashboard._id },
      } as any,
      activeView: "dashboard",
      workspaceConnections: [
        { id: "conn_1", type: "postgresql", sqlDialect: "postgresql" },
      ] as any,
      pinnedDashboardId: baseDashboard._id,
    });

    expect(requestBody).toHaveProperty("openDashboards");
    expect(requestBody).toHaveProperty("activeDashboardContext");
    expect(requestBody.activeDashboardContext).toMatchObject({
      dashboardId: baseDashboard._id,
      title: baseDashboard.title,
    });
    expect(requestBody.openDashboards).toEqual([
      { id: baseDashboard._id, title: baseDashboard.title, isActive: true },
    ]);
  });
});
