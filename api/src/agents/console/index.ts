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
): string {
  let runtimeContext = "";

  if (
    (consoles && consoles.length > 0) ||
    (databases && databases.length > 0)
  ) {
    runtimeContext += "\n\n---\n\n## Current State (auto-injected)\n";

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

        // Determine active console using consoleId param
        const isActive = c.id === consoleId;
        const activeLabel = isActive ? "[ACTIVE] " : "";
        runtimeContext += `\n${i + 1}. ${activeLabel}"${c.title}" (id: ${c.id})\n`;

        // Connection info
        if (connType || connName || c.databaseName) {
          const parts: string[] = [];
          if (connType) parts.push(connType);
          if (connName) parts.push(connName);
          if (c.databaseName) parts.push(`db: ${c.databaseName}`);
          runtimeContext += `   - Connection: ${parts.join(" / ")}\n`;
        } else {
          runtimeContext += `   - Connection: none\n`;
        }

        // Content
        const trimmedContent = c.content.trim();
        if (!trimmedContent) {
          runtimeContext += `   - Content: empty\n`;
        } else {
          // Truncate long content for context
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
    }

    // Available Connections section
    if (databases && databases.length > 0) {
      runtimeContext += "\n### Available Connections:\n";
      for (const db of databases) {
        runtimeContext += `- ${db.type}: ${db.name} (id: ${db.id})\n`;
      }
    }

    runtimeContext += "\n---";
  }

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
  );

  // Create tools
  const tools = createUniversalTools(workspaceId, enrichedConsoles, consoleId);
  const selfDirectiveTools = createSelfDirectiveTools(workspaceId);

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
        content: selfDirectiveContext + runtimeContext,
      },
    ],
    tools: { ...tools, ...selfDirectiveTools } as Record<string, any>,
  };
};
