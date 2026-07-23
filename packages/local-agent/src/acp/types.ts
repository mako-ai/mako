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
    };

export interface AcpSessionInfo {
  id: string;
  providerId: AcpProviderId;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  busy: boolean;
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
  authMethods: Array<{ id: string; name?: string; description?: string }>;
  error?: string;
}

export interface AcpStatusResponse {
  available: true;
  defaultCwd: string;
  providers: AcpProviderStatus[];
}

export interface CreateAcpSessionRequest {
  providerId?: AcpProviderId;
  cwd?: string;
  title?: string;
  /** Reserved for Phase 3 — Mako MCP attach. Ignored in v1 bridge. */
  attachMakoMcp?: boolean;
  mcpUrl?: string;
  mcpAuthorization?: string;
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
