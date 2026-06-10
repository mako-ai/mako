/**
 * Client for the Mako Local Agent: a small daemon on 127.0.0.1 that executes
 * queries and browses schemas on databases only reachable from the user's
 * machine (e.g. localhost Postgres). Counterpart of `apiClient` for
 * connections whose id starts with `local_`.
 *
 * Requests are annotated with `targetAddressSpace: "loopback"` so Chromium's
 * Local Network Access rules allow an HTTPS page (app.mako.ai) to call the
 * plain-HTTP loopback agent after the user grants the LNA permission.
 */

export const LOCAL_AGENT_PORT = 41720;
export const LOCAL_AGENT_BASE_URL = `http://127.0.0.1:${LOCAL_AGENT_PORT}`;

const LOCAL_CONNECTION_ID_PREFIX = "local_";

export function isLocalConnectionId(id: string | undefined | null): boolean {
  return Boolean(id && id.startsWith(LOCAL_CONNECTION_ID_PREFIX));
}

interface AgentRequestOptions extends RequestInit {
  params?: Record<string, string>;
  timeoutMs?: number;
}

export interface AgentHealth {
  status: string;
  name: string;
  version: string;
}

class LocalAgentClient {
  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(
      path.startsWith("/") ? path : `/${path}`,
      LOCAL_AGENT_BASE_URL,
    );
    if (params) {
      Object.entries(params).forEach(([key, value]) =>
        url.searchParams.append(key, value),
      );
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    options: AgentRequestOptions = {},
  ): Promise<T> {
    const { params, timeoutMs, signal, ...rest } = options;

    let effectiveSignal = signal;
    if (!effectiveSignal && timeoutMs) {
      effectiveSignal = AbortSignal.timeout(timeoutMs);
    }

    const response = await fetch(this.buildUrl(path, params), {
      ...rest,
      signal: effectiveSignal,
      headers: { "Content-Type": "application/json", ...rest.headers },
      // Chromium Local Network Access: declare the loopback destination so
      // the request is exempt from mixed-content blocking (https -> http).
      ...({ targetAddressSpace: "loopback" } as Record<string, unknown>),
    });

    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: `Agent error (HTTP ${response.status})` }));
      throw new Error(
        (body as { error?: string }).error ||
          `Agent error (HTTP ${response.status})`,
      );
    }
    return (await response.json()) as T;
  }

  /** POST returning { status, body } for structured non-2xx handling. */
  async postWithStatus<T>(
    path: string,
    data?: unknown,
    options?: { signal?: AbortSignal; alsoOk?: number[] },
  ): Promise<{ status: number; body: T }> {
    const alsoOk = new Set(options?.alsoOk ?? [400, 403]);
    const response = await fetch(this.buildUrl(path), {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
      signal: options?.signal,
      headers: { "Content-Type": "application/json" },
      ...({ targetAddressSpace: "loopback" } as Record<string, unknown>),
    });

    const text = await response.text();
    let body: T = {} as T;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = text as unknown as T;
      }
    }

    if (response.ok || alsoOk.has(response.status)) {
      return { status: response.status, body };
    }
    const errBody = body as { error?: string };
    throw new Error(errBody?.error || `Agent error (HTTP ${response.status})`);
  }

  async get<T>(
    path: string,
    params?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    return this.request<T>(path, { method: "GET", params, ...options });
  }

  async post<T>(
    path: string,
    data?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
      signal: options?.signal,
    });
  }

  async put<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  /** Quick liveness probe; resolves null when the agent is not running. */
  async ping(): Promise<AgentHealth | null> {
    try {
      return await this.get<AgentHealth>("/health", undefined, {
        timeoutMs: 1500,
      });
    } catch {
      return null;
    }
  }
}

export const localAgentClient = new LocalAgentClient();
