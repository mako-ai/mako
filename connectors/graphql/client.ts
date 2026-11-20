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
 * It sends through the SDK's `safeRequest`: the socket's own `lookup`
 * checks every resolved address and the connection uses the address it
 * checked, so DNS rebinding finds no window. Only public unicast and
 * loopback (which reaches only the box) are allowed. A redirect is refused.
 */

import {
  SafeRequestError,
  checkUrl,
  isBlockedAddress,
  safeRequest,
} from "@makoai/connector-sdk";
import type { SafeRequestOptions } from "@makoai/connector-sdk";

/** The address policy, with loopback allowed: it reaches only the box. */
export const addressBlocked = (address: string): boolean =>
  isBlockedAddress(address, { allowLoopback: true });

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

/**
 * The endpoint, checked: http or https, never a cloud metadata name or a
 * blocked IP literal. A host name is checked by the socket's own lookup
 * inside `safeRequest`, where the address checked is the address used.
 * Loopback is allowed: it reaches only the box.
 */
export function checkEndpoint(endpoint: string): URL {
  try {
    new URL(endpoint);
  } catch {
    throw new Error("Invalid GraphQL endpoint URL");
  }
  try {
    return checkUrl(endpoint, { allowLoopback: true });
  } catch (error) {
    if (error instanceof SafeRequestError && error.code === "BLOCKED_HOST") {
      throw new Error(
        `The GraphQL endpoint points at a private or metadata address: ${error.message.split(": ").pop()}`,
      );
    }
    if (error instanceof SafeRequestError && error.code === "BAD_URL") {
      // The SDK's message names the origin and path only: no userinfo, no query.
      throw new Error(error.message);
    }
    throw error;
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
    // Origin and path only: the query string can carry a token.
    let shown = "The GraphQL endpoint";
    try {
      const u = new URL(url);
      shown = `The GraphQL endpoint ${u.origin}${u.pathname}`;
    } catch {
      // keep the generic wording
    }
    super(
      `${shown} answered with a redirect. Set the endpoint to the URL it redirects to.`,
    );
    this.name = "GraphqlRedirectError";
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class GraphqlClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly log: (message: string) => void;
  private readonly resolve: SafeRequestOptions["resolve"];

  constructor(
    config: { endpoint?: unknown; headers?: unknown },
    log: (message: string) => void = () => {},
    resolve?: SafeRequestOptions["resolve"],
  ) {
    this.resolve = resolve;
    if (!config.endpoint) throw new Error("GraphQL endpoint not configured");
    this.url = checkEndpoint(String(config.endpoint)).toString();
    this.headers = buildHeaders(config.headers);
    this.log = log;
  }

  /** One POST; the body as JSON, or the raw text when it is not JSON. */
  async post(body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    let status: number;
    let text: string;
    let retryAfter: string | null;
    try {
      // One request, resolved and checked inside the socket's own lookup.
      // Every header is a credential as far as redirects go, and a redirect
      // is refused below, never followed.
      const response = await safeRequest(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        timeoutMs,
        allowLoopback: true,
        followRedirects: false,
        secretHeaders: Object.keys(this.headers),
        resolve: this.resolve,
      });
      status = response.status;
      text = response.text;
      retryAfter = response.headers["retry-after"] ?? null;
    } catch (error) {
      throw error instanceof SafeRequestError || !isNetworkFailure(error)
        ? error
        : new GraphqlNetworkError(error);
    }
    if (REDIRECTS.has(status)) throw new GraphqlRedirectError(this.url);
    if (status < 200 || status > 299) {
      throw new GraphqlHttpError(status, text, retryAfter);
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
