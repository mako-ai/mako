/**
 * Live inventory of agent tool names (server factories + client packages).
 *
 * Used by the MCP bridge policy tests to detect unclassified / stale tools.
 * Instantiating factories only builds tool *definitions* — execute is not
 * called — so this is safe without a database.
 */
import {
  clientAgentTools,
  clientScreenshotTools,
  PLAN_GATE_ALLOWED_TOOL_NAMES,
} from "@mako/agent-tools";
import { Types } from "mongoose";

import { createFlowTools } from "../agents/flow";
import { createConsoleSearchTools } from "../agent-lib/tools/console-search-tools";
import { createDashboardSearchTools } from "../agent-lib/tools/dashboard-search-tools";
import { createConnectorTools } from "../agent-lib/tools/connector-tools";
import { createDbtServerTools } from "../agent-lib/tools/dbt-tools";
import { createMemberTools } from "../agent-lib/tools/member-tools";
import { createMongoToolsV2 } from "../agent-lib/tools/mongodb-tools";
import { createScheduleQueryTool } from "../agent-lib/tools/schedule-query-tool";
import { createSelfDirectiveTools } from "../agent-lib/tools/self-directive-tool";
import { createServerConsoleTools } from "../agent-lib/tools/server-console-tools";
import { createSkillTools } from "../agent-lib/tools/skill-tools";
import { createSqlToolsV2 } from "../agent-lib/tools/sql-tools";
import { createUniversalTools } from "../agent-lib/tools/universal-tools";
import { createVersionHistoryTools } from "../agent-lib/tools/version-history-tools";
import { createWebTools } from "../agent-lib/tools/web-tools";
import { CORE_ALWAYS_TOOL_NAMES, modeRegistry } from "../agents/modes/registry";

/** Stable dummy workspace id for definition-only factory calls. */
const INVENTORY_WORKSPACE_ID = new Types.ObjectId().toString();

function keysOf(tools: Record<string, unknown>): string[] {
  return Object.keys(tools);
}

/**
 * Every tool name the in-product agent can expose (union across modes),
 * including client-only tools that never have `execute` on the server.
 */
export function collectLiveAgentToolNames(): string[] {
  const names = new Set<string>();

  const add = (list: Iterable<string>) => {
    for (const name of list) names.add(name);
  };

  // Mode allowlists + core always-on tools (string sources of truth for UX).
  add(CORE_ALWAYS_TOOL_NAMES);
  add(PLAN_GATE_ALLOWED_TOOL_NAMES);
  for (const mode of Object.values(modeRegistry)) {
    add(mode.toolNames);
  }

  // Client packages (no execute).
  add(keysOf(clientAgentTools));
  add(keysOf(clientScreenshotTools));

  // Server factories (with execute) — namespaced as the unified agent sees them.
  const consoleTools = createServerConsoleTools({
    workspaceId: INVENTORY_WORKSPACE_ID,
  });
  add(keysOf(consoleTools));

  const sqlTools = createSqlToolsV2(INVENTORY_WORKSPACE_ID, []);
  add(keysOf(sqlTools));

  const mongoTools = createMongoToolsV2(INVENTORY_WORKSPACE_ID, []);
  // Unified agent namespaces these with mongo_*.
  add([
    "mongo_list_connections",
    "mongo_list_databases",
    "mongo_list_collections",
    "mongo_inspect_collection",
    "mongo_execute_query",
  ]);
  // Raw factory also exports unnamespaced aliases used by older paths.
  add(keysOf(mongoTools));

  const universal = createUniversalTools(INVENTORY_WORKSPACE_ID, []);
  add(keysOf(universal));

  add(keysOf(createConsoleSearchTools(INVENTORY_WORKSPACE_ID)));
  add(keysOf(createDashboardSearchTools(INVENTORY_WORKSPACE_ID)));
  add(keysOf(createVersionHistoryTools(INVENTORY_WORKSPACE_ID)));
  add(keysOf(createSkillTools(INVENTORY_WORKSPACE_ID)));
  add(keysOf(createSelfDirectiveTools(INVENTORY_WORKSPACE_ID)));
  add(keysOf(createConnectorTools(INVENTORY_WORKSPACE_ID)));
  // MCP-surface only (no mode lists them), but they are real server factories
  // and the bridge policy classifies them, so the inventory has to know them.
  add(keysOf(createMemberTools(INVENTORY_WORKSPACE_ID)));
  add(keysOf(createWebTools()));
  add(keysOf(createDbtServerTools(INVENTORY_WORKSPACE_ID)));
  add(
    keysOf(
      createScheduleQueryTool({
        workspaceId: INVENTORY_WORKSPACE_ID,
        canManageScheduledQueries: true,
      }),
    ),
  );

  // Flow unique tools (validate/execute/explain + client form tools + discovery).
  add(keysOf(createFlowTools(INVENTORY_WORKSPACE_ID)));

  // Conditional tools that factories omit without optional providers/config —
  // still part of the agent surface when configured.
  add(["web_search"]);

  return [...names].sort();
}
