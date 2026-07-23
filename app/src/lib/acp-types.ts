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
  };
  lastAdapterError?: string | null;
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
