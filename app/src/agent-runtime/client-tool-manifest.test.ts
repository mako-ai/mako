import { describe, expect, it } from "vitest";
import {
  clientChartTools,
  clientConsoleTools,
  clientDashboardTools,
} from "@mako/agent-tools";
import { UNIVERSAL_PROMPT_V2 } from "../../../api/src/agent-lib/prompts/universal";
import { buildCurrentScreenContext } from "../../../api/src/agents/unified/prompt";
import { createDbtServerTools } from "../../../api/src/agent-lib/tools/dbt-tools";
import {
  AGENT_TOOL_MANIFEST,
  type AgentToolName,
  type AgentToolManifestEntry,
  getAgentToolManifestEntry,
} from "./client-tool-manifest";

function manifestKeysFor(
  predicate: (entry: AgentToolManifestEntry) => boolean,
): string[] {
  return (
    Object.entries(AGENT_TOOL_MANIFEST) as Array<
      [AgentToolName, AgentToolManifestEntry]
    >
  )
    .filter(([, entry]) => predicate(entry))
    .map(([toolName]) => toolName)
    .sort();
}

describe("client tool manifest contracts", () => {
  it("matches the console client tool schema keys", () => {
    expect(
      manifestKeysFor(toolName => {
        return toolName.execution === "client" && toolName.domain === "console";
      }),
    ).toEqual(Object.keys(clientConsoleTools).sort());
  });

  it("matches the dashboard client executor schema keys", () => {
    expect(
      manifestKeysFor(toolName => {
        return (
          toolName.execution === "client" &&
          toolName.clientExecutor === "dashboard"
        );
      }),
    ).toEqual(Object.keys(clientDashboardTools).sort());
  });

  it("matches the chart client tool schema keys", () => {
    expect(
      manifestKeysFor(toolName => {
        return toolName.execution === "client" && toolName.domain === "chart";
      }),
    ).toEqual(Object.keys(clientChartTools).sort());
  });

  it("keeps the console prompt on engine-specific execute tools", () => {
    expect(UNIVERSAL_PROMPT_V2).toContain("sql_execute_query");
    expect(UNIVERSAL_PROMPT_V2).toContain("mongo_execute_query");
    expect(UNIVERSAL_PROMPT_V2).not.toContain("`execute_query`");
  });

  it("renders open dashboards from the typed context contract", () => {
    const context = buildCurrentScreenContext({
      workspaceId: "ws_1",
      activeView: "dashboard",
      openDashboards: [
        { id: "dash_1", title: "Revenue Dashboard", isActive: true },
      ],
      activeDashboardContext: {
        dashboardId: "dash_1",
        title: "Revenue Dashboard",
        dataSources: [],
        widgets: [],
        crossFilterEnabled: true,
      },
    } as any);

    expect(context).toContain("### Open Dashboards");
    expect(context).toContain("Revenue Dashboard");
    expect(context).toContain("dash_1");
  });

  // Server-side dbt tools have no compile-time drift guard (unlike client
  // tools), so a new dbt tool can ship without a manifest entry and render the
  // ugly humanizeToolName fallback ("Dbt Get Run"). This is exactly what leaked
  // into an agent transcript. Assert every dbt server tool has an entry.
  it("covers every dbt server tool with a manifest entry", () => {
    const dbtServerToolNames = Object.keys(
      createDbtServerTools("000000000000000000000000"),
    ).sort();

    const missing = dbtServerToolNames.filter(
      name => getAgentToolManifestEntry(name) === undefined,
    );
    expect(missing).toEqual([]);

    for (const name of dbtServerToolNames) {
      expect(getAgentToolManifestEntry(name)?.domain).toBe("dbt");
    }
  });

  it("gives dbt status/preview tools human labels (no humanize fallback)", () => {
    expect(getAgentToolManifestEntry("dbt_get_run")?.getLabel()).toBe(
      "Checking dbt run status",
    );
    expect(
      getAgentToolManifestEntry("dbt_show")?.getLabel({ model: "stg_orders" }),
    ).toBe("Previewing stg_orders");
    expect(
      getAgentToolManifestEntry("dbt_create_project")?.getLabel({
        name: "analytics",
      }),
    ).toBe('Creating dbt project "analytics"');
  });

  it("registers web tools for chat tool cards", () => {
    expect(getAgentToolManifestEntry("fetch_url")).toMatchObject({
      execution: "server",
      domain: "search",
      icon: "external-link",
    });
    expect(getAgentToolManifestEntry("web_search")).toMatchObject({
      execution: "server",
      domain: "search",
      icon: "search",
    });
    expect(
      getAgentToolManifestEntry("fetch_url")?.getLabel({
        url: "https://example.com",
      }),
    ).toBe("Fetching https://example.com");
    expect(
      getAgentToolManifestEntry("web_search")?.getLabel({
        query: "PostgreSQL 17",
      }),
    ).toBe('Searching web: "PostgreSQL 17"');
  });

  it("aliases Claude Code ACP ToolSearch onto search_tools card UI", () => {
    expect(getAgentToolManifestEntry("ToolSearch")).toMatchObject({
      domain: "search",
      icon: "search",
    });
    expect(getAgentToolManifestEntry("ToolSearch")?.getLabel()).toBe(
      "Searching tools",
    );
    expect(
      getAgentToolManifestEntry("ToolSearch")?.getLabel({ query: "sql" }),
    ).toBe("Searching tools: sql");
    expect(getAgentToolManifestEntry("tool_search")?.icon).toBe("search");
  });
});
