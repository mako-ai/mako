/**
 * Client executor for the shared, surface-agnostic data source tools
 * (`list_data_sources`, `inspect_data_source`, `query_duckdb`).
 *
 * Dispatches on `input.surface.kind` to the app runtime or the dashboard
 * runtime. Both surfaces expose the same concept — named (connection, query)
 * data sources materialized into in-browser DuckDB tables — so the agent uses
 * one set of primitives regardless of where the data lives.
 */

import {
  APP_INSPECT_CODE_PREVIEW_CHARS,
  APP_SAMPLE_CELL_MAX_CHARS,
  clipAgentText,
} from "@mako/agent-tools";
import { useAppStore } from "../store/appStore";
import { useDashboardStore } from "../store/dashboardStore";
import {
  ensureBindingLoaded,
  queryAppDuckDB,
  bindingTableName,
} from "../app-runtime/duckdb";
import { ensureBindingLoadedForPreview } from "../app-runtime/binding-preview";
import { queryDashboardRuntime } from "../dashboard-runtime/gateway";
import { previewDashboardQuery } from "../dashboard-runtime/commands";
import { getCurrentWorkspaceId } from "../app-runtime/shell";

function clipSampleRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const budget = { remaining: 20_000 };

  const clipValue = (value: unknown, depth: number): unknown => {
    if (budget.remaining <= 0) return "[output budget exhausted]";
    if (typeof value === "string") {
      const max = Math.min(APP_SAMPLE_CELL_MAX_CHARS, budget.remaining);
      const clipped = clipAgentText(value, max).text;
      budget.remaining -= clipped.length;
      return clipped;
    }
    if (typeof value === "bigint") {
      const serialized = value.toString();
      budget.remaining -= serialized.length;
      return serialized;
    }
    if (
      value === undefined ||
      typeof value === "symbol" ||
      typeof value === "function"
    ) {
      const serialized = value === undefined ? "null" : String(value);
      budget.remaining -= serialized.length;
      return serialized;
    }
    if (value == null || typeof value !== "object") {
      const serialized = String(value);
      budget.remaining -= serialized.length;
      return value;
    }
    if (depth >= 2) {
      budget.remaining -= 16;
      return "[nested omitted]";
    }
    if (Array.isArray(value)) {
      return value.slice(0, 10).map(item => clipValue(item, depth + 1));
    }
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 15)) {
      if (budget.remaining <= 0) break;
      const clippedKey = clipAgentText(key, 200).text;
      budget.remaining -= clippedKey.length;
      next[clippedKey] = clipValue(nested, depth + 1);
    }
    return next;
  };

  const clippedRows: Record<string, unknown>[] = [];
  for (const row of rows.slice(0, 5)) {
    if (budget.remaining <= 0) break;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row).slice(0, 50)) {
      if (budget.remaining <= 0) break;
      const clippedKey = clipAgentText(key, 200).text;
      budget.remaining -= clippedKey.length;
      next[clippedKey] = clipValue(value, 0);
    }
    clippedRows.push(next);
  }
  return clippedRows;
}

type ToolResult = Record<string, unknown>;

interface Surface {
  kind: "app" | "dashboard";
  id: string;
}

function fail(error: string): ToolResult {
  return { success: false, error };
}

export async function executeDataSourceTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const surface = input.surface as Surface | undefined;
  if (!surface?.kind || !surface.id) {
    return fail("surface { kind, id } is required");
  }
  if (surface.kind === "app") {
    return executeAppDataTool(toolName, surface.id, input);
  }
  if (surface.kind === "dashboard") {
    return executeDashboardDataTool(toolName, surface.id, input);
  }
  return fail(`Unknown surface kind: ${String(surface.kind)}`);
}

// ---- App surface ---------------------------------------------------------

type AppEntityLike = ReturnType<
  typeof useAppStore.getState
>["openApps"][string];

