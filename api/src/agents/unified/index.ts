import type { AgentConfig, AgentContext, AgentMeta } from "../types";
import { createUniversalTools } from "../../agent-lib/tools/universal-tools";
import {
  clientDashboardTools,
  clientDbtTools,
  clientDataSourceTools,
  clientNotebookTools,
} from "@mako/agent-tools";
import { createDbtServerTools } from "../../agent-lib/tools/dbt-tools";
import { createNotebookServerTools } from "../../agent-lib/tools/server-notebook-tools";
import { createAppsTools } from "../../agent-lib/tools/apps-tools";
import { createSelfDirectiveTools } from "../../agent-lib/tools/self-directive-tool";
import { createSkillTools } from "../../agent-lib/tools/skill-tools";
import { createConsoleSearchTools } from "../../agent-lib/tools/console-search-tools";
import { createDashboardSearchTools } from "../../agent-lib/tools/dashboard-search-tools";
import { createFlowTools } from "../flow";
import { createFlowFileTools } from "../../agent-lib/tools/flow-file-tools";
import { createVersionHistoryTools } from "../../agent-lib/tools/version-history-tools";
import { createWebTools } from "../../agent-lib/tools/web-tools";
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
  const flowFileTools = createFlowFileTools(workspaceId);
  const selfDirectiveTools = createSelfDirectiveTools(workspaceId, userId);
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
  const dbtServerTools = createDbtServerTools(workspaceId, userId, {
    chatId: context.chatId,
  });
  const webTools = createWebTools(context.toolExecutionContext);
  const serverNotebookTools = createNotebookServerTools({
    workspaceId,
    userId,
    chatId: context.chatId,
    defaultNotebookId: context.notebookId,
  });
  // Apps (experimental, flag-gated) — empty object when disabled.
  const appsTools = createAppsTools({
    workspaceId,
    userId,
    supportsVision: context.modelSupportsVision,
    touchedPaths: context.appsTouchedPaths,
  });

  const {
    list_connections: _flowListConnections,
    list_databases: _flowListDatabases,
    list_tables: _flowListTables,
    inspect_table: _flowInspectTable,
    ...flowUniqueTools
  } = flowTools;

  const tools = {
    ...universalTools,
    ...clientDashboardTools,
    ...appsTools,
    ...clientDbtTools,
    ...dbtServerTools,
    ...clientDataSourceTools,
    ...clientNotebookTools,
    ...serverNotebookTools,
    ...flowUniqueTools,
    ...flowFileTools,
    ...selfDirectiveTools,
    ...skillTools,
    ...consoleSearchTools,
    ...dashboardSearchTools,
    ...versionHistoryTools,
    ...webTools,
    // MCP tools (Close CRM etc.) resolved per request in agent.routes.ts.
    ...(context.mcpTools ?? {}),
  };

  // Vision gate. capture_screenshot exists to give the model eyes ("what is
  // visible", "why does this look wrong"); a model that cannot read images
  // gets nothing from it but a wasted round-trip and an image the server then
  // has to strip. Applied to the MERGED set on purpose — the tool is spread in
  // from two places (createUniversalTools and clientDashboardTools), so gating
  // either source alone silently leaves the other one registered. Removing it
  // from the registered set (not just the working set) also keeps the
  // system-prompt tool inventory in sync with what is actually callable.
  // undefined = assume vision (external MCP clients).
  if (context.modelSupportsVision === false) {
    delete (tools as Record<string, unknown>).capture_screenshot;
  }

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
    tools,
  };
}
