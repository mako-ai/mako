import type {
  DashboardDataSourceRuntimeState,
  DashboardLogEntry,
  DashboardRuntimeEvent,
  DashboardRuntimeState,
  DashboardSessionRuntimeState,
  DashboardWidgetRuntimeState,
} from "./types";
import { DASHBOARD_EVENT_LOG_LIMIT } from "./event-log";

function ensureSessionState(
  state: DashboardRuntimeState,
  dashboardId: string,
): DashboardSessionRuntimeState {
  if (!state.sessions[dashboardId]) {
    state.sessions[dashboardId] = {
      dashboardId,
      sessionId: "",
      queryGeneration: 0,
      dataSources: {},
      widgets: {},
      eventLog: [],
    };
  }

  return state.sessions[dashboardId];
}

function ensureDataSourceState(
  session: DashboardSessionRuntimeState,
  dataSourceId: string,
): DashboardDataSourceRuntimeState {
  if (!session.dataSources[dataSourceId]) {
    session.dataSources[dataSourceId] = {
      dataSourceId,
      tableRef: "",
      version: "",
      dataVersion: 0,
      status: "idle",
      rowsLoaded: 0,
      schema: [],
      sampleRows: [],
      error: null,
    };
  }

  return session.dataSources[dataSourceId];
}

function ensureWidgetState(
  session: DashboardSessionRuntimeState,
  widgetId: string,
): DashboardWidgetRuntimeState {
  if (!session.widgets[widgetId]) {
    session.widgets[widgetId] = {
      widgetId,
      queryEngine: "mosaic",
      queryStatus: "idle",
      queryError: null,
      queryErrorKind: null,
      queryRowCount: null,
      queryFields: [],
      renderStatus: "idle",
      renderError: null,
      renderErrorKind: null,
      lastQueryAt: null,
      lastRenderAt: null,
      refreshGeneration: 0,
    };
  }

  return session.widgets[widgetId];
}

function appendLog(
  session: DashboardSessionRuntimeState,
  entry: DashboardLogEntry,
): void {
  session.eventLog.push(entry);
  if (session.eventLog.length > DASHBOARD_EVENT_LOG_LIMIT) {
    session.eventLog.splice(
      0,
      session.eventLog.length - DASHBOARD_EVENT_LOG_LIMIT,
    );
  }
}

