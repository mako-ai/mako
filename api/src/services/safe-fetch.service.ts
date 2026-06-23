import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

type UndiciModule = typeof import("undici");

const BLOCKED_IP_RANGES = new Set([
  "private",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "reserved",
  "unspecified",
  "broadcast",
  "multicast",
  "carrierGradeNat",
]);

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

/** Reject private, loopback, link-local, and other non-public IP ranges. */
export function assertPublicIp(ip: string): void {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    throw new SafeFetchError(`Invalid IP address: ${ip}`);
  }

  const range = addr.range();
  if (BLOCKED_IP_RANGES.has(range)) {
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

  if (ipaddr.isValid(hostname)) {
    assertPublicIp(hostname);
  }
}

async function resolveAndValidateHostname(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  assertAllowedHostname(hostname);

  const results = await dnsLookup(hostname, { all: true, verbatim: true });
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
          address: string,
          family: number,
        ) => void,
      ) {
        callback(null, validatedIp, family);
      },
    },
  });
}

let undiciModulePromise: Promise<UndiciModule> | undefined;

async function loadUndici(): Promise<UndiciModule> {
  undiciModulePromise ??= import("undici");
  return undiciModulePromise;
}

async function readBodyWithLimit(
  response: {
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  },
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number.parseInt(contentLength, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new SafeFetchError(`Response body exceeds ${maxBytes} byte limit`);
    }
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new SafeFetchError(`Response body exceeds ${maxBytes} byte limit`);
  }
  return buffer;
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
        headers: DEFAULT_HEADERS,
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
