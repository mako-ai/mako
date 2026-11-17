/**
 * The Wise HTTP client, with the in-process connector's retry policy
 * (`api/src/connectors/base/http-retry.ts`, through `createRetryExecutor`):
 *
 * - `Authorization: Bearer <token>`, JSON;
 * - up to 5 retries on 429, 5xx and network errors, waiting the server's
 *   `Retry-After` when given (capped at 5 minutes), else full jitter over
 *   1 s doubling up to 60 s;
 * - any other status is thrown at once, as `WiseHttpError`, with the
 *   in-process error line (`HTTP <status>: <Wise's message>`).
 *
 * Two limits the in-process client does not have, because a box is killed
 * after 10 minutes: 60 s per attempt, and 4 minutes of backoff per process.
 *
 * Strong customer authentication (SCA) is `sendWithSca`: a 403 that carries
 * `x-2fa-approval` is retried once with that one-time token signed
 * (SHA256withRSA) by the connection's private key, as in-process.
 *
 * It uses `fetch` and `node:crypto`, not axios: the folder needs no
 * dependency.
 */
import crypto from "node:crypto";

export const WISE_DEFAULT_BASE_URL = "https://api.wise.com";

/** Hosts the token may be sent to, besides a loopback address. */
const WISE_HOSTS = new Set([
  "api.wise.com",
  "api.transferwise.com",
  "api.sandbox.transferwise.tech",
  "sandbox.transferwise.tech",
  "api.sandbox.wise.com",
  "sandbox.wise.com",
]);

const SANDBOX_HOST_MARKERS = [
  "sandbox.transferwise.tech",
  "api.sandbox.transferwise",
  "sandbox.wise.com",
];

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOTAL_WAIT_MS = 4 * 60_000;

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

/**
 * The connection's `api_base_url`, trimmed and without a trailing slash, or
 * Wise's production API. Only Wise's own hosts (production or sandbox, over
 * https) and a loopback address (the fixture server) are honoured: the
 * stored token must not follow a URL a connection editor typed.
 */
export function wiseBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return WISE_DEFAULT_BASE_URL;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("api_base_url is not a URL");
  }
  const wise = url.protocol === "https:" && WISE_HOSTS.has(url.hostname);
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!wise && !loopback) {
    throw new Error(
      "api_base_url must be https://api.wise.com, a Wise sandbox host or a loopback address",
    );
  }
  return trimmed;
}

export function isWiseSandboxBaseUrl(baseUrl: string): boolean {
  const base = baseUrl.toLowerCase();
  return SANDBOX_HOST_MARKERS.some(marker => base.includes(marker));
}

/** The in-process `describeWiseErrorBody`. */
function describeWiseErrorBody(raw: unknown): string | undefined {
  const data = raw as
    | {
        error?: string;
        error_description?: string;
        message?: string;
        errors?: Array<{ code?: string; message?: string }>;
      }
    | string
    | undefined;
  const direct =
    typeof data === "string"
      ? data
      : typeof data?.error_description === "string"
        ? data.error_description
        : typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string"
            ? data.error
            : undefined;
  const nested = Array.isArray((data as { errors?: unknown[] })?.errors)
    ? (
        (data as { errors: Array<{ code?: string; message?: string }> })
          .errors ?? []
      )
        .map(e => `${e.code ?? "?"}: ${e.message ?? "?"}`)
        .join("; ")
    : undefined;
  return [direct, nested].filter(Boolean).join(" — ");
}

