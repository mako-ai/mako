import type {
  Dashboard,
  DashboardDataSource,
  DashboardDataSourceRuntimeState,
  DashboardSessionRuntimeState,
  DashboardWidgetRuntimeState,
} from "./types";
import { useDashboardRuntimeStore } from "./store";

export function selectDashboardSession(
  dashboardId: string | null | undefined,
): DashboardSessionRuntimeState | null {
  if (!dashboardId) {
    return null;
  }

  return useDashboardRuntimeStore.getState().sessions[dashboardId] || null;
}

export function selectDataSourceRuntime(
  dashboardId: string | null | undefined,
  dataSourceId: string | null | undefined,
): DashboardDataSourceRuntimeState | null {
  if (!dashboardId || !dataSourceId) {
    return null;
  }

  const session = selectDashboardSession(dashboardId);
  if (!session) {
    return null;
  }

  return session.dataSources[dataSourceId] || null;
}

export function selectWidgetRuntime(
  dashboardId: string | null | undefined,
  widgetId: string | null | undefined,
): DashboardWidgetRuntimeState | null {
  if (!dashboardId || !widgetId) {
    return null;
  }

  const session = selectDashboardSession(dashboardId);
  if (!session) {
    return null;
  }

  return session.widgets[widgetId] || null;
}

export function selectAllSourcesReady(dashboard: Dashboard | null): boolean {
  if (!dashboard || dashboard.dataSources.length === 0) {
    return true;
  }

  return dashboard.dataSources.every(ds => {
    const runtime = selectDataSourceRuntime(dashboard._id, ds.id);
    return runtime?.status === "ready";
  });
}

export function selectSomeSourcesLoading(dashboard: Dashboard | null): boolean {
  if (!dashboard) {
    return false;
  }

  return dashboard.dataSources.some(ds => {
    const runtime = selectDataSourceRuntime(dashboard._id, ds.id);
    return runtime?.status === "loading";
  });
}

export function selectLoadingSummary(dashboard: Dashboard | null): {
  label: string;
  rowsLoaded: number;
} | null {
  if (!dashboard) {
    return null;
  }

  const loadingSources = dashboard.dataSources.filter(ds => {
    const runtime = selectDataSourceRuntime(dashboard._id, ds.id);
    return runtime?.status === "loading";
  });

  if (loadingSources.length === 0) {
    return null;
  }

  return {
    label:
      loadingSources.length === 1
        ? `Loading ${loadingSources[0].name}`
        : `Loading ${loadingSources.length} data sources`,
    rowsLoaded: loadingSources.reduce((sum, ds) => {
      const runtime = selectDataSourceRuntime(dashboard._id, ds.id);
      return sum + (runtime?.rowsLoaded || 0);
    }, 0),
  };
}

export function selectErrorSummary(dashboard: Dashboard | null): {
  count: number;
  message: string;
} | null {
  if (!dashboard) {
    return null;
  }

  const failingSources = dashboard.dataSources.filter(ds => {
    const runtime = selectDataSourceRuntime(dashboard._id, ds.id);
    return runtime?.status === "error";
  });

  if (failingSources.length === 0) {
    return null;
  }

  const firstRuntime = selectDataSourceRuntime(
    dashboard._id,
    failingSources[0].id,
  );

  return {
    count: failingSources.length,
    message: firstRuntime?.error || "Failed to load one or more data sources",
  };
}

export function selectResolvedTableRef(
  dashboardId: string | null | undefined,
  dataSource: DashboardDataSource,
): string {
  const runtime = selectDataSourceRuntime(dashboardId, dataSource.id);
  return runtime?.tableRef || dataSource.tableRef;
}
