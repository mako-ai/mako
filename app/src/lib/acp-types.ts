/** Types for the Local Agent ACP bridge (`/acp/*`). */

export type AcpProviderId = "claude" | "codex";

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
  authMethods: Array<{ id: string; name?: string; description?: string }>;
  error?: string;
}

export interface AcpStatus {
  available: true;
  defaultCwd: string;
  providers: AcpProviderStatus[];
}

export interface AcpSessionInfo {
  id: string;
  providerId: AcpProviderId;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  busy: boolean;
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
