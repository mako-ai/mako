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
import { useDashboardStore } from "../store/dashboardStore";
import { queryDashboardRuntime } from "../dashboard-runtime/gateway";
import { previewDashboardQuery } from "../dashboard-runtime/commands";

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
  if (surface.kind === "dashboard") {
    return executeDashboardDataTool(toolName, surface.id, input);
  }
  return fail(`Unknown surface kind: ${String(surface.kind)}`);
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
