import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import {
  DashboardDefinitionSchema,
  normalizeWidgetLayouts,
} from "@mako/schemas";
import { computeDashboardStateHash } from "../utils/stateHash";
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
  DashboardEditLock,
  DashboardQueryDefinition,
  DashboardQueryLanguage,
  DashboardWidget,
  GlobalFilter,
  TableRelationship,
} from "../dashboard-runtime/types";

interface HistoryEntry {
  stack: Dashboard[];
  index: number;
}

export interface DashboardConflict {
  dashboardId: string;
  serverVersion: number;
  serverDashboard: Dashboard;
  localDashboard: Dashboard;
}

export interface DashboardDataSourceMaterializationStatus {
  dataSourceId: string;
  name: string;
  status: "missing" | "building" | "ready" | "error";
  version: string | null;
  format: "parquet";
  storageBackend: "filesystem" | "gcs" | "s3";
  rowCount: number | null;
  byteSize: number | null;
  builtAt: string | null;
  readUrl: string | null;
  lastError: string | null;
  artifactKey: string | null;
  lastMaterializedAt: string | null;
}

export interface DashboardMaterializationStatus {
  dashboardId: string;
  workspaceId: string;
  status: "missing" | "building" | "ready" | "error";
  lastRefreshedAt: string | null;
  allReady: boolean;
  anyBuilding: boolean;
  dataSources: DashboardDataSourceMaterializationStatus[];
}

