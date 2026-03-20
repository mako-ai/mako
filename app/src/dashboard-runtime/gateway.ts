import {
  describeTable,
  dropTable,
  loadNdjsonStreamTable,
  queryDuckDB,
} from "../lib/duckdb";
import { dashboardRuntimeEvents } from "./events";
import { selectDataSourceRuntime } from "./selectors";
import {
  ensureDashboardSession,
  getDashboardSession,
  checkpointSession,
  persistDataSourceVersion,
  removePersistedDataSource,
} from "./session-registry";
import { useDashboardRuntimeStore } from "./store";
import type {
  Dashboard,
  DashboardDataSource,
  DashboardQueryResult,
  DashboardRuntimeColumn,
} from "./types";

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return String(hash >>> 0);
}

function buildDataSourceVersion(dataSource: DashboardDataSource): string {
  return hashString(
    JSON.stringify({
      tableRef: dataSource.tableRef,
      rowLimit: dataSource.rowLimit,
      query: dataSource.query,
      computedColumns: dataSource.computedColumns,
    }),
  );
}

function buildDashboardExportPayload(dataSource: DashboardDataSource) {
  return {
    connectionId: dataSource.query.connectionId,
    format: "ndjson",
    batchSize: 2000,
    filename: dataSource.name,
    queryDefinition: dataSource.query,
  };
}

function resolveSqlBindings(
  dashboard: Dashboard,
  sql: string,
  primaryDataSourceId?: string,
): string {
  if (!primaryDataSourceId) {
    return sql;
  }

  const primary = dashboard.dataSources.find(
    ds => ds.id === primaryDataSourceId,
  );
  if (!primary) {
    return sql;
  }

  const aliases = [primary.name, primary.id].filter(Boolean);
  let resolved = sql
    .replace(/\{\{\s*source\s*\}\}/g, `"${primary.tableRef}"`)
    .replace(/\{\{\s*table\s*\}\}/g, `"${primary.tableRef}"`);

  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    resolved = resolved.replace(
      new RegExp(`\\b(from|join)\\s+"${escaped}"`, "gi"),
      `$1 "${primary.tableRef}"`,
    );
    resolved = resolved.replace(
      new RegExp(`\\b(from|join)\\s+${escaped}\\b`, "gi"),
      `$1 "${primary.tableRef}"`,
    );
  }

  return resolved;
}

async function introspectDataSource(
  dashboardId: string,
  dataSource: DashboardDataSource,
): Promise<{
  schema: DashboardRuntimeColumn[];
  sampleRows: Record<string, unknown>[];
}> {
  const session = getDashboardSession(dashboardId);
  if (!session) {
    return { schema: [], sampleRows: [] };
  }

  const schemaRows = await describeTable(session.db, dataSource.tableRef);
  let sampleRows: Record<string, unknown>[] = [];
  try {
    const preview = await queryDuckDB(
      session.db,
      `SELECT * FROM "${dataSource.tableRef}" LIMIT 5`,
    );
    sampleRows = preview.rows;
  } catch {
    sampleRows = [];
  }

  const schema = schemaRows.map(row => ({
    name: row.name,
    type: row.type,
    sampleValues: sampleRows
      .map(sample => sample[row.name])
      .filter(value => value !== null && value !== undefined)
      .slice(0, 3),
  }));

  return { schema, sampleRows };
}

async function getPersistedRowCount(
  db: import("@duckdb/duckdb-wasm").AsyncDuckDB,
  tableRef: string,
): Promise<number | null> {
  const conn = await db.connect();
  try {
    const result = await conn.query(
      `SELECT count(*) as cnt FROM "${tableRef}"`,
    );
    return Number(result.getChild("cnt")?.get(0));
  } catch {
    return null;
  } finally {
    await conn.close();
  }
}

export async function activateDashboardRuntime(
  dashboard: Dashboard,
): Promise<void> {
  const session = await ensureDashboardSession(dashboard._id);
  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.activateSession(dashboard._id, session.sessionId),
    );
}

export async function disposeDashboardRuntime(
  dashboardId: string,
): Promise<void> {
  useDashboardRuntimeStore
    .getState()
    .dispatch(dashboardRuntimeEvents.disposeSession(dashboardId));
  const { disposeDashboardSession } = await import("./session-registry");
  await disposeDashboardSession(dashboardId);
}

