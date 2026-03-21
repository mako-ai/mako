import type { AgentConfig, AgentContext, AgentMeta } from "../types";
import { createUniversalTools } from "../../agent-lib/tools/universal-tools";
import { createDashboardServerTools } from "../../agent-lib/tools/dashboard-tools-server";
import { clientDashboardTools } from "../../agent-lib/tools/dashboard-tools-client";
import { createSelfDirectiveTools } from "../../agent-lib/tools/self-directive-tool";
import { createConsoleSearchTools } from "../../agent-lib/tools/console-search-tools";
import { createFlowTools } from "../flow";
import { UNIFIED_SYSTEM_PROMPT, buildCurrentScreenContext } from "./prompt";

export const unifiedAgentMeta: AgentMeta = {
  id: "unified",
  name: "Workspace Assistant",
  description:
    "Unified assistant for consoles, dashboards, and database sync flows",
  enabled: true,
};

export function unifiedAgentFactory(context: AgentContext): AgentConfig {
  const { workspaceId, consoles = [], consoleId, userId } = context;

  const universalTools = createUniversalTools(
    workspaceId,
    consoles,
    consoleId,
    userId,
  );
  const dashboardServerTools = createDashboardServerTools(workspaceId);
  const flowTools = createFlowTools(workspaceId);
  const selfDirectiveTools = createSelfDirectiveTools(workspaceId);
  const consoleSearchTools = createConsoleSearchTools(workspaceId);

  const {
    list_connections: _flowListConnections,
    list_databases: _flowListDatabases,
    list_tables: _flowListTables,
    inspect_table: _flowInspectTable,
    ...flowUniqueTools
  } = flowTools;

  return {
    systemPrompt: [
      {
        role: "system" as const,
        content: UNIFIED_SYSTEM_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      {
        role: "system" as const,
        content: buildCurrentScreenContext(context),
      },
    ],
    tools: {
      ...universalTools,
      ...dashboardServerTools,
      ...clientDashboardTools,
      ...flowUniqueTools,
      ...selfDirectiveTools,
      ...consoleSearchTools,
    } as Record<string, unknown>,
  };
}