/**
 * Server-side materialization completes with only a workspace poke as the
 * fast-path delivery; a missed poke (dead SSE) leaves this window's copy of
 * the binding cache stale — historically surfacing as "table does not exist"
 * / "Parquet not built yet" loops even though the artifact was long ready.
 * When a relevant parquet binding's local cache isn't "ready", pull the
 * authoritative app once before trusting the stale copy.
 */
async function refreshAppIfParquetCacheStale(
  workspaceId: string | null | undefined,
  appId: string,
  appEntity: AppEntityLike,
  bindingName?: string,
): Promise<AppEntityLike> {
  if (!workspaceId) return appEntity;
  const stale = appEntity.dataBindings.some(
    b =>
      b.materialization === "parquet" &&
      (bindingName === undefined || b.name === bindingName) &&
      b.cache?.parquetBuildStatus !== "ready",
  );
  if (!stale) return appEntity;
  const fresh = await useAppStore.getState().fetchApp(workspaceId, appId);
  return fresh ?? appEntity;
}

async function executeAppDataTool(
  toolName: string,
  appId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const store = useAppStore.getState();
  const workspaceId = getCurrentWorkspaceId();

  let appEntity = store.openApps[appId] as
    | (typeof store.openApps)[string]
    | undefined;
  if (!appEntity && workspaceId) {
    appEntity = (await store.fetchApp(workspaceId, appId)) ?? undefined;
  }
  if (!appEntity) return fail("App not found (is it open?)");

  if (toolName === "list_data_sources") {
    // Omit full SQL here — use inspect_data_source / app_get_data_binding.
    return {
      success: true,
      dataSources: appEntity.dataBindings.map(b => ({
        name: b.name,
        connectionId: b.connectionId,
        language: b.language,
        materialization: b.materialization,
        codeLength: (b.code ?? "").length,
        status: b.cache?.parquetBuildStatus ?? null,
        rowCount: b.cache?.rowCount ?? null,
        table:
          b.materialization === "parquet"
            ? bindingTableName(b.name)
            : undefined,
      })),
    };
  }

  if (toolName === "inspect_data_source") {
    const name = input.dataSource as string;
    appEntity = await refreshAppIfParquetCacheStale(
      workspaceId,
      appId,
      appEntity,
      name,
    );
    const binding = appEntity.dataBindings.find(b => b.name === name);
    if (!binding) return fail(`No data source named "${name}"`);

    let columns: string[] = [];
    let sampleRows: Record<string, unknown>[] = [];
    let note: string | undefined;
    try {
      if (binding.materialization === "parquet") {
        // Preview-env aware: while a dbt preview override is active the table
        // holds a live run against the override schema, not the prod artifact.
        const loaded = workspaceId
          ? await ensureBindingLoadedForPreview(workspaceId, appId, binding)
          : await ensureBindingLoaded(appId, binding);
        if (loaded) {
          const result = await queryAppDuckDB(
            appId,
            `SELECT * FROM "${bindingTableName(binding.name)}" LIMIT 5`,
          );
          columns = result.fields.map(f => f.name);
          sampleRows = result.rows;
        } else {
          note = "Parquet not built yet — call materialize_binding first.";
        }
      } else if (workspaceId) {
        const result = await store.runBinding(workspaceId, appId, binding.name);
        const rows = (result.rows as Record<string, unknown>[]) || [];
        sampleRows = rows.slice(0, 5);
        columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        if (!result.success) note = result.error;
      }
    } catch (e) {
      note = e instanceof Error ? e.message : "Inspect failed";
    }

    const codeClipped = clipAgentText(
      binding.code ?? "",
      APP_INSPECT_CODE_PREVIEW_CHARS,
    );
    return {
      success: true,
      dataSource: {
        name: binding.name,
        connectionId: binding.connectionId,
        language: binding.language,
        materialization: binding.materialization,
        codePreview: codeClipped.text,
        codeLength: codeClipped.length,
        codeTruncated: codeClipped.truncated,
        table:
          binding.materialization === "parquet"
            ? bindingTableName(binding.name)
            : undefined,
        status: binding.cache?.parquetBuildStatus ?? null,
        rowCount: binding.cache?.rowCount ?? null,
        columns,
        sampleRows: clipSampleRows(sampleRows),
      },
      note:
        note ||
        (codeClipped.truncated
          ? "Query preview truncated — use app_get_data_binding for more code."
          : undefined),
    };
  }

  if (toolName === "query_duckdb") {
    try {
      appEntity = await refreshAppIfParquetCacheStale(
        workspaceId,
        appId,
        appEntity,
      );
      // Preview-env aware, matching what the app preview itself reads.
      await Promise.all(
        appEntity.dataBindings
          .filter(b => b.materialization === "parquet")
          .map(b =>
            (workspaceId
              ? ensureBindingLoadedForPreview(workspaceId, appId, b)
              : ensureBindingLoaded(appId, b)
            ).catch(() => false),
          ),
      );
      const result = await queryAppDuckDB(appId, input.sql as string);
      return {
        success: true,
        rows: result.rows.slice(0, 100),
        fields: result.fields,
        rowCount: result.rowCount,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : "DuckDB query failed");
    }
  }

  return fail(`Unknown data source tool: ${toolName}`);
}

