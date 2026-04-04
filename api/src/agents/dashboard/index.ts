/**
 * Dashboard Agent
 *
 * Creates and manages interactive data dashboards from saved queries.
 * Supports charts (Vega-Lite), KPI cards, data tables, cross-filtering,
 * and global filters — all powered by in-browser DuckDB.
 */

import type { AgentContext, AgentConfig, AgentMeta } from "../types";
import {
  DASHBOARD_SYSTEM_PROMPT,
  buildDashboardRuntimeContext,
} from "./prompt";
import { clientDashboardTools } from "../../agent-lib/tools/dashboard-tools-client";
import { createSelfDirectiveTools } from "../../agent-lib/tools/self-directive-tool";
import { createConsoleSearchTools } from "../../agent-lib/tools/console-search-tools";
import { createDashboardSearchTools } from "../../agent-lib/tools/dashboard-search-tools";

/**
 * Dashboard agent metadata for UI and routing
 */
export const dashboardAgentMeta: AgentMeta = {
  id: "dashboard",
  name: "Dashboard Builder",
  description:
    "Creates and manages interactive data dashboards from saved queries",
  tabKinds: ["dashboard"],
  enabled: true,
};

/**
 * Dashboard agent factory
 * Creates agent configuration with dashboard-specific prompt and tools
 */
export function dashboardAgentFactory(context: AgentContext): AgentConfig {
  const { workspaceId } = context;

  const selfDirectiveTools = createSelfDirectiveTools(workspaceId);
  const consoleSearchTools = createConsoleSearchTools(workspaceId);
  const dashboardSearchTools = createDashboardSearchTools(workspaceId);

  const runtimeContext = buildDashboardRuntimeContext(context);

  return {
    systemPrompt: [
      {
        role: "system" as const,
        content: DASHBOARD_SYSTEM_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      {
        role: "system" as const,
        content: runtimeContext,
      },
    ],
    tools: {
      ...clientDashboardTools,
      ...selfDirectiveTools,
      ...consoleSearchTools,
      ...dashboardSearchTools,
    } as Record<string, unknown>,
  };
}
