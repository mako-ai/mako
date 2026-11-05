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
import { RateGateBusyError, throttledRequest } from "../connectors/rate-gate";
import { redactSecrets } from "./redact";
import type { ISourceConnection } from "../database/workspace-schema";
import {
  applyCredential,
  rateGateOf,
  readsByProfile,
  secretsOf,
  type CallableConnection,
  type RequestShape,
} from "./callable";

/** A caller mistake or a refusal: the message is safe to show. */
export class ConnectionRequestError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 503 = 400,
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

/**
 * The only caller headers forwarded (plus a profile's `callerHeaders`); any
 * other is dropped. The credential, the transport and anything a gateway in
 * front of the service could read as a different path, host or method are
 * Mako's.
 */
const CALLER_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "idempotency-key",
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

/** Characters a server may read as a dot: `.`, and dot-like ones NFKC keeps. */
const DOT_LIKE = /[.\u2024\uFF0E\u3002\uFE52]/;
const DOT_SEGMENT = /^[.\u2024\uFF0E\u3002\uFE52\s\0]+$/;

/**
 * Whether one path segment is, or a server may read it as, `.` or `..`: after
 * NFKC, without `;` parameters (`..;`), made only of dots or dot-like
 * characters and trailing spaces, tabs or NUL that some servers strip.
 */
function isDotSegment(segment: string): boolean {
  const bare = segment.normalize("NFKC").split(";")[0];
  return DOT_SEGMENT.test(bare) && DOT_LIKE.test(bare);
}

/**
 * Whether `path`, decoded as often as it changes (a service or a gateway in
 * front of it may decode `%2F` or `%252F`), has a segment that is or may be
 * read as `.` or `..` (isDotSegment), `/` and `\` both separating. The path
 * is still sent as given, so an encoded `/` inside an id works when it forms
 * no such segment. Undecodable: refused.
 */
export function hasDotSegment(path: string): boolean {
  let decoded = path.split("?")[0];
  for (let i = 0; i < 10; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) {
      return decoded.split(/[/\\]/).some(isDotSegment);
    }
    decoded = next;
  }
  return true;
}

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
    hasDotSegment(path)
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
  if (typeof body === "string") {
    headers["content-type"] ??=
      callable.bodyEncoding === "form"
        ? "application/x-www-form-urlencoded"
        : "application/json";
    return body;
  }
  if (callable.bodyEncoding === "form") {
    headers["content-type"] ??= "application/x-www-form-urlencoded";
    return formEncode(body).join("&");
  }
  headers["content-type"] ??= "application/json";
  return JSON.stringify(body);
}

/**
 * The body of a request its profile reads (`readsByProfile`): always JSON,
 * the caller's content type replaced, so a service cannot read the checked
 * body as a form or anything else. A string body is re-serialized from its
 * parsed JSON; one that is not JSON is refused.
 */
function encodeReadBody(
  body: unknown,
  headers: Record<string, string>,
): string | undefined {
  headers["content-type"] = "application/json";
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") return JSON.stringify(body);
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    throw new ConnectionRequestError("A request that reads sends a JSON body.");
  }
}

/** Methods sent without a body. */
const NO_BODY = new Set(["GET", "HEAD", "OPTIONS"]);

/** The caller's headers Mako forwards, lower-cased: allowlisted ones only. */
export function callerHeaders(
  headers: Record<string, string> | undefined,
  extra: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!CALLER_HEADERS.has(lower) && !extra.includes(lower)) continue;
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
  const methodOverride =
    typeof override === "string" ? override.trim().toUpperCase() : undefined;
  // A profile that reads an override takes only the values it knows.
  if (
    methodOverride !== undefined &&
    callable.methodOverrides &&
    !callable.methodOverrides.includes(methodOverride)
  ) {
    throw new ConnectionRequestError(
      `X-HTTP-Method-Override may only be ${callable.methodOverrides.join(" or ")} on this connection.`,
    );
  }
  return {
    method,
    url,
    path,
    headers: callerHeaders(input.headers, callable.callerHeaders),
    body: input.body,
    ...(methodOverride !== undefined ? { methodOverride } : {}),
  };
}

/**
 * Send `input` to the service of `connection`, credential added, and return
 * its answer without any credential in it. Errors from the network are
 * thrown; every HTTP status is returned.
 */
export async function forward(
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
  const headers = {
    ...request.headers,
    ...callable.extraHeaders?.(request, config),
  };
  const body = NO_BODY.has(request.method)
    ? undefined
    : readsByProfile(callable, request, config)
      ? encodeReadBody(request.body, headers)
      : encodeBody(request.body, callable, headers);
  const sent = applyCredential(callable.credential(config), headers, url);

  const gate = rateGateOf(callable, connection);
  let answer: SafeRequestResult;
  try {
    answer = await throttledRequest(
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
      { signal: options.signal },
    );
  } catch (error) {
    if (error instanceof RateGateBusyError) {
      throw new ConnectionRequestError(error.message, 503);
    }
    throw withoutSecrets(
      error,
      searchableSecrets(secretsOf(callable, config), sent),
    );
  }
  return clean(answer, callable, config, sent);
}

/**
 * A transport error with every credential value redacted from its message:
 * the HTTP client quotes a header value it refuses ("Bearer <key>" is an
 * invalid header value), and that message reaches agents, tests and logs.
 * Same class, name and status; a cause that quotes a secret is dropped.
 */
function withoutSecrets(error: unknown, secrets: string[]): unknown {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? redactSecrets(error, secrets) : error;
  }
  const leaks = (value: unknown): boolean =>
    value instanceof Error && containsSecret(value.message, secrets);
  if (!leaks(error) && !leaks(error.cause)) return error;
  const message = redactSecrets(error.message, secrets);
  if (error instanceof ConnectionRequestError) {
    return new ConnectionRequestError(message, error.status);
  }
  const clean = new Error(message);
  clean.name = error.name;
  return clean;
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
