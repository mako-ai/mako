import { UNIVERSAL_PROMPT_V2 } from "../../agent-lib/prompts/universal";
import { DASHBOARD_SYSTEM_PROMPT } from "../dashboard/prompt";
import { FLOW_PROMPT } from "../flow/prompt";
import type { AgentContext } from "../types";

export const UNIFIED_SYSTEM_PROMPT = `You are Mako's unified workspace assistant.

## What is Mako

Mako is a data platform. Its core concepts are:
- **Connections** — registered database connections (PostgreSQL, BigQuery, MongoDB, ClickHouse, MySQL, etc.)
- **Consoles** — query editors tied to a connection. Users write, run, and save queries here. This is the primary workspace artifact.
- **Connectors** — SaaS integrations (Stripe, PostHog, Close CRM, REST, GraphQL) that sync external data into a connection.
- **Flows** — scheduled or webhook-triggered data sync pipelines that use connectors to move data from a source into a database.
- **Dashboards** — interactive visual boards with charts (Vega-Lite), KPI cards, and data tables. Dashboards pull data from connections via data sources (materialized into in-browser DuckDB) and support cross-filtering.

## Modality Triage (read this FIRST)

You must decide which set of tools to use for each request. Follow these rules strictly.

### New conversations (first user message, no prior tool calls in this chat)

Default to **console tools** (create/modify a console, execute queries) unless the user's
message explicitly targets a different modality:
- Use **dashboard tools** ONLY when the user explicitly mentions dashboards, widgets, or
  references something visible on the active dashboard by name or title (e.g., "add a chart
  to this dashboard", "fix the Enquiries widget", "modify this KPI card").
- Use **flow tools** ONLY when the user explicitly mentions flows, syncs, scheduling, or
  connectors.
- For everything else — data questions, analysis, building queries, funnels, reports —
  use **console tools**. This is the default.

The "Open Tabs" section tells you what the user has open. It does NOT mean the user wants
to modify what is on screen. A user viewing a dashboard who asks "build me a funnel" wants
a console query, not widgets added to their unrelated open dashboard.

### Follow-up turns (prior tool calls exist in the conversation)

Stay in the modality you already committed to. If you created a console, keep working in
console. If you started adding dashboard widgets, keep working on that dashboard.

Only switch modalities when the user explicitly asks, e.g.:
- "Now put this on a dashboard" (console -> dashboard)
- "Can you write this as a query instead?" (dashboard -> console)

### Unrelated content rule

Before modifying ANY existing console or dashboard, check whether its current content is
related to what the user is asking about. If the open console or dashboard has unrelated
content (different topic, different data domain), **create a new one** rather than polluting
the existing artifact. This applies equally to consoles and dashboards.

## Tool Availability

All tools are always registered. Console editing and flow form tools operate on the active
UI tab. Dashboard tools require an explicit \`dashboardId\`; use \`list_open_dashboards\`
to get the current IDs and pass that ID on every dashboard tool call. If no dashboard is
open, use \`create_dashboard\` or \`open_dashboard\` first.

When you create or modify source queries, use the source connection type and SQL dialect.
When you create or modify dashboard widgets, the widget \`localSql\` always runs in DuckDB.
See Dashboard Guidance for cross-filter rules on widget SQL.

Prefer validating before mutating whenever validation tools are available.
Prefer explaining failures using the specific runtime error, status, and query context available.

## Self-Directive (persistent memory)

You can learn and remember workspace-specific knowledge that persists across all conversations:
* \`read_self_directive\` — Read your workspace-learned rules and knowledge
* \`update_self_directive\` — Save learned rules, schema quirks, user preferences (persists across conversations)

When you discover important schema quirks, user preferences, or useful rules, save them with
\`update_self_directive\`. Check \`read_self_directive\` before updating to avoid duplicates.
This applies to all modes — console, dashboard, and flow work alike.

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
  const openDashboards = context.openDashboards;
  const dashboard = context.activeDashboardContext;

  if (openDashboards && openDashboards.length > 0) {
    parts.push("### Open Dashboards");
    parts.push(
      "Use `list_open_dashboards` to get the latest list. Pass `dashboardId` to every dashboard tool call.",
    );
    for (const d of openDashboards) {
      parts.push(
        `- **${d.title}** (id: ${d.id})${d.isActive ? " ← active tab" : ""}`,
      );
    }
    parts.push("");
  }

  parts.push("### Active Dashboard Detail");
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

function buildTabSummary(context: AgentContext): string[] {
  const parts: string[] = [];
  const tabs = context.openTabs || [];

  parts.push("### Open Tabs");
  if (tabs.length === 0) {
    parts.push("No tabs are currently open.");
    return parts;
  }

  tabs.forEach((tab, index) => {
    const activeMarker = tab.isActive ? "[ACTIVE] " : "";
    let detail = "";
    if (tab.kind === "console" && (tab.connectionId || tab.databaseName)) {
      const connName =
        context.databases?.find(db => db.id === tab.connectionId)?.name ||
        tab.connectionId;
      detail = ` (${connName}${tab.databaseName ? ` / ${tab.databaseName}` : ""})`;
    } else if (tab.kind === "dashboard" && tab.dashboardId) {
      detail = ` (id: ${tab.dashboardId})`;
    } else if (tab.kind === "flow-editor" && tab.flowId) {
      detail = ` (flow: ${tab.flowId})`;
    }
    const kindLabel =
      tab.kind === "flow-editor"
        ? "Flow"
        : tab.kind.charAt(0).toUpperCase() + tab.kind.slice(1);
    parts.push(
      `${index + 1}. ${activeMarker}${kindLabel} "${tab.title}"${detail}`,
    );
  });

  const activeTab = tabs.find(t => t.isActive);
  if (activeTab) {
    const kindLabel =
      activeTab.kind === "flow-editor"
        ? "Flow"
        : activeTab.kind.charAt(0).toUpperCase() + activeTab.kind.slice(1);
    parts.push("");
    parts.push(
      `The user is currently viewing: ${kindLabel} "${activeTab.title}".`,
    );
  }

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
    const dialect = db.sqlDialect ? `, dialect: ${db.sqlDialect}` : "";
    parts.push(`- ${db.name} (${db.type}${dialect}) - id: ${db.id}`);
  });

  return parts;
}

export function buildCurrentScreenContext(context: AgentContext): string {
  const sections: string[] = [];

  sections.push("## Current Workspace State");
  sections.push("");

  sections.push(...buildTabSummary(context));
  sections.push("");

  sections.push(...buildConsoleContext(context));
  sections.push("");

  if (context.activeDashboardContext || context.openDashboards?.length) {
    sections.push(...buildDashboardContext(context));
    sections.push("");
  }

  if (context.flowFormState && Object.keys(context.flowFormState).length > 0) {
    sections.push(...buildFlowContext(context));
    sections.push("");
  }

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

  if (context.skillsBlock?.trim()) {
    // skillsBlock is pre-rendered with its own header/separator by
    // renderSkillsPromptBlock — don't double-wrap it here.
    sections.push(context.skillsBlock);
  }

  if (context.consoleHints?.trim()) {
    sections.push("");
    sections.push("### Relevant Saved Consoles");
    sections.push(context.consoleHints.trim());
  }

  return sections.join("\n");
}
