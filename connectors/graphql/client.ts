/**
 * The GraphQL HTTP client, with the in-process connector's policy
 * (`api/src/connectors/graphql/connector.ts`):
 *
 * - one POST of `{ query, variables }` to the endpoint, with
 *   `Content-Type: application/json` and the connection's custom headers on
 *   top (a JSON string, or an object from older connections);
 * - a response with `errors` fails the request, and so does one without
 *   `data`. Neither is retried;
 * - up to 3 retries on 429, 5xx and network errors. A 429 waits its
 *   `Retry-After` seconds, else 2^n s; anything else waits 500 ms × 2^n
 *   (n counts from 1). 4xx fails at once;
 * - 30 s per request.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 *
 * The in-process client is SSRF-guarded (`createSsrfSafeAxios`): it refuses
 * private, link-local and metadata targets because it runs inside Mako's
 * network. A box is outside it. The folder still refuses the cloud metadata
 * names and private or link-local IP literals; loopback reaches only the
 * box itself and is allowed.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 3;
const MAX_ERROR_BODY = 2_000;

/** Network failures: no response at all, as axios reports them. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export class GraphqlHttpError extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, body: string, retryAfter: string | null) {
    super(
      `Request failed with status code ${status}${body ? `: ${body.slice(0, MAX_ERROR_BODY)}` : ""}`,
    );
    this.name = "GraphqlHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** A transport failure: no HTTP response, retried as axios's are. */
export class GraphqlNetworkError extends Error {
  constructor(cause: unknown) {
    super(
      `GraphQL request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "GraphqlNetworkError";
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") {
    return true;
  }
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" && NETWORK_CODES.has(code);
}

/** Headers: the in-process `getGraphQLClient`, line for line. */
export function buildHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (raw) {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      throw new Error("Invalid JSON format in headers field", {
        cause: error,
      });
    }
    if (parsed && typeof parsed === "object") Object.assign(headers, parsed);
  }
  return headers;
}

function v4Blocked(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p))) return false;
  const value =
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const ranges: Array<[string, number]> = [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["169.254.0.0", 16],
    ["100.64.0.0", 10],
    ["0.0.0.0", 8],
  ];
  return ranges.some(([base, bits]) => {
    const b = base.split(".").map(Number);
    const baseValue = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

/** An IPv6 address's 8 groups, `::` expanded; null when it is not one. */
function v6Groups(address: string): number[] | null {
  // A dotted IPv4 tail (`::ffff:169.254.169.254`, as a resolver may write
  // it) is the last two groups.
  const host = address.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) =>
      `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`,
  );
  const [head, tail, ...rest] = host.split("::");
  if (rest.length > 0) return null;
  const parse = (part: string | undefined) =>
    part ? part.split(":").map(g => parseInt(g, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  if (tail === undefined && left.length !== 8) return null;
  const groups = [
    ...left,
    ...new Array(8 - left.length - right.length).fill(0),
    ...right,
  ];
  return groups.length === 8 &&
    groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * The IPv4 address an IPv6 literal carries in its last 32 bits: mapped
 * (`::ffff:a.b.c.d`), compatible (`::a.b.c.d`) or NAT64 (`64:ff9b::`).
 * Node writes them in hex (`::ffff:a9fe:a9fe`).
 */
function embeddedV4(host: string): string | null {
  const groups = v6Groups(host);
  if (!groups) return null;
  const zero = (from: number, to: number) =>
    groups.slice(from, to).every(g => g === 0);
  const mapped = zero(0, 5) && (groups[5] === 0xffff || groups[5] === 0);
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6);
  if (!mapped && !nat64) return null;
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join(".");
}

/**
 * The endpoint, checked: http or https, never a cloud metadata name or a
 * private or link-local IP literal.
 */
export function checkEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid GraphQL endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The GraphQL endpoint must be http or https: ${endpoint}`);
  }
  // A trailing dot names the same host to DNS (`metadata.google.internal.`).
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  const metadata =
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal");
  if (metadata || addressBlocked(host)) {
    throw new Error(
      `The GraphQL endpoint points at a private or metadata address: ${host}`,
    );
  }
  return url;
}

/**
 * A private, link-local, CGNAT or unspecified address, in IPv4 or IPv6
 * form (an IPv4 inside IPv6 included). Loopback is not: it reaches only
 * the box.
 */
export function addressBlocked(address: string): boolean {
  const host = address.toLowerCase();
  if (!host.includes(":")) return v4Blocked(host);
  return (
    /^f[cd]/.test(host) ||
    /^fe[89ab]/.test(host) ||
    host === "::" ||
    v4Blocked(embeddedV4(host) ?? "")
  );
}

