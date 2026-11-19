/**
 * Retry with exponential backoff for transient connection failures and cold
 * starts (connect/ping only: a query with side effects is never re-run).
 */
import { loggers } from "../logging";

const logger = loggers.db();

/**
 * Options for the retry utility
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in milliseconds (doubles with each retry) */
  baseDelayMs: number;
  /** Optional: only retry if error matches these patterns */
  retryableErrorPatterns?: RegExp[];
  /** Optional: abort signal to cancel retries */
  signal?: AbortSignal;
}

/**
 * Default patterns for retryable connection errors
 * These indicate transient failures that may succeed on retry
 */
const DEFAULT_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  // Connection errors
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /ENETUNREACH/i,
  /EHOSTUNREACH/i,
  /EAI_AGAIN/i,
  // Timeout errors
  /timeout/i,
  /timed out/i,
  // Connection closed/reset
  /connection.*closed/i,
  /connection.*reset/i,
  /connection.*terminated/i,
  /socket hang up/i,
  // Server temporarily unavailable (cold start)
  /service unavailable/i,
  /503/i,
  /502/i,
  /temporarily unavailable/i,
  // ClickHouse specific
  /Code: 159/i, // TIMEOUT_EXCEEDED
  /Code: 209/i, // SOCKET_TIMEOUT
  /Code: 210/i, // NETWORK_ERROR
];

/**
 * Patterns for errors that should NOT be retried
 * These indicate permanent failures (syntax errors, auth issues, etc.)
 */
const NON_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  // SQL syntax errors
  /syntax error/i,
  /parse error/i,
  // Authentication/authorization
  /authentication failed/i,
  /access denied/i,
  /permission denied/i,
  /unauthorized/i,
  /invalid.*password/i,
  /invalid.*credentials/i,
  // Invalid queries
  /unknown.*table/i,
  /unknown.*column/i,
  /unknown.*database/i,
  /does not exist/i,
  /no such/i,
  // Query cancelled by user
  /cancelled/i,
  /aborted/i,
];

/**
 * Check if an error is retryable based on error patterns
 */
export function isRetryableError(
  error: Error,
  customPatterns?: RegExp[],
): boolean {
  const errorMessage = error.message || "";
  const errorName = error.name || "";
  const fullErrorString = `${errorName}: ${errorMessage}`;

  // First check if it's explicitly non-retryable
  for (const pattern of NON_RETRYABLE_ERROR_PATTERNS) {
    if (pattern.test(fullErrorString)) {
      return false;
    }
  }

  // Then check if it matches retryable patterns
  const patterns = customPatterns || DEFAULT_RETRYABLE_ERROR_PATTERNS;
  for (const pattern of patterns) {
    if (pattern.test(fullErrorString)) {
      return true;
    }
  }

  return false;
}

/**
 * The warehouse ran out of memory, slots or time for one query. The same
 * query can pass a few minutes later, once the cluster's other load is gone.
 * On 19 Nov 2026, 3 scheduled ClickHouse bindings hit "memory limit exceeded
 * ... OvercommitTracker" and served day-old data.
 */
const RESOURCE_EXHAUSTED_ERROR_PATTERNS: RegExp[] = [
  // ClickHouse
  /MEMORY_LIMIT_EXCEEDED/i,
  /memory limit exceeded/i,
  /OvercommitTracker/i,
  /Code: 241/i, // MEMORY_LIMIT_EXCEEDED
  /TIMEOUT_EXCEEDED/i,
  /Code: 159/i, // TIMEOUT_EXCEEDED
  // BigQuery
  /Resources exceeded/i,
  // Postgres
  /out of memory/i,
  /statement timeout/i,
  // Generic timeouts
  /timeout/i,
  /timed out/i,
];

/**
 * Did a query fail because the warehouse lacked resources (memory, slots,
 * time)? Errors the classifier above calls permanent never match.
 */
export function isResourceExhaustedError(error: unknown): boolean {
  const err = error instanceof Error ? error : new Error(String(error));
  return isRetryableError(err, RESOURCE_EXHAUSTED_ERROR_PATTERNS);
}

/**
 * Execute a function with retry logic and exponential backoff
 * Used for transient connection failures and cold starts
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, retryableErrorPatterns, signal } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if cancelled
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if this is the last attempt
      if (attempt >= maxRetries) {
        break;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(lastError, retryableErrorPatterns)) {
        break;
      }

      // Calculate delay with exponential backoff
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      logger.debug("Retry attempt failed, retrying", {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        error: lastError.message,
        delayMs,
      });

      // Wait before retrying
      await new Promise<void>((resolve, reject) => {
        const abortHandler = () => {
          clearTimeout(timeoutId);
          reject(new Error("Operation cancelled"));
        };

        const timeoutId = setTimeout(() => {
          // Clean up abort listener when timeout completes normally
          if (signal) {
            signal.removeEventListener("abort", abortHandler);
          }
          resolve();
        }, delayMs);

        if (signal) {
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      });
    }
  }

  throw lastError;
}
