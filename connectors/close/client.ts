/**
 * The Close HTTP client, with the in-process connector's rate-limit policy
 * (`api/src/connectors/close/client.ts`, `rate-gate.ts`, `base/http-retry.ts`):
 *
 * - basic auth with the API key as the user name;
 * - one request in flight at a time, and the gate stays closed `minDelayMs`
 *   after each request completes (the in-process per-key gate, here per
 *   process: a box holds one connection, so one key);
 * - up to 8 retries on 429, 5xx and network errors, waiting the server's
 *   `Retry-After` when given (capped at 5 minutes), else full jitter over
 *   1 s doubling up to 60 s. Every Close call this connector makes is a
 *   read, so every retryable error is retried.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 */

export const CLOSE_DEFAULT_BASE_URL = "https://api.close.com/api/v1";

const MAX_RETRIES = 8;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_ERROR_BODY = 2_000;

export class CloseHttpError extends Error {
  status: number;
  data: unknown;
  retryAfter: string | null;
  constructor(
    status: number,
    endpoint: string,
    data: unknown,
    retryAfter: string | null,
  ) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    super(
      `Close API ${status} on ${endpoint}${body ? `: ${body.slice(0, MAX_ERROR_BODY)}` : ""}`,
    );
    this.name = "CloseHttpError";
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

const RETRYABLE_STATUS = (status: number) =>
  status === 429 || (status >= 500 && status < 600);

export interface CloseClient {
  get<T = any>(endpoint: string, params?: Record<string, unknown>): Promise<T>;
  post<T = any>(endpoint: string, body: unknown): Promise<T>;
}

export interface CloseClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Floor after each request: `max(500, rate_limit_delay_ms)` in-process. */
  minDelayMs: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export function createCloseClient(options: CloseClientOptions): CloseClient {
  const baseUrl = (options.baseUrl || CLOSE_DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const authorization = `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`;
  let gate: Promise<void> = Promise.resolve();

  /** One attempt, through the gate. */
  const attempt = (url: string, init: RequestInit): Promise<Response> => {
    const turn = gate.then(() => fetch(url, init));
    gate = turn.then(
      () => sleep(options.minDelayMs),
      () => sleep(options.minDelayMs),
    );
    return turn;
  };

  async function request<T>(
    method: "GET" | "POST",
    endpoint: string,
    params?: Record<string, unknown>,
    body?: unknown,
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    const url = `${baseUrl}${endpoint}${qs ? `?${qs}` : ""}`;
    const init: RequestInit = {
      method,
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    for (let retry = 0; ; retry++) {
      let error: unknown;
      try {
        const response = await attempt(url, init);
        const text = await response.text();
        let data: unknown = text;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          // Not JSON: keep the text for the error message.
        }
        if (response.ok) return data as T;
        error = new CloseHttpError(
          response.status,
          endpoint,
          data,
          response.headers.get("retry-after"),
        );
      } catch (caught) {
        error = caught;
      }

      const status = error instanceof CloseHttpError ? error.status : undefined;
      const retryable = status === undefined || RETRYABLE_STATUS(status);
      if (retry >= MAX_RETRIES || !retryable) throw error;

      const fromHeader =
        error instanceof CloseHttpError
          ? parseRetryAfter(error.retryAfter)
          : null;
      const delayMs =
        fromHeader !== null
          ? Math.min(fromHeader, MAX_RETRY_AFTER_MS)
          : Math.floor(
              random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
            );
      log(
        `Close API ${method} ${endpoint} -> ${status ?? String(error)}; retry ${retry + 1}/${MAX_RETRIES} in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }

  return {
    get: (endpoint, params) => request("GET", endpoint, params),
    post: (endpoint, body) => request("POST", endpoint, undefined, body),
  };
}

export const isHttp400 = (error: unknown): boolean =>
  error instanceof CloseHttpError && error.status === 400;

/** Close's "cursor expired or past its limit" answer. */
export function isCloseSearchCursorError(error: unknown): boolean {
  return (
    isHttp400(error) &&
    Boolean(((error as CloseHttpError).data as any)?.["field-errors"]?.cursor)
  );
}
