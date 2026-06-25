/**
 * Server-side data-source execution (surface-agnostic).
 *
 * Mirrors the browser data-source tools (`list_data_sources`,
 * `inspect_data_source`, `query_duckdb`) on the API so the agent can run them
 * with NO attached browser. Materialized Parquet artifacts — built by the SAME
 * pipeline the browser loads into DuckDB-WASM (see
 * app-binding-materialization.service.ts / parquet-build.service.ts) — are
 * streamed from the artifact store into a node DuckDB instance
 * (`@duckdb/node-api`) and queried with identical SQL. The browser's WASM tables
 * and the server's node tables are loaded from the same artifacts, so results
 * match.
 *
 * Safety: the agent's SQL is gated to a single read-only SELECT/WITH statement
 * with no file/extension access (DuckDB external access is disabled before the
 * query runs, and a denylist rejects file table-functions). The instance only
 * holds this workspace's own materialized data, which the caller can already
 * read.
 */

import os from "os";
import path from "path";
import { promises as fsPromises, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Types } from "mongoose";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  MakoApp,
  Dashboard,
  DatabaseConnection,
} from "../database/workspace-schema";
import { getArtifactStore } from "./dashboard-cache.service";
import { databaseConnectionService } from "./database-connection.service";
import { loggers } from "../logging";

const logger = loggers.api("server-data-source");

const DEFAULT_DUCKDB_MEMORY_LIMIT_MB = 512;
/** Rows returned to the model (matches the browser tool's `slice(100)`). */
const RESULT_ROW_CAP = 100;
/** Hard cap on rows materialized from the agent query to bound API heap. */
const READ_ROW_CAP = 10_000;
/** Sample rows for inspect_data_source (matches the browser tool). */
const INSPECT_SAMPLE_ROWS = 5;

export interface DataSourceSurface {
  kind: "app" | "dashboard";
  id: string;
}

export interface ServerDataSourceResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/** DuckDB-safe table name derived from a binding name (mirrors the client). */
function bindingTableName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(safe) ? safe : `t_${safe}`;
}

function fail(error: string): ServerDataSourceResult {
  return { success: false, error };
}

const LEADING_SQL_COMMENTS = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/;
// Table functions / statements that reach the host filesystem, network, or
// extension loader. Rejected even though external access is also disabled at
// the DuckDB level (defense in depth).
const FILE_ACCESS_DENYLIST =
  /\b(read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_text|read_blob|read_ndjson|parquet_scan|glob|attach|detach|copy|install|load|sniff_csv)\b/i;

/**
 * Gate agent-supplied DuckDB SQL: a single read-only SELECT/WITH statement with
 * no file/extension access. Mirrors `checkSandboxDuckDbSql` on the client and
 * adds the file-access denylist for the (more sensitive) server context.
 */
