import {
  collectStreamBytes,
  describeTable,
  dropTable,
  loadArrowStreamTable,
  loadParquetTable,
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
  return hashString(JSON.stringify(payload));
}

function buildTemporaryTableRef(tableRef: string): string {
  return `${tableRef}__tmp__${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function buildDashboardExportPayload(
  dashboardId: string,
  dataSource: DashboardDataSource,
  format: "arrow" | "ndjson" | "parquet" = "arrow",
) {
  return {
    dashboardId,
    dataSourceId: dataSource.id,
    connectionId: dataSource.query.connectionId,
    format,
    batchSize: format === "arrow" ? 5000 : 2000,
    filename: dataSource.name,
    queryDefinition: dataSource.query,
  };
}

type DashboardRuntimeContext = "builder" | "viewer";

function getParquetArtifactUrl(
  dataSource: DashboardDataSource,
): string | undefined {
  return (
    dataSource.cache as
      | (DashboardDataSource["cache"] & { parquetUrl?: string })
      | undefined
  )?.parquetUrl;
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

function appendRuntimeLog(
  dashboardId: string,
  level: "info" | "warn" | "error",
  message: string,
  metadata?: Record<string, unknown>,
) {
  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.appendLog(dashboardId, level, message, metadata),
    );
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
  dashboardId: string,
  dataSource: DashboardDataSource,
  format: "arrow" | "ndjson" | "parquet",
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/execute/export`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildDashboardExportPayload(dashboardId, dataSource, format),
      ),
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

async function loadParquetArtifactIntoTable(options: {
  session: Awaited<ReturnType<typeof ensureDashboardSession>>;
  parquetUrl: string;
  targetTableRef: string;
  onProgress?: (progress: {
    rowsLoaded: number;
    bytesLoaded: number;
    totalBytes: number | null;
  }) => void;
}): Promise<number> {
  const response = await fetch(options.parquetUrl, {
    credentials: "include",
  });
  if (!response.ok || !response.body) {
    throw new Error(response.statusText || "Failed to fetch parquet artifact");
  }

  const totalBytes = parseNumericHeader(response.headers, "Content-Length");
  const totalRows = parseNumericHeader(response.headers, "X-Row-Count");
  const parquetBuffer = await collectStreamBytes(response.body, bytesLoaded => {
    const estimatedRows = estimateRowsFromBytes(
      bytesLoaded,
      totalBytes,
      totalRows,
    );
    options.onProgress?.({
      rowsLoaded: estimatedRows ?? 0,
      bytesLoaded,
      totalBytes: totalBytes ?? null,
    });
  });

  const loadedRowCount = await loadParquetTable(
    options.session.db,
    options.targetTableRef,
    parquetBuffer,
  );
  options.onProgress?.({
    rowsLoaded: totalRows ?? loadedRowCount,
    bytesLoaded: parquetBuffer.byteLength,
    totalBytes: totalBytes ?? null,
  });
  return totalRows ?? loadedRowCount;
}

function trackStreamProgress(
  stream: ReadableStream<Uint8Array>,
  onProgress: (bytesLoaded: number) => void,
): ReadableStream<Uint8Array> {
  let bytesLoaded = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesLoaded += chunk.byteLength;
        onProgress(bytesLoaded);
        controller.enqueue(chunk);
      },
    }),
  );
}

function dispatchLoadProgress(options: {
  runtimeStore: ReturnType<typeof useDashboardRuntimeStore.getState>;
  dashboardId: string;
  dataSourceId: string;
  onRowsLoaded: (loaded: number) => void;
  rowsLoaded: number;
  bytesLoaded: number;
  totalBytes: number | null;
  preserveExistingData?: boolean;
}) {
  options.onRowsLoaded(options.rowsLoaded);
  options.runtimeStore.dispatch(
    dashboardRuntimeEvents.datasourceLoadProgress(
      options.dashboardId,
      options.dataSourceId,
      options.rowsLoaded,
      options.bytesLoaded,
      options.totalBytes,
      options.preserveExistingData,
    ),
  );
}

