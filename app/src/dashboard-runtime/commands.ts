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
import { ensureMosaicInstance } from "./session-registry";
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

function getActiveDashboardOrThrow(): Dashboard {
  const dashboard = useDashboardStore.getState().activeDashboard;
  if (!dashboard) {
    throw new Error("No active dashboard");
  }
  return dashboard;
}

export async function activateDashboardSession(
  workspaceId: string,
): Promise<void> {
  const dashboard = getActiveDashboardOrThrow();
  await activateDashboardRuntime(dashboard);
  await syncDashboardRuntime({ workspaceId, dashboard });
}

export async function closeDashboardSession(): Promise<void> {
  const dashboardId = useDashboardStore.getState().activeDashboard?._id;
  if (!dashboardId) {
    return;
  }
  await disposeDashboardRuntime(dashboardId);
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
}): Promise<DashboardDataSource> {
  const store = useDashboardStore.getState();
  const dashboard = getActiveDashboardOrThrow();
  const dataSource = buildDashboardDataSource({
    name: options.name,
    query: options.query,
    timeDimension: options.timeDimension,
    rowLimit: options.rowLimit,
    cacheTtlSeconds: options.cacheTtlSeconds,
    origin: { type: "local" },
  });

  store.addDataSource(dataSource);
  await store.saveDashboard(options.workspaceId);
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
  const dashboard = getActiveDashboardOrThrow();
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

  store.addDataSource(dataSource);
  await store.saveDashboard(options.workspaceId);
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
}): Promise<void> {
  const store = useDashboardStore.getState();
  getActiveDashboardOrThrow();
  store.updateDataSource(options.dataSourceId, options.changes);
  await store.saveDashboard(options.workspaceId);

  if (options.rematerialize !== false) {
    const updatedDashboard = getActiveDashboardOrThrow();
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
}): Promise<void> {
  const store = useDashboardStore.getState();
  const _dashboard = getActiveDashboardOrThrow();
  const dataSource = _dashboard.dataSources.find(
    ds => ds.id === options.dataSourceId,
  );
  if (!dataSource) {
    return;
  }

  store.removeDataSource(options.dataSourceId);
  await store.saveDashboard(options.workspaceId);
  await removeDashboardDataSourceRuntime({
    dashboardId: _dashboard._id,
    dataSourceId: dataSource.id,
    tableRef: dataSource.tableRef,
  });
}

export async function refreshDashboardDataSourceCommand(options: {
  workspaceId: string;
  dataSourceId: string;
}): Promise<void> {
  const dashboard = getActiveDashboardOrThrow();
  await refreshDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard,
    dataSourceId: options.dataSourceId,
  });
}

export async function refreshAllDashboardDataSourcesCommand(
  workspaceId: string,
): Promise<void> {
  const dashboard = getActiveDashboardOrThrow();
  await refreshAllDashboardDataSources({ workspaceId, dashboard });
}

export function getDashboardStateSnapshot(dashboardId?: string) {
  const dashboard = useDashboardStore.getState().activeDashboard;
  if (!dashboard || (dashboardId && dashboard._id !== dashboardId)) {
    throw new Error("No matching active dashboard");
  }

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
}) {
  const dashboard = getActiveDashboardOrThrow();
  return await previewDashboardDataSource({
    dashboard,
    dataSourceId: options.dataSourceId,
    sql: options.sql,
  });
}

export async function executeDashboardSql(options: {
  sql: string;
  dataSourceId?: string;
}) {
  const dashboard = getActiveDashboardOrThrow();
  return await queryDashboardRuntime({
    dashboard,
    sql: options.sql,
    dataSourceId: options.dataSourceId,
  });
}

export async function getDashboardMosaicInstance(dashboardId: string) {
  return await ensureMosaicInstance(dashboardId);
}

export function addDashboardWidget(widget: DashboardWidget): void {
  useDashboardStore.getState().addWidget(widget);
}

export function updateDashboardWidget(
  widgetId: string,
  changes: Partial<DashboardWidget>,
): void {
  useDashboardStore.getState().modifyWidget(widgetId, changes);
}

export function removeDashboardWidget(widgetId: string): void {
  useDashboardStore.getState().removeWidget(widgetId);
}
