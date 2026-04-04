import { nanoid } from "nanoid";
import { buildTableRef } from "@mako/schemas";
import { apiClient } from "../lib/api-client";
import type { ConsoleContentResponse } from "../lib/api-types";
import {
  useDashboardStore,
  type DashboardMaterializationStatus,
} from "../store/dashboardStore";
import {
  activateDashboardRuntime,
  disposeDashboardRuntime,
  materializeDashboardDataSource,
  previewDashboardDataSource,
  queryDashboardRuntime,
  removeDashboardDataSourceRuntime,
  syncDashboardRuntime,
} from "./gateway";
import { ensureMosaicInstance, getMosaicInstance } from "./session-registry";
import { selectDataSourceRuntime, selectWidgetRuntime } from "./selectors";
import { dashboardRuntimeEvents } from "./events";
import { useDashboardRuntimeStore } from "./store";
import type {
  Dashboard,
  DashboardDataSource,
  DashboardDataSourceOrigin,
  DashboardQueryDefinition,
  DashboardWidget,
} from "./types";

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function syncRuntimeMaterializationStatus(
  dashboardId: string,
  status: DashboardMaterializationStatus,
) {
  const runtimeStore = useDashboardRuntimeStore.getState();
  runtimeStore.dispatch(
    dashboardRuntimeEvents.setMaterializationPolling(
      dashboardId,
      status.anyBuilding,
    ),
  );
  for (const dataSource of status.dataSources) {
    runtimeStore.dispatch(
      dashboardRuntimeEvents.updateDatasourceDiagnostics(
        dashboardId,
        dataSource.dataSourceId,
        {
          materializationStatus: dataSource.status,
          materializationVersion: dataSource.version,
          materializedAt: dataSource.lastMaterializedAt,
          artifactUrl: dataSource.readUrl,
          storageBackend: dataSource.storageBackend,
        },
      ),
    );
  }
}

export function shouldAutoApplyFreshMaterialization(
  dashboardId: string,
): boolean {
  const session = useDashboardRuntimeStore.getState().sessions[dashboardId];
  if (!session) {
    return false;
  }

  return !Object.values(session.dataSources).some(
    dataSource => dataSource.activeSource === "draft_stream",
  );
}

async function fetchAndSyncMaterializationStatus(
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardMaterializationStatus | null> {
  const status = await useDashboardStore
    .getState()
    .fetchDashboardMaterializationStatus(workspaceId, dashboardId);
  if (status) {
    syncRuntimeMaterializationStatus(dashboardId, status);
  }
  return status;
}

async function waitForDashboardMaterialization(options: {
  workspaceId: string;
  dashboardId: string;
  pollMs?: number;
}): Promise<DashboardMaterializationStatus | null> {
  const runtimeStore = useDashboardRuntimeStore.getState();
  const initial = await fetchAndSyncMaterializationStatus(
    options.workspaceId,
    options.dashboardId,
  );
  if (!initial) {
    return null;
  }

  const initialVersions = new Map(
    initial.dataSources.map(source => [source.dataSourceId, source.version]),
  );
  let current = initial;
  while (current.anyBuilding) {
    await sleep(options.pollMs ?? 3000);
    const nextStatus = await fetchAndSyncMaterializationStatus(
      options.workspaceId,
      options.dashboardId,
    );
    if (!nextStatus) {
      return null;
    }
    current = nextStatus;
  }

  const hasFreshData = current.dataSources.some(
    source =>
      source.status === "ready" &&
      source.version &&
      source.version !== initialVersions.get(source.dataSourceId),
  );
  runtimeStore.dispatch(
    dashboardRuntimeEvents.setFreshDataAvailable(
      options.dashboardId,
      hasFreshData,
    ),
  );
  return current;
}

async function applyDashboardMaterializedData(options: {
  workspaceId: string;
  dashboardId: string;
  runtimeContext?: "builder" | "viewer";
}) {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  await fetchAndSyncMaterializationStatus(options.workspaceId, dashboard._id);
  const refreshedDashboard = getDashboardOrThrow(options.dashboardId);
  await syncDashboardRuntime({
    workspaceId: options.workspaceId,
    dashboard: refreshedDashboard,
    runtimeContext: options.runtimeContext ?? "viewer",
  });
  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.setFreshDataAvailable(dashboard._id, false),
    );
  useDashboardRuntimeStore
    .getState()
    .dispatch(dashboardRuntimeEvents.bumpQueryGeneration(dashboard._id));
}

