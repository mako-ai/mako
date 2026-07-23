import type { AcpProviderId } from "./providers";

/** Events streamed to the app over SSE (`GET /acp/sessions/:id/events`). */
export type AcpBridgeEvent =
  | {
      type: "session_update";
      sessionId: string;
      update: unknown;
      at: string;
    }
  | {
      type: "permission_request";
      sessionId: string;
      requestId: string;
      toolCall: unknown;
      options: unknown[];
      at: string;
    }
  | {
      type: "turn_done";
      sessionId: string;
      stopReason: string;
      at: string;
    }
  | {
      type: "error";
      sessionId: string;
      message: string;
      at: string;
    }
  | {
      type: "status";
      sessionId: string;
      message: string;
      at: string;
    }
  | {
      type: "session_invalidated";
      sessionId: string;
      message: string;
      at: string;
    };

export interface AcpModelChoice {
  value: string;
  name: string;
  description?: string;
}

export interface AcpSessionInfo {
  id: string;
  providerId: AcpProviderId;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  busy: boolean;
  /** True when Mako `/api/mcp` was attached on session/new. */
  makoMcpAttached?: boolean;
  /** Current Claude/Codex model id from session configOptions (when known). */
  currentModel?: string | null;
  /** Selectable models advertised by the adapter for this session. */
  availableModels?: AcpModelChoice[];
}

export interface AcpProviderStatus {
  id: AcpProviderId;
  label: string;
  description: string;
  authProduct: string;
  installHint: string;
  adapterCommand: string | null;
  adapterFound: boolean;
  connected: boolean;
  authRequired: boolean;
  authMethods: Array<{
    id: string;
    name?: string;
    description?: string;
    type?: string;
    terminalCommand?: string;
  }>;
  error?: string;
  /**
   * Models last seen from session/new configOptions for this provider.
   * Used by Chat's model picker before/without opening Settings.
   */
  availableModels?: AcpModelChoice[];
  currentModel?: string | null;
}

export interface AcpAuthenticateResult {
  ok: true;
  methodId: string;
  /** True when we opened a system Terminal for Claude/Codex CLI login. */
  launchedTerminal?: boolean;
  /** Copy-paste fallback when a Terminal window could not be opened. */
  terminalCommand?: string;
  message?: string;
}

export interface AcpStatusResponse {
  available: true;
  defaultCwd: string;
  providers: AcpProviderStatus[];
  /**
   * Capability marker so the web UI can detect an outdated Desktop-bundled
   * agent (raw "ACP connection closed" with no rewrite / no terminal auth).
   */
  acpBridge?: {
    version: 3 | 4;
    terminalAuth: true;
    mcpProbe: true;
    reconnect: true;
    sessionConfig: true;
    desktopMcp?: true;
  };
  /** Last Claude/Codex adapter stderr snippet (when a connection died). */
  lastAdapterError?: string | null;
}

export interface CreateAcpSessionRequest {
  providerId?: AcpProviderId;
  cwd?: string;
  title?: string;
  /** Attach Mako HTTP MCP (`/api/mcp`) so Claude/Codex get workspace data tools. */
  attachMakoMcp?: boolean;
  /** Absolute URL to Mako MCP, e.g. https://app.mako.ai/api/mcp */
  mcpUrl?: string;
  /** `Bearer mcpat_…` (or raw token — normalized to Bearer). */
  mcpAuthorization?: string;
  /**
   * MCP server name advertised to the agent (Claude tool prefix mcp__{name}__).
   * Default `mako-workspace` — avoid `mako` which collides with Claude.ai connectors.
   */
  mcpServerName?: string;
  /**
   * Extra text appended to Claude ACP systemPrompt (workspace custom prompt,
   * etc.). Skills stay on demand via MCP — do not stuff full skill bodies here.
   * Codex adapters often ignore this until they support instruction _meta.
   */
  systemPromptAppend?: string;
  /**
   * Preferred model value for `session/set_config_option` (e.g. `fable`,
   * `sonnet`, or a full id like `claude-fable-5`). Applied after session/new.
   */
  model?: string;
}

export interface SetAcpSessionConfigRequest {
  configId?: string;
  /** Select option value id, or boolean for boolean options. */
  value: string | boolean;
}

export interface PromptAcpSessionRequest {
  text?: string;
  content?: unknown[];
}

export interface PermissionResponseRequest {
  /** Selected option id from the agent's permission options, or "cancelled". */
  outcome: "cancelled" | "selected";
  optionId?: string;
}