export interface MaterializationRunRecord {
  runId: string;
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  triggerType: "manual" | "schedule" | "dashboard_update";
  status: "building" | "ready" | "error";
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  artifactKey?: string;
  version?: string;
  rowCount?: number;
  byteSize?: number;
  error?: string;
  events: Array<{
    type: string;
    timestamp: string;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
}

function applyMaterializationStatusToDashboard(
  dashboard: Dashboard,
  status: DashboardMaterializationStatus,
) {
  dashboard.cache = {
    ...dashboard.cache,
    lastRefreshedAt: status.lastRefreshedAt || dashboard.cache?.lastRefreshedAt,
  };
  dashboard.dataSources = dashboard.dataSources.map(dataSource => {
    const sourceStatus = status.dataSources.find(
      source => source.dataSourceId === dataSource.id,
    );
    if (!sourceStatus) {
      return dataSource;
    }

    return {
      ...dataSource,
      cache: {
        ...dataSource.cache,
        rowCount: sourceStatus.rowCount ?? undefined,
        byteSize: sourceStatus.byteSize ?? undefined,
        parquetArtifactKey: sourceStatus.artifactKey ?? undefined,
        parquetVersion: sourceStatus.version ?? undefined,
        parquetBuiltAt: sourceStatus.builtAt ?? undefined,
        parquetBuildStatus: sourceStatus.status,
        parquetLastError: sourceStatus.lastError ?? undefined,
        parquetUrl: sourceStatus.readUrl ?? undefined,
      },
    };
  });
}

interface DashboardStoreState {
  dashboards: Record<string, Dashboard[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  openDashboards: Record<string, Dashboard>;
  activeDashboardId: string | null;
  historyMap: Record<string, HistoryEntry>;
  autoRefreshInterval: number | null;

  conflict: DashboardConflict | null;

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
  reloadDashboard: (workspaceId: string, dashboardId: string) => Promise<void>;
  closeDashboard: (dashboardId: string) => void;
  saveDashboard: (workspaceId: string, dashboardId: string) => Promise<boolean>;
  resolveConflict: (
    resolution: "discard" | "overwrite",
    workspaceId: string,
  ) => Promise<void>;
  applyDefinition: (
    dashboardId: string,
    json: unknown,
  ) => { issues: Array<{ path: PropertyKey[]; message: string }> } | null;
  addDataSource: (dashboardId: string, dataSource: DashboardDataSource) => void;
  updateDataSource: (
    dashboardId: string,
    dataSourceId: string,
    changes: Partial<DashboardDataSource>,
  ) => void;
  removeDataSource: (dashboardId: string, dataSourceId: string) => void;
  addWidget: (dashboardId: string, widget: DashboardWidget) => void;
  modifyWidget: (
    dashboardId: string,
    widgetId: string,
    changes: Partial<DashboardWidget>,
  ) => void;
  removeWidget: (dashboardId: string, widgetId: string) => void;
  addRelationship: (dashboardId: string, rel: TableRelationship) => void;
  removeRelationship: (dashboardId: string, relId: string) => void;
  addGlobalFilter: (dashboardId: string, filter: GlobalFilter) => void;
  removeGlobalFilter: (dashboardId: string, filterId: string) => void;
  setAutoRefreshInterval: (interval: number | null) => void;
  pushHistory: (dashboardId: string) => void;
  undo: (dashboardId: string) => void;
  redo: (dashboardId: string) => void;
  fetchDashboardMaterializationStatus: (
    workspaceId: string,
    dashboardId: string,
  ) => Promise<DashboardMaterializationStatus | null>;
  materializeDashboard: (
    workspaceId: string,
    dashboardId: string,
    input?: { force?: boolean; blocking?: boolean; dataSourceIds?: string[] },
  ) => Promise<any>;
  materializeDashboardDataSource: (
    workspaceId: string,
    dashboardId: string,
    dataSourceId: string,
    input?: { force?: boolean; blocking?: boolean },
  ) => Promise<any>;
  fetchMaterializationRuns: (
    workspaceId: string,
    dashboardId: string,
    dataSourceId?: string,
  ) => Promise<MaterializationRunRecord[]>;
  fetchMaterializationRunDetail: (
    workspaceId: string,
    dashboardId: string,
    runId: string,
  ) => Promise<MaterializationRunRecord | null>;

  markDashboardSaved: (dashboardId: string) => void;
  getDashboardSavedStateHash: (dashboardId: string) => string | undefined;

  acquireLock: (workspaceId: string, dashboardId: string) => Promise<boolean>;
  forceAcquireLock: (
    workspaceId: string,
    dashboardId: string,
  ) => Promise<boolean>;
  releaseLock: (workspaceId: string, dashboardId: string) => Promise<void>;
  autoSaveDashboard: (workspaceId: string, dashboardId: string) => void;
  heartbeatLock: (workspaceId: string, dashboardId: string) => Promise<void>;
}

const savedStateHashes: Record<string, string> = {};
const draftSaveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const DRAFT_SAVE_DEBOUNCE_MS = 2000;

export const useDashboardStore = create<DashboardStoreState>()(
  persist(
    immer((set, get) => ({
      dashboards: {},
      loading: {},
      error: {},
      openDashboards: {},
      activeDashboardId: null,
      historyMap: {},
      autoRefreshInterval: null,
      conflict: null,

      fetchDashboards: async (workspaceId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });
        try {
          const response = await apiClient.get<{
            success: boolean;
            data?: Dashboard[];
            myDashboards?: any[];
            workspaceDashboards?: any[];
          }>(`/workspaces/${workspaceId}/dashboards`);

          // Support both flat (legacy) and tree (new) response shapes
          let data: Dashboard[];
          if (response.data) {
            data = response.data;
          } else {
            const flatten = (nodes: any[]): Dashboard[] => {
              const result: Dashboard[] = [];
              for (const node of nodes) {
                if (node.isDirectory && node.children) {
                  result.push(...flatten(node.children));
                } else if (!node.isDirectory) {
                  result.push(node);
                }
              }
              return result;
            };
            data = [
              ...flatten(response.myDashboards || []),
              ...flatten(response.workspaceDashboards || []),
            ];
          }

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
          const response = await apiClient.put<{
            success: boolean;
            data: Dashboard;
          }>(`/workspaces/${workspaceId}/dashboards/${id}`, data);
          set(state => {
            const list = state.dashboards[workspaceId];
            if (list) {
              const idx = list.findIndex(d => d._id === id);
              if (idx !== -1) {
                Object.assign(list[idx], response.data || data);
              }
            }
            if (state.openDashboards[id]) {
              Object.assign(state.openDashboards[id], response.data || data);
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
            delete state.openDashboards[id];
            delete state.historyMap[id];
            if (state.activeDashboardId === id) {
              state.activeDashboardId = null;
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
        const existing = get().openDashboards[dashboardId];
        if (existing) {
          set(state => {
            state.activeDashboardId = dashboardId;
          });
          return;
        }

        await get().reloadDashboard(workspaceId, dashboardId);
      },

      reloadDashboard: async (workspaceId: string, dashboardId: string) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: Dashboard;
          }>(`/workspaces/${workspaceId}/dashboards/${dashboardId}`);

          if (response.data) {
            const dashboard = response.data;
            dashboard.isSaved = true;
            if (Array.isArray(dashboard.widgets)) {
              dashboard.widgets = dashboard.widgets.map(
                w =>
                  normalizeWidgetLayouts(
                    w as Record<string, unknown>,
                  ) as typeof w,
              );
            }
            set(state => {
              state.openDashboards[dashboardId] = dashboard;
              state.activeDashboardId = dashboardId;
              state.historyMap[dashboardId] = { stack: [], index: -1 };
            });
            savedStateHashes[dashboardId] =
              computeDashboardStateHash(dashboard);
          }
        } catch {
          // silent
        }
      },

      closeDashboard: (dashboardId: string) => {
        set(state => {
          delete state.openDashboards[dashboardId];
          delete state.historyMap[dashboardId];
          if (state.activeDashboardId === dashboardId) {
            state.activeDashboardId = null;
          }
        });
        delete savedStateHashes[dashboardId];
      },

      saveDashboard: async (workspaceId: string, dashboardId: string) => {
        const dashboard = get().openDashboards[dashboardId];
        if (!dashboard) return false;
        try {
          const payload = {
            widgets: dashboard.widgets,
            dataSources: dashboard.dataSources,
            relationships: dashboard.relationships,
            globalFilters: dashboard.globalFilters,
            crossFilter: dashboard.crossFilter,
            materializationSchedule: dashboard.materializationSchedule,
            layout: dashboard.layout,
            cache: dashboard.cache,
            title: dashboard.title,
            description: dashboard.description,
            version: dashboard.version,
          };
          const response = await apiClient.patch<{
            success: boolean;
            data: Dashboard;
          }>(`/workspaces/${workspaceId}/dashboards/${dashboardId}`, payload);
          if (response.data) {
            set(state => {
              const local = state.openDashboards[dashboardId];
              if (local) {
                local.version = response.data.version;
              }
            });
          }
          return true;
        } catch (err: any) {
          const status = err?.response?.status ?? err?.status;
          if (
            status === 409 &&
            err?.response?.data?.code === "VERSION_CONFLICT"
          ) {
            const serverData = err.response.data.data as Dashboard;
            set(state => {
              state.conflict = {
                dashboardId,
                serverVersion: err.response.data.serverVersion,
                serverDashboard: serverData,
                localDashboard: JSON.parse(
                  JSON.stringify(state.openDashboards[dashboardId]),
                ),
              };
            });
          }
          return false;
        }
      },

      resolveConflict: async (
        resolution: "discard" | "overwrite",
        workspaceId: string,
      ) => {
        const conflict = get().conflict;
        if (!conflict) return;
        const { dashboardId, serverDashboard, localDashboard } = conflict;

        if (resolution === "discard") {
          set(state => {
            state.openDashboards[dashboardId] = serverDashboard;
            state.conflict = null;
            state.historyMap[dashboardId] = { stack: [], index: -1 };
          });
        } else {
          set(state => {
            state.openDashboards[dashboardId] = {
              ...localDashboard,
              version: serverDashboard.version,
            };
            state.conflict = null;
          });
          await get().saveDashboard(workspaceId, dashboardId);
        }
      },

      applyDefinition: (dashboardId: string, json: unknown) => {
        const result = DashboardDefinitionSchema.safeParse(json);
        if (!result.success) {
          return result.error;
        }
        const dashboard = get().openDashboards[dashboardId];
        if (!dashboard) return null;

        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            Object.assign(d, result.data);
            d.isSaved = false;
          }
        });
        const workspaceId = dashboard.workspaceId;
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
        return null;
      },

      addDataSource: (dashboardId: string, dataSource: DashboardDataSource) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.dataSources.push(dataSource);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      updateDataSource: (
        dashboardId: string,
        dataSourceId: string,
        changes: Partial<DashboardDataSource>,
      ) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            const idx = d.dataSources.findIndex(ds => ds.id === dataSourceId);
            if (idx !== -1) {
              const current = d.dataSources[idx];
              d.dataSources[idx] = {
                ...current,
                ...changes,
                query: changes.query
                  ? { ...current.query, ...changes.query }
                  : current.query,
                cache: changes.cache
                  ? { ...current.cache, ...changes.cache }
                  : current.cache,
                origin: changes.origin
                  ? { ...current.origin, ...changes.origin }
                  : current.origin,
              };
            }
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      removeDataSource: (dashboardId: string, dataSourceId: string) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.dataSources = d.dataSources.filter(ds => ds.id !== dataSourceId);
            d.widgets = d.widgets.filter(w => w.dataSourceId !== dataSourceId);
            d.relationships = d.relationships.filter(
              r =>
                r.from.dataSourceId !== dataSourceId &&
                r.to.dataSourceId !== dataSourceId,
            );
            d.globalFilters = d.globalFilters.filter(
              f => f.dataSourceId !== dataSourceId,
            );
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      addWidget: (dashboardId: string, widget: DashboardWidget) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.widgets.push(widget);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      modifyWidget: (
        dashboardId: string,
        widgetId: string,
        changes: Partial<DashboardWidget>,
      ) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            const idx = d.widgets.findIndex(w => w.id === widgetId);
            if (idx !== -1) {
              Object.assign(d.widgets[idx], changes);
            }
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      removeWidget: (dashboardId: string, widgetId: string) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.widgets = d.widgets.filter(w => w.id !== widgetId);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      addRelationship: (dashboardId: string, rel: TableRelationship) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.relationships.push(rel);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      removeRelationship: (dashboardId: string, relId: string) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.relationships = d.relationships.filter(r => r.id !== relId);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      addGlobalFilter: (dashboardId: string, filter: GlobalFilter) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.globalFilters.push(filter);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      removeGlobalFilter: (dashboardId: string, filterId: string) => {
        const workspaceId = get().openDashboards[dashboardId]?.workspaceId;
        get().pushHistory(dashboardId);
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (d) {
            d.globalFilters = d.globalFilters.filter(f => f.id !== filterId);
            d.isSaved = false;
          }
        });
        if (workspaceId) get().autoSaveDashboard(workspaceId, dashboardId);
      },

