import { nanoid } from "nanoid";
import { apiClient } from "../lib/api-client";
import type { ConsoleContentResponse } from "../lib/api-types";
import { useDashboardStore } from "../store/dashboardStore";
import {
  activateDashboardRuntime,
  disposeDashboardRuntime,
  materializeDashboardDataSource,
  previewDashboardDataSource,
  queryDashboardRuntime,
  refreshAllDashboardDataSources,
  refreshDashboardDataSource,
  removeDashboardDataSourceRuntime,
  syncDashboardRuntime,
} from "./gateway";
import { ensureMosaicInstance, getMosaicInstance } from "./session-registry";
import { selectDataSourceRuntime } from "./selectors";
import type {
  Dashboard,
  DashboardDataSource,
  DashboardDataSourceOrigin,
  DashboardQueryDefinition,
  DashboardWidget,
} from "./types";

function sanitizeTableRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "ds_table";
}

function buildTableRef(): string {
  return sanitizeTableRef(`ds_${nanoid()}`);
}

function resolveActiveDashboardId(): string {
  const id = useDashboardStore.getState().activeDashboardId;
  if (!id) throw new Error("No active dashboard");
  return id;
}

function getDashboardOrThrow(dashboardId?: string): Dashboard {
  const id = dashboardId ?? resolveActiveDashboardId();
  const dashboard = useDashboardStore.getState().openDashboards[id];
  if (!dashboard) {
    throw new Error(`Dashboard ${id} is not open`);
  }
  return dashboard;
}

export async function activateDashboardSession(
  workspaceId: string,
  dashboardId?: string,
): Promise<void> {
  const dashboard = getDashboardOrThrow(dashboardId);
  await activateDashboardRuntime(dashboard);
  await syncDashboardRuntime({ workspaceId, dashboard });
}

export async function closeDashboardSession(
  dashboardId?: string,
): Promise<void> {
  const id = dashboardId ?? useDashboardStore.getState().activeDashboardId;
  if (!id) return;
  await disposeDashboardRuntime(id);
}

export async function getDashboardMosaicInstance(dashboardId?: string) {
  const resolvedDashboardId =
    dashboardId || useDashboardStore.getState().activeDashboardId;
  if (!resolvedDashboardId) {
    throw new Error("No active dashboard");
  }

  return (
    getMosaicInstance(resolvedDashboardId) ||
    (await ensureMosaicInstance(resolvedDashboardId))
  );
}

export function buildDashboardDataSource(input: {
  name: string;
  query: DashboardQueryDefinition;
  timeDimension?: string;
  rowLimit?: number;
  cacheTtlSeconds?: number;
  origin?: DashboardDataSourceOrigin;
}): DashboardDataSource {
  return {
    id: nanoid(),
    name: input.name,
    tableRef: buildTableRef(),
    query: input.query,
    origin: input.origin,
    timeDimension: input.timeDimension,
    rowLimit: input.rowLimit,
    cache: {
      ttlSeconds: input.cacheTtlSeconds ?? 3600,
    },
    computedColumns: [],
  };
}

export async function createDashboardDataSource(options: {
  workspaceId: string;
  name: string;
  query: DashboardQueryDefinition;
  timeDimension?: string;
  rowLimit?: number;
  cacheTtlSeconds?: number;
  dashboardId?: string;
}): Promise<DashboardDataSource> {
  const store = useDashboardStore.getState();
  const dashboard = getDashboardOrThrow(options.dashboardId);
  const dataSource = buildDashboardDataSource({
    name: options.name,
    query: options.query,
    timeDimension: options.timeDimension,
    rowLimit: options.rowLimit,
    cacheTtlSeconds: options.cacheTtlSeconds,
    origin: { type: "local" },
  });

  store.addDataSource(dashboard._id, dataSource);
  await store.saveDashboard(options.workspaceId, dashboard._id);
  await materializeDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard,
    dataSource,
    force: true,
  });

  return dataSource;
}

export async function importConsoleAsDashboardDataSource(options: {
  workspaceId: string;
  consoleId: string;
  name?: string;
  rowLimit?: number;
  timeDimension?: string;
  dashboardId?: string;
}): Promise<DashboardDataSource> {
  const response = await apiClient.get<ConsoleContentResponse>(
    `/workspaces/${options.workspaceId}/consoles/content`,
    { id: options.consoleId },
  );

  if (!response.success) {
    throw new Error("Failed to fetch console content");
  }

  if (!response.connectionId) {
    throw new Error("Saved console is missing a connection");
  }

  const store = useDashboardStore.getState();
  const dashboard = getDashboardOrThrow(options.dashboardId);
  const dataSource = buildDashboardDataSource({
    name: options.name || response.name || "imported_data_source",
    rowLimit: options.rowLimit,
    timeDimension: options.timeDimension,
    query: {
      connectionId: response.connectionId,
      language: response.language || "sql",
      code: response.content,
      databaseId: response.databaseId,
      databaseName: response.databaseName,
    },
    origin: {
      type: "saved_console",
      consoleId: response.id,
      consoleName: response.name,
      importedAt: new Date().toISOString(),
    },
  });

  store.addDataSource(dashboard._id, dataSource);
  await store.saveDashboard(options.workspaceId, dashboard._id);
  await materializeDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard,
    dataSource,
    force: true,
  });

  return dataSource;
}

