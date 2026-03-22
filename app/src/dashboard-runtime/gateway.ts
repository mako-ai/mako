/* eslint-disable no-console */
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
  const payload = {
    tableRef: dataSource.tableRef,
    rowLimit: dataSource.rowLimit ?? null,
    query: dataSource.query,
    computedColumns: dataSource.computedColumns ?? [],
  };
  const json = JSON.stringify(payload);
  const hash = hashString(json);
  console.log(
    `[opfs-diag] buildDataSourceVersion("${dataSource.name}"): hash=${hash}, payload keys=${Object.keys(dataSource.query ?? {}).join(",")}`,
  );
  return hash;
}

function buildTemporaryTableRef(tableRef: string): string {
  return `${tableRef}__tmp__${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
  console.log(
    `[opfs-diag] fetchDashboardExport start: dataSource="${dataSource.name}" format=${format} workspace=${workspaceId}`,
  );
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

  console.log(
    `[opfs-diag] fetchDashboardExport success: dataSource="${dataSource.name}" format=${format} status=${response.status} contentLength=${response.headers.get("Content-Length") ?? "(none)"} rowCount=${response.headers.get("X-Row-Count") ?? "(none)"}`,
  );

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
    console.log(
      `[opfs-diag] loadDashboardDataSourceWithFallback arrow start: dataSource="${dataSource.name}" targetTableRef="${targetTableRef}"`,
    );
    const response = await fetchDashboardExport(
      workspaceId,
      dataSource,
      "arrow",
    );
    const totalBytes = parseNumericHeader(response.headers, "Content-Length");
    const totalRows = parseNumericHeader(response.headers, "X-Row-Count");
    console.log(
      `[opfs-diag] loadDashboardDataSourceWithFallback arrow headers: dataSource="${dataSource.name}" totalBytes=${totalBytes ?? "(none)"} totalRows=${totalRows ?? "(none)"}`,
    );

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

    console.log(
      `[opfs-diag] loadDashboardDataSourceWithFallback arrow success: dataSource="${dataSource.name}" loadedRowCount=${loadedRowCount} headerRowCount=${totalRows ?? "(none)"}`,
    );
    return totalRows ?? loadedRowCount;
  } catch (error) {
    console.warn(
      `[opfs-diag] loadDashboardDataSourceWithFallback arrow failed: dataSource="${dataSource.name}" targetTableRef="${targetTableRef}" -> falling back to NDJSON`,
      error,
    );
    await dropTable(session.db, targetTableRef).catch(() => undefined);
  }

  console.log(
    `[opfs-diag] loadDashboardDataSourceWithFallback ndjson start: dataSource="${dataSource.name}" targetTableRef="${targetTableRef}"`,
  );
  const response = await fetchDashboardExport(
    workspaceId,
    dataSource,
    "ndjson",
  );
  const loadedRows = await loadNdjsonStreamTable(
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
  console.log(
    `[opfs-diag] loadDashboardDataSourceWithFallback ndjson success: dataSource="${dataSource.name}" loadedRows=${loadedRows}`,
  );
  return loadedRows;
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
    console.warn(
      `[opfs-diag] introspectDataSource skipped: no session for dashboard=${dashboardId} dataSource="${dataSource.name}" tableRef="${tableRef}"`,
    );
    return { schema: [], sampleRows: [] };
  }

  console.log(
    `[opfs-diag] introspectDataSource start: dashboard=${dashboardId} dataSource="${dataSource.name}" tableRef="${tableRef}"`,
  );
  const schemaRows = await describeTable(session.db, tableRef);
  console.log(
    `[opfs-diag] introspectDataSource schema rows: dashboard=${dashboardId} dataSource="${dataSource.name}" tableRef="${tableRef}" columns=${schemaRows.length}`,
  );
  let sampleRows: Record<string, unknown>[] = [];
  try {
    const preview = await queryDuckDB(
      session.db,
      `SELECT * FROM "${tableRef}" LIMIT 5`,
    );
    sampleRows = preview.rows;
    console.log(
      `[opfs-diag] introspectDataSource preview success: dashboard=${dashboardId} dataSource="${dataSource.name}" tableRef="${tableRef}" sampleRows=${sampleRows.length}`,
    );
  } catch (error) {
    console.warn(
      `[opfs-diag] introspectDataSource preview failed: dashboard=${dashboardId} dataSource="${dataSource.name}" tableRef="${tableRef}"`,
      error,
    );
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

  console.log(
    `[opfs-diag] introspectDataSource success: dashboard=${dashboardId} dataSource="${dataSource.name}" tableRef="${tableRef}" schema=${schema.length} sampleRows=${sampleRows.length}`,
  );
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
  console.log(`[opfs-diag] getPersistedRowCount start: tableRef="${tableRef}"`);
  const conn = await db.connect();
  try {
    const result = await conn.query(
      `SELECT count(*) as cnt FROM "${tableRef}"`,
    );
    const rowCount = Number(result.getChild("cnt")?.get(0));
    console.log(
      `[opfs-diag] getPersistedRowCount success: tableRef="${tableRef}" rowCount=${rowCount}`,
    );
    return rowCount;
  } catch (error) {
    console.warn(
      `[opfs-diag] getPersistedRowCount failed: tableRef="${tableRef}"`,
      error,
    );
    return null;
  } finally {
    await conn.close();
    console.log(
      `[opfs-diag] getPersistedRowCount connection closed: tableRef="${tableRef}"`,
    );
  }
}

async function tryRecoverPersistedDataSource(options: {
  session: Awaited<ReturnType<typeof ensureDashboardSession>>;
  dashboard: Dashboard;
  dataSource: DashboardDataSource;
  version: string;
  persistedVersion: string | undefined;
}): Promise<{
  recovered: boolean;
  branch:
    | "metadata-hit"
    | "metadata-miss-table-hit"
    | "metadata-exists-table-miss"
    | "metadata-mismatch"
    | "table-read-failed";
  rowCount?: number;
  schema?: DashboardRuntimeColumn[];
  sampleRows?: Record<string, unknown>[];
}> {
  const { session, dashboard, dataSource, version, persistedVersion } = options;

  if (!session.persistent) {
    console.log(
      `[opfs-diag] tryRecoverPersistedDataSource skipped: dataSource="${dataSource.name}" session is not persistent`,
    );
    return { recovered: false, branch: "table-read-failed" };
  }

  console.log(
    `[opfs-diag] tryRecoverPersistedDataSource metadata evaluation: dataSource="${dataSource.name}" persistedVersion=${persistedVersion ?? "(none)"} computedVersion=${version}`,
  );

  if (persistedVersion !== undefined && persistedVersion !== version) {
    console.warn(
      `[opfs-diag] tryRecoverPersistedDataSource metadata mismatch: dataSource="${dataSource.name}" persistedVersion=${persistedVersion} computedVersion=${version}`,
    );
    return { recovered: false, branch: "metadata-mismatch" };
  }

  const branch =
    persistedVersion === version ? "metadata-hit" : "metadata-miss-table-hit";
  console.log(
    `[opfs-diag] tryRecoverPersistedDataSource probing physical table: dataSource="${dataSource.name}" branch=${branch} tableRef="${dataSource.tableRef}"`,
  );
  const rowCount = await getPersistedRowCount(session.db, dataSource.tableRef);
  if (rowCount === null) {
    console.warn(
      `[opfs-diag] tryRecoverPersistedDataSource table probe failed: dataSource="${dataSource.name}" branch=${branch} tableRef="${dataSource.tableRef}"`,
    );
    return {
      recovered: false,
      branch:
        persistedVersion === version
          ? "metadata-exists-table-miss"
          : "table-read-failed",
    };
  }

  console.log(
    `[opfs-diag] tryRecoverPersistedDataSource introspection start: dataSource="${dataSource.name}" branch=${branch} rowCount=${rowCount}`,
  );
  try {
    const { schema, sampleRows } = await introspectDataSource(
      dashboard._id,
      dataSource,
    );
    console.log(
      `[opfs-diag] tryRecoverPersistedDataSource introspection success: dataSource="${dataSource.name}" branch=${branch} schema=${schema.length} sampleRows=${sampleRows.length}`,
    );

    if (persistedVersion === undefined) {
      console.log(
        `[opfs-diag] tryRecoverPersistedDataSource metadata missing; rehydrating for dataSource="${dataSource.name}" version=${version}`,
      );
      session.dataSourceVersions.set(dataSource.id, version);
      await persistDataSourceVersion(
        dashboard._id,
        dataSource.id,
        version,
        dataSource.tableRef,
        rowCount,
      );
      console.log(
        `[opfs-diag] tryRecoverPersistedDataSource metadata persisted; checkpointing dashboard=${dashboard._id}`,
      );
      await checkpointSession(dashboard._id);
      console.log(
        `[opfs-diag] tryRecoverPersistedDataSource checkpoint complete: dashboard=${dashboard._id} dataSource="${dataSource.name}"`,
      );
    }

    return {
      recovered: true,
      branch,
      rowCount,
      schema,
      sampleRows,
    };
  } catch (error) {
    console.warn(
      `[opfs-diag] tryRecoverPersistedDataSource introspection failed: dataSource="${dataSource.name}" branch=${branch}`,
      error,
    );
    return { recovered: false, branch: "table-read-failed" };
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
  console.log(
    `[opfs-diag] materialize runtime state: dataSource="${dataSource.name}" existingRuntime=${existingRuntime?.status ?? "(none)"} preserveExistingData=${preserveExistingData}`,
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

  if (!force && session.persistent) {
    console.log(
      `[opfs-diag] materialize evaluating persistent recovery ladder: dataSource="${dataSource.name}"`,
    );
    const recovery = await tryRecoverPersistedDataSource({
      session,
      dashboard,
      dataSource,
      version,
      persistedVersion,
    });
    console.log(
      `[opfs-diag] materialize recovery result: dataSource="${dataSource.name}" recovered=${recovery.recovered} branch=${recovery.branch}`,
    );
    if (recovery.recovered) {
      runtimeStore.dispatch(
        dashboardRuntimeEvents.datasourceLoadSucceeded(
          dashboard._id,
          dataSource.id,
          recovery.rowCount ?? 0,
          recovery.rowCount ?? 0,
          recovery.schema ?? [],
          recovery.sampleRows ?? [],
        ),
      );
      console.log(
        `[opfs-diag] materialize local recovery success: dataSource="${dataSource.name}" branch=${recovery.branch} rows=${recovery.rowCount ?? 0}`,
      );
      return;
    }

    if (recovery.branch === "metadata-mismatch") {
      console.warn(
        `[opfs-diag] OPFS VERSION MISMATCH: dataSource="${dataSource.name}" persistedVersion=${persistedVersion ?? "(none)"} computedVersion=${version} rowLimit=${dataSource.rowLimit ?? "(none)"} computedColumns=${dataSource.computedColumns?.length ?? 0} queryCode=${dataSource.query?.code?.slice(0, 100) ?? "(none)"}`,
      );
    } else if (recovery.branch === "metadata-exists-table-miss") {
      console.warn(
        `[opfs-diag] OPFS inconsistency: metadata matched but table probe failed for dataSource="${dataSource.name}" tableRef="${dataSource.tableRef}"`,
      );
    } else if (recovery.branch === "table-read-failed") {
      console.warn(
        `[opfs-diag] OPFS recovery aborted after metadata-miss/table-read failure for dataSource="${dataSource.name}" tableRef="${dataSource.tableRef}"`,
      );
    }
  } else if (force) {
    console.log(
      `[opfs-diag] FORCED RELOAD: dataSource="${dataSource.name}", bypassing cache`,
    );
  } else {
    console.log(
      `[opfs-diag] materialize skipping persistent recovery ladder: dataSource="${dataSource.name}" persistent=${session.persistent} force=${force}`,
    );
  }

  console.log(
    `[opfs-diag] FETCHING FROM SERVER: dataSource="${dataSource.name}" (${dataSource.id})`,
  );

  const inFlight = session.activeLoads.get(dataSource.id);
  if (inFlight) {
    console.log(
      `[opfs-diag] materialize found in-flight load: dataSource="${dataSource.name}" force=${force}`,
    );
    if (!force) {
      await inFlight;
      console.log(
        `[opfs-diag] materialize returning after awaiting existing in-flight load: dataSource="${dataSource.name}"`,
      );
      return;
    }
    // When forced, wait for the existing load to settle before starting fresh
    await inFlight.catch(() => {});
    console.log(
      `[opfs-diag] materialize force reload continuing after existing in-flight load settled: dataSource="${dataSource.name}"`,
    );
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
  console.log(
    `[opfs-diag] datasourceLoadStarted dispatched: dataSource="${dataSource.name}" preserveExistingData=${preserveExistingData}`,
  );

  try {
    temporaryTableRef = buildTemporaryTableRef(dataSource.tableRef);
    console.log(
      `[opfs-diag] temporary table prepared: dataSource="${dataSource.name}" temporaryTableRef="${temporaryTableRef}"`,
    );
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
    console.log(
      `[opfs-diag] temporary table introspection complete: dataSource="${dataSource.name}" temporaryTableRef="${temporaryTableRef}" schema=${schema.length} sampleRows=${sampleRows.length}`,
    );

    await swapMaterializedTable({
      db: session.db,
      liveTableRef: dataSource.tableRef,
      temporaryTableRef,
    });
    console.log(
      `[opfs-diag] swapMaterializedTable success: dataSource="${dataSource.name}" liveTableRef="${dataSource.tableRef}" temporaryTableRef="${temporaryTableRef}"`,
    );

    session.dataSourceVersions.set(dataSource.id, version);
    console.log(
      `[opfs-diag] session dataSourceVersions updated: dataSource="${dataSource.name}" version=${version}`,
    );
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
    console.log(
      `[opfs-diag] materialize load promise resolved: dataSource="${dataSource.name}"`,
    );
  } catch (error) {
    console.warn(
      `[opfs-diag] materialize failed: dataSource="${dataSource.name}" temporaryTableRef="${temporaryTableRef ?? "(none)"}" rowsLoaded=${rowsLoaded}`,
      error,
    );
    session.dataSourceVersions.delete(dataSource.id);
    if (temporaryTableRef) {
      await dropTable(session.db, temporaryTableRef).catch(() => undefined);
      console.log(
        `[opfs-diag] temporary table dropped after failure: dataSource="${dataSource.name}" temporaryTableRef="${temporaryTableRef}"`,
      );
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
    console.log(
      `[opfs-diag] active load cleared: dataSource="${dataSource.name}"`,
    );
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
