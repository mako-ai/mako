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
  /** True when Mako `/api/mcp` was attached on session/new. */
  makoMcpAttached?: boolean;
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
  /** Attach Mako HTTP MCP (`/api/mcp`) so Claude/Codex get workspace data tools. */
  attachMakoMcp?: boolean;
  /** Absolute URL to Mako MCP, e.g. https://app.mako.ai/api/mcp */
  mcpUrl?: string;
  /** `Bearer mcpat_…` (or raw token — normalized to Bearer). */
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
