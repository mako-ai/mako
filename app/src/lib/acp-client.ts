/**
 * Loopback client for Local Agent ACP routes.
 * Same LNA/`targetAddressSpace: "loopback"` pattern as `local-agent-client`.
 */
import { LOCAL_AGENT_BASE_URL, localAgentClient } from "./local-agent-client";
import type {
  AcpAuthenticateResult,
  AcpBridgeEvent,
  AcpEnsureAdapterResult,
  AcpPromptImage,
  AcpProviderId,
  AcpSessionInfo,
  AcpStatus,
  AcpWarmModelsResult,
} from "./acp-types";

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function unwrap<T>(body: Envelope<T>, fallback: string): T {
  if (!body?.success || body.data === undefined) {
    throw new Error(rewriteLocalAgentNotFound(body?.error || fallback));
  }
  return body.data;
}

/** Old Local Agents return bare "Not Found" for new ACP routes. */
function rewriteLocalAgentNotFound(message: string): string {
  if (!/^not found$/i.test(message.trim())) return message;
  return (
    "Local Agent is missing this ACP route. " +
    "Install PR Desktop 0.3.9 (not mako.ai/download 0.3.1), " +
    "kill port 41720, reopen, then retry Update / model switch."
  );
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

  /** Null when the session is unknown or the Local Agent is unreachable. */
  async getSession(sessionId: string): Promise<AcpSessionInfo | null> {
    try {
      const body = await localAgentClient.get<Envelope<AcpSessionInfo>>(
        `/acp/sessions/${encodeURIComponent(sessionId)}`,
        undefined,
        { timeoutMs: 5000 },
      );
      return body?.success && body.data ? body.data : null;
    } catch {
      return null;
    }
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

  /**
   * Install/update ACP adapter (+ Codex CLI) via Local Agent `npm i -g`.
   * Long timeout — first install can take a minute.
   */
  async ensureAdapter(
    providerId: AcpProviderId,
    options?: { force?: boolean },
  ): Promise<AcpEnsureAdapterResult> {
    try {
      const body = await localAgentClient.post<
        Envelope<AcpEnsureAdapterResult>
      >(
        `/acp/adapters/${encodeURIComponent(providerId)}/ensure`,
        { force: Boolean(options?.force) },
        { timeoutMs: 4 * 60 * 1000 },
      );
      return unwrap(body, "Failed to update local adapter");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(rewriteLocalAgentNotFound(message));
    }
  },

  /** Populate real Claude/Codex model ids without starting a Chat turn. */
  async warmProviderModels(
    providerId: AcpProviderId,
  ): Promise<AcpWarmModelsResult> {
    try {
      const body = await localAgentClient.post<Envelope<AcpWarmModelsResult>>(
        `/acp/providers/${encodeURIComponent(providerId)}/warm-models`,
        {},
        { timeoutMs: 2 * 60 * 1000 },
      );
      return unwrap(body, "Failed to load local models");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(rewriteLocalAgentNotFound(message));
    }
  },

  async createSession(input: {
    providerId: AcpProviderId;
    cwd?: string;
    title?: string;
    attachMakoMcp?: boolean;
    mcpUrl?: string;
    mcpAuthorization?: string;
    mcpServerName?: string;
    makoAgentSessionId?: string;
    makoWorkspaceId?: string;
    /** ISO expiry of the MCP Bearer so Local Agent retires stale sessions. */
    mcpTokenExpiresAt?: string;
    /** Lean workspace guidance for Claude systemPrompt.append (not full skills). */
    systemPromptAppend?: string;
    /** Preferred Claude/Codex model (`fable`, `sonnet`, …). */
    model?: string;
  }): Promise<AcpSessionInfo> {
    // session/new may `npm i -g` Codex/Claude adapters before connecting.
    const body = await localAgentClient.post<Envelope<AcpSessionInfo>>(
      "/acp/sessions",
      input,
      { timeoutMs: 4 * 60 * 1000 },
    );
    return unwrap(body, "Failed to create ACP session");
  },

  async setSessionConfig(
    sessionId: string,
    input: { configId?: string; value: string | boolean },
  ): Promise<AcpSessionInfo> {
    const body = await localAgentClient.post<Envelope<AcpSessionInfo>>(
      `/acp/sessions/${encodeURIComponent(sessionId)}/config`,
      input,
    );
    return unwrap(body, "Failed to update session config");
  },

  async prompt(
    sessionId: string,
    text: string,
    images?: AcpPromptImage[],
  ): Promise<{ stopReason: string }> {
    const body = await localAgentClient.post<Envelope<{ stopReason: string }>>(
      `/acp/sessions/${encodeURIComponent(sessionId)}/prompt`,
      images?.length ? { text, images } : { text },
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
   *
   * @param options.replay When false, ask Local Agent for live events only
   *   (`?replay=0`). Use for Chat turns so prior agent chunks are not painted
   *   into the new assistant message. Defaults to true (Coding Agents UI).
   */
  subscribeEvents(
    sessionId: string,
    onEvent: (event: AcpBridgeEvent) => void,
    onError?: (error: Error) => void,
    options?: { replay?: boolean },
  ): () => void {
    const url = new URL(
      `/acp/sessions/${encodeURIComponent(sessionId)}/events`,
      LOCAL_AGENT_BASE_URL,
    );
    if (options?.replay === false) {
      url.searchParams.set("replay", "0");
    }
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
          let flushedInChunk = 0;
          for (const line of parts) {
            if (line === "") {
              flush();
              flushedInChunk += 1;
              // One TCP read can contain thought + first text. Yield so React
              // can paint `state: "streaming"` Thinking before it flips to done.
              if (flushedInChunk > 1) {
                await new Promise<void>(resolve => {
                  setTimeout(resolve, 0);
                });
              }
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