// ---- Dashboard surface ---------------------------------------------------

async function executeDashboardDataTool(
  toolName: string,
  dashboardId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const dashboard = useDashboardStore.getState().openDashboards[dashboardId];
  if (!dashboard) {
    return fail("Dashboard not found (open it first with open_dashboard)");
  }

  if (toolName === "list_data_sources") {
    // Omit full SQL — inspect_data_source returns code for one source.
    return {
      success: true,
      dataSources: (dashboard.dataSources || []).map(ds => ({
        id: ds.id,
        name: ds.name,
        table: ds.tableRef,
        connectionId: ds.query?.connectionId,
        language: ds.query?.language,
        codeLength: (ds.query?.code ?? "").length,
        status: ds.cache?.parquetBuildStatus ?? null,
        rowCount: ds.cache?.rowCount ?? null,
      })),
    };
  }

  if (toolName === "inspect_data_source") {
    const ref = input.dataSource as string;
    const ds =
      dashboard.dataSources.find(d => d.id === ref) ||
      dashboard.dataSources.find(d => d.name === ref);
    if (!ds) return fail(`No data source "${ref}" on this dashboard`);
    try {
      const result = await previewDashboardQuery({
        dashboardId,
        dataSourceId: ds.id,
      });
      const codeClipped = clipAgentText(
        ds.query?.code ?? "",
        APP_INSPECT_CODE_PREVIEW_CHARS,
      );
      return {
        success: true,
        dataSource: {
          id: ds.id,
          name: ds.name,
          table: ds.tableRef,
          connectionId: ds.query?.connectionId,
          language: ds.query?.language,
          codePreview: codeClipped.text,
          codeLength: codeClipped.length,
          codeTruncated: codeClipped.truncated,
          columns: result.fields,
          sampleRows: clipSampleRows(
            result.rows.slice(0, 5) as Record<string, unknown>[],
          ),
          rowCount: result.rowCount,
        },
        ...(codeClipped.truncated
          ? {
              note: "Query preview truncated — fetch the source query only when editing it.",
            }
          : {}),
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Inspect failed");
    }
  }

  if (toolName === "query_duckdb") {
    try {
      const result = await queryDashboardRuntime({
        dashboard,
        sql: input.sql as string,
      });
      return {
        success: true,
        rows: result.rows.slice(0, 100),
        fields: result.fields,
        rowCount: result.rowCount,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : "DuckDB query failed");
    }
  }

  return fail(`Unknown data source tool: ${toolName}`);
}