/**
 * Load a data source into DuckDB, trying parquet artifact first,
 * then Arrow stream, then NDJSON as final fallback.
 * Always materializes into an in-memory TABLE (never a remote VIEW).
 */
async function loadDashboardDataSourceWithFallback(options: {
  session: Awaited<ReturnType<typeof ensureDashboardSession>>;
  runtimeStore: ReturnType<typeof useDashboardRuntimeStore.getState>;
  workspaceId: string;
  dashboardId: string;
  dashboard: Dashboard;
  dataSource: DashboardDataSource;
  targetTableRef: string;
  preserveExistingData?: boolean;
  onRowsLoaded: (loaded: number) => void;
  runtimeContext?: DashboardRuntimeContext;
  skipParquet?: boolean;
}): Promise<number> {
  const {
    session,
    runtimeStore,
    workspaceId,
    dashboardId,
    dataSource,
    targetTableRef,
    onRowsLoaded,
    runtimeContext = "builder",
    skipParquet = false,
  } = options;

  const parquetUrl = skipParquet
    ? undefined
    : getParquetArtifactUrl(dataSource);

  const tryParquet = async (): Promise<number | null> => {
    if (!parquetUrl) return null;
    try {
      runtimeStore.dispatch(
        dashboardRuntimeEvents.updateDatasourceDiagnostics(
          dashboardId,
          dataSource.id,
          {
            loadPath: "memory",
            resolvedMode: runtimeContext,
            artifactUrl: parquetUrl,
          },
        ),
      );
      return await loadParquetArtifactIntoTable({
        session,
        parquetUrl,
        targetTableRef,
        onProgress: progress => {
          dispatchLoadProgress({
            runtimeStore,
            dashboardId,
            dataSourceId: dataSource.id,
            onRowsLoaded,
            rowsLoaded: progress.rowsLoaded,
            bytesLoaded: progress.bytesLoaded,
            totalBytes: progress.totalBytes,
            preserveExistingData: options.preserveExistingData,
          });
        },
      });
    } catch (error) {
      console.warn(
        `Parquet artifact load failed for "${dataSource.name}", falling back to streamed export`,
        error,
      );
      appendRuntimeLog(
        dashboardId,
        "warn",
        `Parquet artifact load failed for "${dataSource.name}", falling back to streamed export`,
        {
          dataSourceId: dataSource.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await dropTable(session.db, targetTableRef).catch(() => undefined);
      return null;
    }
  };

  const tryArrow = async (): Promise<number | null> => {
    try {
      runtimeStore.dispatch(
        dashboardRuntimeEvents.updateDatasourceDiagnostics(
          dashboardId,
          dataSource.id,
          {
            loadPath: "arrow_stream",
            resolvedMode: runtimeContext,
          },
        ),
      );
      const response = await fetchDashboardExport(
        workspaceId,
        dashboardId,
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
            if (estimatedRows == null) return;
            dispatchLoadProgress({
              runtimeStore,
              dashboardId,
              dataSourceId: dataSource.id,
              onRowsLoaded,
              rowsLoaded: estimatedRows ?? 0,
              bytesLoaded,
              totalBytes: totalBytes ?? null,
              preserveExistingData: options.preserveExistingData,
            });
          },
        },
      );
      return totalRows ?? loadedRowCount;
    } catch (error) {
      console.warn(`Arrow stream failed for "${dataSource.name}"`, error);
      appendRuntimeLog(
        dashboardId,
        "warn",
        `Arrow stream failed for "${dataSource.name}"`,
        {
          dataSourceId: dataSource.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await dropTable(session.db, targetTableRef).catch(() => undefined);
      return null;
    }
  };

  const tryNdjson = async (): Promise<number> => {
    runtimeStore.dispatch(
      dashboardRuntimeEvents.updateDatasourceDiagnostics(
        dashboardId,
        dataSource.id,
        {
          loadPath: "ndjson_stream",
          resolvedMode: runtimeContext,
        },
      ),
    );
    const response = await fetchDashboardExport(
      workspaceId,
      dashboardId,
      dataSource,
      "ndjson",
    );
    const totalBytes = parseNumericHeader(response.headers, "Content-Length");
    let ndjsonBytesLoaded = 0;
    let ndjsonRowsLoaded = 0;
    const trackedBody = trackStreamProgress(response.body, bytesLoaded => {
      ndjsonBytesLoaded = bytesLoaded;
      dispatchLoadProgress({
        runtimeStore,
        dashboardId,
        dataSourceId: dataSource.id,
        onRowsLoaded,
        rowsLoaded: ndjsonRowsLoaded,
        bytesLoaded,
        totalBytes: totalBytes ?? null,
        preserveExistingData: options.preserveExistingData,
      });
    });
    return await loadNdjsonStreamTable(
      session.db,
      targetTableRef,
      trackedBody,
      {
        onProgress: loaded => {
          ndjsonRowsLoaded = loaded;
          dispatchLoadProgress({
            runtimeStore,
            dashboardId,
            dataSourceId: dataSource.id,
            onRowsLoaded,
            rowsLoaded: loaded,
            bytesLoaded: ndjsonBytesLoaded,
            totalBytes: totalBytes ?? null,
            preserveExistingData: options.preserveExistingData,
          });
        },
      },
    );
  };

  // WIP/edit mode (skipParquet): prefer NDJSON (stable) over Arrow.
  // Viewer/published mode: prefer parquet artifact, then Arrow, then NDJSON.
  if (skipParquet) {
    const ndjsonResult = await tryNdjson().catch(() => null as number | null);
    if (ndjsonResult != null) return ndjsonResult;
    const arrowResult = await tryArrow();
    if (arrowResult != null) return arrowResult;
    throw new Error(`All stream loading paths failed for "${dataSource.name}"`);
  }

  const parquetResult = await tryParquet();
  if (parquetResult != null) return parquetResult;
  const arrowResult = await tryArrow();
  if (arrowResult != null) return arrowResult;
  return await tryNdjson();
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

async function countTableRows(
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
  runtimeContext: DashboardRuntimeContext = "builder",
): Promise<void> {
  const session = await ensureDashboardSession(dashboard._id);
  useDashboardRuntimeStore
    .getState()
    .dispatch(
      dashboardRuntimeEvents.activateSession(
        dashboard._id,
        session.sessionId,
        runtimeContext,
        false,
      ),
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
  runtimeContext?: DashboardRuntimeContext;
  skipParquet?: boolean;
}): Promise<void> {
  const {
    workspaceId,
    dashboard,
    dataSource,
    force = false,
    runtimeContext = "builder",
    skipParquet = false,
  } = options;
  const session = await ensureDashboardSession(dashboard._id);
  const runtimeStore = useDashboardRuntimeStore.getState();
  const version = buildDataSourceVersion(dataSource);
  const cachedVersion = session.dataSourceVersions.get(dataSource.id);
  const cache = (dataSource.cache || {}) as {
    parquetBuildStatus?: "missing" | "building" | "ready" | "error";
    parquetVersion?: string;
    parquetBuiltAt?: string;
  };
  const parquetUrl = getParquetArtifactUrl(dataSource);
  const existingRuntime = selectDataSourceRuntime(dashboard._id, dataSource.id);
  const preserveExistingData = force && existingRuntime?.status === "ready";
  const loadStartedAt = Date.now();

  runtimeStore.dispatch(
    dashboardRuntimeEvents.registerDataSource(
      dashboard._id,
      dataSource.id,
      dataSource.tableRef,
      version,
    ),
  );
  runtimeStore.dispatch(
    dashboardRuntimeEvents.updateDatasourceDiagnostics(
      dashboard._id,
      dataSource.id,
      {
        resolvedMode: runtimeContext,
        artifactUrl: parquetUrl || null,
        materializationStatus: cache.parquetBuildStatus,
        materializationVersion: cache.parquetVersion || version,
        materializedAt: cache.parquetBuiltAt || null,
      },
    ),
  );

  // Skip if already loaded with the same version.
  // Staleness (dataFreshnessTtlMs) is handled by the materialization pipeline
  // which produces a new parquet version; reloading the same parquet into
  // DuckDB would not produce fresher data.
  if (
    !force &&
    cachedVersion === version &&
    existingRuntime?.status === "ready"
  ) {
    return;
  }

  // Await any in-flight load.
  const inFlight = session.activeLoads.get(dataSource.id);
  if (inFlight) {
    if (!force) {
      await inFlight;
      return;
    }
    await inFlight.catch(() => {});
  }

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
  appendRuntimeLog(
    dashboard._id,
    "info",
    "Data source materialization started",
    {
      dataSourceId: dataSource.id,
      dataSourceName: dataSource.name,
      runtimeContext,
    },
  );

  try {
    temporaryTableRef = buildTemporaryTableRef(dataSource.tableRef);
    await dropTable(session.db, temporaryTableRef).catch(() => undefined);
    const rowCount = await loadDashboardDataSourceWithFallback({
      session,
      runtimeStore,
      workspaceId,
      dashboardId: dashboard._id,
      dashboard,
      dataSource,
      targetTableRef: temporaryTableRef,
      preserveExistingData,
      onRowsLoaded: loaded => {
        rowsLoaded = loaded;
      },
      runtimeContext,
      skipParquet,
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

    const resolvedRowCount =
      rowCount ??
      (await countTableRows(session.db, dataSource.tableRef)) ??
      rowsLoaded;

    session.dataSourceVersions.set(dataSource.id, version);
    runtimeStore.dispatch(
      dashboardRuntimeEvents.datasourceLoadSucceeded(
        dashboard._id,
        dataSource.id,
        resolvedRowCount,
        resolvedRowCount,
        schema,
        sampleRows,
      ),
    );
    runtimeStore.dispatch(
      dashboardRuntimeEvents.updateDatasourceDiagnostics(
        dashboard._id,
        dataSource.id,
        {
          loadPath: "memory",
          resolvedMode: runtimeContext,
          artifactUrl: parquetUrl || null,
          loadDurationMs: Date.now() - loadStartedAt,
        },
      ),
    );
    appendRuntimeLog(
      dashboard._id,
      "info",
      "Data source materialization succeeded",
      {
        dataSourceId: dataSource.id,
        loadDurationMs: Date.now() - loadStartedAt,
        rowCount: resolvedRowCount,
      },
    );

    await persistDataSourceVersion(
      dashboard._id,
      dataSource.id,
      version,
      dataSource.tableRef,
      resolvedRowCount,
    );
    await checkpointSession(dashboard._id);
    resolveLoad();
  } catch (error) {
    console.warn(`Materialization failed for "${dataSource.name}"`, error);
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
        Date.now() - loadStartedAt,
      ),
    );
    appendRuntimeLog(
      dashboard._id,
      "error",
      "Data source materialization failed",
      {
        dataSourceId: dataSource.id,
        error:
          error instanceof Error ? error.message : "Failed to load data source",
        loadDurationMs: Date.now() - loadStartedAt,
      },
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
  runtimeContext?: DashboardRuntimeContext;
}): Promise<void> {
  const { workspaceId, dashboard, runtimeContext = "builder" } = options;
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
      materializeDashboardDataSource({
        workspaceId,
        dashboard,
        dataSource,
        runtimeContext,
      }),
    ),
  );
}

export async function refreshDashboardDataSource(options: {
  workspaceId: string;
  dashboard: Dashboard;
  dataSourceId: string;
  runtimeContext?: DashboardRuntimeContext;
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
    runtimeContext: options.runtimeContext,
  });
}

export async function refreshAllDashboardDataSources(options: {
  workspaceId: string;
  dashboard: Dashboard;
  runtimeContext?: DashboardRuntimeContext;
}): Promise<void> {
  await Promise.allSettled(
    options.dashboard.dataSources.map(dataSource =>
      materializeDashboardDataSource({
        workspaceId: options.workspaceId,
        dashboard: options.dashboard,
        dataSource,
        force: true,
        runtimeContext: options.runtimeContext,
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
    `SELECT * FROM "${runtime.tableRef || dataSource.tableRef}" LIMIT 100`;
  return await queryDashboardRuntime({
    dashboard: options.dashboard,
    sql,
  });
}
