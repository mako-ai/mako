/**
 * The REST HTTP client, with the in-process connector's request building
 * (`api/src/connectors/rest/connector.ts`, an axios instance):
 *
 * - `baseURL` joined to the entity path as axios joins them (an absolute
 *   path wins, trailing slashes of the base collapse);
 * - `Content-Type: application/json` and `Accept` as axios sends them, the
 *   connection's custom headers on top (a JSON string, or an object from
 *   older connections);
 * - query parameters serialised as axios does (`a[]=1`, `a[b]=1`, nulls
 *   dropped, spaces as `+`);
 * - a non-GET request carries the entity's JSON body, `{}` when it has none;
 * - a non-2xx answer fails with axios's message, and nothing is retried;
 * - a body that parses as JSON is the JSON, anything else the raw text.
 *
 * It uses `fetch`, not axios: the folder needs no dependency.
 *
 * The in-process client is SSRF-guarded (`createSsrfSafeAxios`) because it
 * runs inside Mako's network. A box is outside it. The folder still refuses
 * the cloud metadata names and private or link-local IP literals, and every
 * address a name resolves to, on every redirect hop. Loopback reaches only
 * the box and is allowed. A request times out after 30 s; in-process has no
 * timeout, and a chunk's own limit ends it there.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 21;

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** A non-2xx answer; the message is axios's. */
export class RestHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`Request failed with status code ${status}`);
    this.name = "RestHttpError";
    this.status = status;
  }
}

/** A transport failure, worded by its cause as the socket reports it. */
export class RestNetworkError extends Error {
  constructor(cause: unknown) {
    super(describe(cause), { cause });
    this.name = "RestNetworkError";
  }
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { message?: unknown } })?.cause;
  if (typeof cause?.message === "string" && cause.message) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") {
    return true;
  }
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" && NETWORK_CODES.has(code);
}

/** Headers: the in-process `getHttpClient`, line for line. */
export function buildHeaders(raw: unknown): Headers {
  const headers = new Headers({
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
  });
  if (raw) {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (error) {
      throw new Error("Invalid JSON in headers configuration", {
        cause: error,
      });
    }
    if (parsed && typeof parsed === "object") {
      for (const [name, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          headers.set(name, String(value));
        }
      }
    }
  }
  return headers;
}

// ---------------------------------------------------------------------------
// URLs, as axios builds them
// ---------------------------------------------------------------------------

const isAbsolute = (url: string) => /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);

/** axios `combineURLs`. */
function combine(base: string, relative: string): string {
  if (!relative) return base;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
  return `${base.slice(0, end)}/${relative.replace(/^\/+/, "")}`;
}

/** axios's default param encoder: `:`, `$`, `,` plain, spaces as `+`. */
const encode = (value: string) =>
  encodeURIComponent(value)
    .replace(/%3A/gi, ":")
    .replace(/%24/g, "$")
    .replace(/%2C/gi, ",")
    .replace(/%20/g, "+");

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};
const isVisitable = (value: unknown) => Array.isArray(value) || isPlain(value);
const removeBrackets = (key: string) =>
  key.endsWith("[]") ? key.slice(0, -2) : key;

/** axios `renderKey`: `a`, then `[b]` for each step below it. */
const renderKey = (path: string[] | undefined, key: string) =>
  path
    ? [...path, key]
        .map((token, i) =>
          i ? `[${removeBrackets(token)}]` : removeBrackets(token),
        )
        .join("")
    : key;

const scalar = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);

/**
 * axios `toFormData`, as `AxiosURLSearchParams` drives it. Null and
 * undefined are skipped at every level. A flat array at the top level is
 * `key[]=a&key[]=b`; below the top level, and when it holds objects, it is
 * indexed (`key[0][a]=1`).
 */
function pairs(
  value: unknown,
  path: string[] | undefined,
  out: Array<[string, string]>,
): void {
  const entries: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value as Record<string, unknown>);
  for (const [rawKey, item] of entries) {
    if (item === undefined || item === null) continue;
    const key = typeof rawKey === "string" ? rawKey.trim() : String(rawKey);
    if (!path && typeof item === "object") {
      if (key.endsWith("{}")) {
        out.push([key, JSON.stringify(item)]);
        continue;
      }
      if (Array.isArray(item) && !item.some(isVisitable)) {
        for (const el of item) {
          if (el !== undefined && el !== null) {
            out.push([`${removeBrackets(key)}[]`, scalar(el)]);
          }
        }
        continue;
      }
    }
    if (isVisitable(item)) {
      pairs(item, path ? [...path, key] : [key], out);
    } else {
      out.push([renderKey(path, key), scalar(item)]);
    }
  }
}

