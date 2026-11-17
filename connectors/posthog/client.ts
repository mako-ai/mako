/**
 * The PostHog HTTP client, with the in-process connector's policy
 * (`api/src/connectors/posthog/connector.ts`, `base/http-retry.ts`):
 *
 * - a personal API key goes in `Authorization: Bearer`, a project API key in
 *   `POSTHOG-API-TOKEN`, chosen by `auth_type`;
 * - up to 3 retries on 429, 5xx and network errors, waiting the server's
 *   `Retry-After` when given (capped at 5 minutes), else full jitter over
 *   1 s doubling up to 60 s. 4xx is thrown at once;
 * - 30 s per list request, 15 s for the `check` probe.
 *
 * One limit the in-process client does not have, because a box is killed
 * after 10 minutes: 4 minutes of backoff per process. Past it the request
 * fails and the chunk retries from its last state.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 */

export const POSTHOG_DEFAULT_BASE_URL = "https://app.posthog.com";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_TOTAL_WAIT_MS = 4 * 60_000;
const MAX_ERROR_BODY = 2_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const CHECK_TIMEOUT_MS = 15_000;

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

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

export class PosthogHttpError extends Error {
  status: number;
  retryAfter: string | null;
  constructor(
    status: number,
    endpoint: string,
    body: string,
    retryAfter: string | null,
  ) {
    super(
      `PostHog API ${status} on ${endpoint}${body ? `: ${body.slice(0, MAX_ERROR_BODY)}` : ""}`,
    );
    this.name = "PosthogHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof PosthogHttpError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  return isNetworkError(error);
}

/** `Retry-After` in ms: delta-seconds or an HTTP-date. Null when absent. */
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

function retryDelay(attempt: number, error: unknown): number {
  const retryAfter =
    error instanceof PosthogHttpError
      ? parseRetryAfter(error.retryAfter)
      : null;
  if (retryAfter !== null) return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
  const window = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(Math.random() * window);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface PosthogClientConfig {
  api_key: string;
  project_id: string | number;
  api_base_url?: string;
  auth_type?: string;
}

export type Params = Record<string, string | number | boolean>;

export class PosthogClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private waited = 0;
  private readonly log: (message: string) => void;
  readonly projectId: string;

  constructor(
    config: PosthogClientConfig,
    log: (message: string) => void = () => {},
  ) {
    this.log = log;
    this.baseUrl = (config.api_base_url || POSTHOG_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.projectId = String(config.project_id);
    const authType = config.auth_type || "personal_api_key";
    this.headers = {
      "Content-Type": "application/json",
      ...(authType === "project_api_key"
        ? { "POSTHOG-API-TOKEN": config.api_key }
        : { Authorization: `Bearer ${config.api_key}` }),
    };
  }

  /** `/api/projects/<id>/<path>` */
  projectPath(path: string): string {
    return `/api/projects/${this.projectId}/${path}`;
  }

  async get<T>(
    path: string,
    params: Params,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return this.withRetry(path, () =>
      this.once<T>(url.toString(), path, { method: "GET" }, timeoutMs),
    );
  }

  /** One POST, never retried: the in-process HogQL probe is not either. */
  async post<T>(
    path: string,
    body: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return this.once<T>(
      `${this.baseUrl}${path}`,
      path,
      { method: "POST", body: JSON.stringify(body) },
      timeoutMs,
    );
  }

  private async once<T>(
    url: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: this.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PosthogHttpError(
        response.status,
        `${init.method} ${path}`,
        text,
        response.headers.get("retry-after"),
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private async withRetry<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= MAX_RETRIES || !isRetryable(error)) throw error;
        const delay = retryDelay(attempt, error);
        if (this.waited + delay > MAX_TOTAL_WAIT_MS) throw error;
        this.waited += delay;
        const status =
          error instanceof PosthogHttpError ? error.status : "network";
        this.log(
          `PostHog ${path} -> ${status}; retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(delay);
      }
    }
  }
}