export async function materializeDashboardDataSource(options: {
  workspaceId: string;
  dashboard: Dashboard;
  dataSource: DashboardDataSource;
  force?: boolean;
}): Promise<void> {
  const { workspaceId, dashboard, dataSource, force = false } = options;
  const session = await ensureDashboardSession(dashboard._id);
  const runtimeStore = useDashboardRuntimeStore.getState();
  const version = buildDataSourceVersion(dataSource);
  runtimeStore.dispatch(
    dashboardRuntimeEvents.registerDataSource(
      dashboard._id,
      dataSource.id,
      dataSource.tableRef,
      version,
    ),
  );

  const existingRuntime = selectDataSourceRuntime(dashboard._id, dataSource.id);
  if (
    !force &&
    session.dataSourceVersions.get(dataSource.id) === version &&
    existingRuntime?.status === "ready"
  ) {
    return;
  }

  // OPFS recovery: table persisted from a previous browser session
  if (
    !force &&
    session.persistent &&
    session.dataSourceVersions.get(dataSource.id) === version
  ) {
    const rowCount = await getPersistedRowCount(
      session.db,
      dataSource.tableRef,
    );
    if (rowCount !== null) {
      const { schema, sampleRows } = await introspectDataSource(
        dashboard._id,
        dataSource,
      );
      runtimeStore.dispatch(
        dashboardRuntimeEvents.datasourceLoadSucceeded(
          dashboard._id,
          dataSource.id,
          rowCount,
          rowCount,
          schema,
          sampleRows,
        ),
      );
      return;
    }
  }

  const inFlight = session.activeLoads.get(dataSource.id);
  if (!force && inFlight) {
    await inFlight;
    return;
  }

  const loadPromise = (async () => {
    let rowsLoaded = 0;
    runtimeStore.dispatch(
      dashboardRuntimeEvents.datasourceLoadStarted(
        dashboard._id,
        dataSource.id,
      ),
    );

    try {
      await dropTable(session.db, dataSource.tableRef).catch(() => undefined);

      const response = await fetch(
        `/api/workspaces/${workspaceId}/execute/export`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildDashboardExportPayload(dataSource)),
        },
      );

      if (!response.ok) {
        let message =
          response.statusText || "Failed to export dashboard data source";
        try {
          const payload = await response.json();
          if (payload?.error) {
            message = payload.error;
          }
        } catch {
          // fall back to status text
        }
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("Dashboard data source export stream is not available");
      }

      const rowCount = await loadNdjsonStreamTable(
        session.db,
        dataSource.tableRef,
        response.body,
        {
          onProgress: loaded => {
            rowsLoaded = loaded;
            runtimeStore.dispatch(
              dashboardRuntimeEvents.datasourceLoadProgress(
                dashboard._id,
                dataSource.id,
                loaded,
              ),
            );
          },
        },
      );

      const { schema, sampleRows } = await introspectDataSource(
        dashboard._id,
        dataSource,
      );

      session.dataSourceVersions.set(dataSource.id, version);
      runtimeStore.dispatch(
        dashboardRuntimeEvents.datasourceLoadSucceeded(
          dashboard._id,
          dataSource.id,
          rowCount,
          rowCount,
          schema,
          sampleRows,
        ),
      );

      await persistDataSourceVersion(
        dashboard._id,
        dataSource.id,
        version,
        dataSource.tableRef,
        rowCount,
      );
      await checkpointSession(dashboard._id);
    } catch (error) {
      session.dataSourceVersions.delete(dataSource.id);
      await dropTable(session.db, dataSource.tableRef).catch(() => undefined);
      runtimeStore.dispatch(
        dashboardRuntimeEvents.datasourceLoadFailed(
          dashboard._id,
          dataSource.id,
          rowsLoaded,
          error instanceof Error ? error.message : "Failed to load data source",
        ),
      );
      throw error;
    } finally {
      session.activeLoads.delete(dataSource.id);
    }
  })();

  session.activeLoads.set(dataSource.id, loadPromise);
  await loadPromise;
}

