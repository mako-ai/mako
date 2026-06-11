/**
 * Dashboard Agent System Prompt
 *
 * Specialized assistant for creating and managing interactive data dashboards
 * from saved queries (consoles). Dashboards use in-browser DuckDB for local
 * SQL queries and Vega-Lite for chart rendering.
 */

import { getSystemSkillFullText } from "../../agent-lib/skills/system-skills";
import type { AgentContext } from "../types";

function requireSystemSkillFullText(name: string): string {
  const body = getSystemSkillFullText(name);
  if (!body) {
    throw new Error(`Required system skill "${name}" was not discovered`);
  }
  return body;
}

export const DASHBOARD_SYSTEM_PROMPT = requireSystemSkillFullText("dashboards");

/**
 * Build runtime context string describing the current dashboard state.
 * Injected as a second system message so the LLM knows what it's working with.
 *
 * Renders a compact markdown overview; full details available via get_dashboard_state.
 */
export function buildDashboardRuntimeContext(context: AgentContext): string {
  const openDashboards = context.openDashboards;
  const dc = context.activeDashboardContext as Record<string, any> | undefined;

  if (!openDashboards?.length && !dc) return "";

  const parts: string[] = [];

  if (openDashboards && openDashboards.length > 0) {
    parts.push("## Open Dashboards");
    parts.push(
      "Use `list_open_dashboards` at runtime for the latest list. Pass the `dashboardId` to every tool call.",
    );
    for (const d of openDashboards) {
      parts.push(
        `- **${d.title}** (id: ${d.id})${d.isActive ? " ← active tab" : ""}`,
      );
    }
    parts.push("");
  }

  if (!dc) return parts.join("\n");

  parts.push("## Active Dashboard Detail");
  parts.push(`Title: ${dc.title}`);
  parts.push(`ID: ${dc.dashboardId}`);
  const cf = dc.crossFilter;
  if (cf) {
    parts.push(
      `Cross-filtering: ${cf.enabled ? "enabled" : "disabled"}${cf.resolution ? ` (${cf.resolution})` : ""}`,
    );
  }
  const grid = dc.layout;
  if (grid) {
    parts.push(
      `Grid: ${grid.columns ?? 12} columns, ${grid.rowHeight ?? 80}px row height`,
    );
  }
  parts.push("");

  // --- Data Sources ---
  const dataSources = dc.dataSources as any[] | undefined;
  if (dataSources && dataSources.length > 0) {
    parts.push("### Data Sources");
    for (const ds of dataSources) {
      const statusParts: string[] = [];
      if (ds.status) statusParts.push(ds.status);
      if (ds.activeSource) statusParts.push(`source=${ds.activeSource}`);
      if (ds.loadPath) statusParts.push(`path=${ds.loadPath}`);
      if (ds.rowsLoaded) {
        statusParts.push(`${ds.rowsLoaded.toLocaleString()} rows`);
      }
      const statusStr =
        statusParts.length > 0 ? `, ${statusParts.join(", ")}` : "";
      parts.push(
        `- **${ds.name}** (id: ${ds.id}, tableRef: \`${ds.tableRef}\`${statusStr})`,
      );
      if (ds.error) {
        parts.push(`  - error: ${ds.error}`);
      }
      if (ds.query?.code) {
        const code =
          ds.query.code.length > 200
            ? ds.query.code.slice(0, 200) + "…"
            : ds.query.code;
        parts.push(`  - query: \`${code.replace(/\n/g, " ")}\``);
      }
      if (ds.columns && ds.columns.length > 0) {
        for (const col of ds.columns) {
          let colDesc = `  - \`${col.name}\` (${col.type})`;
          if (col.cardinality != null) {
            colDesc += ` — ${col.cardinality} distinct`;
          }
          if (col.sampleValues && col.sampleValues.length > 0) {
            colDesc += ` — e.g. ${col.sampleValues
              .slice(0, 3)
              .map((v: unknown) => JSON.stringify(v))
              .join(", ")}`;
          }
          parts.push(colDesc);
        }
      }
    }
    parts.push("");
  }

  // --- Widgets ---
  const widgets = dc.widgets as any[] | undefined;
  if (widgets && widgets.length > 0) {
    parts.push("### Widgets");
    for (const w of widgets) {
      const lg = w.layouts?.lg;
      const layoutStr = lg
        ? ` layout:{x:${lg.x},y:${lg.y},w:${lg.w},h:${lg.h}}`
        : "";
      parts.push(
        `- **${w.title || "Untitled"}** (id: ${w.id}, type: ${w.type}, source: ${w.dataSourceId})${layoutStr}`,
      );
      if (w.localSql) {
        const sql =
          w.localSql.length > 200 ? w.localSql.slice(0, 200) + "…" : w.localSql;
        parts.push(`  - sql: \`${sql.replace(/\n/g, " ")}\``);
      }
      if (w.vegaLiteSpec) {
        const mark =
          typeof w.vegaLiteSpec.mark === "string"
            ? w.vegaLiteSpec.mark
            : w.vegaLiteSpec.mark?.type;
        if (mark) parts.push(`  - mark: ${mark}`);
      }
      if (w.kpiConfig) {
        const kpi = w.kpiConfig;
        parts.push(
          `  - kpi: valueField=${kpi.valueField}${kpi.format ? `, format=${kpi.format}` : ""}`,
        );
      }
      if (w.crossFilter && !w.crossFilter.enabled) {
        parts.push(`  - cross-filter: disabled`);
      }
      if (w.renderError) {
        parts.push(`  - ⚠ render error: ${w.renderError}`);
      }
      if (w.queryError) {
        parts.push(`  - ⚠ query error: ${w.queryError}`);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}
