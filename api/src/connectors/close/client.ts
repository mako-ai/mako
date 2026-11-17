/**
 * The Close HTTP client: basic auth with the API key, every verb through
 * the per-key rate gate and the shared retry policy, and a sync-log line per
 * request/response so a run's log explains where its time went.
 */
import axios, { AxiosInstance, AxiosResponse } from "axios";
import { loggers } from "../../logging";
import { throttledRequest } from "../rate-gate";
import {
  getErrorStatus,
  isRetryableHttpError,
  withHttpRetry,
} from "../base/http-retry";

const logger = loggers.connector("close");

export const CLOSE_DEFAULT_BASE_URL = "https://api.close.com/api/v1";

/**
 * Retries per Close request (shared policy in base/http-retry.ts). Close
 * rate limits are per key and frequent during bulk syncs, and its
 * Retry-After is honoured, so allow more than the default.
 */
const CLOSE_MAX_RETRIES = 8;

const MAX_CLOSE_ERROR_RESPONSE_LENGTH = 2_000;

export type CloseLogLevel = "debug" | "info" | "warn" | "error";

/** Emit a line to the active sync's log (no-op outside a sync). */
export type CloseSyncLog = (
  level: CloseLogLevel,
  message: string,
  metadata?: Record<string, unknown>,
) => void;

/**
 * Whether a Close request only reads, so repeating it is harmless: a GET,
 * the search API (a POST that reads), or a POST tunnelled as GET via
 * `x-http-method-override`.
 */
function isCloseReadRequest(
  method: string,
  endpoint: string,
  args: unknown[],
): boolean {
  if (method === "get") return true;
  if (method !== "post") return false;
  if (endpoint === "/data/search/") return true;
  const config = args[2] as { headers?: Record<string, unknown> } | undefined;
  const override = config?.headers?.["x-http-method-override"];
  return typeof override === "string" && override.toUpperCase() === "GET";
}

export function formatCloseApiErrorResponse(
  error: unknown,
): string | undefined {
  if (!axios.isAxiosError(error) || error.response?.data === undefined) {
    return undefined;
  }

  const responseData = error.response.data;
  const serialized =
    typeof responseData === "string"
      ? responseData
      : JSON.stringify(responseData);

  return serialized.length > MAX_CLOSE_ERROR_RESPONSE_LENGTH
    ? `${serialized.slice(0, MAX_CLOSE_ERROR_RESPONSE_LENGTH)}...`
    : serialized;
}

const WRAPPED_METHODS = ["get", "post", "put", "patch", "delete"];

export function createCloseClient(options: {
  apiKey: string;
  /** Minimum spacing between requests on this key's rate gate. */
  minDelayMs: number;
  /**
   * Requests on this key's gate at once, this one included. Entities of one
   * flow sync in parallel; with one slot, the ones in this process would
   * take turns and gain nothing. Default 1.
   */
  maxInFlight?: number;
  emitLog: CloseSyncLog;
  /** Late-bound so tests that stub `sleep` on the connector stay fast. */
  sleep: (ms: number) => Promise<void>;
}): AxiosInstance {
  const { apiKey, minDelayMs, emitLog, sleep } = options;
  const maxInFlight = options.maxInFlight ?? 1;
  // The rate gate's key as the connection proxy keys it (trimmed,
  // connections/callable.ts), so sync and proxy wait at one gate.
  const gateKey = String(apiKey).trim();

  const rawClient = axios.create({
    baseURL: CLOSE_DEFAULT_BASE_URL,
    auth: {
      username: apiKey,
      password: "",
    },
    headers: {
      "Content-Type": "application/json",
    },
  });

  // Wrap get/post/put/patch/delete through the per-API-key throttle
  // so concurrent flows sharing the same key don't blast the rate limit.
  const seqRef = { seq: 0 };

  return new Proxy(rawClient, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (
        typeof val !== "function" ||
        typeof prop !== "string" ||
        !WRAPPED_METHODS.includes(prop)
      ) {
        return val;
      }
      const method = prop.toUpperCase();
      return (...args: unknown[]) => {
        const endpoint = typeof args[0] === "string" ? args[0] : "";
        return withHttpRetry(
          () =>
            throttledRequest(
              gateKey,
              () => {
                const requestId = `close_req_${Date.now()}_${++seqRef.seq}`;
                emitLog("info", "Close API request sent", {
                  requestId,
                  method,
                  endpoint,
                });
                const startedAt = Date.now();

                return (val.apply(target, args) as Promise<AxiosResponse>).then(
                  response => {
                    emitLog("info", "Close API response received", {
                      requestId,
                      method,
                      endpoint,
                      status: response.status,
                      durationMs: Date.now() - startedAt,
                    });
                    return response;
                  },
                  (error: any) => {
                    emitLog("warn", "Close API request failed", {
                      requestId,
                      method,
                      endpoint,
                      status: error?.response?.status,
                      durationMs: Date.now() - startedAt,
                      error: axios.isAxiosError(error)
                        ? error.message
                        : String(error),
                      responseBody: formatCloseApiErrorResponse(error),
                    });
                    return Promise.reject(error);
                  },
                );
              },
              minDelayMs,
              "sync",
              { maxInFlight },
            ),
          {
            maxRetries: CLOSE_MAX_RETRIES,
            // Outside the gate: a backoff wait never holds it.
            sleep: ms => sleep(ms),
            // Reads retry on 429/5xx/network. A write is retried only
            // on 429 (not processed), never after a 5xx or a dropped
            // connection, which may have applied it.
            isRetryable: error =>
              isCloseReadRequest(prop, endpoint, args)
                ? isRetryableHttpError(error)
                : getErrorStatus(error) === 429,
            onRetry: ({ status, attempt, delayMs, fromRetryAfter }) => {
              emitLog("warn", "Close API rate limited or failed, retrying", {
                method,
                endpoint,
                status,
                attempt,
                delayMs,
                fromRetryAfter,
              });
              logger.warn("Close API request retrying", {
                endpoint,
                status,
                attempt,
                delayMs,
              });
            },
          },
        );
      };
    },
  });
}
