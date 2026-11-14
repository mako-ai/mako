/**
 * The one retry policy for connector HTTP calls: exponential backoff with
 * full jitter, a hard attempt cap, and `Retry-After` honoured in both of
 * its forms.
 *
 * It replaces per-connector copies that had drifted apart: Calendly and
 * Wise defaulted a missing `Retry-After` to "1" (a flat 1 s wait, so the
 * exponential branch was unreachable), Claap to "60" (every 5xx waited a
 * minute), none retried network errors, and Close's eight hand-rolled 429
 * loops had no cap and parsed an HTTP-date `Retry-After` to NaN, which
 * `sleep(NaN)` turns into 0 ms: a tight loop against a rate-limited API.
 *
 * Retryable: HTTP 429, any 5xx, and network errors (no response: reset,
 * timeout, DNS). Everything else (4xx, programming errors, cancellation)
 * is thrown at once.
 */
import axios from "axios";

export interface HttpRetryOptions {
  /** Retries after the first attempt (so at most maxRetries + 1 calls). */
  maxRetries?: number;
  /** Backoff base: attempt n waits up to baseDelayMs * 2^n. */
  baseDelayMs?: number;
  /** Cap on a computed backoff delay. */
  maxDelayMs?: number;
  /** Cap on a server-requested `Retry-After` delay. */
  maxRetryAfterMs?: number;
  /** Pass the connector's own `sleep` so tests that stub it stay fast. */
  sleep?: (ms: number) => Promise<void>;
  /** Override what counts as retryable. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each wait (log here). */
  onRetry?: (info: RetryInfo) => void;
  /** Test seams. */
  random?: () => number;
  now?: () => number;
}

export interface RetryInfo {
  /** 1-based number of the retry about to happen. */
  attempt: number;
  delayMs: number;
  status?: number;
  /** True when the delay came from a `Retry-After` header. */
  fromRetryAfter: boolean;
  error: unknown;
}

export const HTTP_RETRY_DEFAULTS = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxRetryAfterMs: 5 * 60_000,
} as const;

/** Network-level failures worth retrying (Node and axios codes). */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_NETWORK",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** HTTP status of an axios-style or fetch-style error, if it has one. */
export function getErrorStatus(error: unknown): number | undefined {
  const err = asRecord(error);
  if (!err) return undefined;
  const response = asRecord(err.response);
  const status = response?.status ?? err.status ?? err.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** A header from an axios-style error response, case-insensitively. */
function getResponseHeader(error: unknown, name: string): unknown {
  const headers = asRecord(asRecord(asRecord(error)?.response)?.headers);
  if (!headers) return undefined;
  // AxiosHeaders exposes get(); plain objects are matched by hand.
  const getter = headers.get;
  if (typeof getter === "function") {
    const value = (getter as (n: string) => unknown).call(headers, name);
    if (value !== undefined && value !== null) return value;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * `Retry-After` in milliseconds: either delta-seconds (`"120"`, also
 * `"1.5"`) or an HTTP-date. Null when absent or unparseable — never NaN —
 * and never negative (a date in the past means "now").
 */
export function parseRetryAfter(
  header: unknown,
  now: number = Date.now(),
): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (value === "") return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  }
  // An HTTP-date always names a month; without this `Date.parse("-5")`
  // happily reads a bare number as a year.
  if (!/[a-z]/i.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function isNetworkError(error: unknown): boolean {
  if (axios.isCancel(error)) return false;
  const err = asRecord(error);
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code : undefined;
  const causeCode = asRecord(err.cause)?.code;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (typeof causeCode === "string" && RETRYABLE_NETWORK_CODES.has(causeCode)) {
    return true;
  }
  // An axios request that never got a response (and was not cancelled).
  return axios.isAxiosError(error) && !error.response && !!error.request;
}

/** The default policy: 429, 5xx, or a network error. */
export function isRetryableHttpError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status < 600);
  }
  return isNetworkError(error);
}

/**
 * Delay before retry number `attempt` (0-based): the server's
 * `Retry-After` when given (capped), else full jitter over an
 * exponentially growing window.
 */
export function computeRetryDelay(
  attempt: number,
  error: unknown,
  options: HttpRetryOptions = {},
): { delayMs: number; fromRetryAfter: boolean } {
  const baseDelayMs = options.baseDelayMs ?? HTTP_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? HTTP_RETRY_DEFAULTS.maxDelayMs;
  const maxRetryAfterMs =
    options.maxRetryAfterMs ?? HTTP_RETRY_DEFAULTS.maxRetryAfterMs;
  const retryAfterMs = parseRetryAfter(
    getResponseHeader(error, "retry-after"),
    (options.now ?? Date.now)(),
  );
  if (retryAfterMs !== null) {
    return {
      delayMs: Math.min(retryAfterMs, maxRetryAfterMs),
      fromRetryAfter: true,
    };
  }
  const window = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const random = options.random ?? Math.random;
  return { delayMs: Math.floor(random() * window), fromRetryAfter: false };
}

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** Run `fn`, retrying per the policy above. Throws the last error. */
export async function withHttpRetry<T>(
  fn: () => Promise<T>,
  options: HttpRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? HTTP_RETRY_DEFAULTS.maxRetries;
  const isRetryable = options.isRetryable ?? isRetryableHttpError;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const { delayMs, fromRetryAfter } = computeRetryDelay(
        attempt,
        error,
        options,
      );
      options.onRetry?.({
        attempt: attempt + 1,
        delayMs,
        status: getErrorStatus(error),
        fromRetryAfter,
        error,
      });
      await sleep(delayMs);
    }
  }
}
