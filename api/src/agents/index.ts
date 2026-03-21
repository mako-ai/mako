/**
 * Agent Registry
 *
 * Simple registry pattern for multi-agent architecture.
 * Agents are explicitly imported - no auto-discovery magic.
 */

import { consoleAgentFactory, consoleAgentMeta } from "./console";
import { dashboardAgentFactory, dashboardAgentMeta } from "./dashboard";
import { flowAgentFactory, flowAgentMeta } from "./flow";
import { unifiedAgentFactory, unifiedAgentMeta } from "./unified";
import type { AgentFactory, AgentMeta, AgentRegistryEntry } from "./types";

// Export types for external use
export * from "./types";

/**
 * Agent registry - explicit imports, no magic
 * To add a new agent: create folder, add import here
 * To remove an agent: delete import and folder
 */
const agents: Record<string, AgentRegistryEntry> = {
  unified: { factory: unifiedAgentFactory, meta: unifiedAgentMeta },
  console: { factory: consoleAgentFactory, meta: consoleAgentMeta },
  dashboard: { factory: dashboardAgentFactory, meta: dashboardAgentMeta },
  flow: { factory: flowAgentFactory, meta: flowAgentMeta },
};

/**
 * Type-safe agent IDs
 */
export type AgentId = keyof typeof agents;

/**
 * Get agent factory by ID
 */
export function getAgentFactory(id: string): AgentFactory | undefined {
  return agents[id]?.factory;
}

/**
 * Get agent metadata by ID
 */
export function getAgentMeta(id: string): AgentMeta | undefined {
  return agents[id]?.meta;
}

/**
 * Get all enabled agent metadata (for UI dropdown)
 */
export function getAllAgentMeta(): AgentMeta[] {
  return Object.values(agents)
    .map(entry => entry.meta)
    .filter(meta => meta.enabled);
}

/**
 * Auto-detect agent ID from tab context
 * Falls back to "console" if no match
 */
export function detectAgentId(tabKind?: string, flowType?: string): string {
  const defaultAgentId = "unified";
  for (const [id, { meta }] of Object.entries(agents)) {
    if (id === defaultAgentId) continue;
    // Check if tab kind matches
    if (tabKind && meta.tabKinds?.includes(tabKind)) {
      // For flow-editor, also check flowType if specified
      if (tabKind === "flow-editor" && flowType && meta.flowTypes) {
        if (meta.flowTypes.includes(flowType)) {
          return defaultAgentId;
        }
        // This agent handles flow-editor but not this flowType, skip
        continue;
      }
      // Tab kind matches and no flowType check needed
      return defaultAgentId;
    }
  }

  // Default fallback
  return defaultAgentId;
}
