/**
 * The Claap HTTP client, with the in-process connector's retry policy
 * (`createRetryExecutor` over `api/src/connectors/base/http-retry.ts`):
 *
 * - `X-Claap-Key: <key>`;
 * - up to 5 retries on 429, 5xx and network errors, waiting the server's
 *   `Retry-After` when given (capped at 5 minutes), else full jitter over
 *   1 s doubling up to 60 s;
 * - every answer, error or not, carries the workspace's daily quota left
 *   (`x-ratelimit-daily-remaining`);
 * - errors read `HTTP <status>: <message>`, as `formatClaapApiError` writes
 *   them.
 *
 * Two limits the in-process client does not have, because a box is killed
 * after 10 minutes: 60 s per attempt, and 4 minutes of backoff per process.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 */

export const CLAAP_DEFAULT_BASE_URL = "https://api.claap.io";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOTAL_WAIT_MS = 4 * 60_000;

/** Network failures worth retrying, as `base/http-retry.ts` lists them. */
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
]);

export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  if (error.name === "TypeError" && error.message === "fetch failed") {
    return true;
  }
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

/** The vendor's own words from an error body, as `describeClaapErrorBody`. */
function describeBody(data: unknown): string | undefined {
  if (typeof data === "string") return data || undefined;
  if (!data || typeof data !== "object") return undefined;
  const body = data as { error?: { message?: unknown }; message?: unknown };
  if (typeof body.error?.message === "string") return body.error.message;
  if (typeof body.message === "string") return body.message;
  return JSON.stringify(data);
}

/** Remaining calls of the workspace's daily quota, from response headers. */
export function readDailyRemaining(
  headers: Headers | null,
): number | undefined {
  const value = headers?.get("x-ratelimit-daily-remaining");
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class ClaapHttpError extends Error {
  status: number;
  data: unknown;
  headers: Headers;
  constructor(status: number, data: unknown, headers: Headers) {
    super(
      `HTTP ${status}: ${describeBody(data) ?? `Request failed with status code ${status}`}`,
    );
    this.name = "ClaapHttpError";
    this.status = status;
    this.data = data;
    this.headers = headers;
  }
}

/** `formatClaapApiError`: an HTTP error's line, else the error's message. */
export function formatClaapError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Claap wraps most bodies in `{ result }`. */
export function extractClaapResult(data: unknown): unknown {
  if (data && typeof data === "object" && "result" in data) {
    return (data as { result: unknown }).result;
  }
  return data;
}

/** `Retry-After` in ms: delta-seconds or an HTTP-date. Null if unusable. */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (value === null) return null;
  const raw = value.trim();
  if (raw === "") return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  if (!/[a-z]/i.test(raw)) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const retryableStatus = (status: number) =>
  status === 429 || (status >= 500 && status < 600);

export interface ClaapResponse<T = unknown> {
  data: T;
  headers: Headers;
}

export interface ClaapClient {
  get<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<ClaapResponse<T>>;
}

export interface ClaapClientOptions {
  apiKey: string;
  baseUrl?: string;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** `api_base_url` trimmed, without a trailing slash; the default when unset. */
export function resolveBaseUrl(configured: unknown): string {
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, "");
  }
  return CLAAP_DEFAULT_BASE_URL;
}

export function createClaapClient(options: ClaapClientOptions): ClaapClient {
  if (!options.apiKey) throw new Error("Claap API key not configured");
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const headers = {
    "x-claap-key": options.apiKey,
    "content-type": "application/json",
    accept: "application/json",
  };
  let waited = 0;

  async function get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<ClaapResponse<T>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;

    for (let retry = 0; ; retry++) {
      let error: unknown;
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let data: unknown = text;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          // Not JSON: keep the text for the error message.
        }
        if (response.ok) return { data: data as T, headers: response.headers };
        error = new ClaapHttpError(response.status, data, response.headers);
      } catch (caught) {
        error = caught;
      }

      const status = error instanceof ClaapHttpError ? error.status : undefined;
      const retryable =
        status === undefined ? isNetworkError(error) : retryableStatus(status);
      if (retry >= MAX_RETRIES || !retryable) throw error;

      const fromHeader =
        error instanceof ClaapHttpError
          ? parseRetryAfter(error.headers.get("retry-after"))
          : null;
      const delayMs =
        fromHeader !== null
          ? Math.min(fromHeader, MAX_RETRY_AFTER_MS)
          : Math.floor(
              random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
            );
      if (waited + delayMs > MAX_TOTAL_WAIT_MS) {
        log(
          `Claap API GET ${path} -> ${status ?? String(error)}; ${waited} ms already spent waiting, giving the chunk back`,
        );
        throw error;
      }
      waited += delayMs;
      log(
        `Claap API rate limited or server error, retrying (status ${status ?? "network"}, attempt ${retry + 1}, ${delayMs} ms)`,
      );
      await sleep(delayMs);
    }
  }

  return { get };
}
