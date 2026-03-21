import type { DashboardRuntimeColumn, DashboardRuntimeEvent } from "./types";

export const dashboardRuntimeEvents = {
  activateSession: (
    dashboardId: string,
    sessionId: string,
  ): DashboardRuntimeEvent => ({
    type: "session/activated",
    dashboardId,
    sessionId,
  }),

  disposeSession: (dashboardId: string): DashboardRuntimeEvent => ({
    type: "session/disposed",
    dashboardId,
  }),

  registerDataSource: (
    dashboardId: string,
    dataSourceId: string,
    tableRef: string,
    version: string,
  ): DashboardRuntimeEvent => ({
    type: "datasource/registered",
    dashboardId,
    dataSourceId,
    tableRef,
    version,
  }),

  bumpQueryGeneration: (dashboardId: string): DashboardRuntimeEvent => ({
    type: "dashboard/query-generation-bumped",
    dashboardId,
  }),

  resetDashboard: (dashboardId: string): DashboardRuntimeEvent => ({
    type: "dashboard/reset",
    dashboardId,
  }),

  datasourceLoadStarted: (
    dashboardId: string,
    dataSourceId: string,
    preserveExistingData = false,
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-started",
    dashboardId,
    dataSourceId,
    preserveExistingData,
  }),

  datasourceLoadProgress: (
    dashboardId: string,
    dataSourceId: string,
    rowsLoaded: number,
    preserveExistingData = false,
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-progress",
    dashboardId,
    dataSourceId,
    rowsLoaded,
    preserveExistingData,
  }),

  datasourceLoadSucceeded: (
    dashboardId: string,
    dataSourceId: string,
    rowsLoaded: number,
    rowCount: number,
    schema: DashboardRuntimeColumn[],
    sampleRows: Record<string, unknown>[],
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-succeeded",
    dashboardId,
    dataSourceId,
    rowsLoaded,
    rowCount,
    schema,
    sampleRows,
  }),

  datasourceLoadFailed: (
    dashboardId: string,
    dataSourceId: string,
    rowsLoaded: number,
    error: string,
    preserveExistingData = false,
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-failed",
    dashboardId,
    dataSourceId,
    rowsLoaded,
    error,
    preserveExistingData,
  }),

  datasourceRemoved: (
    dashboardId: string,
    dataSourceId: string,
  ): DashboardRuntimeEvent => ({
    type: "datasource/removed",
    dashboardId,
    dataSourceId,
  }),

  widgetQueryStarted: (
    dashboardId: string,
    widgetId: string,
  ): DashboardRuntimeEvent => ({
    type: "widget/query-started",
    dashboardId,
    widgetId,
  }),

  widgetQuerySucceeded: (
    dashboardId: string,
    widgetId: string,
    rowCount: number,
    fields: string[],
  ): DashboardRuntimeEvent => ({
    type: "widget/query-succeeded",
    dashboardId,
    widgetId,
    rowCount,
    fields,
  }),

  widgetQueryFailed: (
    dashboardId: string,
    widgetId: string,
    error: string,
    errorKind: string | null,
  ): DashboardRuntimeEvent => ({
    type: "widget/query-failed",
    dashboardId,
    widgetId,
    error,
    errorKind,
  }),

  widgetRenderSucceeded: (
    dashboardId: string,
    widgetId: string,
  ): DashboardRuntimeEvent => ({
    type: "widget/render-succeeded",
    dashboardId,
    widgetId,
  }),

  widgetRenderFailed: (
    dashboardId: string,
    widgetId: string,
    error: string,
    errorKind: string | null,
  ): DashboardRuntimeEvent => ({
    type: "widget/render-failed",
    dashboardId,
    widgetId,
    error,
    errorKind,
  }),

  bumpWidgetRefresh: (
    dashboardId: string,
    widgetId: string,
  ): DashboardRuntimeEvent => ({
    type: "widget/refresh-bumped",
    dashboardId,
    widgetId,
  }),

  widgetRemoved: (
    dashboardId: string,
    widgetId: string,
  ): DashboardRuntimeEvent => ({
    type: "widget/removed",
    dashboardId,
    widgetId,
  }),
};
