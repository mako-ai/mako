/**
 * Loopback client for Local Agent ACP routes.
 * Same LNA/`targetAddressSpace: "loopback"` pattern as `local-agent-client`.
 */
import { LOCAL_AGENT_BASE_URL, localAgentClient } from "./local-agent-client";
import type {
  AcpAuthenticateResult,
  AcpBridgeEvent,
  AcpProviderId,
  AcpSessionInfo,
  AcpStatus,
} from "./acp-types";

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function unwrap<T>(body: Envelope<T>, fallback: string): T {
  if (!body?.success || body.data === undefined) {
    throw new Error(body?.error || fallback);
  }
  return body.data;
}

export const acpClient = {
  async getStatus(signal?: AbortSignal): Promise<AcpStatus> {
    const body = await localAgentClient.get<Envelope<AcpStatus>>(
      "/acp/status",
      undefined,
      { signal, timeoutMs: 5000 },
    );
    return unwrap(body, "Failed to load ACP status");
  },

  async listSessions(): Promise<AcpSessionInfo[]> {
    const body =
      await localAgentClient.get<Envelope<AcpSessionInfo[]>>("/acp/sessions");
    return unwrap(body, "Failed to list ACP sessions");
  },

  async authenticate(
    providerId: AcpProviderId,
    methodId?: string,
  ): Promise<AcpAuthenticateResult> {
    const body = await localAgentClient.post<Envelope<AcpAuthenticateResult>>(
      "/acp/authenticate",
      { providerId, methodId },
    );
    return unwrap(body, "Authentication failed");
  },

  async createSession(input: {
    providerId: AcpProviderId;
    cwd?: string;
    title?: string;
    attachMakoMcp?: boolean;
    mcpUrl?: string;
    mcpAuthorization?: string;
    mcpServerName?: string;
    /** Lean workspace guidance for Claude systemPrompt.append (not full skills). */
    systemPromptAppend?: string;
  }): Promise<AcpSessionInfo> {
    const body = await localAgentClient.post<Envelope<AcpSessionInfo>>(
      "/acp/sessions",
      input,
    );
    return unwrap(body, "Failed to create ACP session");
  },

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string }> {
    const body = await localAgentClient.post<Envelope<{ stopReason: string }>>(
      `/acp/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { text },
    );
    return unwrap(body, "Prompt failed");
  },

  async cancel(sessionId: string): Promise<void> {
    await localAgentClient.post(
      `/acp/sessions/${encodeURIComponent(sessionId)}/cancel`,
    );
  },

  async closeSession(sessionId: string): Promise<void> {
    await localAgentClient.delete(
      `/acp/sessions/${encodeURIComponent(sessionId)}`,
    );
  },

  async respondPermission(
    sessionId: string,
    requestId: string,
    outcome: { outcome: "cancelled" | "selected"; optionId?: string },
  ): Promise<void> {
    const body = await localAgentClient.post<Envelope<{ ok: true }>>(
      `/acp/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      outcome,
    );
    unwrap(body, "Failed to respond to permission");
  },

  /**
   * Subscribe to SSE events for a session via fetch (supports Chromium
   * Local Network Access `targetAddressSpace: "loopback"`, unlike EventSource).
   */
  subscribeEvents(
    sessionId: string,
    onEvent: (event: AcpBridgeEvent) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const url = new URL(
      `/acp/sessions/${encodeURIComponent(sessionId)}/events`,
      LOCAL_AGENT_BASE_URL,
    );
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(url.toString(), {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
          ...({ targetAddressSpace: "loopback" } as Record<string, unknown>),
        });
        if (!response.ok || !response.body) {
          throw new Error(`ACP event stream failed (HTTP ${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType = "message";
        let dataLines: string[] = [];

        const flush = () => {
          if (dataLines.length === 0) {
            eventType = "message";
            return;
          }
          const data = dataLines.join("\n");
          dataLines = [];
          const type = eventType;
          eventType = "message";
          if (type === "ping") return;
          try {
            onEvent(JSON.parse(data) as AcpBridgeEvent);
          } catch (error) {
            onError?.(
              error instanceof Error ? error : new Error("Bad ACP SSE payload"),
            );
          }
        };

        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop() || "";
          for (const line of parts) {
            if (line === "") {
              flush();
              continue;
            }
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
        // Server closed the stream — drop the subscription so callers can
        // reconnect and replay history.
        if (!controller.signal.aborted) {
          onError?.(new Error("ACP event stream closed"));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        onError?.(
          error instanceof Error
            ? error
            : new Error("ACP event stream interrupted"),
        );
      }
    })();

    return () => {
      controller.abort();
    };
  },
};