export async function updateDashboardDataSourceQuery(options: {
  workspaceId: string;
  dataSourceId: string;
  changes: Partial<DashboardDataSource>;
  rematerialize?: boolean;
  dashboardId?: string;
}): Promise<void> {
  const store = useDashboardStore.getState();
  const dashboard = getDashboardOrThrow(options.dashboardId);
  store.updateDataSource(dashboard._id, options.dataSourceId, options.changes);
  await store.saveDashboard(options.workspaceId, dashboard._id);

  if (options.rematerialize !== false) {
    const updatedDashboard = getDashboardOrThrow(dashboard._id);
    const dataSource = updatedDashboard.dataSources.find(
      ds => ds.id === options.dataSourceId,
    );
    if (dataSource) {
      await materializeDashboardDataSource({
        workspaceId: options.workspaceId,
        dashboard: updatedDashboard,
        dataSource,
        force: true,
      });
    }
  }
}

export async function removeDashboardDataSource(options: {
  workspaceId: string;
  dataSourceId: string;
  dashboardId?: string;
}): Promise<void> {
  const store = useDashboardStore.getState();
  const dashboard = getDashboardOrThrow(options.dashboardId);
  const dataSource = dashboard.dataSources.find(
    ds => ds.id === options.dataSourceId,
  );
  if (!dataSource) {
    return;
  }

  store.removeDataSource(dashboard._id, options.dataSourceId);
  await store.saveDashboard(options.workspaceId, dashboard._id);
  await removeDashboardDataSourceRuntime({
    dashboardId: dashboard._id,
    dataSourceId: dataSource.id,
    tableRef: dataSource.tableRef,
  });
}

export async function refreshDashboardDataSourceCommand(options: {
  workspaceId: string;
  dataSourceId: string;
  dashboardId?: string;
}): Promise<void> {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  await refreshDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard,
    dataSourceId: options.dataSourceId,
  });
}

export async function refreshAllDashboardDataSourcesCommand(
  workspaceId: string,
  dashboardId?: string,
): Promise<void> {
  const dashboard = getDashboardOrThrow(dashboardId);
  await refreshAllDashboardDataSources({ workspaceId, dashboard });
}

export function getDashboardStateSnapshot(dashboardId?: string) {
  const dashboard = getDashboardOrThrow(dashboardId);

  return {
    ...dashboard,
    dataSources: dashboard.dataSources.map(ds => {
      const runtime = selectDataSourceRuntime(dashboard._id, ds.id);
      return {
        ...ds,
        status: runtime?.status || "idle",
        rowsLoaded: runtime?.rowsLoaded || 0,
        rowCount: runtime?.rowCount,
        error: runtime?.error || null,
        columns: runtime?.schema || [],
        sampleRows: runtime?.sampleRows || [],
      };
    }),
  };
}

export async function previewDashboardQuery(options: {
  dataSourceId: string;
  sql?: string;
  dashboardId?: string;
}) {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  return await previewDashboardDataSource({
    dashboard,
    dataSourceId: options.dataSourceId,
    sql: options.sql,
  });
}

export async function executeDashboardSql(options: {
  sql: string;
  dataSourceId?: string;
  dashboardId?: string;
}) {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  return await queryDashboardRuntime({
    dashboard,
    sql: options.sql,
    dataSourceId: options.dataSourceId,
  });
}

export function addDashboardWidget(
  widget: DashboardWidget,
  dashboardId?: string,
): void {
  const id = dashboardId ?? resolveActiveDashboardId();
  useDashboardStore.getState().addWidget(id, widget);
}

export function updateDashboardWidget(
  widgetId: string,
  changes: Partial<DashboardWidget>,
  dashboardId?: string,
): void {
  const id = dashboardId ?? resolveActiveDashboardId();
  useDashboardStore.getState().modifyWidget(id, widgetId, changes);
}

export function removeDashboardWidget(
  widgetId: string,
  dashboardId?: string,
): void {
  const id = dashboardId ?? resolveActiveDashboardId();
  useDashboardStore.getState().removeWidget(id, widgetId);
}
