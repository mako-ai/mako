/**
 * Send one request to a connection's service with its credential, and give
 * back what the service answered without the credential in it.
 *
 * The path must stay under the connection's base URL (connections/callable.ts).
 * The request goes through the SSRF-hardened `safeRequest` (no private addresses, no
 * redirects followed) and waits at the key's rate gate. Response headers the
 * credential may travel in, cookies, and any header or body text holding a
 * secret value are removed.
 *
 * Who may send what is not decided here: see connections/proxy.service.ts.
 */
import {
  safeRequest,
  type SafeRequestResult,
} from "../services/safe-fetch.service";
import { throttledRequest } from "../connectors/rate-gate";
import { redactSecrets } from "./redact";
import type { ISourceConnection } from "../database/workspace-schema";
import {
  applyCredential,
  rateGateOf,
  secretsOf,
  type CallableConnection,
  type RequestShape,
} from "./callable";

/** A caller mistake or a refusal: the message is safe to show. */
export class ConnectionRequestError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ConnectionRequestError";
  }
}

export type QueryValue =
  string | number | boolean | Array<string | number | boolean>;

export interface ForwardInput {
  method: string;
  path: string;
  query?: Record<string, QueryValue | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the service answered JSON, else text. */
  body: unknown;
}

/** The connection as the proxy needs it, config already decrypted. */
type ForwardConnection = Pick<
  ISourceConnection,
  "_id" | "type" | "config" | "settings"
>;

type Transport = (
  url: string,
  options: Parameters<typeof safeRequest>[1],
) => Promise<SafeRequestResult>;

let transport: Transport = safeRequest;

/** Tests only: answer requests without a network. */
export function setTransportForTests(next: Transport | null): void {
  transport = next ?? safeRequest;
}

const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Headers a caller may never set: the credential and transport are Mako's. */
const CALLER_HEADER_BLOCKLIST = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  // A method override would turn a read into a write behind Mako's back.
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);

/** Response headers never passed back. */
const RESPONSE_HEADER_BLOCKLIST = new Set([
  "set-cookie",
  "set-cookie2",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "transfer-encoding",
  "connection",
  "content-encoding",
  "content-length",
]);

const MAX_PATH_LENGTH = 2048;

/**
 * The full URL of `path` under `baseUrl`, and the path relative to it as the
 * read/write rules see it; or a refusal. The path is resolved as a URL would
 * be (dot segments, encoded dots) and must land on the same origin, under the
 * base path.
 */
export function urlUnder(
  baseUrl: string,
  path: string,
  query?: ForwardInput["query"],
): { url: URL; path: string } {
  if (!baseUrl) {
    throw new ConnectionRequestError("This connection has no base URL.");
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ConnectionRequestError("This connection's base URL is invalid.");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new ConnectionRequestError("This connection's base URL is invalid.");
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new ConnectionRequestError(
      'A path starts with "/" and is relative to the connection\'s base URL.',
    );
  }
  if (
    path.length > MAX_PATH_LENGTH ||
    path.startsWith("//") ||
    /[\\#\s]/.test(path) ||
    /(^|\/)(\.|%2e){2}(\/|$|\?)/i.test(path)
  ) {
    throw new ConnectionRequestError(
      "The path must stay under the connection's base URL.",
      403,
    );
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  // "/" is the base URL itself (a GraphQL endpoint takes no trailing slash).
  const url = new URL(
    path === "/" ? basePath || "/" : `${basePath}${path}`,
    base.origin,
  );
  const under =
    url.pathname === basePath ||
    url.pathname.startsWith(`${basePath}/`) ||
    basePath === "";
  if (url.origin !== base.origin || !under) {
    throw new ConnectionRequestError(
      "The path must stay under the connection's base URL.",
      403,
    );
  }
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(one));
    }
  }
  return { url, path: url.pathname.slice(basePath.length) || "/" };
}