export async function activateDashboardSession(
  workspaceId: string,
  dashboardId?: string,
  runtimeContext: "builder" | "viewer" = "builder",
): Promise<void> {
  let dashboard = getDashboardOrThrow(dashboardId);
  if (runtimeContext === "viewer") {
    const status = await fetchAndSyncMaterializationStatus(
      workspaceId,
      dashboard._id,
    );
    dashboard = getDashboardOrThrow(dashboard._id);
    if (status?.anyBuilding) {
      useDashboardRuntimeStore
        .getState()
        .dispatch(
          dashboardRuntimeEvents.appendLog(
            dashboard._id,
            "info",
            "Dashboard materialization is still running; using previous artifact until fresh data is ready",
          ),
        );
      void waitForDashboardMaterialization({
        workspaceId,
        dashboardId: dashboard._id,
      })
        .then(async result => {
          if (!result || !shouldAutoApplyFreshMaterialization(dashboard._id)) {
            return;
          }

          await applyDashboardMaterializedData({
            workspaceId,
            dashboardId: dashboard._id,
            runtimeContext: "viewer",
          });
        })
        .catch(() => undefined);
    }
  }
  await activateDashboardRuntime(dashboard, runtimeContext);
  await syncDashboardRuntime({ workspaceId, dashboard, runtimeContext });
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
  origin?: DashboardDataSourceOrigin;
}): DashboardDataSource {
  return {
    id: nanoid(),
    name: input.name,
    tableRef: buildTableRef(input.name),
    query: input.query,
    origin: input.origin,
    timeDimension: input.timeDimension,
    rowLimit: input.rowLimit,
    computedColumns: [],
  };
}

export async function createDashboardDataSource(options: {
  workspaceId: string;
  name: string;
  query: DashboardQueryDefinition;
  timeDimension?: string;
  rowLimit?: number;
  dashboardId?: string;
}): Promise<DashboardDataSource> {
  const store = useDashboardStore.getState();
  const dashboard = getDashboardOrThrow(options.dashboardId);
  const dataSource = buildDashboardDataSource({
    name: options.name,
    query: options.query,
    timeDimension: options.timeDimension,
    rowLimit: options.rowLimit,
    origin: { type: "local" },
  });

  store.addDataSource(dashboard._id, dataSource);
  await materializeDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard: getDashboardOrThrow(dashboard._id),
    dataSource,
    force: true,
    skipParquet: true,
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
  await materializeDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard: getDashboardOrThrow(dashboard._id),
    dataSource,
    force: true,
    skipParquet: true,
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

  if (options.rematerialize === true) {
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
        skipParquet: true,
      });

      const mosaicInstance = getMosaicInstance(updatedDashboard._id);
      if (mosaicInstance) {
        try {
          mosaicInstance.coordinator.clear?.({ clients: false, cache: true });
        } catch {
          // best-effort cache clear
        }
      }
      useDashboardRuntimeStore
        .getState()
        .dispatch(
          dashboardRuntimeEvents.bumpQueryGeneration(updatedDashboard._id),
        );
    }
  }
}

