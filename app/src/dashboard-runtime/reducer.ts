import type {
  DashboardDataSourceRuntimeState,
  DashboardRuntimeEvent,
  DashboardRuntimeState,
  DashboardSessionRuntimeState,
} from "./types";

function ensureSessionState(
  state: DashboardRuntimeState,
  dashboardId: string,
): DashboardSessionRuntimeState {
  if (!state.sessions[dashboardId]) {
    state.sessions[dashboardId] = {
      dashboardId,
      sessionId: "",
      dataSources: {},
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
      status: "idle",
      rowsLoaded: 0,
      schema: [],
      sampleRows: [],
      error: null,
    };
  }

  return session.dataSources[dataSourceId];
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
      return;
    }

    case "datasource/load-started": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      dataSource.status = "loading";
      dataSource.rowsLoaded = 0;
      dataSource.rowCount = undefined;
      dataSource.schema = [];
      dataSource.sampleRows = [];
      dataSource.error = null;
      return;
    }

    case "datasource/load-progress": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      dataSource.status = "loading";
      dataSource.rowsLoaded = event.rowsLoaded;
      return;
    }

    case "datasource/load-succeeded": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      dataSource.status = "ready";
      dataSource.rowsLoaded = event.rowsLoaded;
      dataSource.rowCount = event.rowCount;
      dataSource.schema = event.schema;
      dataSource.sampleRows = event.sampleRows;
      dataSource.error = null;
      return;
    }

    case "datasource/load-failed": {
      const session = ensureSessionState(state, event.dashboardId);
      const dataSource = ensureDataSourceState(session, event.dataSourceId);
      dataSource.status = "error";
      dataSource.rowsLoaded = event.rowsLoaded;
      dataSource.error = event.error;
      dataSource.sampleRows = [];
      return;
    }

    case "datasource/removed": {
      const session = ensureSessionState(state, event.dashboardId);
      delete session.dataSources[event.dataSourceId];
      return;
    }
  }
}
