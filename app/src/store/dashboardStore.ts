import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

export interface DashboardDataSource {
  id: string;
  name: string;
  consoleId: string;
  connectionId: string;
  timeDimension?: string;
  rowLimit?: number;
  cache?: {
    ttlSeconds?: number;
    lastRefreshedAt?: string;
    rowCount?: number;
    byteSize?: number;
  };
}

export interface DashboardWidget {
  id: string;
  title?: string;
  type: "chart" | "kpi" | "table";
  dataSourceId: string;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  kpiConfig?: {
    valueField: string;
    format?: string;
    comparisonField?: string;
    comparisonLabel?: string;
  };
  tableConfig?: { columns?: string[]; pageSize?: number };
  crossFilter: { enabled: boolean; fields?: string[] };
  layout: {
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
  };
}

export interface TableRelationship {
  id: string;
  from: { dataSourceId: string; column: string };
  to: { dataSourceId: string; column: string };
  type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
}

export interface GlobalFilter {
  id: string;
  type: "date-range" | "select" | "multi-select" | "search";
  label: string;
  dataSourceId: string;
  column: string;
  config: Record<string, unknown>;
  layout: { order: number; width?: number };
}

export interface Dashboard {
  _id: string;
  workspaceId: string;
  title: string;
  description?: string;
  dataSources: DashboardDataSource[];
  relationships: TableRelationship[];
  widgets: DashboardWidget[];
  globalFilters: GlobalFilter[];
  crossFilter: { enabled: boolean; resolution: "intersect" | "union" };
  layout: { columns: number; rowHeight: number };
  cache: { ttlSeconds: number; lastRefreshedAt?: string };
  access: "private" | "workspace";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface DashboardStoreState {
  dashboards: Record<string, Dashboard[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  activeDashboardId: string | null;
  activeDashboard: Dashboard | null;

  db: AsyncDuckDB | null;
  dataSourceStatus: Record<string, "loading" | "ready" | "error">;

  autoRefreshInterval: number | null;

  history: Dashboard[];
  historyIndex: number;

  fetchDashboards: (workspaceId: string) => Promise<Dashboard[]>;
  createDashboard: (
    workspaceId: string,
    data: Partial<Dashboard>,
  ) => Promise<Dashboard | null>;
  updateDashboard: (
    workspaceId: string,
    id: string,
    data: Partial<Dashboard>,
  ) => Promise<void>;
  deleteDashboard: (workspaceId: string, id: string) => Promise<void>;
  duplicateDashboard: (
    workspaceId: string,
    id: string,
  ) => Promise<Dashboard | null>;

  openDashboard: (workspaceId: string, dashboardId: string) => Promise<void>;
  closeDashboard: () => void;
  saveDashboard: (workspaceId: string) => Promise<void>;

  addWidget: (widget: DashboardWidget) => void;
  modifyWidget: (widgetId: string, changes: Partial<DashboardWidget>) => void;
  removeWidget: (widgetId: string) => void;

  addRelationship: (rel: TableRelationship) => void;
  removeRelationship: (relId: string) => void;

  addGlobalFilter: (filter: GlobalFilter) => void;
  removeGlobalFilter: (filterId: string) => void;

  setDataSourceStatus: (
    dataSourceId: string,
    status: "loading" | "ready" | "error",
  ) => void;
  setDb: (db: AsyncDuckDB | null) => void;
  setAutoRefreshInterval: (interval: number | null) => void;

  loadDataSource: (
    dataSource: DashboardDataSource,
    workspaceId: string,
  ) => Promise<void>;
  refreshAllDataSources: (workspaceId: string) => Promise<void>;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(get: () => DashboardStoreState, workspaceId: string) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    get().saveDashboard(workspaceId);
  }, 500);
}

