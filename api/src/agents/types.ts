/**
 * Agent Architecture Types
 *
 * Defines the interfaces for the multi-agent registry pattern.
 * Agents are defined as factory functions that create configuration
 * based on runtime context.
 */

import type { SystemModelMessage } from "ai";
import type { ConsoleDataV2 } from "../agent-lib/types";

/**
 * Metadata about an agent for UI display and routing
 */
export interface AgentMeta {
  /** Unique agent identifier */
  id: string;
  /** Display name for UI */
  name: string;
  /** Brief description of agent capabilities */
  description: string;
  /** Tab kinds that trigger this agent (e.g., "console", "flow-editor") */
  tabKinds?: string[];
  /** For flow-editor tabs, which flow types trigger this agent */
  flowTypes?: string[];
  /** Whether this agent is enabled */
  enabled: boolean;
}

/**
 * Runtime context passed to agent factory
 */
export interface AgentContext {
  /** Current workspace ID */
  workspaceId: string;
  /** Current user ID (if session auth) */
  userId?: string;
  /** Open console tabs (for console agent) */
  consoles?: ConsoleDataV2[];
  /** Preferred console ID (active tab) */
  consoleId?: string;
  /** Database connections in workspace */
  databases?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  /** Flow form state (for flow agent) - read-only snapshot */
  flowFormState?: Record<string, unknown>;
  /** Custom workspace prompt */
  workspaceCustomPrompt?: string;
  /** Agent-editable self-directive (persisted workspace knowledge) */
  selfDirective?: string;
}

/**
 * Configuration returned by agent factory
 *
 * Tools can be either:
 * - Server-side tools (created with `tool()` from AI SDK, has execute function)
 * - Client-side tools (plain objects with description and inputSchema, no execute)
 */
export interface AgentConfig {
  /** System prompt — plain string or structured array with provider options (e.g. Anthropic cacheControl) */
  systemPrompt: string | SystemModelMessage | SystemModelMessage[];
  /** Tools available to the agent - mix of server and client tools */
  tools: Record<string, unknown>;
}

/**
 * Factory function type - creates agent config from runtime context
 */
export type AgentFactory = (context: AgentContext) => AgentConfig;

/**
 * Registry entry combining factory and metadata
 */
export interface AgentRegistryEntry {
  factory: AgentFactory;
  meta: AgentMeta;
}