export class WiseHttpError extends Error {
  status: number;
  data: unknown;
  headers: Headers;
  constructor(status: number, data: unknown, headers: Headers) {
    super(
      `HTTP ${status}: ${describeWiseErrorBody(data) || `Request failed with status code ${status}`}`,
    );
    this.name = "WiseHttpError";
    this.status = status;
    this.data = data;
    this.headers = headers;
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

/** A 429, a 5xx, a network failure or a timed-out attempt: worth a later try. */
export function isTransientError(error: unknown): boolean {
  return error instanceof WiseHttpError
    ? RETRYABLE_STATUS(error.status)
    : isNetworkError(error);
}

/**
 * One request's limits. A webhook fill runs inside a box command that is
 * killed at 60 s, so it asks for one attempt (`once`) that ends with its
 * budget (`timeoutMs`), and answers a transient failure `deferred`.
 */
export interface GetOptions {
  once?: boolean;
  timeoutMs?: number;
}

export type Params = Record<string, string | number | undefined | null>;

export interface WiseClient {
  readonly baseUrl: string;
  get<T = unknown>(
    path: string,
    params?: Params,
    headers?: Record<string, string>,
    options?: GetOptions,
  ): Promise<T>;
}

export interface WiseClientOptions {
  token: string;
  baseUrl?: unknown;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export function createWiseClient(options: WiseClientOptions): WiseClient {
  const baseUrl = wiseBaseUrl(options.baseUrl);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? (() => {});
  /**
   * When this process first backed off. The budget is wall-clock time from
   * there: requests running at once (Calendly's invitee waves) wait side by
   * side, so adding their sleeps up would overcount.
   */
  let backoffStartedAt: number | undefined;

  async function get<T>(
    path: string,
    params?: Params,
    extraHeaders?: Record<string, string>,
    getOptions?: GetOptions,
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const init: RequestInit = {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        ...(extraHeaders ?? {}),
      },
    };

    for (let retry = 0; ; retry++) {
      let error: unknown;
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.min(
                REQUEST_TIMEOUT_MS,
                getOptions?.timeoutMs ?? REQUEST_TIMEOUT_MS,
              ),
            ),
          ),
        });
        const text = await response.text();
        let data: unknown = text;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          // Not JSON: keep the text for the error message.
        }
        if (response.ok) return data as T;
        error = new WiseHttpError(response.status, data, response.headers);
      } catch (caught) {
        error = caught;
      }

      const status = error instanceof WiseHttpError ? error.status : undefined;
      const retryable =
        status === undefined ? isNetworkError(error) : RETRYABLE_STATUS(status);
      if (retry >= MAX_RETRIES || !retryable || getOptions?.once) throw error;

      const fromHeader =
        error instanceof WiseHttpError
          ? parseRetryAfter(error.headers.get("retry-after"))
          : null;
      const delayMs =
        fromHeader !== null
          ? Math.min(fromHeader, MAX_RETRY_AFTER_MS)
          : Math.floor(
              random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
            );
      const nowMs = Date.now();
      backoffStartedAt ??= nowMs;
      const waited = nowMs - backoffStartedAt;
      if (waited + delayMs > MAX_TOTAL_WAIT_MS) {
        log(
          `Wise API GET ${path} -> ${status ?? String(error)}; ${waited} ms already spent waiting, giving the chunk back`,
        );
        throw error;
      }
      log(
        `Wise API rate limited or server error, retrying: GET ${path} -> ${status ?? String(error)}; retry ${retry + 1}/${MAX_RETRIES} in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }

  return { baseUrl, get };
}

/**
 * A PEM key as pasted into a single-line secret field, rebuilt so node's
 * crypto can read it. The in-process `normalizePemKey`.
 */
export function normalizePemKey(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  const match = text.match(
    /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/,
  );
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return (
    [`-----BEGIN ${match[1]}-----`, ...lines, `-----END ${match[1]}-----`].join(
      "\n",
    ) + "\n"
  );
}

/** SHA-256 of a private key's public half (DER), hex, 16 characters. */
export function publicKeyFingerprint(privatePem: string): string {
  const der = crypto
    .createPublicKey(privatePem)
    .export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export interface ScaMessages {
  noChallenge: string;
  noKey: string;
}

/**
 * The in-process `sendWithSca`: send, and answer a 403 `x-2fa-approval`
 * challenge once with the token signed by `privateKey`.
 */
export async function sendWithSca<T>(
  privateKey: unknown,
  send: (headers?: Record<string, string>) => Promise<T>,
  messages: ScaMessages,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    const approval =
      error instanceof WiseHttpError && error.status === 403
        ? (error.headers.get("x-2fa-approval") ?? undefined)
        : undefined;
    if (!approval) {
      if (error instanceof WiseHttpError && error.status === 403) {
        throw new Error(messages.noChallenge, { cause: error });
      }
      throw error;
    }
    if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
      throw new Error(messages.noKey, { cause: error });
    }
    const pem = normalizePemKey(privateKey);
    const signature = crypto
      .createSign("SHA256")
      .update(approval)
      .sign(pem, "base64");
    try {
      return await send({
        "x-2fa-approval": approval,
        "X-Signature": signature,
      });
    } catch (signedError) {
      const response =
        signedError instanceof WiseHttpError ? signedError : undefined;
      const result = response?.headers.get("x-2fa-approval-result");
      const body =
        typeof response?.data === "string"
          ? response.data
          : JSON.stringify(response?.data ?? "");
      throw new Error(
        `Wise refused the signed (SCA) request: HTTP ${response?.status ?? "?"}` +
          `, x-2fa-approval-result: ${result ?? "none"}` +
          `, signed with key ${publicKeyFingerprint(pem)}` +
          (body && body !== '""' ? `, body: ${body.slice(0, 300)}` : ""),
        { cause: signedError },
      );
    }
  }
}