export const useDashboardStore = create<DashboardStoreState>()(
  persist(
    immer((set, get) => ({
      dashboards: {},
      loading: {},
      error: {},
      activeDashboardId: null,
      activeDashboard: null,
      db: null,
      dataSourceStatus: {},
      autoRefreshInterval: null,
      history: [],
      historyIndex: -1,

      fetchDashboards: async (workspaceId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: Dashboard[];
          }>(`/workspaces/${workspaceId}/dashboards`);

          const data = response.data || [];
          set(state => {
            state.dashboards[workspaceId] = data;
          });
          return data;
        } catch (e: any) {
          set(state => {
            state.error[workspaceId] =
              e?.message || "Failed to fetch dashboards";
          });
          return [];
        } finally {
          set(state => {
            state.loading[workspaceId] = false;
          });
        }
      },

      createDashboard: async (
        workspaceId: string,
        data: Partial<Dashboard>,
      ) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data: Dashboard;
          }>(`/workspaces/${workspaceId}/dashboards`, data);

          if (response.data) {
            set(state => {
              if (!state.dashboards[workspaceId]) {
                state.dashboards[workspaceId] = [];
              }
              state.dashboards[workspaceId].unshift(response.data);
            });
            return response.data;
          }
          return null;
        } catch {
          return null;
        }
      },

      updateDashboard: async (
        workspaceId: string,
        id: string,
        data: Partial<Dashboard>,
      ) => {
        try {
          await apiClient.put(
            `/workspaces/${workspaceId}/dashboards/${id}`,
            data,
          );
          set(state => {
            const list = state.dashboards[workspaceId];
            if (list) {
              const idx = list.findIndex(d => d._id === id);
              if (idx !== -1) Object.assign(list[idx], data);
            }
            if (state.activeDashboard?._id === id) {
              Object.assign(state.activeDashboard, data);
            }
          });
        } catch {
          // silent
        }
      },

      deleteDashboard: async (workspaceId: string, id: string) => {
        try {
          await apiClient.delete(`/workspaces/${workspaceId}/dashboards/${id}`);
          set(state => {
            const list = state.dashboards[workspaceId];
            if (list) {
              state.dashboards[workspaceId] = list.filter(d => d._id !== id);
            }
            if (state.activeDashboardId === id) {
              state.activeDashboardId = null;
              state.activeDashboard = null;
            }
          });
        } catch {
          // silent
        }
      },

      duplicateDashboard: async (workspaceId: string, id: string) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data: Dashboard;
          }>(`/workspaces/${workspaceId}/dashboards/${id}/duplicate`);

          if (response.data) {
            set(state => {
              if (!state.dashboards[workspaceId]) {
                state.dashboards[workspaceId] = [];
              }
              state.dashboards[workspaceId].unshift(response.data);
            });
            return response.data;
          }
          return null;
        } catch {
          return null;
        }
      },

      openDashboard: async (workspaceId: string, dashboardId: string) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: Dashboard;
          }>(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);

          if (response.data) {
            set(state => {
              state.activeDashboardId = dashboardId;
              state.activeDashboard = response.data;
              state.dataSourceStatus = {};
              state.history = [];
              state.historyIndex = -1;
            });
          }
        } catch {
          // silent
        }
      },

      closeDashboard: () => {
        set(state => {
          state.activeDashboardId = null;
          state.activeDashboard = null;
          state.dataSourceStatus = {};
          state.db = null;
          state.history = [];
          state.historyIndex = -1;
        });
      },

      saveDashboard: async (workspaceId: string) => {
        const { activeDashboard } = get();
        if (!activeDashboard) return;
        try {
          const payload = {
            widgets: activeDashboard.widgets,
            dataSources: activeDashboard.dataSources,
            relationships: activeDashboard.relationships,
            globalFilters: activeDashboard.globalFilters,
            crossFilter: activeDashboard.crossFilter,
            layout: activeDashboard.layout,
            cache: activeDashboard.cache,
            title: activeDashboard.title,
            description: activeDashboard.description,
          };
          console.log("[Dashboard] Auto-saving", {
            widgets: payload.widgets.length,
            dataSources: payload.dataSources.length,
          });
          await apiClient.patch(
            `/workspaces/${workspaceId}/dashboards/${activeDashboard._id}`,
            payload,
          );
        } catch (err) {
          console.error("[Dashboard] Auto-save failed:", err);
        }
      },

      addWidget: (widget: DashboardWidget) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.widgets.push(widget);
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      modifyWidget: (widgetId: string, changes: Partial<DashboardWidget>) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            const idx = state.activeDashboard.widgets.findIndex(
              w => w.id === widgetId,
            );
            if (idx !== -1) {
              Object.assign(state.activeDashboard.widgets[idx], changes);
            }
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      removeWidget: (widgetId: string) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.widgets =
              state.activeDashboard.widgets.filter(w => w.id !== widgetId);
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      addRelationship: (rel: TableRelationship) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.relationships.push(rel);
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      removeRelationship: (relId: string) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.relationships =
              state.activeDashboard.relationships.filter(r => r.id !== relId);
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      addGlobalFilter: (filter: GlobalFilter) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.globalFilters.push(filter);
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      removeGlobalFilter: (filterId: string) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.globalFilters =
              state.activeDashboard.globalFilters.filter(
                f => f.id !== filterId,
              );
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      setDataSourceStatus: (
        dataSourceId: string,
        status: "loading" | "ready" | "error",
      ) => {
        set(state => {
          state.dataSourceStatus[dataSourceId] = status;
        });
      },

      setDb: (db: AsyncDuckDB | null) => {
        set(state => {
          state.db = db as any;
        });
      },

      setAutoRefreshInterval: (interval: number | null) => {
        set(state => {
          state.autoRefreshInterval = interval;
        });
      },

      loadDataSource: async (
        dataSource: DashboardDataSource,
        workspaceId: string,
      ) => {
        const { db, setDataSourceStatus } = get();
        if (!db) return;

        setDataSourceStatus(dataSource.id, "loading");
        try {
          const response = await fetch(
            `/api/workspaces/${workspaceId}/consoles/${dataSource.consoleId}/export?format=json&limit=${dataSource.rowLimit || 500000}`,
            { credentials: "include" },
          );

          if (!response.ok) {
            throw new Error(`Export failed: ${response.statusText}`);
          }

          const json = await response.json();
          const rows = json.data || [];
          const { loadJsonTable } = await import("../lib/duckdb");
          await loadJsonTable(db, dataSource.name, rows);

          setDataSourceStatus(dataSource.id, "ready");

          set(state => {
            if (state.activeDashboard) {
              const ds = state.activeDashboard.dataSources.find(
                d => d.id === dataSource.id,
              );
              if (ds && ds.cache) {
                ds.cache.lastRefreshedAt = new Date().toISOString();
                ds.cache.rowCount = parseInt(
                  response.headers.get("X-Row-Count") || "0",
                  10,
                );
              }
            }
          });
        } catch {
          setDataSourceStatus(dataSource.id, "error");
        }
      },

      refreshAllDataSources: async (workspaceId: string) => {
        const { activeDashboard, loadDataSource } = get();
        if (!activeDashboard) return;
        await Promise.all(
          activeDashboard.dataSources.map(ds =>
            loadDataSource(ds, workspaceId),
          ),
        );
      },

      pushHistory: () => {
        set(state => {
          if (state.activeDashboard) {
            const snapshot = JSON.parse(JSON.stringify(state.activeDashboard));
            state.history = state.history.slice(0, state.historyIndex + 1);
            state.history.push(snapshot);
            if (state.history.length > 50) state.history.shift();
            state.historyIndex = state.history.length - 1;
          }
        });
      },

      undo: () => {
        set(state => {
          if (state.historyIndex > 0) {
            state.historyIndex -= 1;
            state.activeDashboard = JSON.parse(
              JSON.stringify(state.history[state.historyIndex]),
            );
          }
        });
      },

      redo: () => {
        set(state => {
          if (state.historyIndex < state.history.length - 1) {
            state.historyIndex += 1;
            state.activeDashboard = JSON.parse(
              JSON.stringify(state.history[state.historyIndex]),
            );
          }
        });
      },
    })),
    {
      name: "mako-dashboard-store",
      partialize: state => ({
        activeDashboardId: state.activeDashboardId,
        autoRefreshInterval: state.autoRefreshInterval,
      }),
    },
  ),
);
