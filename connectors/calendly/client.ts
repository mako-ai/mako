/**
 * The Calendly HTTP client and record helpers, with the in-process
 * connector's policy (`api/src/connectors/calendly/client.ts` and
 * `base/http-retry.ts`):
 *
 * - bearer auth with the connection's token;
 * - up to 5 retries on 429, 5xx and network errors, waiting the server's
 *   `Retry-After` when given (capped at 5 minutes), else full jitter over
 *   1 s doubling up to 60 s. No request floor: in-process pauses only
 *   between pages (`rate_limit_delay_ms`), and so does this folder.
 *
 * Two limits the in-process client does not have, because a box is killed
 * after 10 minutes: 60 s per attempt, and 4 minutes of backoff per process.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 */

export const CALENDLY_DEFAULT_BASE_URL = "https://api.calendly.com";
export const CALENDLY_MAX_PAGE_LIMIT = 100;

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_ERROR_BODY = 2_000;
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
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

type CalendlyErrorBody = {
  message?: string;
  title?: string;
  details?: Array<{ message?: string; parameter?: string }>;
};

/** The in-process `describeCalendlyErrorBody`: message or title, then details. */
function describeErrorBody(raw: unknown): string | undefined {
  const data = raw as CalendlyErrorBody | string | undefined;
  const direct =
    typeof data === "string"
      ? data
      : typeof data?.message === "string"
        ? data.message
        : typeof data?.title === "string"
          ? data.title
          : undefined;
  const details = Array.isArray((data as { details?: unknown[] })?.details)
    ? (data as Required<Pick<CalendlyErrorBody, "details">>).details
        .map(d => `${d.parameter ?? "?"}: ${d.message ?? "?"}`)
        .join("; ")
    : undefined;
  return [direct, details].filter(Boolean).join(" — ") || undefined;
}

export class CalendlyHttpError extends Error {
  status: number;
  data: unknown;
  retryAfter: string | null;
  constructor(
    status: number,
    path: string,
    data: unknown,
    retryAfter: string | null,
  ) {
    const detail =
      describeErrorBody(data) ??
      (typeof data === "string" ? data : JSON.stringify(data ?? ""));
    super(
      `HTTP ${status} on ${path}: ${String(detail).slice(0, MAX_ERROR_BODY)}`,
    );
    this.name = "CalendlyHttpError";
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

/**
 * The base URL the token may be sent to: the in-process default, or a
 * configured `api_base_url` (trimmed, no trailing slash). Tenant config
 * reaches the box unfiltered, so only Calendly itself or a loopback address
 * (the fixture server) is honoured; anything else is refused, never used.
 */
export function calendlyBaseUrl(configured: unknown): string {
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return CALENDLY_DEFAULT_BASE_URL;
  }
  const value = configured.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("api_base_url is not a URL");
  }
  const calendly =
    url.protocol === "https:" && url.hostname === "api.calendly.com";
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!calendly && !loopback) {
    throw new Error(
      "api_base_url must be https://api.calendly.com or a loopback address",
    );
  }
  return value;
}

/** A network failure, named: fetch's own message is only "fetch failed". */
function described(error: unknown, path: string): unknown {
  if (error instanceof CalendlyHttpError || !(error instanceof Error)) {
    return error;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })
    .cause;
  const detail = cause?.code ?? cause?.message;
  return detail
    ? new Error(
        `Calendly API GET ${path} failed: ${error.message} (${String(detail)})`,
        {
          cause: error,
        },
      )
    : error;
}

export interface CalendlyClient {
  readonly baseUrl: string;
  get<T = any>(
    path: string,
    params?: Record<string, string | number | undefined | null>,
  ): Promise<T>;
}

export interface CalendlyClientOptions {
  token: string;
  baseUrl: string;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export function createCalendlyClient(
  options: CalendlyClientOptions,
): CalendlyClient {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  let waited = 0;

  async function get<T>(
    path: string,
    params?: Record<string, string | number | undefined | null>,
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    const url = `${options.baseUrl}${path}${qs ? `?${qs}` : ""}`;

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
        error = new CalendlyHttpError(
          response.status,
          path,
          data,
          response.headers.get("retry-after"),
        );
      } catch (caught) {
        error = caught;
      }

      const status =
        error instanceof CalendlyHttpError ? error.status : undefined;
      const retryable =
        status === undefined ? isNetworkError(error) : RETRYABLE_STATUS(status);
      if (retry >= MAX_RETRIES || !retryable) throw described(error, path);

      const fromHeader =
        error instanceof CalendlyHttpError
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
          `Calendly API GET ${path} -> ${status ?? String(error)}; ${waited} ms already spent waiting, giving the chunk back`,
        );
        throw described(error, path);
      }
      waited += delayMs;
      log(
        `Calendly API rate limited or server error, retrying: GET ${path} -> ${status ?? String(error)}; retry ${retry + 1}/${MAX_RETRIES} in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }

  return { baseUrl: options.baseUrl, get };
}

/**
 * The path of an API-returned URI, refusing any URI outside the configured
 * base so the token is never sent to another host.
 */
export function calendlyRelativePath(base: string, uri: string): string {
  if (!uri.startsWith(`${base}/`)) {
    throw new Error(
      `Refusing to call non-Calendly URL returned by API (expected base ${base})`,
    );
  }
  return uri.slice(base.length);
}

/** Calendly requires count in [1, 100]; a 0 or missing size falls back. */
export function calendlyPageCount(
  requested: unknown,
  fallback: number,
): number {
  const n = Number(requested);
  const size = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(Math.max(size, 1), CALENDLY_MAX_PAGE_LIMIT);
}

export type CalendlyListResponse<T = Record<string, unknown>> = {
  collection: T[];
  pagination: { next_page_token?: string | null; count?: number };
};

/** One list page; undefined/null params are left out. */
export async function fetchCalendlyPage<T = Record<string, unknown>>(
  api: CalendlyClient,
  path: string,
  params: Record<string, string | number | undefined | null>,
): Promise<CalendlyListResponse<T>> {
  const data = ((await api.get(path, params)) ?? {}) as Partial<
    CalendlyListResponse<T>
  >;
  return {
    collection: Array.isArray(data.collection) ? data.collection : [],
    pagination: data.pagination ?? {},
  };
}

export function uuidFromUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length === 0) return "";
  const trimmed = uri.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** A record keyed by its URI's last segment when it has no `id`. */
export function withId(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record == null) return record;
  if (typeof record.id === "string" && record.id.length > 0) return record;
  const id = uuidFromUri(record.uri);
  return id ? { ...record, id } : record;
}

/** An organization membership with its embedded user flattened. */
export function flattenMembership(
  membership: Record<string, unknown>,
): Record<string, unknown> {
  const user =
    membership.user && typeof membership.user === "object"
      ? (membership.user as Record<string, unknown>)
      : undefined;
  return withId({
    ...membership,
    user_uri: user?.uri ?? null,
    user_email: user?.email ?? null,
    user_name: user?.name ?? null,
    user_slug: user?.slug ?? null,
    user_timezone: user?.timezone ?? null,
    user_scheduling_url: user?.scheduling_url ?? null,
    user_avatar_url: user?.avatar_url ?? null,
    user_locale: user?.locale ?? null,
  });
}