/** `a[b][0]=c`, as Stripe reads a form body. */
export function formEncode(value: unknown, prefix = ""): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => formEncode(item, `${prefix}[${i}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nested]) => formEncode(nested, prefix ? `${prefix}[${key}]` : key),
    );
  }
  return [`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`];
}

function encodeBody(
  body: unknown,
  callable: CallableConnection,
  headers: Record<string, string>,
): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (callable.bodyEncoding === "form") {
    headers["content-type"] ??= "application/x-www-form-urlencoded";
    return formEncode(body).join("&");
  }
  headers["content-type"] ??= "application/json";
  return JSON.stringify(body);
}

/** The caller's headers Mako forwards, lower-cased. */
export function callerHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (CALLER_HEADER_BLOCKLIST.has(lower) || lower.startsWith("proxy-")) {
      continue;
    }
    if (typeof value === "string") out[lower] = value;
  }
  return out;
}

function containsSecret(text: string, secrets: string[]): boolean {
  return redactSecrets(text, secrets) !== text;
}

/**
 * The values to search an answer for, longest first: every credential value
 * and exactly what the credential put on the wire (`applyCredential`),
 * whatever their length. `redactSecrets` also finds their encoded forms.
 */
function searchableSecrets(secrets: string[], sent: string[]): string[] {
  return [...new Set([...secrets, ...sent].filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
}

/** A request checked and resolved: allowed method, path under the base URL. */
export interface ResolvedRequest extends RequestShape {
  url: URL;
}

/**
 * Check `input` against `callable` and resolve it: the method is allowed,
 * the path stays under the base URL, the caller's headers are filtered.
 */
export function resolveRequest(
  callable: CallableConnection,
  config: ForwardConnection["config"],
  input: ForwardInput,
): ResolvedRequest {
  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ConnectionRequestError(`Method ${input.method} is not allowed.`);
  }
  const { url, path } = urlUnder(
    callable.baseUrl(config ?? {}),
    input.path,
    input.query,
  );
  // `_method` overrides the method on some frameworks: never forwarded.
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase() === "_method") url.searchParams.delete(name);
  }
  const override = Object.entries(input.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "x-http-method-override",
  )?.[1];
  return {
    method,
    url,
    path,
    headers: callerHeaders(input.headers),
    body: input.body,
    ...(typeof override === "string"
      ? { methodOverride: override.trim().toUpperCase() }
      : {}),
  };
}

/**
 * Send `input` to the service of `connection`, credential added, and return
 * its answer without any credential in it. Errors from the network are
 * thrown; every HTTP status is returned.
 */
export function forward(
  connection: ForwardConnection,
  callable: CallableConnection,
  input: ForwardInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ForwardResult> {
  return send(
    connection,
    callable,
    resolveRequest(callable, connection.config, input),
    options,
  );
}

/** `forward` for a request already resolved (`resolveRequest`). */
export async function send(
  connection: ForwardConnection,
  callable: CallableConnection,
  request: ResolvedRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ForwardResult> {
  const config = connection.config ?? {};
  const url = new URL(request.url);
  const headers = { ...request.headers, ...callable.extraHeaders?.(request) };
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : encodeBody(request.body, callable, headers);
  const sent = applyCredential(callable.credential(config), headers, url);

  const gate = rateGateOf(callable, connection);
  const answer = await throttledRequest(
    gate.key,
    () =>
      transport(url.toString(), {
        method: request.method,
        headers,
        body,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
    gate.minDelayMs,
    "proxy",
  );
  return clean(answer, callable, config, sent);
}

/**
 * The service's answer without the credential: auth headers, cookies, and
 * any header holding a secret value (URL-encoded too) or a value the
 * credential was sent as are removed; those values are redacted from the
 * body.
 */
function clean(
  answer: SafeRequestResult,
  callable: CallableConnection,
  config: ForwardConnection["config"],
  sent: string[],
): ForwardResult {
  const secrets = searchableSecrets(secretsOf(callable, config), sent);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(answer.headers)) {
    const lower = name.toLowerCase();
    if (
      RESPONSE_HEADER_BLOCKLIST.has(lower) ||
      containsSecret(value, secrets)
    ) {
      continue;
    }
    headers[lower] = value;
  }
  const text = redactSecrets(answer.body.toString("utf8"), secrets);
  const type = headers["content-type"] ?? "";
  let body: unknown = text;
  if (/\bjson\b/i.test(type) && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: answer.status, headers, body };
}