export function reduceDashboardRuntimeEvent(
  state: DashboardRuntimeState,
  event: DashboardRuntimeEvent,
): void {
  switch (event.type) {
    case "session/activated": {
      const session = ensureSessionState(state, event.dashboardId);
      session.sessionId = event.sessionId;
      state.activeDashboardId = event.dashboardId;
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Dashboard session activated",
        metadata: { sessionId: event.sessionId },
      });
      return;
    }

    case "session/disposed": {
      delete state.sessions[event.dashboardId];
      if (state.activeDashboardId === event.dashboardId) {
        state.activeDashboardId = null;
      }
      return;
    }

    case "datasource/registered": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      dataSource.tableRef = event.tableRef;
      dataSource.version = event.version;
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Registered dashboard data source",
        metadata: {
          dataSourceId: event.dataSourceId,
          tableRef: event.tableRef,
        },
      });
      return;
    }

    case "dashboard/query-generation-bumped": {
      const session = ensureSessionState(state, event.dashboardId);
      session.queryGeneration += 1;
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Dashboard query generation bumped",
        metadata: { queryGeneration: session.queryGeneration },
      });
      return;
    }

    case "datasource/load-started": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      if (event.preserveExistingData && dataSource.status === "ready") {
        dataSource.rowsLoaded = 0;
      } else {
        dataSource.status = "loading";
        dataSource.rowsLoaded = 0;
        dataSource.rowCount = undefined;
        dataSource.schema = [];
        dataSource.sampleRows = [];
      }
      dataSource.error = null;
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Data source load started",
        metadata: { dataSourceId: event.dataSourceId },
      });
      return;
    }

    case "datasource/load-progress": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      if (!(event.preserveExistingData && dataSource.status === "ready")) {
        dataSource.status = "loading";
      }
      dataSource.rowsLoaded = event.rowsLoaded;
      return;
    }

    case "datasource/load-succeeded": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      dataSource.status = "ready";
      dataSource.rowsLoaded = event.rowsLoaded;
      dataSource.rowCount = event.rowCount;
      dataSource.dataVersion += 1;
      dataSource.schema = event.schema;
      dataSource.sampleRows = event.sampleRows;
      dataSource.error = null;
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Data source load succeeded",
        metadata: {
          dataSourceId: event.dataSourceId,
          rowCount: event.rowCount,
          dataVersion: dataSource.dataVersion,
        },
      });
      return;
    }

    case "datasource/load-failed": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      if (!(event.preserveExistingData && dataSource.status === "ready")) {
        dataSource.status = "error";
      }
      dataSource.rowsLoaded = event.rowsLoaded;
      dataSource.error = event.error;
      if (!(event.preserveExistingData && dataSource.status === "ready")) {
        dataSource.sampleRows = [];
      }
      appendLog(session, {
        timestamp: Date.now(),
        level: "error",
        message: "Data source load failed",
        metadata: { dataSourceId: event.dataSourceId, error: event.error },
      });
      return;
    }

    case "datasource/removed": {
      const session = ensureSessionState(state, event.dashboardId);
      delete session.dataSources[event.dataSourceId];
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Data source removed",
        metadata: { dataSourceId: event.dataSourceId },
      });
      return;
    }

    case "widget/query-started": {
      const session = ensureSessionState(state, event.dashboardId);
      const widget = ensureWidgetState(session, event.widgetId);
      widget.queryStatus = "loading";
      widget.queryError = null;
      widget.queryErrorKind = null;
      return;
    }

    case "widget/query-succeeded": {
      const session = ensureSessionState(state, event.dashboardId);
      const widget = ensureWidgetState(session, event.widgetId);
      widget.queryStatus = "ready";
      widget.queryError = null;
      widget.queryErrorKind = null;
      widget.queryRowCount = event.rowCount;
      widget.queryFields = event.fields;
      widget.lastQueryAt = Date.now();
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Widget query succeeded",
        metadata: {
          widgetId: event.widgetId,
          rowCount: event.rowCount,
          fields: event.fields,
        },
      });
      return;
    }

    case "widget/query-failed": {
      const session = ensureSessionState(state, event.dashboardId);
      const widget = ensureWidgetState(session, event.widgetId);
      widget.queryStatus = "error";
      widget.queryError = event.error;
      widget.queryErrorKind = event.errorKind;
      widget.lastQueryAt = Date.now();
      appendLog(session, {
        timestamp: Date.now(),
        level: "error",
        message: "Widget query failed",
        metadata: {
          widgetId: event.widgetId,
          error: event.error,
          errorKind: event.errorKind,
        },
      });
      return;
    }

    case "widget/render-succeeded": {
      const session = ensureSessionState(state, event.dashboardId);
      const widget = ensureWidgetState(session, event.widgetId);
      widget.renderStatus = "ready";
      widget.renderError = null;
      widget.renderErrorKind = null;
      widget.lastRenderAt = Date.now();
      return;
    }

    case "widget/render-failed": {
      const session = ensureSessionState(state, event.dashboardId);
      const widget = ensureWidgetState(session, event.widgetId);
      widget.renderStatus = "error";
      widget.renderError = event.error;
      widget.renderErrorKind = event.errorKind;
      widget.lastRenderAt = Date.now();
      appendLog(session, {
        timestamp: Date.now(),
        level: "error",
        message: "Widget render failed",
        metadata: {
          widgetId: event.widgetId,
          error: event.error,
          errorKind: event.errorKind,
        },
      });
      return;
    }

    case "widget/refresh-bumped": {
      const session = ensureSessionState(state, event.dashboardId);
      const widget = ensureWidgetState(session, event.widgetId);
      widget.refreshGeneration += 1;
      appendLog(session, {
        timestamp: Date.now(),
        level: "info",
        message: "Widget refresh requested",
        metadata: {
          widgetId: event.widgetId,
          refreshGeneration: widget.refreshGeneration,
        },
      });
      return;
    }

    case "widget/removed": {
      const session = ensureSessionState(state, event.dashboardId);
      delete session.widgets[event.widgetId];
      return;
    }
  }
}
