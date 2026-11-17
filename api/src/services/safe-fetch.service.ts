import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

type UndiciModule = typeof import("undici");

/**
 * Request headers that are never sent, whatever the caller passes: they are
 * only meaningful to cloud metadata services.
 */
const BLOCKED_REQUEST_HEADER = /^(metadata-flavor$|x-google-)/i;

const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; MakoAgent/1.0; +https://mako.dev)",
  "accept-language": "en-US,en;q=0.9",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
} as const;

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/** Strip a URL hostname's IPv6 brackets (`[::1]` → `::1`). */
function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** Drop request headers that only cloud metadata services act on. */
export function stripBlockedRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!BLOCKED_REQUEST_HEADER.test(name)) out[name] = value;
  }
  return out;
}

/**
 * Allow only globally routable unicast addresses. An IPv4-mapped IPv6
 * address (`::ffff:a.b.c.d`) is judged as the IPv4 address it reaches.
 */
export function assertPublicIp(ip: string): void {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(unbracket(ip));
  } catch {
    throw new SafeFetchError(`Invalid IP address: ${ip}`);
  }

  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }

  const range = addr.range();
  if (range !== "unicast") {
    throw new SafeFetchError(`Blocked IP range (${range}): ${ip}`);
  }

  if (addr.kind() === "ipv4" && addr.toString() === "169.254.169.254") {
    throw new SafeFetchError("Blocked cloud metadata IP");
  }
}

export function assertAllowedScheme(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`Blocked URL scheme: ${url.protocol}`);
  }
}

export function assertAllowedHostname(hostname: string): void {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new SafeFetchError(`Blocked hostname: ${hostname}`);
  }

  if (ipaddr.isValid(unbracket(hostname))) {
    assertPublicIp(hostname);
  }
}

async function resolveAndValidateHostname(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  assertAllowedHostname(hostname);

  const results = await dnsLookup(unbracket(hostname), {
    all: true,
    verbatim: true,
  });
  if (results.length === 0) {
    throw new SafeFetchError(
      `DNS lookup returned no addresses for ${hostname}`,
    );
  }

  for (const entry of results) {
    assertPublicIp(entry.address);
  }

  const preferred = results.find(entry => entry.family === 4) ?? results[0];
  if (!preferred) {
    throw new SafeFetchError(
      `DNS lookup returned no addresses for ${hostname}`,
    );
  }
  return {
    address: preferred.address,
    family: preferred.family as 4 | 6,
  };
}

const POOL_MAX_AGENTS = 100;
const POOL_IDLE_MS = 30_000;
/** Sockets one agent (one host on one IP) may hold; more requests wait. */
const POOL_MAX_SOCKETS = 32;

type PinnedAgent = InstanceType<UndiciModule["Agent"]>;

interface PinnedAgentOptions {
  /** Checks the pinned IP again at every connect. */
  assertIp?: (ip: string) => void;
  /** How long an idle socket stays open for the next request. */
  idleMs?: number;
  /** Most sockets the agent opens; requests past it wait for a free one. */
  maxSockets?: number;
  /** Extra TLS options (tests: a self-signed CA). */
  tls?: Record<string, unknown>;
}

/**
 * An undici Agent whose sockets only ever reach `validatedIp`: its DNS
 * lookup ignores the hostname and answers the pinned IP, after checking it
 * again. Idle sockets stay open `idleMs` for the next request.
 */
export function createPinnedAgent(
  undici: UndiciModule,
  validatedIp: string,
  family: 4 | 6,
  options: PinnedAgentOptions = {},
): PinnedAgent {
  const assertIp = options.assertIp ?? assertPublicIp;
  const idleMs = options.idleMs ?? POOL_IDLE_MS;
  return new undici.Agent({
    keepAliveTimeout: idleMs,
    keepAliveMaxTimeout: idleMs,
    connections: options.maxSockets ?? POOL_MAX_SOCKETS,
    connect: {
      ...options.tls,
      lookup(
        _hostname: string,
        _options: unknown,
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void,
      ) {
        // Node 22+ expects an array of { address, family }; older Node accepts
        // (err, address, family). Passing both shapes keeps CI (Node 20) and
        // local dev (Node 22+) working with pinned DNS resolution.
        // Re-check the address actually connected to.
        try {
          assertIp(validatedIp);
        } catch (error) {
          callback(error as NodeJS.ErrnoException, []);
          return;
        }
        callback(null, [{ address: validatedIp, family }]);
      },
    },
  });
}

/**
 * Pinned agents kept for reuse, so a run of calls to one service shares its
 * TCP+TLS connections. An agent is keyed by scheme, host (name and port) and
 * the pinned IP, so it is never shared across hosts or ports, and it still
 * only connects to the IP it was made for. Every request resolves and
 * validates DNS first: a changed answer is a new key and a new agent. The
 * least recently used agent is closed past `maxAgents`.
 */
export function createPinnedAgentPool(
  undici: UndiciModule,
  options: PinnedAgentOptions & { maxAgents?: number } = {},
) {
  const maxAgents = options.maxAgents ?? POOL_MAX_AGENTS;
  const agents = new Map<string, PinnedAgent>();
  return {
    get(url: URL, ip: string, family: 4 | 6): PinnedAgent {
      const key = `${url.protocol}//${url.host}|${ip}`;
      const found = agents.get(key);
      if (found) {
        agents.delete(key);
        agents.set(key, found);
        return found;
      }
      const agent = createPinnedAgent(undici, ip, family, options);
      agents.set(key, agent);
      if (agents.size > maxAgents) {
        const [oldestKey, oldest] = agents.entries().next().value ?? [];
        if (oldestKey !== undefined && oldest) {
          agents.delete(oldestKey);
          // Graceful: requests in flight on it finish first.
          void oldest.close().catch(() => undefined);
        }
      }
      return agent;
    },
    get size() {
      return agents.size;
    },
    async close(): Promise<void> {
      const all = [...agents.values()];
      agents.clear();
      await Promise.all(all.map(agent => agent.close()));
    },
  };
}

