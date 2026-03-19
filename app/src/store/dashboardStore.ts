import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import type {
  Dashboard,
  DashboardDataSource,
  DashboardWidget,
  GlobalFilter,
  TableRelationship,
} from "../dashboard-runtime/types";

export type {
  Dashboard,
  DashboardDataSource,
  DashboardDataSourceOrigin,
  DashboardQueryDefinition,
  DashboardQueryLanguage,
  DashboardWidget,
  GlobalFilter,
  TableRelationship,
} from "../dashboard-runtime/types";

interface DashboardStoreState {
  dashboards: Record<string, Dashboard[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  activeDashboardId: string | null;
  activeDashboard: Dashboard | null;
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
  addDataSource: (dataSource: DashboardDataSource) => void;
  updateDataSource: (
    dataSourceId: string,
    changes: Partial<DashboardDataSource>,
  ) => void;
  removeDataSource: (dataSourceId: string) => void;
  addWidget: (widget: DashboardWidget) => void;
  modifyWidget: (widgetId: string, changes: Partial<DashboardWidget>) => void;
  removeWidget: (widgetId: string) => void;
  addRelationship: (rel: TableRelationship) => void;
  removeRelationship: (relId: string) => void;
  addGlobalFilter: (filter: GlobalFilter) => void;
  removeGlobalFilter: (filterId: string) => void;
  setAutoRefreshInterval: (interval: number | null) => void;
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
          await apiClient.patch(
            `/workspaces/${workspaceId}/dashboards/${activeDashboard._id}`,
            payload,
          );
        } catch {
          // best-effort save
        }
      },

      addDataSource: (dataSource: DashboardDataSource) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.dataSources.push(dataSource);
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      updateDataSource: (
        dataSourceId: string,
        changes: Partial<DashboardDataSource>,
      ) => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            const idx = state.activeDashboard.dataSources.findIndex(
              ds => ds.id === dataSourceId,
            );
            if (idx !== -1) {
              const current = state.activeDashboard.dataSources[idx];
              state.activeDashboard.dataSources[idx] = {
                ...current,
                ...changes,
                query: changes.query
                  ? {
                      ...current.query,
                      ...changes.query,
                    }
                  : current.query,
                cache: changes.cache
                  ? {
                      ...current.cache,
                      ...changes.cache,
                    }
                  : current.cache,
                origin: changes.origin
                  ? {
                      ...current.origin,
                      ...changes.origin,
                    }
                  : current.origin,
              };
            }
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
      },

      removeDataSource: dataSourceId => {
        const workspaceId = get().activeDashboard?.workspaceId;
        get().pushHistory();
        set(state => {
          if (state.activeDashboard) {
            state.activeDashboard.dataSources =
              state.activeDashboard.dataSources.filter(
                ds => ds.id !== dataSourceId,
              );
            state.activeDashboard.widgets =
              state.activeDashboard.widgets.filter(
                widget => widget.dataSourceId !== dataSourceId,
              );
            state.activeDashboard.relationships =
              state.activeDashboard.relationships.filter(
                rel =>
                  rel.from.dataSourceId !== dataSourceId &&
                  rel.to.dataSourceId !== dataSourceId,
              );
            state.activeDashboard.globalFilters =
              state.activeDashboard.globalFilters.filter(
                filter => filter.dataSourceId !== dataSourceId,
              );
          }
        });
        if (workspaceId) debouncedSave(get, workspaceId);
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

      setAutoRefreshInterval: (interval: number | null) => {
        set(state => {
          state.autoRefreshInterval = interval;
        });
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