export async function syncDashboardRuntime(options: {
  workspaceId: string;
  dashboard: Dashboard;
}): Promise<void> {
  const { workspaceId, dashboard } = options;
  const session = await ensureDashboardSession(dashboard._id);
  const currentIds = new Set(dashboard.dataSources.map(ds => ds.id));

  for (const [dataSourceId, runtimeState] of Object.entries(
    useDashboardRuntimeStore.getState().sessions[dashboard._id]?.dataSources ||
      {},
  )) {
    if (!currentIds.has(dataSourceId)) {
      await dropTable(session.db, runtimeState.tableRef).catch(() => undefined);
      session.dataSourceVersions.delete(dataSourceId);
      await removePersistedDataSource(dashboard._id, dataSourceId);
      useDashboardRuntimeStore
        .getState()
        .dispatch(
          dashboardRuntimeEvents.datasourceRemoved(dashboard._id, dataSourceId),
        );
    }
  }

  for (const dataSource of dashboard.dataSources) {
    await materializeDashboardDataSource({
      workspaceId,
      dashboard,
      dataSource,
    });
  }
}

export async function refreshDashboardDataSource(options: {
  workspaceId: string;
  dashboard: Dashboard;
  dataSourceId: string;
}): Promise<void> {
  const dataSource = options.dashboard.dataSources.find(
    ds => ds.id === options.dataSourceId,
  );
  if (!dataSource) {
    throw new Error(`Data source ${options.dataSourceId} not found`);
  }

  await materializeDashboardDataSource({
    workspaceId: options.workspaceId,
    dashboard: options.dashboard,
    dataSource,
    force: true,
  });
}

export async function refreshAllDashboardDataSources(options: {
  workspaceId: string;
  dashboard: Dashboard;
}): Promise<void> {
  for (const dataSource of options.dashboard.dataSources) {
    await materializeDashboardDataSource({
      workspaceId: options.workspaceId,
      dashboard: options.dashboard,
      dataSource,
      force: true,
    });
  }
}

export async function removeDashboardDataSourceRuntime(options: {
  dashboardId: string;
  dataSourceId: string;
  tableRef: string;
}): Promise<void> {
  const session = getDashboardSession(options.dashboardId);
  if (session) {
    await dropTable(session.db, options.tableRef).catch(() => undefined);
    session.dataSourceVersions.delete(options.dataSourceId);
    await removePersistedDataSource(options.dashboardId, options.dataSourceId);
  }

  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.datasourceRemoved(
        options.dashboardId,
        options.dataSourceId,
      ),
    );
}

export async function queryDashboardRuntime(options: {
  dashboard: Dashboard;
  sql: string;
  dataSourceId?: string;
}): Promise<DashboardQueryResult> {
  const session = getDashboardSession(options.dashboard._id);
  if (!session) {
    throw new Error("Dashboard runtime session is not initialized");
  }

  const resolvedSql = resolveSqlBindings(
    options.dashboard,
    options.sql,
    options.dataSourceId,
  );
  return await queryDuckDB(session.db, resolvedSql);
}

export async function previewDashboardDataSource(options: {
  dashboard: Dashboard;
  dataSourceId: string;
  sql?: string;
}): Promise<DashboardQueryResult> {
  const dataSource = options.dashboard.dataSources.find(
    ds => ds.id === options.dataSourceId,
  );
  if (!dataSource) {
    throw new Error(`Data source ${options.dataSourceId} not found`);
  }

  const runtime = selectDataSourceRuntime(options.dashboard._id, dataSource.id);
  if (!runtime || runtime.status === "idle") {
    throw new Error(`Data source "${dataSource.name}" is not materialized yet`);
  }
  if (runtime.status === "loading") {
    throw new Error(
      `Data source "${dataSource.name}" is still loading (${runtime.rowsLoaded.toLocaleString()} rows loaded so far)`,
    );
  }
  if (runtime.status === "error") {
    throw new Error(
      runtime.error || `Data source "${dataSource.name}" failed to load`,
    );
  }

  const sql =
    options.sql ||
    `SELECT * FROM "${runtime.tableRef || dataSource.tableRef}" LIMIT 10`;
  return await queryDashboardRuntime({
    dashboard: options.dashboard,
    sql,
  });
}