let pinnedAgentPool: ReturnType<typeof createPinnedAgentPool> | undefined;

function pooledAgent(
  undici: UndiciModule,
  url: URL,
  resolved: { address: string; family: 4 | 6 },
): PinnedAgent {
  pinnedAgentPool ??= createPinnedAgentPool(undici);
  return pinnedAgentPool.get(url, resolved.address, resolved.family);
}

/** Methods sent again after a stale socket: they change nothing. */
const RETRIED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Error codes of a socket the service closed: a kept-alive socket it had
 * already dropped (the race every connection pool has), or a reset.
 */
const CLOSED_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

function isClosedSocketError(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") return false;
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && CLOSED_SOCKET_CODES.has(code)) return true;
    current = cause;
  }
  return false;
}

/**
 * Run `attempt`, and once more when it failed on a closed socket, for a
 * method that changes nothing (GET, HEAD, OPTIONS) and a caller still
 * waiting. A write is never sent twice: the service may have received it.
 */
export async function retryClosedSocketOnce<T>(
  method: string,
  signal: AbortSignal,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (
      signal.aborted ||
      !RETRIED_METHODS.has(method.toUpperCase()) ||
      !isClosedSocketError(error)
    ) {
      throw error;
    }
    return attempt();
  }
}

let undiciModulePromise: Promise<UndiciModule> | undefined;

export async function loadUndici(): Promise<UndiciModule> {
  undiciModulePromise ??= import("undici");
  return undiciModulePromise;
}

interface BodyChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/**
 * Read a response body, refusing it once it passes `maxBytes`. The count is
 * of DECODED bytes: fetch transparently decompresses gzip/br/deflate/zstd, so
 * `content-length` (the compressed size, absent when chunked) is only an early
 * reject. The stream is cancelled as soon as the limit is crossed, so an
 * oversized body is never buffered in full.
 */
export async function readBodyWithLimit(
  response: {
    headers: { get(name: string): string | null };
    body: { getReader(): BodyChunkReader } | null;
  },
  maxBytes: number,
): Promise<Buffer> {
  const tooLarge = () =>
    new SafeFetchError(`Response body exceeds ${maxBytes} byte limit`);

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number.parseInt(contentLength, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      if (response.body) {
        await response.body
          .getReader()
          .cancel()
          .catch(() => undefined);
      }
      throw tooLarge();
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function mergeSignals(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * SSRF-hardened HTTP GET: scheme allowlist, DNS resolution with IP validation,
 * socket pinning to defeat DNS rebind, manual redirect re-validation.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? 5_000_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = new URL(rawUrl);
  let redirectCount = 0;

  for (;;) {
    assertAllowedScheme(currentUrl);
    assertAllowedHostname(currentUrl.hostname);

    const resolved = await resolveAndValidateHostname(currentUrl.hostname);
    const { signal, cleanup } = mergeSignals(timeoutMs, options.signal);

    try {
      const undici = await loadUndici();
      const agent = pooledAgent(undici, currentUrl, resolved);
      const response = await undici.fetch(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: stripBlockedRequestHeaders({ ...DEFAULT_HEADERS }),
        dispatcher: agent,
      });

      if (response.status < 200 || response.status >= 300) {
        // Free the pooled socket for the next request.
        await response.body?.cancel().catch(() => undefined);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new SafeFetchError("Redirect response missing Location header");
        }
        if (redirectCount >= maxRedirects) {
          throw new SafeFetchError("Too many redirects");
        }
        redirectCount += 1;
        currentUrl = new URL(location, currentUrl);
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new SafeFetchError(
          `HTTP ${response.status} for ${currentUrl.toString()}`,
        );
      }

      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const body = await readBodyWithLimit(response, maxBytes);

      return {
        url: currentUrl.toString(),
        status: response.status,
        contentType,
        body,
      };
    } finally {
      cleanup();
    }
  }
}

export interface SafeRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SafeRequestResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * One SSRF-hardened request with any method, for the connection proxy
 * (connections/proxy.service.ts): the same scheme, hostname and pinned-IP
 * checks as `safeFetch`, but the caller's method, headers and body, every
 * status returned as it is, and no redirect followed (a 3xx comes back to
 * the caller, so credentials are never replayed to another host).
 */
export async function safeRequest(
  rawUrl: string,
  options: SafeRequestOptions,
): Promise<SafeRequestResult> {
  const url = new URL(rawUrl);
  assertAllowedScheme(url);
  const resolved = await resolveAndValidateHostname(url.hostname);
  const { signal, cleanup } = mergeSignals(
    options.timeoutMs ?? 30_000,
    options.signal,
  );
  try {
    const undici = await loadUndici();
    return await retryClosedSocketOnce(options.method, signal, async () => {
      const response = await undici.fetch(url.toString(), {
        method: options.method,
        redirect: "manual",
        signal,
        headers: stripBlockedRequestHeaders(options.headers),
        body: options.body,
        dispatcher: pooledAgent(undici, url, resolved),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return {
        status: response.status,
        headers,
        body: await readBodyWithLimit(response, options.maxBytes ?? 10_000_000),
      };
    });
  } finally {
    cleanup();
  }
}
