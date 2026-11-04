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

function assertAllowedScheme(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`Blocked URL scheme: ${url.protocol}`);
  }
}

function assertAllowedHostname(hostname: string): void {
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

function createPinnedAgent(
  undici: UndiciModule,
  validatedIp: string,
  family: 4 | 6,
): InstanceType<UndiciModule["Agent"]> {
  return new undici.Agent({
    connect: {
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
          assertPublicIp(validatedIp);
        } catch (error) {
          callback(error as NodeJS.ErrnoException, []);
          return;
        }
        callback(null, [{ address: validatedIp, family }]);
      },
    },
  });
}

let undiciModulePromise: Promise<UndiciModule> | undefined;

async function loadUndici(): Promise<UndiciModule> {
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
      const agent = createPinnedAgent(
        undici,
        resolved.address,
        resolved.family,
      );
      const response = await undici.fetch(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: stripBlockedRequestHeaders({ ...DEFAULT_HEADERS }),
        dispatcher: agent,
      });

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
