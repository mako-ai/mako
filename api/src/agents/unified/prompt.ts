import { UNIVERSAL_PROMPT_V2 } from "../../agent-lib/prompts/universal";
import { DASHBOARD_SYSTEM_PROMPT } from "../dashboard/prompt";
import { FLOW_PROMPT } from "../flow/prompt";
import type { AgentContext } from "../types";

export const UNIFIED_SYSTEM_PROMPT = `You are Mako's unified workspace assistant.

You always have access to all supported tools for:
- console editing and charting
- source database discovery and query execution
- dashboard data sources, widgets, filters, and relationships
- database sync flow configuration

Nothing about your capabilities depends on what the user is currently looking at.
The current screen context only tells you what the user likely wants right now.

When you create or modify source queries, use the source connection type and SQL dialect.
When you create or modify dashboard widgets, the widget localSql always runs in DuckDB.
Mosaic is the canonical widget execution engine. Cross-filtering wraps widget localSql with
selection predicates; it does not replace widget localSql as the query abstraction.
For cross-filtered widgets, keep canonical dimension field names unchanged in widget SQL.
Do not rename dimension fields or create calculated dimension fields in widget SQL if those widgets
need cross-filtering. Prefer moving renames and derived dimensions to the data source extraction
layer, and use Vega titles/labels for presentation. Metric aliases such as COUNT(*) AS enquiry_count
are acceptable.

Prefer validating before mutating whenever validation tools are available.
Prefer explaining failures using the specific runtime error, status, and query context available.

---

## Console Guidance

${UNIVERSAL_PROMPT_V2}

---

## Dashboard Guidance

${DASHBOARD_SYSTEM_PROMPT}

---

## Flow Guidance

${FLOW_PROMPT}`;

function buildConsoleContext(context: AgentContext): string[] {
  const parts: string[] = [];
  const consoles = context.consoles || [];

  parts.push("### Open Consoles");
  if (consoles.length === 0) {
    parts.push("No console tabs are currently open.");
  } else {
    consoles.forEach((consoleTab, index) => {
      const isActive = consoleTab.id === context.consoleId;
      const header = `${index + 1}. ${isActive ? "[ACTIVE] " : ""}"${consoleTab.title}" (id: ${consoleTab.id})`;
      parts.push(header);
      parts.push(
        `   - Connection: ${
          consoleTab.connectionType || "unknown"
        }${consoleTab.connectionId ? ` / ${consoleTab.connectionId}` : ""}${
          consoleTab.databaseName ? ` / db: ${consoleTab.databaseName}` : ""
        }`,
      );
      const content = (consoleTab.content || "").trim();
      if (!content) {
        parts.push("   - Content: empty");
      } else {
        const lines = content.split("\n");
        const display = lines.slice(0, 30).join("\n");
        const truncated =
          lines.length > 30
            ? `\n     ... (${lines.length - 30} more lines)`
            : "";
        parts.push("   - Content:");
        parts.push(
          display
            .split("\n")
            .map(line => `     ${line}`)
            .join("\n") + truncated,
        );
      }
    });
  }

  if (context.activeConsoleResults) {
    parts.push("");
    parts.push("### Active Console Results");
    parts.push(`- View mode: ${context.activeConsoleResults.viewMode}`);
    if (!context.activeConsoleResults.hasResults) {
      parts.push("- No query results yet.");
    } else {
      parts.push(`- Row count: ${context.activeConsoleResults.rowCount}`);
      if (context.activeConsoleResults.columns.length > 0) {
        parts.push(
          `- Columns: ${context.activeConsoleResults.columns.join(", ")}`,
        );
      }
      if (context.activeConsoleResults.sampleRows.length > 0) {
        parts.push(
          `- Sample rows: ${context.activeConsoleResults.sampleRows
            .slice(0, 2)
            .map(row => JSON.stringify(row))
            .join(" | ")}`,
        );
      }
      if (context.activeConsoleResults.chartSpec) {
        parts.push(
          `- Current chart spec: ${JSON.stringify(context.activeConsoleResults.chartSpec)}`,
        );
      }
    }
  }

  return parts;
}

