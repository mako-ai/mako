/**
 * Client executor for the shared, surface-agnostic data source tools
 * (`list_data_sources`, `inspect_data_source`, `query_duckdb`).
 *
 * Dispatches on `input.surface.kind` to the app runtime or the dashboard
 * runtime. Both surfaces expose the same concept — named (connection, query)
 * data sources materialized into in-browser DuckDB tables — so the agent uses
 * one set of primitives regardless of where the data lives.
 */

import { useAppStore } from "../store/appStore";
import { useDashboardStore } from "../store/dashboardStore";
import {
  ensureBindingLoaded,
  queryAppDuckDB,
  bindingTableName,
} from "../app-runtime/duckdb";
import { queryDashboardRuntime } from "../dashboard-runtime/gateway";
import { previewDashboardQuery } from "../dashboard-runtime/commands";
import { getCurrentWorkspaceId } from "../app-runtime/shell";

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
    return {
      success: true,
      dataSources: appEntity.dataBindings.map(b => ({
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

  if (toolName === "inspect_data_source") {
    const name = input.dataSource as string;
    const binding = appEntity.dataBindings.find(b => b.name === name);
    if (!binding) return fail(`No data source named "${name}"`);

    let columns: string[] = [];
    let sampleRows: Record<string, unknown>[] = [];
    let note: string | undefined;
    try {
      if (binding.materialization === "parquet") {
        const loaded = await ensureBindingLoaded(appId, binding);
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

  if (toolName === "query_duckdb") {
    try {
      await Promise.all(
        appEntity.dataBindings
          .filter(b => b.materialization === "parquet")
          .map(b => ensureBindingLoaded(appId, b).catch(() => false)),
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
    return {
      success: true,
      dataSources: (dashboard.dataSources || []).map(ds => ({
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
      return {
        success: true,
        dataSource: {
          id: ds.id,
          name: ds.name,
          table: ds.tableRef,
          connectionId: ds.query?.connectionId,
          language: ds.query?.language,
          code: ds.query?.code,
          columns: result.fields,
          sampleRows: result.rows.slice(0, 5),
          rowCount: result.rowCount,
        },
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