export async function runDashboardDataSource(options: {
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
}): Promise<{ loadPath: string | null; recovered: boolean }> {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  const dataSource = dashboard.dataSources.find(
    ds => ds.id === options.dataSourceId,
  );
  if (!dataSource) {
    throw new Error(`Data source ${options.dataSourceId} not found`);
  }

  let recovered = false;
  try {
    await materializeDashboardDataSource({
      workspaceId: options.workspaceId,
      dashboard,
      dataSource,
      force: true,
      skipParquet: true,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isFatalWasm =
      msg.includes("memory access out of bounds") ||
      msg.includes("unreachable executed") ||
      msg.toLowerCase().includes("out of memory");
    if (!isFatalWasm) {
      throw error;
    }

    await disposeDashboardRuntime(options.dashboardId);
    recovered = true;

    const freshDashboard = getDashboardOrThrow(options.dashboardId);
    const freshDs = freshDashboard.dataSources.find(
      ds => ds.id === options.dataSourceId,
    );
    if (!freshDs) {
      throw new Error(
        `Data source ${options.dataSourceId} not found after session recovery`,
      );
    }

    // Re-materialize all data sources since the DuckDB instance was destroyed.
    // The target data source is loaded first, then remaining ones in parallel.
    await materializeDashboardDataSource({
      workspaceId: options.workspaceId,
      dashboard: freshDashboard,
      dataSource: freshDs,
      force: true,
      skipParquet: true,
    });

    const otherDataSources = freshDashboard.dataSources.filter(
      ds => ds.id !== options.dataSourceId,
    );
    if (otherDataSources.length > 0) {
      await Promise.allSettled(
        otherDataSources.map(ds =>
          materializeDashboardDataSource({
            workspaceId: options.workspaceId,
            dashboard: freshDashboard,
            dataSource: ds,
            force: true,
            skipParquet: true,
          }),
        ),
      );
    }
  }

  const resolvedDashboard = getDashboardOrThrow(options.dashboardId);
  const mosaicInstance = getMosaicInstance(resolvedDashboard._id);
  if (mosaicInstance) {
    try {
      mosaicInstance.coordinator.clear?.({ clients: false, cache: true });
    } catch {
      // best-effort cache clear
    }
  }
  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.bumpQueryGeneration(resolvedDashboard._id),
    );

  const runtime = selectDataSourceRuntime(
    options.dashboardId,
    options.dataSourceId,
  );
  return {
    loadPath: runtime?.loadPath ?? null,
    recovered,
  };
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
  await useDashboardStore
    .getState()
    .materializeDashboard(options.workspaceId, dashboard._id, {
      force: true,
      dataSourceIds: [options.dataSourceId],
    });
  await waitForDashboardMaterialization({
    workspaceId: options.workspaceId,
    dashboardId: dashboard._id,
  });
  await applyDashboardMaterializedData({
    workspaceId: options.workspaceId,
    dashboardId: dashboard._id,
    runtimeContext: "viewer",
  });
}

export async function reloadDashboardDataSourcesCommand(
  workspaceId: string,
  dashboardId?: string,
): Promise<void> {
  const dashboard = getDashboardOrThrow(dashboardId);
  await useDashboardStore
    .getState()
    .materializeDashboard(workspaceId, dashboard._id, {
      force: true,
    });
  await waitForDashboardMaterialization({
    workspaceId,
    dashboardId: dashboard._id,
  });
  await applyDashboardMaterializedData({
    workspaceId,
    dashboardId: dashboard._id,
    runtimeContext: "viewer",
  });
}

export async function materializeDashboardInBackgroundCommand(options: {
  workspaceId: string;
  dashboardId?: string;
}): Promise<void> {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  await useDashboardStore
    .getState()
    .materializeDashboard(options.workspaceId, dashboard._id, {
      force: true,
    });
  const status = await waitForDashboardMaterialization({
    workspaceId: options.workspaceId,
    dashboardId: dashboard._id,
  });
  if (!status || !shouldAutoApplyFreshMaterialization(dashboard._id)) {
    return;
  }

  await applyDashboardMaterializedData({
    workspaceId: options.workspaceId,
    dashboardId: dashboard._id,
    runtimeContext: "viewer",
  });
}

export async function applyFreshMaterializationCommand(options: {
  workspaceId: string;
  dashboardId?: string;
}): Promise<void> {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  await applyDashboardMaterializedData({
    workspaceId: options.workspaceId,
    dashboardId: dashboard._id,
    runtimeContext: "viewer",
  });
}

export async function refreshDashboardCommand(
  workspaceId: string,
  dashboardId?: string,
): Promise<void> {
  const dashboard = getDashboardOrThrow(dashboardId);
  await disposeDashboardRuntime(dashboard._id);
  await activateDashboardRuntime(dashboard, "viewer");
  await syncDashboardRuntime({
    workspaceId,
    dashboard,
    runtimeContext: "viewer",
  });
}

export function refreshDashboardWidgetCommand(options: {
  dashboardId?: string;
  widgetId: string;
}): void {
  const dashboard = getDashboardOrThrow(options.dashboardId);
  const mosaicInstance = getMosaicInstance(dashboard._id);
  if (mosaicInstance) {
    try {
      mosaicInstance.coordinator.clear?.({ clients: false, cache: true });
    } catch {
      // best-effort cache clear
    }
  }
  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.bumpWidgetRefresh(dashboard._id, options.widgetId),
    );
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
        activeSource: runtime?.activeSource ?? null,
        loadPath: runtime?.loadPath ?? null,
        loadingMessage: runtime?.loadingMessage ?? null,
        resolvedMode: runtime?.resolvedMode ?? null,
        artifactUrl: runtime?.artifactUrl ?? null,
        loadDurationMs: runtime?.loadDurationMs ?? null,
        materializationStatus: runtime?.materializationStatus ?? null,
        materializationVersion: runtime?.materializationVersion ?? null,
        materializedAt: runtime?.materializedAt ?? null,
        storageBackend: runtime?.storageBackend ?? null,
        columns: runtime?.schema || [],
        sampleRows: runtime?.sampleRows || [],
      };
    }),
    widgets: dashboard.widgets.map(widget => {
      const runtime = selectWidgetRuntime(dashboard._id, widget.id);
      return {
        ...widget,
        queryEngine: "mosaic" as const,
        queryStatus: runtime?.queryStatus || "idle",
        queryError: runtime?.queryError || null,
        queryErrorKind: runtime?.queryErrorKind || null,
        renderStatus: runtime?.renderStatus || "idle",
        renderError: runtime?.renderError || null,
        renderErrorKind: runtime?.renderErrorKind || null,
        queryRowCount: runtime?.queryRowCount ?? null,
        queryFields: runtime?.queryFields || [],
      };
    }),
    queryGeneration:
      useDashboardRuntimeStore.getState().sessions[dashboard._id]
        ?.queryGeneration || 0,
    eventLog:
      useDashboardRuntimeStore.getState().sessions[dashboard._id]?.eventLog ||
      [],
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
  useDashboardRuntimeStore
    .getState()
    .dispatch(dashboardRuntimeEvents.bumpWidgetRefresh(id, widget.id));
}

