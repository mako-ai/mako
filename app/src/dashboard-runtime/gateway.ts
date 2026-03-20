import {
  describeTable,
  dropTable,
  loadArrowStreamTable,
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
      rowLimit: dataSource.rowLimit ?? null,
      query: dataSource.query,
      computedColumns: dataSource.computedColumns ?? [],
    }),
  );
}

function buildDashboardExportPayload(
  dataSource: DashboardDataSource,
  format: "arrow" | "ndjson" = "arrow",
) {
  return {
    connectionId: dataSource.query.connectionId,
    format,
    batchSize: format === "arrow" ? 5000 : 2000,
    filename: dataSource.name,
    queryDefinition: dataSource.query,
  };
}

function parseNumericHeader(
  headers: Headers,
  name: string,
): number | undefined {
  const raw = headers.get(name);
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function estimateRowsFromBytes(
  bytesLoaded: number,
  totalBytes: number | undefined,
  totalRows: number | undefined,
): number | null {
  if (!totalBytes || !totalRows || totalBytes <= 0 || totalRows <= 0) {
    return null;
  }

  return Math.max(
    0,
    Math.min(totalRows, Math.round((bytesLoaded / totalBytes) * totalRows)),
  );
}

async function fetchDashboardExport(
  workspaceId: string,
  dataSource: DashboardDataSource,
  format: "arrow" | "ndjson",
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/execute/export`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDashboardExportPayload(dataSource, format)),
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
      // Fall back to status text when the body is not JSON.
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Dashboard data source export stream is not available");
  }

  return response as Response & { body: ReadableStream<Uint8Array> };
}

function dispatchLoadProgress(options: {
  runtimeStore: ReturnType<typeof useDashboardRuntimeStore.getState>;
  dashboardId: string;
  dataSourceId: string;
  onRowsLoaded: (loaded: number) => void;
  rowsLoaded: number;
}) {
  options.onRowsLoaded(options.rowsLoaded);
  options.runtimeStore.dispatch(
    dashboardRuntimeEvents.datasourceLoadProgress(
      options.dashboardId,
      options.dataSourceId,
      options.rowsLoaded,
    ),
  );
}

async function loadDashboardDataSourceWithFallback(options: {
  session: Awaited<ReturnType<typeof ensureDashboardSession>>;
  runtimeStore: ReturnType<typeof useDashboardRuntimeStore.getState>;
  workspaceId: string;
  dashboardId: string;
  dataSource: DashboardDataSource;
  onRowsLoaded: (loaded: number) => void;
}): Promise<number | null> {
  const {
    session,
    runtimeStore,
    workspaceId,
    dashboardId,
    dataSource,
    onRowsLoaded,
  } = options;

  try {
    const response = await fetchDashboardExport(
      workspaceId,
      dataSource,
      "arrow",
    );
    const totalBytes = parseNumericHeader(response.headers, "Content-Length");
    const totalRows = parseNumericHeader(response.headers, "X-Row-Count");

    const loadedRowCount = await loadArrowStreamTable(
      session.db,
      dataSource.tableRef,
      response.body,
      {
        onProgress: bytesLoaded => {
          const estimatedRows = estimateRowsFromBytes(
            bytesLoaded,
            totalBytes,
            totalRows,
          );
          if (estimatedRows == null) {
            return;
          }

          dispatchLoadProgress({
            runtimeStore,
            dashboardId,
            dataSourceId: dataSource.id,
            onRowsLoaded,
            rowsLoaded: estimatedRows,
          });
        },
      },
    );

    return totalRows ?? loadedRowCount;
  } catch {
    await dropTable(session.db, dataSource.tableRef).catch(() => undefined);
  }

  const response = await fetchDashboardExport(
    workspaceId,
    dataSource,
    "ndjson",
  );
  return await loadNdjsonStreamTable(
    session.db,
    dataSource.tableRef,
    response.body,
    {
      onProgress: loaded => {
        dispatchLoadProgress({
          runtimeStore,
          dashboardId,
          dataSourceId: dataSource.id,
          onRowsLoaded,
          rowsLoaded: loaded,
        });
      },
    },
  );
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
  if (inFlight) {
    if (!force) {
      await inFlight;
      return;
    }
    // When forced, wait for the existing load to settle before starting fresh
    await inFlight.catch(() => {});
  }

  // Reserve the slot BEFORE creating the promise to prevent concurrent loads
  let resolveLoad: () => void = () => {};
  let rejectLoad: (err: unknown) => void = () => {};
  const loadPromise = new Promise<void>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  session.activeLoads.set(dataSource.id, loadPromise);

  let rowsLoaded = 0;
  runtimeStore.dispatch(
    dashboardRuntimeEvents.datasourceLoadStarted(dashboard._id, dataSource.id),
  );

  try {
    await dropTable(session.db, dataSource.tableRef).catch(() => undefined);
    const rowCount = await loadDashboardDataSourceWithFallback({
      session,
      runtimeStore,
      workspaceId,
      dashboardId: dashboard._id,
      dataSource,
      onRowsLoaded: loaded => {
        rowsLoaded = loaded;
      },
    });

    const { schema, sampleRows } = await introspectDataSource(
      dashboard._id,
      dataSource,
    );

    session.dataSourceVersions.set(dataSource.id, version);
    runtimeStore.dispatch(
      dashboardRuntimeEvents.datasourceLoadSucceeded(
        dashboard._id,
        dataSource.id,
        rowCount ?? rowsLoaded,
        rowCount ?? rowsLoaded,
        schema,
        sampleRows,
      ),
    );

    await persistDataSourceVersion(
      dashboard._id,
      dataSource.id,
      version,
      dataSource.tableRef,
      rowCount ?? rowsLoaded,
    );
    await checkpointSession(dashboard._id);
    resolveLoad();
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
    rejectLoad(error);
    throw error;
  } finally {
    session.activeLoads.delete(dataSource.id);
  }
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

  await Promise.allSettled(
    dashboard.dataSources.map(dataSource =>
      materializeDashboardDataSource({ workspaceId, dashboard, dataSource }),
    ),
  );
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
  await Promise.allSettled(
    options.dashboard.dataSources.map(dataSource =>
      materializeDashboardDataSource({
        workspaceId: options.workspaceId,
        dashboard: options.dashboard,
        dataSource,
        force: true,
      }),
    ),
  );
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