      setAutoRefreshInterval: (interval: number | null) => {
        set(state => {
          state.autoRefreshInterval = interval;
        });
      },

      pushHistory: (dashboardId: string) => {
        set(state => {
          const d = state.openDashboards[dashboardId];
          if (!d) return;
          if (!state.historyMap[dashboardId]) {
            state.historyMap[dashboardId] = { stack: [], index: -1 };
          }
          const h = state.historyMap[dashboardId];
          const snapshot = JSON.parse(JSON.stringify(d));
          h.stack = h.stack.slice(0, h.index + 1);
          h.stack.push(snapshot);
          if (h.stack.length > 50) h.stack.shift();
          h.index = h.stack.length - 1;
        });
      },

      undo: (dashboardId: string) => {
        set(state => {
          const h = state.historyMap[dashboardId];
          if (!h || h.index <= 0) return;
          h.index -= 1;
          state.openDashboards[dashboardId] = JSON.parse(
            JSON.stringify(h.stack[h.index]),
          );
        });
      },

      redo: (dashboardId: string) => {
        set(state => {
          const h = state.historyMap[dashboardId];
          if (!h || h.index >= h.stack.length - 1) return;
          h.index += 1;
          state.openDashboards[dashboardId] = JSON.parse(
            JSON.stringify(h.stack[h.index]),
          );
        });
      },

