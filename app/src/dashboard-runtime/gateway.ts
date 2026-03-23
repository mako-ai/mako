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
  ensureWritableDashboardSession,
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
  const payload = {
    tableRef: dataSource.tableRef,
    rowLimit: dataSource.rowLimit ?? null,
    query: dataSource.query,
    computedColumns: dataSource.computedColumns ?? [],
  };
  const json = JSON.stringify(payload);
  const hash = hashString(json);
  console.debug(
    `[opfs-diag] buildDataSourceVersion("${dataSource.name}"): hash=${hash}, payload keys=${Object.keys(dataSource.query ?? {}).join(",")}`,
  );
  return hash;
}

function buildTemporaryTableRef(tableRef: string): string {
  return `${tableRef}__tmp__${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function buildReloadRequiredMessage(
  dataSource: DashboardDataSource,
  reason: "missing" | "stale" | "locked" | "open-failed" | "unsupported",
): string {
  switch (reason) {
    case "missing":
      return `Cached data for "${dataSource.name}" is unavailable. Click Reload data to fetch it from the source database.`;
    case "stale":
      return `Cached data for "${dataSource.name}" is stale. Click Reload data to fetch the latest source data.`;
    case "locked":
      return `Cached data for "${dataSource.name}" is currently locked by another dashboard tab. Close the other tab or click Reload data to fetch it from the source database in this tab.`;
    case "open-failed":
      return `Cached data for "${dataSource.name}" could not be opened from OPFS in this browser session. Click Reload data to fetch it from the source database.`;
    default:
      return `This browser does not support OPFS-backed dashboard cache for "${dataSource.name}". Click Reload data to fetch it from the source database.`;
  }
}

function isOPFSLockError(message: string | null | undefined): boolean {
  const normalized = message?.toLowerCase() || "";
  return (
    normalized.includes("createsyncaccesshandle") &&
    (normalized.includes("another open access handle") ||
      normalized.includes("writable stream associated with the same file"))
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
  preserveExistingData?: boolean;
}) {
  options.onRowsLoaded(options.rowsLoaded);
  options.runtimeStore.dispatch(
    dashboardRuntimeEvents.datasourceLoadProgress(
      options.dashboardId,
      options.dataSourceId,
      options.rowsLoaded,
      options.preserveExistingData,
    ),
  );
}

async function loadDashboardDataSourceWithFallback(options: {
  session: Awaited<ReturnType<typeof ensureDashboardSession>>;
  runtimeStore: ReturnType<typeof useDashboardRuntimeStore.getState>;
  workspaceId: string;
  dashboardId: string;
  dataSource: DashboardDataSource;
  targetTableRef: string;
  preserveExistingData?: boolean;
  onRowsLoaded: (loaded: number) => void;
}): Promise<number | null> {
  const {
    session,
    runtimeStore,
    workspaceId,
    dashboardId,
    dataSource,
    targetTableRef,
    preserveExistingData = false,
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
      targetTableRef,
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
            preserveExistingData,
          });
        },
      },
    );

    return totalRows ?? loadedRowCount;
  } catch {
    await dropTable(session.db, targetTableRef).catch(() => undefined);
  }

  const response = await fetchDashboardExport(
    workspaceId,
    dataSource,
    "ndjson",
  );
  return await loadNdjsonStreamTable(
    session.db,
    targetTableRef,
    response.body,
    {
      onProgress: loaded => {
        dispatchLoadProgress({
          runtimeStore,
          dashboardId,
          dataSourceId: dataSource.id,
          onRowsLoaded,
          rowsLoaded: loaded,
          preserveExistingData,
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
  tableRef = dataSource.tableRef,
): Promise<{
  schema: DashboardRuntimeColumn[];
  sampleRows: Record<string, unknown>[];
}> {
  const session = getDashboardSession(dashboardId);
  if (!session) {
    return { schema: [], sampleRows: [] };
  }

  const schemaRows = await describeTable(session.db, tableRef);
  let sampleRows: Record<string, unknown>[] = [];
  try {
    const preview = await queryDuckDB(
      session.db,
      `SELECT * FROM "${tableRef}" LIMIT 5`,
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

async function swapMaterializedTable(options: {
  db: import("@duckdb/duckdb-wasm").AsyncDuckDB;
  liveTableRef: string;
  temporaryTableRef: string;
}): Promise<void> {
  const conn = await options.db.connect();
  try {
    await conn.query("BEGIN TRANSACTION");
    await conn.query(`DROP TABLE IF EXISTS "${options.liveTableRef}"`);
    await conn.query(
      `ALTER TABLE "${options.temporaryTableRef}" RENAME TO "${options.liveTableRef}"`,
    );
    await conn.query("COMMIT");
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await conn.close();
  }
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
  let session = await ensureDashboardSession(dashboard._id);
  if (force) {
    session = await ensureWritableDashboardSession(dashboard._id);
  }
  const runtimeStore = useDashboardRuntimeStore.getState();
  const version = buildDataSourceVersion(dataSource);
  const persistedVersion = session.dataSourceVersions.get(dataSource.id);
  const existingRuntime = selectDataSourceRuntime(dashboard._id, dataSource.id);
  const preserveExistingData = force && existingRuntime?.status === "ready";

  console.log(
    `[opfs-diag] materialize dataSource="${dataSource.name}" (${dataSource.id})`,
    {
      force,
      persistent: session.persistent,
      computedVersion: version,
      persistedVersion: persistedVersion ?? "(none)",
      versionMatch: persistedVersion === version,
      runtimeStatus: existingRuntime?.status ?? "(no runtime)",
      tableRef: dataSource.tableRef,
    },
  );

  runtimeStore.dispatch(
    dashboardRuntimeEvents.registerDataSource(
      dashboard._id,
      dataSource.id,
      dataSource.tableRef,
      version,
    ),
  );

  if (
    !force &&
    persistedVersion === version &&
    existingRuntime?.status === "ready"
  ) {
    console.log(
      `[opfs-diag] SKIP (in-memory hit): dataSource="${dataSource.name}" already ready with matching version`,
    );
    return;
  }

  // OPFS recovery: table persisted from a previous browser session
  if (!force && session.persistent && persistedVersion === version) {
    console.log(
      `[opfs-diag] OPFS recovery attempt: dataSource="${dataSource.name}", checking persisted table "${dataSource.tableRef}"...`,
    );
    const rowCount = await getPersistedRowCount(
      session.db,
      dataSource.tableRef,
    );
    if (rowCount !== null) {
      console.log(
        `[opfs-diag] OPFS HIT: dataSource="${dataSource.name}" recovered ${rowCount} rows from OPFS, skipping network fetch`,
      );
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
    console.warn(
      `[opfs-diag] OPFS MISS: dataSource="${dataSource.name}" version matched but table "${dataSource.tableRef}" not found in DB (rowCount=null)`,
    );
  } else if (!force && session.persistent && persistedVersion !== version) {
    console.warn(
      `[opfs-diag] OPFS VERSION MISMATCH: dataSource="${dataSource.name}"`,
      {
        persistedVersion: persistedVersion ?? "(none)",
        computedVersion: version,
        queryCode: dataSource.query?.code?.slice(0, 100),
        rowLimit: dataSource.rowLimit,
        computedColumns: dataSource.computedColumns?.length ?? 0,
      },
    );
  } else if (force) {
    console.log(
      `[opfs-diag] FORCED RELOAD: dataSource="${dataSource.name}", bypassing cache`,
    );
  }

  if (!force) {
    const errorReason:
      | "missing"
      | "stale"
      | "locked"
      | "open-failed"
      | "unsupported" =
      session.persistent && persistedVersion !== version
        ? "stale"
        : session.persistent
          ? "missing"
          : isOPFSLockError(session.persistenceError)
            ? "locked"
            : session.opfsAvailable
              ? "open-failed"
              : "unsupported";
    const message = buildReloadRequiredMessage(dataSource, errorReason);
    console.log(
      `[opfs-diag] STARTUP CACHE-ONLY MODE: dataSource="${dataSource.name}" not fetching from source`,
      {
        reason: errorReason,
        persistenceError: session.persistenceError,
        persistent: session.persistent,
        accessMode: session.accessMode,
      },
    );
    runtimeStore.dispatch(
      dashboardRuntimeEvents.datasourceLoadFailed(
        dashboard._id,
        dataSource.id,
        0,
        message,
        false,
      ),
    );
    return;
  }

  console.log(
    `[opfs-diag] FETCHING FROM SERVER: dataSource="${dataSource.name}" (${dataSource.id})`,
  );

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
  let temporaryTableRef: string | null = null;
  runtimeStore.dispatch(
    dashboardRuntimeEvents.datasourceLoadStarted(
      dashboard._id,
      dataSource.id,
      preserveExistingData,
    ),
  );

  try {
    temporaryTableRef = buildTemporaryTableRef(dataSource.tableRef);
    await dropTable(session.db, temporaryTableRef).catch(() => undefined);
    const rowCount = await loadDashboardDataSourceWithFallback({
      session,
      runtimeStore,
      workspaceId,
      dashboardId: dashboard._id,
      dataSource,
      targetTableRef: temporaryTableRef,
      preserveExistingData,
      onRowsLoaded: loaded => {
        rowsLoaded = loaded;
      },
    });

    const { schema, sampleRows } = await introspectDataSource(
      dashboard._id,
      dataSource,
      temporaryTableRef,
    );

    await swapMaterializedTable({
      db: session.db,
      liveTableRef: dataSource.tableRef,
      temporaryTableRef,
    });

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
    console.log(
      `[opfs-diag] PERSISTED: dataSource="${dataSource.name}" version=${version} rows=${rowCount ?? rowsLoaded} tableRef="${dataSource.tableRef}" persistent=${session.persistent}`,
    );
    resolveLoad();
  } catch (error) {
    session.dataSourceVersions.delete(dataSource.id);
    if (temporaryTableRef) {
      await dropTable(session.db, temporaryTableRef).catch(() => undefined);
    }
    runtimeStore.dispatch(
      dashboardRuntimeEvents.datasourceLoadFailed(
        dashboard._id,
        dataSource.id,
        rowsLoaded,
        error instanceof Error ? error.message : "Failed to load data source",
        preserveExistingData,
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
      if (session.accessMode === "read-write") {
        await dropTable(session.db, runtimeState.tableRef).catch(
          () => undefined,
        );
      }
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
  let session = getDashboardSession(options.dashboardId);
  if (session?.persistent && session.accessMode !== "read-write") {
    session = await ensureWritableDashboardSession(options.dashboardId);
  }
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
