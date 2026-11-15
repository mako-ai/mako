/**
 * The Claap HTTP layer: the `X-Claap-Key` client, readable API errors, the
 * `{ result }` envelope and the daily-quota header.
 */
import axios, { AxiosInstance } from "axios";
import {
  formatHttpApiError,
  resolveConfiguredBaseUrl,
  type RetryExecutor,
} from "../base/http-client";

export const CLAAP_DEFAULT_BASE_URL = "https://api.claap.io";

/** What the Claap fetch and webhook modules read from the connector. */
export interface ClaapContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
  sleep(ms: number): Promise<void>;
  /** The connection's sync batch size setting. */
  batchSize(): number;
  /** The connection's rate-limit delay setting. */
  rateLimitDelay(): number;
  /** `config.recordings_lookback_days` as stored. */
  recordingsLookbackDays(): unknown;
  /** Download a signed transcript link (overridable for tests). */
  downloadSignedUrl(url: string): Promise<string>;
}

export function resolveClaapBaseUrl(configured: unknown): string {
  return resolveConfiguredBaseUrl(configured, CLAAP_DEFAULT_BASE_URL);
}

export function createClaapClient(
  baseURL: string,
  apiKey: string,
): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      "X-Claap-Key": apiKey,
      "Content-Type": "application/json",
    },
  });
}

/** Remaining calls of the workspace's daily quota, from response headers. */
export function readDailyRemaining(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "x-ratelimit-daily-remaining") continue;
    const parsed = Number(Array.isArray(value) ? value[0] : value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Claap wraps most bodies in `{ result }`. */
export function extractClaapResult(data: unknown): unknown {
  if (data && typeof data === "object" && "result" in data) {
    return (data as { result: unknown }).result;
  }
  return data;
}

function describeClaapErrorBody(raw: unknown): string | undefined {
  const data = raw as
    { error?: { message?: string }; message?: string } | string | undefined;

  const directError =
    typeof data === "string"
      ? data
      : typeof data?.error?.message === "string"
        ? data.error.message
        : typeof data?.message === "string"
          ? data.message
          : undefined;

  const serialized =
    !directError && data && typeof data === "object"
      ? JSON.stringify(data)
      : undefined;

  return directError || serialized;
}

export function formatClaapApiError(error: unknown): string {
  return formatHttpApiError(error, describeClaapErrorBody);
}