/**
 * Every address a host name resolves to, checked. A literal was checked by
 * `checkEndpoint`. A name pointing at a private address (`10.0.0.5` behind a
 * public DNS name) fails here, before any request carries the headers.
 */
export async function checkResolved(
  url: URL,
  resolve: (host: string) => Promise<Array<{ address: string }>> = host =>
    lookup(host, { all: true, verbatim: true }),
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  const addresses = await resolve(host);
  const blocked = addresses.find(a => addressBlocked(a.address));
  if (blocked) {
    throw new Error(
      `The GraphQL endpoint ${host} resolves to a private or metadata address: ${blocked.address}`,
    );
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface GraphqlResponse {
  data?: unknown;
  errors?: Array<{ message?: string }>;
  [key: string]: unknown;
}

/** A redirect: refused, never followed, never retried. */
export class GraphqlRedirectError extends Error {
  constructor(url: string) {
    super(
      `The GraphQL endpoint ${url} answered with a redirect. Set the endpoint to the URL it redirects to.`,
    );
    this.name = "GraphqlRedirectError";
  }
}

function isRedirect(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } })?.cause;
  return (
    error instanceof TypeError &&
    typeof cause?.message === "string" &&
    /redirect/i.test(cause.message)
  );
}

export class GraphqlClient {
  private resolved = false;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly log: (message: string) => void;

  constructor(
    config: { endpoint?: unknown; headers?: unknown },
    log: (message: string) => void = () => {},
  ) {
    if (!config.endpoint) throw new Error("GraphQL endpoint not configured");
    this.url = checkEndpoint(String(config.endpoint)).toString();
    this.headers = buildHeaders(config.headers);
    this.log = log;
  }

  /** One POST; the body as JSON, or the raw text when it is not JSON. */
  async post(body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.resolved) {
      try {
        await checkResolved(new URL(this.url));
      } catch (error) {
        // A name that does not resolve is a network failure, as in-process.
        throw isNetworkFailure(error) ? new GraphqlNetworkError(error) : error;
      }
      this.resolved = true;
    }
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        // A redirect could lead anywhere, the checks above notwithstanding.
        redirect: "error",
      });
    } catch (error) {
      if (isRedirect(error)) throw new GraphqlRedirectError(this.url);
      throw isNetworkFailure(error) ? new GraphqlNetworkError(error) : error;
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new GraphqlNetworkError(error);
    }
    if (!response.ok) {
      throw new GraphqlHttpError(
        response.status,
        text,
        response.headers.get("retry-after"),
      );
    }
    try {
      return text ? JSON.parse(text) : "";
    } catch {
      return text;
    }
  }

  /** `executeGraphQLQuery`: errors and a missing `data` fail the query. */
  async query(
    query: string,
    variables: Record<string, unknown> | undefined,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<GraphqlResponse> {
    const data = (await this.post({ query, variables }, timeoutMs)) as
      GraphqlResponse | string;
    const payload = (
      typeof data === "object" && data ? data : {}
    ) as GraphqlResponse;
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const message = payload.errors.map(err => err?.message).join(", ");
      throw new Error(`GraphQL errors: ${message}`);
    }
    if (!payload.data) throw new Error("GraphQL response missing data field");
    return payload;
  }

  /** `executeWithRetry`: the in-process waits, attempt for attempt. */
  async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = MAX_RETRIES,
  ): Promise<T> {
    let attempts = 0;
    while (attempts <= maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempts++;
        if (attempts > maxRetries) throw error;
        let delay: number;
        if (error instanceof GraphqlHttpError && error.status === 429) {
          delay = error.retryAfter
            ? parseInt(error.retryAfter, 10) * 1000
            : 1000 * 2 ** attempts;
        } else if (
          error instanceof GraphqlNetworkError ||
          (error instanceof GraphqlHttpError && error.status >= 500)
        ) {
          delay = 500 * 2 ** attempts;
        } else {
          throw error;
        }
        const status =
          error instanceof GraphqlHttpError ? error.status : "network";
        this.log(
          `GraphQL ${status}; retrying in ${delay}ms (${attempts}/${maxRetries})`,
        );
        // `setTimeout(NaN)` waits about 1 ms, as an unparsable
        // `Retry-After` does in-process.
        await sleep(Number.isNaN(delay) ? 1 : delay);
      }
    }
    throw new Error("Max retries exceeded");
  }
}