function buildDashboardContext(context: AgentContext): string[] {
  const parts: string[] = [];
  const dashboard = context.activeDashboardContext;

  parts.push("### Active Dashboard");
  if (!dashboard) {
    parts.push("No active dashboard context is available.");
    return parts;
  }

  parts.push(`- Title: ${dashboard.title}`);
  parts.push(`- Dashboard ID: ${dashboard.dashboardId}`);
  parts.push(
    `- Cross-filtering: ${dashboard.crossFilterEnabled ? "enabled" : "disabled"}`,
  );

  if (dashboard.dataSources.length > 0) {
    parts.push("- Data sources:");
    dashboard.dataSources.forEach(ds => {
      parts.push(
        `  - ${ds.name} (id: ${ds.id}${ds.tableRef ? `, tableRef: ${ds.tableRef}` : ""})`,
      );
      if (ds.connectionType || ds.sqlDialect) {
        parts.push(
          `    - Source: ${ds.connectionType || "unknown"}${ds.sqlDialect ? ` / ${ds.sqlDialect}` : ""}`,
        );
      }
      if (ds.queryLanguage || ds.queryCode) {
        parts.push(
          `    - Query: ${ds.queryLanguage || "unknown"}${ds.queryCode ? ` -> ${ds.queryCode}` : ""}`,
        );
      }
      if (ds.status) {
        parts.push(
          `    - Status: ${ds.status}${
            ds.rowCount != null ? ` (${ds.rowCount.toLocaleString()} rows)` : ""
          }`,
        );
      }
      if (ds.error) {
        parts.push(`    - Last error: ${ds.error}`);
      }
      if (ds.columns.length > 0) {
        parts.push(
          `    - Columns: ${ds.columns
            .map(col => `${col.name}:${col.type}`)
            .join(", ")}`,
        );
      }
      if (ds.sampleRows && ds.sampleRows.length > 0) {
        parts.push(
          `    - Sample rows: ${ds.sampleRows
            .slice(0, 2)
            .map(row => JSON.stringify(row))
            .join(" | ")}`,
        );
      }
    });
  } else {
    parts.push("- Data sources: none");
  }

  if (dashboard.widgets.length > 0) {
    parts.push("- Widgets:");
    dashboard.widgets.forEach(widget => {
      parts.push(
        `  - ${widget.title || "Untitled"} (id: ${widget.id}, type: ${widget.type}, source: ${widget.dataSourceId})`,
      );
      if (widget.localSql) {
        parts.push(`    - localSql: ${widget.localSql}`);
      }
      if (widget.queryEngine) {
        parts.push(`    - query engine: ${widget.queryEngine}`);
      }
      if (widget.queryStatus || widget.renderStatus) {
        parts.push(
          `    - runtime: query=${widget.queryStatus || "unknown"} render=${widget.renderStatus || "unknown"}`,
        );
      }
      if (widget.queryError) {
        parts.push(
          `    - query error${widget.queryErrorKind ? ` (${widget.queryErrorKind})` : ""}: ${widget.queryError}`,
        );
      }
      if (widget.renderError) {
        parts.push(
          `    - render error${widget.renderErrorKind ? ` (${widget.renderErrorKind})` : ""}: ${widget.renderError}`,
        );
      }
      if (widget.queryFields && widget.queryFields.length > 0) {
        parts.push(`    - fields: ${widget.queryFields.join(", ")}`);
      }
      if (widget.queryRowCount != null) {
        parts.push(`    - row count: ${widget.queryRowCount}`);
      }
    });
  } else {
    parts.push("- Widgets: none");
  }

  return parts;
}

function buildFlowContext(context: AgentContext): string[] {
  const parts: string[] = [];

  parts.push("### Active Flow");
  if (
    !context.flowFormState ||
    Object.keys(context.flowFormState).length === 0
  ) {
    parts.push("No active flow form state is available.");
    return parts;
  }

  parts.push(JSON.stringify(context.flowFormState, null, 2));
  return parts;
}

function buildConnectionsContext(context: AgentContext): string[] {
  const parts: string[] = [];

  parts.push("### Available Connections");
  if (!context.databases || context.databases.length === 0) {
    parts.push("No workspace connections configured.");
    return parts;
  }

  context.databases.forEach(db => {
    parts.push(`- ${db.name} (${db.type}) - id: ${db.id}`);
  });

  return parts;
}

export function buildCurrentScreenContext(context: AgentContext): string {
  const sections: string[] = [];

  sections.push("## Current Screen");
  sections.push(`You are looking at: ${context.activeView || "empty"}`);
  sections.push("");

  sections.push(...buildConsoleContext(context));
  sections.push("");
  sections.push(...buildDashboardContext(context));
  sections.push("");
  sections.push(...buildFlowContext(context));
  sections.push("");
  sections.push(...buildConnectionsContext(context));

  if (context.workspaceCustomPrompt?.trim()) {
    sections.push("");
    sections.push("### Workspace Context");
    sections.push(context.workspaceCustomPrompt.trim());
  }

  if (context.selfDirective?.trim()) {
    sections.push("");
    sections.push("### Self-Directive");
    sections.push(context.selfDirective.trim());
  }

  if (context.consoleHints?.trim()) {
    sections.push("");
    sections.push("### Relevant Saved Consoles");
    sections.push(context.consoleHints.trim());
  }

  return sections.join("\n");
}
