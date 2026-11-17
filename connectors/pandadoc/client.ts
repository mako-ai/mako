/**
 * The PandaDoc HTTP client, with the in-process connector's retry policy
 * (`createRetryExecutor` over `api/src/connectors/base/http-retry.ts`):
 *
 * - `Authorization: API-Key <key>`;
 * - up to 5 retries on 429, 5xx and network errors, waiting the server's
 *   `Retry-After` when given (capped at 5 minutes), else full jitter over
 *   1 s doubling up to 60 s;
 * - errors read `HTTP <status>: <message or detail>`, as
 *   `formatPandaDocApiError` writes them.
 *
 * Two limits the in-process client does not have, because a box is killed
 * after 10 minutes: 60 s per attempt, and 4 minutes of backoff per process.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 */

export const PANDADOC_DEFAULT_BASE_URL = "https://api.pandadoc.com";

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

/** The vendor's own words from an error body, as the in-process connector reads them. */
function describeBody(data: unknown): string | undefined {
  if (typeof data === "string") return data || undefined;
  if (!data || typeof data !== "object") return undefined;
  const body = data as { message?: unknown; detail?: unknown };
  if (typeof body.message === "string") return body.message;
  if (typeof body.detail === "string") return body.detail;
  if (body.detail && typeof body.detail === "object") {
    return JSON.stringify(body.detail);
  }
  return undefined;
}

export class PandaDocHttpError extends Error {
  status: number;
  data: unknown;
  retryAfter: string | null;
  constructor(status: number, data: unknown, retryAfter: string | null) {
    super(
      `HTTP ${status}: ${describeBody(data) ?? `Request failed with status code ${status}`}`.slice(
        0,
        2_000,
      ),
    );
    this.name = "PandaDocHttpError";
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
  }
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

export interface PandaDocClient {
  get<T = unknown>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T>;
}

export interface PandaDocClientOptions {
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
  return PANDADOC_DEFAULT_BASE_URL;
}

export function createPandaDocClient(
  options: PandaDocClientOptions,
): PandaDocClient {
  if (!options.apiKey) throw new Error("PandaDoc API key not configured");
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const headers = {
    authorization: `API-Key ${options.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  let waited = 0;

  async function get<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
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
        if (response.ok) return data as T;
        error = new PandaDocHttpError(
          response.status,
          data,
          response.headers.get("retry-after"),
        );
      } catch (caught) {
        error = caught;
      }

      const status =
        error instanceof PandaDocHttpError ? error.status : undefined;
      const retryable =
        status === undefined ? isNetworkError(error) : retryableStatus(status);
      if (retry >= MAX_RETRIES || !retryable) throw error;

      const fromHeader =
        error instanceof PandaDocHttpError
          ? parseRetryAfter(error.retryAfter)
          : null;
      const delayMs =
        fromHeader !== null
          ? Math.min(fromHeader, MAX_RETRY_AFTER_MS)
          : Math.floor(
              random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
            );
      if (waited + delayMs > MAX_TOTAL_WAIT_MS) {
        log(
          `PandaDoc API GET ${path} -> ${status ?? String(error)}; ${waited} ms already spent waiting, giving the chunk back`,
        );
        throw error;
      }
      waited += delayMs;
      log(
        `PandaDoc API rate limited or server error, retrying (status ${status ?? "network"}, attempt ${retry + 1}, ${delayMs} ms)`,
      );
      await sleep(delayMs);
    }
  }

  return { get };
}
