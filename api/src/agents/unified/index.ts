import type { AgentConfig, AgentContext, AgentMeta } from "../types";
import { createUniversalTools } from "../../agent-lib/tools/universal-tools";
import {
  clientDashboardTools,
  clientAppTools,
  clientDbtTools,
  clientDataSourceTools,
} from "@mako/agent-tools";
import { createDbtServerTools } from "../../agent-lib/tools/dbt-tools";
import { createSelfDirectiveTools } from "../../agent-lib/tools/self-directive-tool";
import { createSkillTools } from "../../agent-lib/tools/skill-tools";
import { createConsoleSearchTools } from "../../agent-lib/tools/console-search-tools";
import { createDashboardSearchTools } from "../../agent-lib/tools/dashboard-search-tools";
import { createFlowTools } from "../flow";
import { createVersionHistoryTools } from "../../agent-lib/tools/version-history-tools";
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
    context.toolExecutionContext,
    { chatId: context.chatId },
  );
  const flowTools = createFlowTools(workspaceId, context.toolExecutionContext);
  const selfDirectiveTools = createSelfDirectiveTools(workspaceId);
  const skillTools = createSkillTools(workspaceId, userId);
  const consoleSearchTools = createConsoleSearchTools(
    workspaceId,
    context.toolExecutionContext,
  );
  const dashboardSearchTools = createDashboardSearchTools(
    workspaceId,
    context.toolExecutionContext,
  );
  const versionHistoryTools = createVersionHistoryTools(workspaceId);
  const dbtServerTools = createDbtServerTools(workspaceId, userId);

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
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
      {
        role: "system" as const,
        content: buildCurrentScreenContext(context),
      },
    ],
    tools: {
      ...universalTools,
      ...clientDashboardTools,
      ...clientAppTools,
      ...clientDbtTools,
      ...dbtServerTools,
      ...clientDataSourceTools,
      ...flowUniqueTools,
      ...selfDirectiveTools,
      ...skillTools,
      ...consoleSearchTools,
      ...dashboardSearchTools,
      ...versionHistoryTools,
    },
  };
}