      fetchDashboardMaterializationStatus: async (
        workspaceId: string,
        dashboardId: string,
      ) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: DashboardMaterializationStatus;
          }>(
            `/workspaces/${workspaceId}/dashboards/${dashboardId}/materialization`,
          );
          if (!response.data) {
            return null;
          }
          set(state => {
            const openDashboard = state.openDashboards[dashboardId];
            if (openDashboard) {
              applyMaterializationStatusToDashboard(
                openDashboard,
                response.data,
              );
            }
            const listDashboard = state.dashboards[workspaceId]?.find(
              dashboard => dashboard._id === dashboardId,
            );
            if (listDashboard) {
              applyMaterializationStatusToDashboard(
                listDashboard,
                response.data,
              );
            }
          });
          return response.data;
        } catch {
          return null;
        }
      },

      materializeDashboard: async (
        workspaceId: string,
        dashboardId: string,
        input = {},
      ) =>
        await apiClient.post(
          `/workspaces/${workspaceId}/dashboards/${dashboardId}/materialize`,
          input,
        ),

      materializeDashboardDataSource: async (
        workspaceId: string,
        dashboardId: string,
        dataSourceId: string,
        input = {},
      ) =>
        await apiClient.post(
          `/workspaces/${workspaceId}/dashboards/${dashboardId}/data-sources/${dataSourceId}/materialize`,
          input,
        ),

      fetchMaterializationRuns: async (
        workspaceId: string,
        dashboardId: string,
        dataSourceId?: string,
      ) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: MaterializationRunRecord[];
          }>(
            dataSourceId
              ? `/workspaces/${workspaceId}/dashboards/${dashboardId}/data-sources/${dataSourceId}/materialization/runs`
              : `/workspaces/${workspaceId}/dashboards/${dashboardId}/materialization/runs`,
          );
          return response.data || [];
        } catch {
          return [];
        }
      },

      fetchMaterializationRunDetail: async (
        workspaceId: string,
        dashboardId: string,
        runId: string,
      ) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: MaterializationRunRecord;
          }>(
            `/workspaces/${workspaceId}/dashboards/${dashboardId}/materialization/runs/${runId}`,
          );
          return response.data || null;
        } catch {
          return null;
        }
      },

      autoSaveDashboard: (workspaceId: string, dashboardId: string) => {
        const dashboard = get().openDashboards[dashboardId];
        if (!dashboard || dashboard.isSaved) return;

        if (draftSaveTimers[dashboardId]) {
          clearTimeout(draftSaveTimers[dashboardId]);
        }
        draftSaveTimers[dashboardId] = setTimeout(() => {
          delete draftSaveTimers[dashboardId];
          const current = get().openDashboards[dashboardId];
          if (current && !current.isSaved) {
            get().saveDashboard(workspaceId, dashboardId);
          }
        }, DRAFT_SAVE_DEBOUNCE_MS);
      },

      markDashboardSaved: (dashboardId: string) => {
        const dashboard = get().openDashboards[dashboardId];
        if (dashboard) {
          set(state => {
            const d = state.openDashboards[dashboardId];
            if (d) d.isSaved = true;
          });
          const updated = get().openDashboards[dashboardId];
          if (updated) {
            savedStateHashes[dashboardId] = computeDashboardStateHash(updated);
          }
        }
      },

      getDashboardSavedStateHash: (dashboardId: string) => {
        return savedStateHashes[dashboardId];
      },

      acquireLock: async (workspaceId: string, dashboardId: string) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data: Pick<Dashboard, "editLock">;
          }>(`/workspaces/${workspaceId}/dashboards/${dashboardId}/lock`);
          if (response.data) {
            set(state => {
              const d = state.openDashboards[dashboardId];
              if (d) {
                d.editLock = response.data.editLock;
              }
            });
          }
          return true;
        } catch {
          const dash = get().openDashboards[dashboardId];
          if (dash) {
            await get().reloadDashboard(workspaceId, dashboardId);
          }
          return false;
        }
      },

      forceAcquireLock: async (workspaceId: string, dashboardId: string) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data: Pick<Dashboard, "editLock">;
          }>(
            `/workspaces/${workspaceId}/dashboards/${dashboardId}/lock?force=true`,
          );
          if (response.data) {
            set(state => {
              const d = state.openDashboards[dashboardId];
              if (d) {
                d.editLock = response.data.editLock;
              }
            });
          }
          return true;
        } catch {
          return false;
        }
      },

      releaseLock: async (workspaceId: string, dashboardId: string) => {
        try {
          await apiClient.delete(
            `/workspaces/${workspaceId}/dashboards/${dashboardId}/lock`,
          );
          set(state => {
            const d = state.openDashboards[dashboardId];
            if (d) {
              d.editLock = null;
            }
          });
        } catch {
          // best-effort
        }
      },

      heartbeatLock: async (workspaceId: string, dashboardId: string) => {
        try {
          await apiClient.post(
            `/workspaces/${workspaceId}/dashboards/${dashboardId}/lock/heartbeat`,
          );
        } catch {
          // best-effort
        }
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

export const selectDashboard =
  (id: string | undefined) =>
  (state: DashboardStoreState): Dashboard | undefined =>
    id ? state.openDashboards[id] : undefined;