export function checkServerDuckDbSql(
  sql: string,
): { ok: true; statement: string } | { ok: false; error: string } {
  const stripped = sql.replace(LEADING_SQL_COMMENTS, "").trim();
  if (!stripped) return { ok: false, error: "Empty SQL." };
  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    return {
      ok: false,
      error: "Only read-only SELECT / WITH queries are allowed.",
    };
  }
  if (FILE_ACCESS_DENYLIST.test(stripped)) {
    return {
      ok: false,
      error:
        "File, network, and extension access (read_parquet, read_csv, ATTACH, COPY, INSTALL, …) is not allowed.",
    };
  }
  // Reject anything after a top-level semicolon (multi-statement).
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inSingle) {
      if (ch === "'") {
        if (stripped[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === ";" && stripped.slice(i + 1).trim().length > 0) {
      return { ok: false, error: "Only a single SQL statement is allowed." };
    }
  }
  return { ok: true, statement: stripped.replace(/;\s*$/, "") };
}

interface SurfaceTable {
  /** Data source name (apps) or display name (dashboards). */
  name: string;
  /** DuckDB table name the SQL references. */
  table: string;
  artifactKey?: string;
  status?: string | null;
  rowCount?: number | null;
}

interface ResolvedSurface {
  tables: SurfaceTable[];
}

/** Resolve a surface's materialized (Parquet) tables from MongoDB. */
async function resolveSurfaceTables(
  workspaceId: string,
  surface: DataSourceSurface,
): Promise<ResolvedSurface | { error: string }> {
  if (!Types.ObjectId.isValid(surface.id)) {
    return { error: `Invalid ${surface.kind} id: ${surface.id}` };
  }
  const wsId = new Types.ObjectId(workspaceId);

  if (surface.kind === "app") {
    const app = await MakoApp.findOne({
      _id: new Types.ObjectId(surface.id),
      workspaceId: wsId,
    });
    if (!app) return { error: "App not found" };
    const tables = (app.dataBindings ?? [])
      .filter(b => b.materialization === "parquet")
      .map(b => ({
        name: b.name,
        table: bindingTableName(b.name),
        artifactKey: b.cache?.parquetArtifactKey,
        status: b.cache?.parquetBuildStatus ?? null,
        rowCount: b.cache?.rowCount ?? null,
      }));
    return { tables };
  }

  const dashboard = await Dashboard.findOne({
    _id: new Types.ObjectId(surface.id),
    workspaceId: wsId,
  });
  if (!dashboard) return { error: "Dashboard not found" };
  const tables = (dashboard.dataSources ?? [])
    .filter(ds => ds.cache?.parquetArtifactKey)
    .map(ds => ({
      name: ds.name,
      table: ds.tableRef,
      artifactKey: ds.cache?.parquetArtifactKey,
      status: ds.cache?.parquetBuildStatus ?? null,
      rowCount: ds.cache?.rowCount ?? null,
    }));
  return { tables };
}

/** Stream a Parquet artifact from the store into a local temp file. */
async function fetchArtifactToTemp(
  artifactKey: string,
  base: string,
): Promise<string> {
  const stream = await getArtifactStore().openReadStream(artifactKey);
  if (!stream) throw new Error(`Artifact not available: ${artifactKey}`);
  const tmpPath = path.join(
    os.tmpdir(),
    `mako-duckdb-${base}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.parquet`,
  );
  await pipeline(stream, createWriteStream(tmpPath));
  return tmpPath;
}

interface DuckDBField {
  name: string;
  type?: string;
}

function extractFields(result: {
  columnNames?: () => string[];
  columnTypes?: () => unknown[];
}): DuckDBField[] {
  try {
    const names = result.columnNames?.() ?? [];
    let types: unknown[] = [];
    try {
      types = result.columnTypes?.() ?? [];
    } catch {
      types = [];
    }
    return names.map((name, i) => ({
      name,
      type: types[i] != null ? String(types[i]) : undefined,
    }));
  } catch {
    return [];
  }
}

interface LoadedDuckDB {
  query: (sql: string) => Promise<{
    rows: Record<string, unknown>[];
    fields: DuckDBField[];
  }>;
  loaded: SurfaceTable[];
  skipped: { name: string; reason: string }[];
  cleanup: () => Promise<void>;
}

/**
 * Create an in-memory node DuckDB instance with this surface's ready Parquet
 * tables materialized into it. External file/extension access is disabled
 * before any caller query runs.
 */
async function loadSurfaceDuckDB(
  surface: DataSourceSurface,
  tables: SurfaceTable[],
): Promise<LoadedDuckDB> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const tempFiles: string[] = [];
  const loaded: SurfaceTable[] = [];
  const skipped: { name: string; reason: string }[] = [];

  const cleanup = async (): Promise<void> => {
    try {
      connection.closeSync();
    } catch {
      /* best-effort */
    }
    try {
      instance.closeSync();
    } catch {
      /* best-effort */
    }
    await Promise.all(
      tempFiles.map(f => fsPromises.rm(f, { force: true }).catch(() => undefined)),
    );
  };

  try {
    await connection.run(
      `PRAGMA memory_limit='${DEFAULT_DUCKDB_MEMORY_LIMIT_MB}MB'`,
    );
    await connection.run(
      `PRAGMA temp_directory='${os.tmpdir().replace(/'/g, "''")}'`,
    );

    for (const t of tables) {
      if (!t.artifactKey || t.status !== "ready") {
        skipped.push({
          name: t.name,
          reason:
            t.status === "ready"
              ? "no artifact"
              : `not materialized (status: ${t.status ?? "missing"})`,
        });
        continue;
      }
      try {
        const tmp = await fetchArtifactToTemp(
          t.artifactKey,
          `${surface.kind}-${surface.id}`,
        );
        tempFiles.push(tmp);
        // CREATE TABLE (not VIEW): copies rows into DuckDB so the query never
        // needs file access — which lets us disable external access below.
        await connection.run(
          `CREATE TABLE "${t.table.replace(/"/g, '""')}" AS SELECT * FROM read_parquet('${tmp.replace(/'/g, "''")}')`,
        );
        loaded.push(t);
      } catch (error) {
        skipped.push({
          name: t.name,
          reason: error instanceof Error ? error.message : "load failed",
        });
      }
    }

    // Lock down the host: after this, the agent's query can only touch the
    // tables loaded above. Best-effort — the SQL gate is the primary defense.
    try {
      await connection.run(`SET enable_external_access=false`);
    } catch (error) {
      logger.warn("Could not disable DuckDB external access", { error });
    }

    const query = async (sql: string) => {
      const result = await connection.run(sql);
      const rows = (await result.getRowObjectsJson()) as Record<
        string,
        unknown
      >[];
      return { rows, fields: extractFields(result as never) };
    };

    return { query, loaded, skipped, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * list_data_sources — pure MongoDB read. Lists a surface's data sources with
 * connection, query, materialization mode, build status, and row counts.
 */
export async function listSurfaceDataSources(
  workspaceId: string,
  surface: DataSourceSurface,
): Promise<ServerDataSourceResult> {
  if (!Types.ObjectId.isValid(surface.id)) {
    return fail(`Invalid ${surface.kind} id: ${surface.id}`);
  }
  const wsId = new Types.ObjectId(workspaceId);

  if (surface.kind === "app") {
    const app = await MakoApp.findOne({
      _id: new Types.ObjectId(surface.id),
      workspaceId: wsId,
    });
    if (!app) return fail("App not found");
    return {
      success: true,
      dataSources: (app.dataBindings ?? []).map(b => ({
        name: b.name,
        connectionId: b.connectionId,
        language: b.language,
        materialization: b.materialization,
        code: b.code,
        status: b.cache?.parquetBuildStatus ?? null,
        rowCount: b.cache?.rowCount ?? null,
        table:
          b.materialization === "parquet"
            ? bindingTableName(b.name)
            : undefined,
      })),
    };
  }

  const dashboard = await Dashboard.findOne({
    _id: new Types.ObjectId(surface.id),
    workspaceId: wsId,
  });
  if (!dashboard) return fail("Dashboard not found");
  return {
    success: true,
    dataSources: (dashboard.dataSources ?? []).map(ds => ({
      id: ds.id,
      name: ds.name,
      table: ds.tableRef,
      connectionId: ds.query?.connectionId,
      language: ds.query?.language,
      code: ds.query?.code,
      status: ds.cache?.parquetBuildStatus ?? null,
      rowCount: ds.cache?.rowCount ?? null,
    })),
  };
}

/**
 * query_duckdb — run read-only analytical SQL against a surface's materialized
 * tables in node DuckDB and return the rows.
 */
export async function querySurfaceDuckDB(
  workspaceId: string,
  surface: DataSourceSurface,
  sql: string,
): Promise<ServerDataSourceResult> {
  const gate = checkServerDuckDbSql(sql);
  if (!gate.ok) return fail(gate.error);

  const resolved = await resolveSurfaceTables(workspaceId, surface);
  if ("error" in resolved) return fail(resolved.error);

  let db: LoadedDuckDB | undefined;
  try {
    db = await loadSurfaceDuckDB(surface, resolved.tables);
    if (db.loaded.length === 0) {
      const detail =
        db.skipped.length > 0
          ? ` (${db.skipped.map(s => `${s.name}: ${s.reason}`).join("; ")})`
          : "";
      return fail(
        `No materialized tables available to query${detail}. ${
          surface.kind === "app"
            ? "Call materialize_binding for the app's parquet bindings first."
            : "Materialize the dashboard's data sources first."
        }`,
      );
    }

    // Cap rows read into the API process; +1 detects truncation.
    const capped = `SELECT * FROM (${gate.statement}) AS _mako_q LIMIT ${READ_ROW_CAP + 1}`;
    const { rows, fields } = await db.query(capped);
    const truncated = rows.length > READ_ROW_CAP;
    const effectiveRows = truncated ? rows.slice(0, READ_ROW_CAP) : rows;

    return {
      success: true,
      rows: effectiveRows.slice(0, RESULT_ROW_CAP),
      fields,
      rowCount: effectiveRows.length,
      truncated,
      tables: db.loaded.map(t => t.table),
      ...(db.skipped.length > 0
        ? {
            skippedTables: db.skipped.map(s => `${s.name} (${s.reason})`),
          }
        : {}),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "DuckDB query failed");
  } finally {
    await db?.cleanup();
  }
}

/**
 * inspect_data_source — connection, query, column schema, and a few sample
 * rows. Uses the materialized Parquet artifact when ready, otherwise a live
 * read-only preview against the source connection.
 */
export async function inspectSurfaceDataSource(
  workspaceId: string,
  surface: DataSourceSurface,
  dataSourceRef: string,
): Promise<ServerDataSourceResult> {
  if (!Types.ObjectId.isValid(surface.id)) {
    return fail(`Invalid ${surface.kind} id: ${surface.id}`);
  }
  const wsId = new Types.ObjectId(workspaceId);

  if (surface.kind === "app") {
    const app = await MakoApp.findOne({
      _id: new Types.ObjectId(surface.id),
      workspaceId: wsId,
    });
    if (!app) return fail("App not found");
    const binding = (app.dataBindings ?? []).find(
      b => b.name === dataSourceRef,
    );
    if (!binding) return fail(`No data source named "${dataSourceRef}"`);

    let columns: string[] = [];
    let sampleRows: Record<string, unknown>[] = [];
    let note: string | undefined;

    if (binding.materialization === "parquet") {
      if (binding.cache?.parquetBuildStatus === "ready") {
        const sample = await querySurfaceDuckDB(
          workspaceId,
          surface,
          `SELECT * FROM "${bindingTableName(binding.name)}" LIMIT ${INSPECT_SAMPLE_ROWS}`,
        );
        if (sample.success) {
          sampleRows = (sample.rows as Record<string, unknown>[]) ?? [];
          columns = ((sample.fields as DuckDBField[]) ?? []).map(f => f.name);
        } else {
          note = sample.error as string;
        }
      } else {
        note = "Parquet not built yet — call materialize_binding first.";
      }
    } else {
      const live = await runLivePreview(
        binding.connectionId,
        binding.code,
        binding.databaseId,
        binding.databaseName,
      );
      sampleRows = live.rows;
      columns = live.columns;
      note = live.note;
    }

    return {
      success: true,
      dataSource: {
        name: binding.name,
        connectionId: binding.connectionId,
        language: binding.language,
        materialization: binding.materialization,
        code: binding.code,
        table:
          binding.materialization === "parquet"
            ? bindingTableName(binding.name)
            : undefined,
        status: binding.cache?.parquetBuildStatus ?? null,
        rowCount: binding.cache?.rowCount ?? null,
        columns,
        sampleRows,
      },
      note,
    };
  }

  const dashboard = await Dashboard.findOne({
    _id: new Types.ObjectId(surface.id),
    workspaceId: wsId,
  });
  if (!dashboard) return fail("Dashboard not found");
  const ds =
    (dashboard.dataSources ?? []).find(d => d.id === dataSourceRef) ||
    (dashboard.dataSources ?? []).find(d => d.name === dataSourceRef);
  if (!ds) return fail(`No data source "${dataSourceRef}" on this dashboard`);

  let columns: string[] = [];
  let sampleRows: Record<string, unknown>[] = [];
  let note: string | undefined;

  if (ds.cache?.parquetArtifactKey && ds.cache?.parquetBuildStatus === "ready") {
    const sample = await querySurfaceDuckDB(
      workspaceId,
      surface,
      `SELECT * FROM "${ds.tableRef.replace(/"/g, '""')}" LIMIT ${INSPECT_SAMPLE_ROWS}`,
    );
    if (sample.success) {
      sampleRows = (sample.rows as Record<string, unknown>[]) ?? [];
      columns = ((sample.fields as DuckDBField[]) ?? []).map(f => f.name);
    } else {
      note = sample.error as string;
    }
  } else if (ds.query?.connectionId && typeof ds.query.code === "string") {
    const live = await runLivePreview(
      ds.query.connectionId,
      ds.query.code,
      undefined,
      undefined,
    );
    sampleRows = live.rows;
    columns = live.columns;
    note = live.note;
  } else {
    note = "Data source not materialized yet.";
  }

  return {
    success: true,
    dataSource: {
      id: ds.id,
      name: ds.name,
      table: ds.tableRef,
      connectionId: ds.query?.connectionId,
      language: ds.query?.language,
      code: ds.query?.code,
      status: ds.cache?.parquetBuildStatus ?? null,
      rowCount: ds.cache?.rowCount ?? null,
      columns,
      sampleRows,
    },
    note,
  };
}

/** Run a binding/data-source query live (read-only) and return a small sample. */
async function runLivePreview(
  connectionId: string | Types.ObjectId,
  code: string,
  databaseId: string | undefined,
  databaseName: string | undefined,
): Promise<{ rows: Record<string, unknown>[]; columns: string[]; note?: string }> {
  try {
    const connectionIdStr = String(connectionId);
    if (!Types.ObjectId.isValid(connectionIdStr)) {
      return { rows: [], columns: [], note: "Invalid connection" };
    }
    const connection = await DatabaseConnection.findById(connectionIdStr);
    if (!connection) {
      return { rows: [], columns: [], note: "Connection not found" };
    }
    const result = await databaseConnectionService.executeQuery(
      connection,
      code,
      { databaseId, databaseName },
    );
    if (!result.success) {
      return { rows: [], columns: [], note: result.error };
    }
    const rows = (Array.isArray(result.data) ? result.data : []).slice(
      0,
      INSPECT_SAMPLE_ROWS,
    ) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, columns };
  } catch (error) {
    return {
      rows: [],
      columns: [],
      note: error instanceof Error ? error.message : "Live preview failed",
    };
  }
}
