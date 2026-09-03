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
import { useAppsStore } from "../store/appsStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useUIStore } from "../store/uiStore";
import { queryDashboardRuntime } from "../dashboard-runtime/gateway";
import { previewDashboardQuery } from "../dashboard-runtime/commands";
import {
  collectStreamBytes,
  createDuckDBInstance,
  loadParquetTable,
  queryDuckDB,
  terminateTrackedDuckDBInstance,
} from "../lib/duckdb";
import { previewParquetArtifact } from "../lib/parquet-preview";

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

interface AppBindingInfo extends Record<string, unknown> {
  name: string;
  connectionId?: string;
  language?: string;
  materialization?: "parquet" | "live";
  code?: string;
  schedule?: string | null;
  lastMaterializedAt?: string | null;
  rowCount?: number | null;
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

function appArtifactUrl(
  workspaceId: string,
  appId: string,
  bindingName: string,
): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/bindings/${encodeURIComponent(bindingName)}/artifact`;
}

async function fetchAppBindings(
  workspaceId: string,
  appId: string,
): Promise<AppBindingInfo[]> {
  return (await useAppsStore
    .getState()
    .fetchAppBindings(workspaceId, appId)) as AppBindingInfo[];
}

async function executeAppDataTool(
  toolName: string,
  appId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = useUIStore.getState().currentWorkspaceId;
  if (!workspaceId) return fail("No active workspace");

  let bindings: AppBindingInfo[];
  try {
    bindings = await fetchAppBindings(workspaceId, appId);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "App not found");
  }

  if (toolName === "list_data_sources") {
    return {
      success: true,
      dataSources: bindings.map(binding => ({
        name: binding.name,
        connectionId: binding.connectionId,
        language: binding.language ?? "sql",
        materialization: binding.materialization ?? "parquet",
        codeLength: binding.code?.length ?? 0,
        schedule: binding.schedule ?? null,
        status: binding.lastMaterializedAt ? "ready" : null,
        rowCount: binding.rowCount ?? null,
        table: binding.name,
      })),
    };
  }

  if (toolName === "inspect_data_source") {
    const name = input.dataSource as string;
    const binding = bindings.find(candidate => candidate.name === name);
    if (!binding) return fail(`No data source named "${name}"`);

    const codeClipped = clipAgentText(
      binding.code ?? "",
      APP_INSPECT_CODE_PREVIEW_CHARS,
    );
    let columns: Array<{ name: string; type: string }> = [];
    let sampleRows: Record<string, unknown>[] = [];
    let note: string | undefined;

    if (binding.materialization === "live") {
      note =
        "Live bindings are queried by the app preview and have no reusable Parquet artifact.";
    } else if (!binding.lastMaterializedAt) {
      note = `Binding "${name}" is not materialized yet — call app_materialize first.`;
    } else {
      try {
        const preview = await previewParquetArtifact(
          appArtifactUrl(workspaceId, appId, name),
          { limit: 5 },
        );
        columns = preview.fields;
        sampleRows = clipSampleRows(preview.rows);
      } catch (error) {
        note =
          error instanceof Error ? error.message : "Artifact preview failed";
      }
    }

    return {
      success: true,
      dataSource: {
        name: binding.name,
        connectionId: binding.connectionId,
        language: binding.language ?? "sql",
        materialization: binding.materialization ?? "parquet",
        codePreview: codeClipped.text,
        codeLength: codeClipped.length,
        codeTruncated: codeClipped.truncated,
        schedule: binding.schedule ?? null,
        status: binding.lastMaterializedAt ? "ready" : null,
        rowCount: binding.rowCount ?? null,
        table: binding.name,
        columns,
        sampleRows,
      },
      note:
        note ||
        (codeClipped.truncated
          ? `Query preview truncated — read bindings/${name}.sql with app_read_file for the full query.`
          : undefined),
    };
  }

  if (toolName === "query_duckdb") {
    const materialized = bindings.filter(
      binding =>
        binding.materialization !== "live" && binding.lastMaterializedAt,
    );
    if (materialized.length === 0) {
      return fail(
        "This app has no materialized Parquet bindings. Call app_materialize first.",
      );
    }

    const db = await createDuckDBInstance();
    try {
      const artifacts = await Promise.all(
        materialized.map(async binding => {
          const response = await fetch(
            appArtifactUrl(workspaceId, appId, binding.name),
          );
          if (!response.ok || !response.body) {
            throw new Error(
              `Failed to fetch materialized binding "${binding.name}"`,
            );
          }
          return {
            binding,
            bytes: await collectStreamBytes(response.body),
          };
        }),
      );
      for (const artifact of artifacts) {
        await loadParquetTable(db, artifact.binding.name, artifact.bytes);
      }
      const result = await queryDuckDB(db, input.sql as string);
      return {
        success: true,
        rows: result.rows.slice(0, 100),
        fields: result.fields,
        rowCount: result.rowCount,
      };
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "DuckDB query failed",
      );
    } finally {
      void terminateTrackedDuckDBInstance(db, "agent-app-data-source").catch(
        () => undefined,
      );
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
