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

/**
 * Hostnames/IPs that are only reachable from the user's machine or local
 * network — i.e. addresses Mako Cloud can never connect to, which must be
 * routed through the Local Agent instead.
 */
export function isLocalHostname(value: string | undefined | null): boolean {
  if (!value) return false;
  const host = value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

/** Extract hostnames from a URI-style connection string (handles multi-host
 * lists like mongodb://h1:p1,h2:p2/db and bracketed IPv6 literals). */
function extractHosts(connectionString: string): string[] {
  const match = connectionString.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)/i,
  );
  if (!match) return [];
  return match[1].split(",").map(part => {
    const trimmed = part.trim();
    const ipv6 = trimmed.match(/^\[([^\]]+)\]/);
    return ipv6 ? ipv6[1] : trimmed.split(":")[0];
  });
}

const HOST_FIELD_RE = /host|server|address|endpoint/i;
const URL_FIELD_RE = /connectionstring|url|uri/i;

/**
 * True when a connection form's values point at a local address (localhost,
 * 127.0.0.1, private LAN ranges, *.local, ...). Drives the automatic
 * cloud-vs-agent routing decision so users never have to think about it.
 */
export function connectionLooksLocal(
  connection: Record<string, unknown> | undefined | null,
): boolean {
  if (!connection) return false;
  for (const [key, value] of Object.entries(connection)) {
    if (typeof value !== "string" || !value) continue;
    if (URL_FIELD_RE.test(key)) {
      if (extractHosts(value).some(isLocalHostname)) return true;
    } else if (HOST_FIELD_RE.test(key)) {
      if (isLocalHostname(value)) return true;
    }
  }
  return false;
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

  /**
   * Liveness probe; resolves null when the agent is not running.
   *
   * The timeout must outlive Chrome's Local Network Access permission prompt:
   * the first probe from a browser blocks on the user accepting it, and a
   * short timeout would abort the request (and mark the agent offline) before
   * they can. When the agent is simply not running the socket is refused
   * immediately, so the long timeout does not slow down that path.
   */
  async ping(): Promise<AgentHealth | null> {
    try {
      return await this.get<AgentHealth>("/health", undefined, {
        timeoutMs: 15000,
      });
    } catch {
      return null;
    }
  }
}

export const localAgentClient = new LocalAgentClient();