/** `path` joined to the base, with `params` appended, as axios does. */
export function buildUrl(
  base: string | undefined,
  path: string,
  params: Record<string, unknown>,
): string {
  let url = base && !isAbsolute(path) ? combine(base, path) : path;
  const list: Array<[string, string]> = [];
  pairs(params, undefined, list);
  const query = list.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
  if (query) {
    const hash = url.indexOf("#");
    if (hash !== -1) url = url.slice(0, hash);
    url += `${url.indexOf("?") === -1 ? "?" : "&"}${query}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// The address guard (the GraphQL folder's, for the same reasons)
// ---------------------------------------------------------------------------

function v4Blocked(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p))) return false;
  const value =
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const ranges: Array<[string, number]> = [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["169.254.0.0", 16],
    ["100.64.0.0", 10],
    ["0.0.0.0", 8],
  ];
  return ranges.some(([base, bits]) => {
    const b = base.split(".").map(Number);
    const baseValue = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

function v6Groups(address: string): number[] | null {
  const host = address.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) =>
      `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`,
  );
  const [head, tail, ...rest] = host.split("::");
  if (rest.length > 0) return null;
  const parse = (part: string | undefined) =>
    part ? part.split(":").map(g => parseInt(g, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  if (tail === undefined && left.length !== 8) return null;
  const groups = [
    ...left,
    ...new Array(8 - left.length - right.length).fill(0),
    ...right,
  ];
  return groups.length === 8 &&
    groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

function embeddedV4(host: string): string | null {
  const groups = v6Groups(host);
  if (!groups) return null;
  const zero = (from: number, to: number) =>
    groups.slice(from, to).every(g => g === 0);
  const mapped = zero(0, 5) && (groups[5] === 0xffff || groups[5] === 0);
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6);
  if (!mapped && !nat64) return null;
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join(".");
}

/** A private, link-local, CGNAT or unspecified address; loopback is not. */
export function addressBlocked(address: string): boolean {
  const host = address.toLowerCase();
  if (!host.includes(":")) return v4Blocked(host);
  const groups = v6Groups(host);
  if (groups?.slice(0, 7).every(g => g === 0) && groups[7] === 1) return false;
  return (
    /^f[cd]/.test(host) ||
    /^fe[89ab]/.test(host) ||
    host === "::" ||
    v4Blocked(embeddedV4(host) ?? "")
  );
}

/** http or https, never a cloud metadata name or a private IP literal. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The REST API URL must be http or https: ${raw}`);
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  const metadata =
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal");
  if (metadata || addressBlocked(host)) {
    throw new Error(
      `The REST API points at a private or metadata address: ${host}`,
    );
  }
  return url;
}

/** Every address a host name resolves to, checked. */
export async function checkResolved(
  url: URL,
  resolve: (host: string) => Promise<Array<{ address: string }>> = host =>
    lookup(host, { all: true, verbatim: true }),
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  const addresses = await resolve(host);
  const blocked = addresses.find(a => addressBlocked(a.address));
  if (blocked) {
    throw new Error(
      `The REST API ${host} resolves to a private or metadata address: ${blocked.address}`,
    );
  }
}

export class RestClient {
  private readonly base: string | undefined;
  private readonly headers: Headers;
  private readonly checked = new Set<string>();

  constructor(config: { api_base_url?: unknown; headers?: unknown }) {
    this.base = config.api_base_url ? String(config.api_base_url) : undefined;
    this.headers = buildHeaders(config.headers);
  }

  private async guard(url: string): Promise<URL> {
    const parsed = checkUrl(url);
    if (!this.checked.has(parsed.host)) {
      try {
        await checkResolved(parsed);
      } catch (error) {
        throw isNetworkFailure(error) ? new RestNetworkError(error) : error;
      }
      this.checked.add(parsed.host);
    }
    return parsed;
  }

  /** `client.get` or `client.request`: the parsed body of a 2xx answer. */
  async request(options: {
    method: string;
    path: string;
    params: Record<string, unknown>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<unknown> {
    let method = options.method.toUpperCase();
    let url = buildUrl(this.base, options.path, options.params);
    let body: string | undefined =
      method === "GET" ? undefined : JSON.stringify(options.body ?? {});
    let headers = new Headers(this.headers);
    const signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);

    for (let hop = 0; ; hop++) {
      const target = await this.guard(url);
      let response: Response;
      try {
        response = await fetch(target, {
          method,
          headers,
          body,
          signal,
          redirect: "manual",
        });
      } catch (error) {
        throw isNetworkFailure(error) ? new RestNetworkError(error) : error;
      }
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        if (hop >= MAX_REDIRECTS) {
          throw new Error("Maximum number of redirects exceeded");
        }
        const next = new URL(location, target);
        // follow-redirects: 301/302 on a POST and 303 on anything but GET
        // and HEAD become a GET without a body.
        if (
          ((response.status === 301 || response.status === 302) &&
            method === "POST") ||
          (response.status === 303 && method !== "GET" && method !== "HEAD")
        ) {
          method = "GET";
          body = undefined;
          headers = new Headers(headers);
          for (const name of [...headers.keys()]) {
            if (/^content-/i.test(name)) headers.delete(name);
          }
        }
        if (next.host !== target.host) {
          headers = new Headers(headers);
          for (const name of [
            "authorization",
            "cookie",
            "proxy-authorization",
          ]) {
            headers.delete(name);
          }
        }
        url = next.toString();
        continue;
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new RestNetworkError(error);
      }
      if (!response.ok) throw new RestHttpError(response.status);
      try {
        return text ? JSON.parse(text) : "";
      } catch {
        return text;
      }
    }
  }
}
