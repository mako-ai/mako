import {
  AgentKind,
  AgentConfig,
  AgentBuilder,
  DatabaseAgentKind,
} from "./types";
import { getAgentRegistration, getRegisteredAgentKinds } from "./registry";
import { buildTriageAgent } from "./triage/agent";

const buildTriage: AgentBuilder = config =>
  buildTriageAgent(
    config.workspaceId,
    config.consoles,
    config.preferredConsoleId,
  );

/**
 * Factory function to create agents based on kind
 * @param kind - The type of agent to create
 * @param config - Configuration for the agent
 * @returns The created agent instance
 * @throws Error if agent kind is not supported
 */
export function createAgent(kind: AgentKind, config: AgentConfig): any {
  if (kind === "triage") {
    return buildTriage(config);
  }

  const registration = getAgentRegistration(kind as DatabaseAgentKind);

  if (!registration) {
    throw new Error(`Unsupported agent kind: ${kind}`);
  }

  return registration.buildAgent(config);
}

/**
 * Get all supported agent kinds
 * @returns Array of supported agent kinds
 */
export function getSupportedAgentKinds(): AgentKind[] {
  return [...getRegisteredAgentKinds(), "triage"] as AgentKind[];
}

/**
 * Check if an agent kind is supported
 * @param kind - The agent kind to check
 * @returns True if the agent kind is supported
 */
export function isAgentKindSupported(kind: string): kind is AgentKind {
  if (kind === "triage") return true;
  return getRegisteredAgentKinds().includes(kind as DatabaseAgentKind);
}