export function updateDashboardWidget(
  widgetId: string,
  changes: Partial<DashboardWidget>,
  dashboardId?: string,
): void {
  const id = dashboardId ?? resolveActiveDashboardId();
  useDashboardStore.getState().modifyWidget(id, widgetId, changes);
  const shouldInvalidateQueries =
    changes.localSql !== undefined ||
    changes.vegaLiteSpec !== undefined ||
    changes.dataSourceId !== undefined;

  if (shouldInvalidateQueries) {
    const mosaicInstance = getMosaicInstance(id);
    if (mosaicInstance) {
      try {
        // Ensure stale cached query plans/results are invalidated before refetch.
        mosaicInstance.coordinator.clear?.({ clients: false, cache: true });
      } catch {
        // best-effort cache clear
      }
    }
    useDashboardRuntimeStore
      .getState()
      .dispatch(dashboardRuntimeEvents.bumpQueryGeneration(id));
  }
  useDashboardRuntimeStore
    .getState()
    .dispatch(dashboardRuntimeEvents.bumpWidgetRefresh(id, widgetId));
}

export function removeDashboardWidget(
  widgetId: string,
  dashboardId?: string,
): void {
  const id = dashboardId ?? resolveActiveDashboardId();
  useDashboardStore.getState().removeWidget(id, widgetId);
  useDashboardRuntimeStore
    .getState()
    .dispatch(dashboardRuntimeEvents.widgetRemoved(id, widgetId));
}
