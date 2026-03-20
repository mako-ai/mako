/**
 * Console Agent
 *
 * Database console assistant for writing and running queries.
 * Supports MongoDB, PostgreSQL, BigQuery, SQLite, Cloudflare D1.
 */

import type {
  AgentFactory,
  AgentMeta,
  AgentContext,
  AgentConfig,
} from "../types";
import { UNIVERSAL_PROMPT_V2 } from "../../agent-lib/prompts/universal";
import { createUniversalTools } from "../../agent-lib/tools/universal-tools";
import { createSelfDirectiveTools } from "../../agent-lib/tools/self-directive-tool";
import { createConsoleSearchTools } from "../../agent-lib/tools/console-search-tools";
import type { ConsoleDataV2 } from "../../agent-lib/types";

/**
 * Console agent metadata for UI and routing
 */
export const consoleAgentMeta: AgentMeta = {
  id: "console",
  name: "Console Assistant",
  description: "Helps write and run database queries",
  tabKinds: ["console"],
  enabled: true,
};

/**
 * Build runtime context string for console agent
 */
function buildRuntimeContext(
  consoles: ConsoleDataV2[],
  consoleId: string | undefined,
  databases: AgentContext["databases"],
  databaseTypeMap: Map<string, string>,
  databaseNameMap: Map<string, string>,
  activeConsoleResults?: AgentContext["activeConsoleResults"],
): string {
  let runtimeContext = "\n\n---\n\n## Current State (auto-injected)\n";

  // Open Consoles section
  if (consoles && consoles.length > 0) {
    runtimeContext += "\n### Open Consoles:\n";
    for (let i = 0; i < consoles.length; i++) {
      const c = consoles[i];
      const connType =
        c.connectionType ||
        (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined);
      const connName = c.connectionId
        ? databaseNameMap.get(c.connectionId)
        : undefined;

      const isActive = c.id === consoleId;
      const activeLabel = isActive ? "[ACTIVE] " : "";
      runtimeContext += `\n${i + 1}. ${activeLabel}"${c.title}" (id: ${c.id})\n`;

      if (connType || connName || c.databaseName) {
        const parts: string[] = [];
        if (connType) parts.push(connType);
        if (connName) parts.push(connName);
        if (c.databaseName) parts.push(`db: ${c.databaseName}`);
        runtimeContext += `   - Connection: ${parts.join(" / ")}\n`;
      } else {
        runtimeContext += `   - Connection: none\n`;
      }

      const trimmedContent = c.content.trim();
      if (!trimmedContent) {
        runtimeContext += `   - Content: empty\n`;
      } else {
        const lines = trimmedContent.split("\n");
        const truncated = lines.length > 50;
        const displayContent = truncated
          ? lines.slice(0, 50).join("\n")
          : trimmedContent;
        const truncatedNote = truncated
          ? ` (truncated from ${lines.length} lines)`
          : "";
        runtimeContext += `   - Content${truncatedNote}:\n`;
        const indentedContent = displayContent
          .split("\n")
          .map((line: string) => `     ${line}`)
          .join("\n");
        runtimeContext += `${indentedContent}\n`;
      }
    }
  } else {
    runtimeContext += "\n### Open Consoles:\nNo consoles open.\n";
  }

  // Available Connections section
  if (databases && databases.length > 0) {
    runtimeContext += "\n### Available Connections:\n";
    for (const db of databases) {
      runtimeContext += `- ${db.type}: ${db.name} (id: ${db.id})\n`;
    }
  } else {
    runtimeContext +=
      "\n### Available Connections:\nNo database connections configured yet.\n";
  }

  // Active console results section
  if (activeConsoleResults) {
    runtimeContext += "\n### Active Console Results:\n";
    runtimeContext += `- View: ${activeConsoleResults.viewMode}\n`;
    if (activeConsoleResults.hasResults) {
      runtimeContext += `- Rows: ${activeConsoleResults.rowCount}\n`;
      if (activeConsoleResults.columns.length > 0) {
        runtimeContext += `- Columns: ${activeConsoleResults.columns.join(", ")}\n`;
      }
      if (activeConsoleResults.sampleRows.length > 0) {
        runtimeContext += `- Sample data (first ${activeConsoleResults.sampleRows.length} rows):\n`;
        runtimeContext += "```json\n";
        runtimeContext += JSON.stringify(
          activeConsoleResults.sampleRows,
          null,
          2,
        );
        runtimeContext += "\n```\n";
      }
      if (
        activeConsoleResults.viewMode === "chart" &&
        activeConsoleResults.chartSpec
      ) {
        runtimeContext += `- Current chart spec:\n`;
        runtimeContext += "```json\n";
        runtimeContext += JSON.stringify(
          activeConsoleResults.chartSpec,
          null,
          2,
        );
        runtimeContext += "\n```\n";
      }
    } else {
      runtimeContext +=
        "- No query results yet (query has not been executed)\n";
    }
  }

  runtimeContext += "\n---";

  return runtimeContext;
}

/**
 * Console agent factory
 * Creates agent configuration with the universal database prompt and tools
 */
export const consoleAgentFactory: AgentFactory = (
  context: AgentContext,
): AgentConfig => {
  const {
    workspaceId,
    consoles = [],
    consoleId,
    databases = [],
    workspaceCustomPrompt = "",
    selfDirective = "",
    consoleHints = "",
    activeConsoleResults,
  } = context;

  // Build database lookup maps
  const databaseTypeMap = new Map<string, string>();
  const databaseNameMap = new Map<string, string>();
  databases.forEach(db => {
    databaseTypeMap.set(db.id, db.type);
    databaseNameMap.set(db.id, db.name);
  });

  // Enrich consoles with connection type from database map
  const enrichedConsoles: ConsoleDataV2[] = consoles.map(c => ({
    ...c,
    connectionType:
      c.connectionType ||
      (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined),
  }));

  // Build system prompt with runtime context
  const customPromptContext =
    workspaceCustomPrompt.trim().length > 0
      ? `\n\n---\n\n### Workspace Context\n${workspaceCustomPrompt.trim()}`
      : "";

  const selfDirectiveContext = selfDirective.trim()
    ? `\n\n---\n\n### Self-Directive (agent-learned rules)\n${selfDirective.trim()}`
    : "";

  const runtimeContext = buildRuntimeContext(
    enrichedConsoles,
    consoleId,
    databases,
    databaseTypeMap,
    databaseNameMap,
    activeConsoleResults,
  );

  // Create tools
  const tools = createUniversalTools(workspaceId, enrichedConsoles, consoleId);
  const selfDirectiveTools = createSelfDirectiveTools(workspaceId);
  const consoleSearchTools = createConsoleSearchTools(workspaceId);

  return {
    systemPrompt: [
      {
        role: "system" as const,
        content: UNIVERSAL_PROMPT_V2 + customPromptContext,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      {
        role: "system" as const,
        content: selfDirectiveContext + consoleHints + runtimeContext,
      },
    ],
    tools: {
      ...tools,
      ...selfDirectiveTools,
      ...consoleSearchTools,
    } as Record<string, any>,
  };
};
