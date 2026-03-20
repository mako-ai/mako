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

  datasourceLoadStarted: (
    dashboardId: string,
    dataSourceId: string,
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-started",
    dashboardId,
    dataSourceId,
  }),

  datasourceLoadProgress: (
    dashboardId: string,
    dataSourceId: string,
    rowsLoaded: number,
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-progress",
    dashboardId,
    dataSourceId,
    rowsLoaded,
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
  ): DashboardRuntimeEvent => ({
    type: "datasource/load-failed",
    dashboardId,
    dataSourceId,
    rowsLoaded,
    error,
  }),

  datasourceRemoved: (
    dashboardId: string,
    dataSourceId: string,
  ): DashboardRuntimeEvent => ({
    type: "datasource/removed",
    dashboardId,
    dataSourceId,
  }),
};
