/** Types for the Local Agent ACP bridge (`/acp/*`). */

export type AcpProviderId = "claude" | "codex";

export interface AcpModelChoice {
  value: string;
  name: string;
  description?: string;
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
  /** Codex: true when ~/.codex/auth.json is present. */
  cliLoggedIn?: boolean;
  authMethods: Array<{
    id: string;
    name?: string;
    description?: string;
    type?: string;
    terminalCommand?: string;
  }>;
  error?: string;
  availableModels?: AcpModelChoice[];
  currentModel?: string | null;
}

export interface AcpAuthenticateResult {
  ok: true;
  methodId: string;
  launchedTerminal?: boolean;
  terminalCommand?: string;
  message?: string;
}

export interface AcpStatus {
  available: true;
  defaultCwd: string;
  providers: AcpProviderStatus[];
  /** Present on Local Agent builds that include ACP MCP/reconnect/terminal auth. */
  acpBridge?: {
    version: number;
    terminalAuth?: boolean;
    mcpProbe?: boolean;
    reconnect?: boolean;
    sessionConfig?: boolean;
    desktopMcp?: boolean;
    hitlTools?: boolean;
    adapterEnsure?: boolean;
    modelWarm?: boolean;
  };
  lastAdapterError?: string | null;
  ensureByProvider?: Partial<
    Record<
      AcpProviderId,
      {
        state: "idle" | "running" | "ok" | "error";
        message?: string;
        startedAt?: string;
        errorCode?: string;
      }
    >
  >;
}

export interface AcpEnsureAdapterResult {
  ok: boolean;
  providerId: AcpProviderId;
  skipped: boolean;
  updated: boolean;
  packages: string[];
  message: string;
  adapterCommand: string | null;
  adapterVia: "env" | "path" | "npx" | null;
  stdoutTail?: string;
  stderrTail?: string;
  errorCode?: string;
}

export interface AcpWarmModelsResult {
  providerId: AcpProviderId;
  availableModels: AcpModelChoice[];
  currentModel: string | null;
  warmed: boolean;
}

export interface AcpSessionInfo {
  id: string;
  providerId: AcpProviderId;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  /** API-side identity bound to this session's Mako MCP Bearer. */
  makoAgentSessionId?: string;
  /** Workspace bound to this session's Mako MCP Bearer. */
  makoWorkspaceId?: string;
  busy: boolean;
  /** True when Mako `/api/mcp` was attached on session/new. */
  makoMcpAttached?: boolean;
  currentModel?: string | null;
  availableModels?: AcpModelChoice[];
}

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

export interface AcpChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at: string;
}

export interface AcpPermissionPrompt {
  requestId: string;
  toolCall: unknown;
  options: Array<{
    optionId: string;
    name: string;
    kind?: string;
  }>;
}
