/**
 * Agent module exports
 * Provides a clean API for agent functionality
 */

// Type exports
export {
  AgentKind,
  AgentConfig,
  AgentMetadata,
  AgentError,
  AgentRegistration,
  AgentBuilder,
  AgentToolFactory,
  AgentHandoffConfig,
  DatabaseAgentKind,
} from "./types";

// Agent builders
export { buildMongoAgent } from "./mongodb/agent";
export { buildBigQueryAgent } from "./bigquery/agent";
export { buildPostgresAgent } from "./postgres/agent";
export { buildTriageAgent } from "./triage/agent";

// Tool creators (if needed externally)
export { createMongoTools } from "./mongodb/tools";
export { createBigQueryTools } from "./bigquery/tools";
export { createPostgresTools } from "./postgres/tools";
export { createTriageTools } from "./triage/tools";

// Shared utilities
export {
  createConsoleTools,
  ConsoleModification,
  ConsoleData,
  ConsoleEvent,
  SendEventFunction,
} from "./shared/console-tools";

// Factory functions
export {
  createAgent,
  getSupportedAgentKinds,
  isAgentKindSupported,
} from "./factory";

// Registry helpers
export {
  registerAgent,
  getAgentRegistration,
  listAgentRegistrations,
  getRegisteredAgentKinds,
} from "./registry";
