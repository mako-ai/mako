/**
 * Small HTTP building blocks every REST connector re-implemented: reading a
 * header case-insensitively, resolving the configurable API base URL,
 * clamping a page size, turning an axios error into one readable line, and
 * a retrying executor over the shared policy in http-retry.ts.
 */
import axios from "axios";
import type { Logger } from "@logtape/logtape";
import { withHttpRetry } from "./http-retry";

export type HeaderBag = Record<string, string | string[] | undefined>;

/** A header value by name, ignoring case; the first one when repeated. */
export function headerValue(
  headers: HeaderBag | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * The connection's `api_base_url` when set (trimmed, no trailing slash),
 * else the vendor default.
 */
export function resolveConfiguredBaseUrl(
  configured: unknown,
  fallback: string,
): string {
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, "");
  }
  return fallback;
}

/**
 * A page size in [1, max]. `requested ?? fallback` is not enough: `??` lets
 * a 0 through, which most APIs reject with a 400.
 */
export function clampPageSize(
  requested: number | undefined,
  fallback: number,
  max: number,
): number {
  const size =
    typeof requested === "number" && requested > 0 ? requested : fallback;
  return Math.min(Math.max(size, 1), max);
}

/**
 * One line for an API failure: `HTTP <status>: <detail>`, where `detail`
 * comes from the vendor-specific `describe` of the response body and falls
 * back to the axios message. Non-axios errors are their message.
 */
export function formatHttpApiError(
  error: unknown,
  describe: (data: unknown) => string | undefined,
): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = describe(error.response?.data) || error.message;
    return status ? `HTTP ${status}: ${detail}` : detail;
  }
  return error instanceof Error ? error.message : String(error);
}

export type RetryExecutor = <T>(
  fn: () => Promise<T>,
  maxRetries?: number,
) => Promise<T>;

/**
 * `executeWithRetry` as the connectors use it: the shared retry policy
 * (backoff with jitter, Retry-After, 429/5xx/network), a warn log per retry,
 * and — when `formatError` is given — the final axios error's message
 * replaced by the API's own error body (it stays an axios error, so callers
 * can still read `error.response.status`).
 */
export function createRetryExecutor(options: {
  /** Vendor name for the retry log line, e.g. "Calendly". */
  label: string;
  logger: Logger;
  /** Late-bound so tests that stub the connector's `sleep` stay fast. */
  sleep: (ms: number) => Promise<void>;
  formatError?: (error: unknown) => string;
}): RetryExecutor {
  const { label, logger, sleep, formatError } = options;
  return async <T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> => {
    try {
      return await withHttpRetry(fn, {
        maxRetries,
        sleep,
        onRetry: ({ status, attempt, delayMs }) =>
          logger.warn(`${label} API rate limited or server error, retrying`, {
            status,
            attempt,
            delayMs,
          }),
      });
    } catch (error) {
      if (formatError && axios.isAxiosError(error)) {
        error.message = formatError(error);
      }
      throw error;
    }
  };
}
