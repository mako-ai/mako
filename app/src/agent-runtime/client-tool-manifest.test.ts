import { describe, expect, it } from "vitest";
import {
  clientChartTools,
  clientConsoleTools,
  clientDashboardTools,
} from "@mako/agent-tools";
import { UNIVERSAL_PROMPT_V2 } from "../../../api/src/agent-lib/prompts/universal";
import { buildCurrentScreenContext } from "../../../api/src/agents/unified/prompt";
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

  // Some tools defined in the shared client maps are ported to server-side
  // execution (#475 — e.g. the chart template reads): they keep a no-execute
  // placeholder in the package that the server `execute` overrides, plus a
  // manifest entry purely for tool-card rendering. The bijection we care about
  // is therefore (a) every package client tool has a manifest entry, and
  // (b) every client-DISPATCHED manifest entry is backed by a package tool
  // (so `onToolCall` never tries to dispatch a tool that doesn't exist).
  it("matches the dashboard client tool schema keys", () => {
    const dashboardToolKeys = Object.keys(clientDashboardTools).sort();
    for (const name of dashboardToolKeys) {
      expect(
        getAgentToolManifestEntry(name),
        `${name} is missing a manifest entry`,
      ).toBeDefined();
    }
    for (const name of manifestKeysFor(
      entry =>
        entry.execution === "client" && entry.clientExecutor === "dashboard",
    )) {
      expect(
        dashboardToolKeys,
        `stale dashboard executor manifest entry: ${name}`,
      ).toContain(name);
    }
  });

  it("matches the chart client tool schema keys", () => {
    // Manifest chart-domain entries are a clean bijection with clientChartTools
    // (both client-executed and #475-ported reads share the chart domain).
    expect(
      manifestKeysFor(toolName => {
        return toolName.domain === "chart";
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
});
