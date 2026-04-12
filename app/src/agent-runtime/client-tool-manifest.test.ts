import { describe, expect, it } from "vitest";
import { UNIVERSAL_PROMPT_V2 } from "../../../api/src/agent-lib/prompts/universal";
import { clientChartTools } from "../../../api/src/agent-lib/tools/chart-tools-client";
import { clientConsoleTools } from "../../../api/src/agent-lib/tools/console-tools-client";
import { clientDashboardTools } from "../../../api/src/agent-lib/tools/dashboard-tools-client";
import { buildCurrentScreenContext } from "../../../api/src/agents/unified/prompt";
import {
  AGENT_TOOL_MANIFEST,
  type AgentToolName,
  type AgentToolManifestEntry,
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
});
