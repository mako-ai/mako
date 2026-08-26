/**
 * Agent Architecture Types
 *
 * Defines the interfaces for the multi-agent registry pattern.
 * Agents are defined as factory functions that create configuration
 * based on runtime context.
 */

import type { SystemModelMessage, ToolSet } from "ai";
import type { ConsoleDataV2 } from "../agent-lib/types";
import type { McpToolCatalogInfo } from "../services/mcp-client.service";

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
  /** Branch of the caller's Apps v2 checkout — saves the agent a `git status` round trip. */
  appsV2Branch?: string;
  /** Current workspace ID */
  workspaceId: string;
  /**
   * Chat driving this turn. Server-side console tools use it as the
   * realtime echo-suppression clientId (`agent:<chatId>`) and to address
   * chat.ui-intent events at windows viewing this chat.
   */
  chatId?: string;
  /** What the user is currently looking at (the active editor tab's kind) */
  activeView?:
    | "console"
    | "dashboard"
    | "flow-editor"
    | "app"
    | "dbt"
    | "empty";
  /**
   * Which left-pane explorer is currently open and visible, or `null` if the
   * left pane is collapsed. Use this when guiding the user to a specific
   * explorer panel (e.g. "open the Databases panel on the left"), instead of
   * assuming a panel is always visible.
   */
  activeExplorer?:
    | "databases"
    | "consoles"
    | "connectors"
    | "flows"
    | "dashboards"
    | "apps"
    | "apps-v2"
    | "dbt"
    | "settings"
    | null;
  /** Current user ID (if session auth) */
  userId?: string;
  /** Open console tabs (for console agent) */
  consoles?: ConsoleDataV2[];
  /** Preferred console ID (active tab) */
  consoleId?: string;
  /** Active notebook id — server notebook tools default their cell ops to it. */
  notebookId?: string;
  /** Lightweight summary of ALL open tabs (all kinds) */
  openTabs?: Array<{
    id: string;
    kind: string;
    title: string;
    isActive: boolean;
    dashboardId?: string;
    flowId?: string;
    connectionId?: string;
    /** dbt project the tab belongs to (dbt-file / dbt-job / dbt-console tabs). */
    dbtProjectId?: string;
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
  /**
   * Pre-rendered `.makorules` block for the dbt project this turn is about.
   * Populated by `agent.routes.ts` via `resolveDbtRulesBlockForTurn`. Empty
   * when no project resolves or the project ships no rules file.
   */
  dbtRulesBlock?: string;
  /** Agent-editable self-directive (persisted workspace knowledge) */
  selfDirective?: string;
  /** Auto-discovered relevant consoles (injected via embedding search) */
  consoleHints?: string;
  /**
   * Pre-rendered skills block: the workspace-scoped skills index + any
   * auto-loaded skill bodies for this turn. Populated by `agent.routes.ts`
   * via `retrieveRelevantSkills` + `renderSkillsPromptBlock`. Empty string
   * if the workspace has no skills.
   */
  skillsBlock?: string;
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
  /**
   * MCP tools resolved for this request (workspace + user scoped servers),
   * built by `buildMcpToolsForChat` in agent.routes.ts. Keys are prefixed
   * (`mcp_<server>_<tool>`); write-tier tools carry `needsApproval`.
   */
  mcpTools?: ToolSet;
  /** Prefixed names of read-tier MCP tools (allowed under the plan gate). */
  mcpReadOnlyToolNames?: string[];
  /** All prefixed MCP tool names (added to the mode-runtime allowlist). */
  mcpToolNames?: string[];
  /**
   * Full-description catalog entries for MCP tools (search_tools ranking +
   * the deferred-tool inventory in the system prompt).
   */
  mcpToolCatalog?: McpToolCatalogInfo[];
  /**
   * Actor may attach cron schedules to saved consoles (workspace owner/admin),
   * or API-key requests act as workspace-scoped automation (same as HTTP schedule routes).
   */
  canManageScheduledQueries?: boolean;
}

/**
 * Configuration returned by agent factory
 *
 * Tools are all defined with the AI SDK `tool()` helper and can be either:
 * - Server-side tools (have an `execute` function that runs on the API)
 * - Client-side tools (no `execute` — the SDK forwards the call to the browser,
 *   which runs it via the `onToolCall` handler and returns the output)
 */
export interface AgentConfig {
  /** System prompt — plain string or structured array with provider options (e.g. Anthropic cacheControl) */
  systemPrompt: string | SystemModelMessage | SystemModelMessage[];
  /** Tools available to the agent - mix of server and client tools */
  tools: ToolSet;
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
