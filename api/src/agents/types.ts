/**
 * Agent Architecture Types
 *
 * Defines the interfaces for the multi-agent registry pattern.
 * Agents are defined as factory functions that create configuration
 * based on runtime context.
 */

import type { SystemModelMessage } from "ai";
import type { ConsoleDataV2 } from "../agent-lib/types";

export interface AgentToolExecutionContext {
  /** Abort signal for the active chat request */
  signal: AbortSignal;
  /** Create a unique execution ID for a long-running tool */
  createExecutionId: (prefix?: string) => string;
  /** Register an execution so the request can cancel it on abort */
  registerExecution: (executionId: string) => void;
  /** Release a previously registered execution */
  releaseExecution: (executionId: string) => void;
  /** Check whether the chat request has already been aborted */
  isAborted: () => boolean;
}

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
  /** What the user is currently looking at */
  activeView?: "console" | "dashboard" | "flow-editor" | "empty";
  /** Current user ID (if session auth) */
  userId?: string;
  /** Open console tabs (for console agent) */
  consoles?: ConsoleDataV2[];
  /** Preferred console ID (active tab) */
  consoleId?: string;
  /** Lightweight summary of ALL open tabs (all kinds) */
  openTabs?: Array<{
    id: string;
    kind: string;
    title: string;
    isActive: boolean;
    dashboardId?: string;
    flowId?: string;
    connectionId?: string;
    databaseName?: string;
  }>;
  /** Lightweight summary of open dashboards for explicit dashboard selection */
  openDashboards?: Array<{
    id: string;
    title: string;
    isActive: boolean;
  }>;
  /** Database connections in workspace */
  databases?: Array<{
    id: string;
    name: string;
    type: string;
    sqlDialect?: string;
  }>;
  /** Flow form state (for flow agent) - read-only snapshot */
  flowFormState?: Record<string, unknown>;
  /** Custom workspace prompt */
  workspaceCustomPrompt?: string;
  /** Agent-editable self-directive (persisted workspace knowledge) */
  selfDirective?: string;
  /** Auto-discovered relevant consoles (injected via embedding search) */
  consoleHints?: string;
  /** Active console's query results and chart state */
  activeConsoleResults?: {
    viewMode: "table" | "json" | "chart";
    hasResults: boolean;
    rowCount: number;
    columns: string[];
    sampleRows: Record<string, unknown>[];
    chartSpec: Record<string, unknown> | null;
  };
  /** Active dashboard context (for dashboard agent) */
  activeDashboardContext?: {
    dashboardId: string;
    title: string;
    dataSources: Array<{
      id: string;
      name: string;
      tableRef?: string;
      connectionType?: string;
      sqlDialect?: string;
      queryCode?: string;
      queryLanguage?: string;
      status?: "idle" | "loading" | "ready" | "error" | null;
      rowsLoaded?: number;
      rowCount?: number;
      error?: string | null;
      columns: Array<{ name: string; type: string }>;
      sampleRows?: Record<string, unknown>[];
    }>;
    widgets: Array<{
      id: string;
      title?: string;
      type: string;
      dataSourceId: string;
      localSql?: string;
      queryEngine?: "mosaic";
      queryStatus?: "idle" | "loading" | "ready" | "error";
      queryError?: string | null;
      queryErrorKind?: string | null;
      renderStatus?: "idle" | "ready" | "error";
      renderError?: string | null;
      renderErrorKind?: string | null;
      queryRowCount?: number | null;
      queryFields?: string[];
    }>;
    crossFilterEnabled: boolean;
  };
  /** Request-scoped execution registry for cancellable server tools */
  toolExecutionContext?: AgentToolExecutionContext;
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
