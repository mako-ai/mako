/**
 * Agent Registry
 *
 * Simple registry pattern for multi-agent architecture.
 * Agents are explicitly imported - no auto-discovery magic.
 */

import { consoleAgentFactory, consoleAgentMeta } from "./console";
import { flowAgentFactory, flowAgentMeta } from "./flow";
import type { AgentFactory, AgentMeta, AgentRegistryEntry } from "./types";

// Export types for external use
export * from "./types";

/**
 * Agent registry - explicit imports, no magic
 * To add a new agent: create folder, add import here
 * To remove an agent: delete import and folder
 */
const agents: Record<string, AgentRegistryEntry> = {
  console: { factory: consoleAgentFactory, meta: consoleAgentMeta },
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
  for (const [id, { meta }] of Object.entries(agents)) {
    // Check if tab kind matches
    if (tabKind && meta.tabKinds?.includes(tabKind)) {
      // For flow-editor, also check flowType if specified
      if (tabKind === "flow-editor" && flowType && meta.flowTypes) {
        if (meta.flowTypes.includes(flowType)) {
          return id;
        }
        // This agent handles flow-editor but not this flowType, skip
        continue;
      }
      // Tab kind matches and no flowType check needed
      return id;
    }
  }

  // Default fallback
  return "console";
}
