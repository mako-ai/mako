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
 * It sends through the SDK's `safeRequest`, not axios. The deleted
 * in-process client was SSRF-guarded because it ran inside Mako's network.
 * A box is outside it, so the guard is the SDK's: the
 * socket's own lookup checks every resolved address and the connection uses
 * the address it checked (no DNS rebinding window), only public unicast and
 * loopback are allowed, every redirect hop is checked, https to http with a
 * credential is refused, the connection's custom headers are dropped on a
 * hop off the original host, and the body is capped at 100 MB. Redirects
 * are followed (up to 21) as axios follows them. A request times out after
 * 120 s; in-process has no timeout, and a chunk's own limit ends it there.
 */
import { safeRequest } from "@makoai/connector-sdk";
import type { SafeRequestOptions } from "@makoai/connector-sdk";

export const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 21;

/** A non-2xx answer; the message is axios's. */
export class RestHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`Request failed with status code ${status}`);
    this.name = "RestHttpError";
    this.status = status;
  }
}

/** Headers: the in-process `getHttpClient`, line for line. */
export function buildHeaders(raw: unknown): {
  headers: Record<string, string>;
  /** The names the connection set: credentials as far as redirects go. */
  custom: string[];
} {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
  };
  const custom: string[] = [];
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
      const probe = new Headers();
      for (const [name, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          try {
            probe.set(name, String(value));
          } catch {
            // The engine's text would quote the value, which is a secret.
            throw new Error(`Invalid value for header "${name}"`);
          }
          headers[name] = String(value);
          custom.push(name);
        }
      }
    }
  }
  return { headers, custom };
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

export class RestClient {
  private readonly base: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly custom: string[];
  private readonly resolve: SafeRequestOptions["resolve"];

  constructor(
    config: { api_base_url?: unknown; headers?: unknown },
    resolve?: SafeRequestOptions["resolve"],
  ) {
    this.resolve = resolve;
    this.base = config.api_base_url ? String(config.api_base_url) : undefined;
    ({ headers: this.headers, custom: this.custom } = buildHeaders(
      config.headers,
    ));
  }

  /** `client.get` or `client.request`: the parsed body of a 2xx answer. */
  async request(options: {
    method: string;
    path: string;
    params: Record<string, unknown>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<unknown> {
    const method = options.method.toUpperCase();
    const response = await safeRequest(
      buildUrl(this.base, options.path, options.params),
      {
        method,
        headers: this.headers,
        body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
        timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        allowLoopback: true,
        followRedirects: true,
        maxRedirects: MAX_REDIRECTS,
        secretHeaders: this.custom,
        resolve: this.resolve,
      },
    );
    if (response.status < 200 || response.status > 299) {
      throw new RestHttpError(response.status);
    }
    try {
      return response.text ? JSON.parse(response.text) : "";
    } catch {
      return response.text;
    }
  }
}
