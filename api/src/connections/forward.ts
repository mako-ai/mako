/**
 * Send one request to a connection's service with its credential, and give
 * back what the service answered without the credential in it.
 *
 * The path must stay under the connection's base URL (connections/callable.ts). The request goes
 * through the SSRF-hardened `safeRequest` (no private addresses, no
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
import { throttledRequest, type RateGateLane } from "../connectors/rate-gate";
import type { ISourceConnection } from "../database/workspace-schema";
import { applyCredential, type OutgoingRequest } from "./credential-types";
import {
  secretHeadersOf,
  secretsOf,
  type CallableConnection,
} from "./callable";

/** A caller mistake or a refusal: the message is safe to show. */
export class ConnectionRequestError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 = 400,
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
  /** Sent as the vendor's idempotency header, where it has one. */
  idempotencyKey?: string;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the service answered JSON, else text. */
  body: unknown;
}

/** The connection as the proxy needs it, config already decrypted. */
export type ForwardConnection = Pick<
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

/** One SSRF-hardened request (or the test transport). */
export function sendRequest(
  url: string,
  options: Parameters<typeof safeRequest>[1],
): Promise<SafeRequestResult> {
  return transport(url, options);
}

export const ALLOWED_METHODS = new Set([
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
 * The full URL of `path` under `baseUrl`, or a refusal. The path is resolved
 * as a URL would be (dot segments, encoded dots) and must land on the same
 * origin, under the base path.
 */
export function urlUnder(
  baseUrl: string,
  path: string,
  query?: ForwardInput["query"],
): URL {
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
  return url;
}

/** A path relative to `baseUrl` as the read/write rules see it. */
export function relativePath(baseUrl: string, url: URL): string {
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return url.pathname.slice(basePath.length) || "/";
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

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function containsSecret(text: string, secrets: string[]): boolean {
  return secrets.some(secret => !!secret && text.includes(secret));
}

/** Values long enough to search for: a one-letter "secret" would mangle every body. */
export function searchableSecrets(secrets: string[]): string[] {
  const values = secrets.filter(s => s.length >= 6);
  // Also the encodings a credential is sent in.
  const encoded = values.flatMap(s => [
    Buffer.from(`${s}:`).toString("base64"),
    encodeURIComponent(s),
  ]);
  return [...new Set([...values, ...encoded])].filter(s => s.length >= 6);
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
  options: {
    signal?: AbortSignal;
    lane?: RateGateLane;
    timeoutMs?: number;
  } = {},
): Promise<ForwardResult> {
  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ConnectionRequestError(`Method ${input.method} is not allowed.`);
  }
  const config = connection.config ?? {};
  const url = urlUnder(callable.baseUrl(config), input.path, input.query);
  const headers = callerHeaders(input.headers);
  if (input.idempotencyKey && callable.idempotencyHeader) {
    headers[callable.idempotencyHeader] = input.idempotencyKey;
  }
  const request: OutgoingRequest = {
    method,
    url,
    headers,
    body:
      method === "GET" || method === "HEAD"
        ? undefined
        : encodeBody(input.body, callable, headers),
  };
  applyCredential(request, callable.credential(config));

  const gate = callable.rateGate(connection);
  const answer = await throttledRequest(
    gate.key || `connection:${String(connection._id)}`,
    () =>
      transport(request.url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
    gate.minDelayMs,
    options.lane ?? "proxy",
  );
  return clean(answer, callable, config);
}

/** The service's answer, without the credential in its headers or body. */
export function clean(
  answer: SafeRequestResult,
  callable: CallableConnection,
  config: ForwardConnection["config"],
): ForwardResult {
  const { headers, text } = cleanAnswer(
    answer,
    secretsOf(callable, config),
    secretHeadersOf(callable, config),
  );
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

/**
 * An answer's headers and text without the credential: headers it may travel
 * in, cookies, and any header or text holding a secret value (also base64-
 * or URL-encoded) are removed.
 */
export function cleanAnswer(
  answer: SafeRequestResult,
  secretValues: string[],
  secretHeaders: string[],
): { headers: Record<string, string>; text: string } {
  const secrets = searchableSecrets(secretValues);
  const dropped = new Set([
    ...RESPONSE_HEADER_BLOCKLIST,
    ...secretHeaders.map(h => h.toLowerCase()),
  ]);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(answer.headers)) {
    const lower = name.toLowerCase();
    if (dropped.has(lower) || containsSecret(value, secrets)) continue;
    headers[lower] = value;
  }
  return { headers, text: redact(answer.body.toString("utf8"), secrets) };
}
