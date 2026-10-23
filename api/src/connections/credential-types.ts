/**
 * Credential types: how Mako talks to a service with a stored credential.
 *
 * Code, not stored. A source connection (collection `connectors`) is one
 * filled-in credential; its `type` names the credential type here. Each type
 * knows the service's base URL, how to add the credential to a request
 * (`authorize`), and which requests other than GET, HEAD and OPTIONS only
 * read (`reads`). The connection proxy (connections/proxy.service.ts) is the
 * only caller: built-in connectors keep their own client and auth.
 *
 * A type is registered here only when it is safe to forward arbitrary paths
 * under its base URL with its credential.
 */
import type { ISourceConnection } from "../database/workspace-schema";

/** A request on its way to the service, before the credential is added. */
export interface OutgoingRequest {
  method: string;
  url: URL;
  /** Lower-case names. */
  headers: Record<string, string>;
  /** Already encoded (`bodyEncoding`). */
  body?: string;
}

/** What a request asks, to tell a read from a write. */
export interface RequestShape {
  /** Upper case. */
  method: string;
  /** Relative to the base URL, starting with `/`. */
  path: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  body?: unknown;
}

type Config = ISourceConnection["config"];

export interface CredentialType {
  type: string;
  /** Where every request goes; a path must stay under it. */
  baseUrl(config: Config): string;
  /** Add the credential to `request`. */
  authorize(request: OutgoingRequest, config: Config): void;
  /** A request other than GET, HEAD or OPTIONS that only reads. */
  reads?(request: RequestShape, config: Config): boolean;
  /** The vendor's idempotency header, set from the caller's key when given. */
  idempotencyHeader?: string;
  /** How an object body is sent. Default JSON. */
  bodyEncoding?: "json" | "form";
  /**
   * The rate gate a request waits at (connectors/rate-gate.ts): the same key
   * as the built-in connector's, where it has one, so sync and proxy share it.
   */
  rateGate(
    connection: Pick<ISourceConnection, "_id" | "config" | "settings">,
  ): { key: string; minDelayMs: number };
  /** Every value that must never appear in a response. */
  secrets(config: Config): string[];
  /** Header names the credential may travel in, removed from responses. */
  secretHeaders(config: Config): string[];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether `request` only reads, for a connection of `type`. */
export function isReadRequest(
  credentialType: CredentialType,
  request: RequestShape,
  config: Config,
): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  return credentialType.reads?.(request, config) === true;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function defaultGate(
  connection: Pick<ISourceConnection, "_id" | "settings">,
  minimum = 0,
): { key: string; minDelayMs: number } {
  return {
    key: `connection:${String(connection._id)}`,
    minDelayMs: Math.max(
      minimum,
      Number(connection.settings?.rate_limit_delay_ms) || 0,
    ),
  };
}

// ---------------------------------------------------------------------------
// GraphQL: a query reads, a mutation or subscription writes
// ---------------------------------------------------------------------------

/**
 * Whether a GraphQL document only queries. Strings and comments are removed
 * first; then any `mutation` or `subscription` word makes it a write, even a
 * field of that name: a read counted as a write is refused, never the
 * other way round.
 */
export function isGraphqlQuery(document: unknown): boolean {
  if (typeof document !== "string" || !document.trim()) return false;
  const bare = document
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, "");
  return !/\b(mutation|subscription)\b/.test(bare);
}

/** A GraphQL POST body (one operation, or a batch) that only queries. */
export function isGraphqlReadBody(body: unknown): boolean {
  const parsed = typeof body === "string" ? safeJson(body) : body;
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  if (operations.length === 0) return false;
  return operations.every(
    op =>
      !!op &&
      typeof op === "object" &&
      isGraphqlQuery((op as { query?: unknown }).query),
  );
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

/** The base URL the built-in Close connector uses (connectors/close). */
const CLOSE_BASE_URL = "https://api.close.com/api/v1";

const close: CredentialType = {
  type: "close",
  baseUrl: () => CLOSE_BASE_URL,
  authorize(request, config) {
    request.headers.authorization = basic(text(config.api_key), "");
  },
  reads(request) {
    // Close reads a POST as a GET when told so (the connector lists leads
    // that way), and its search API only searches.
    if (request.headers["x-http-method-override"]?.toUpperCase() === "GET") {
      return true;
    }
    return (
      request.method === "POST" && /^\/data\/search\/?$/.test(request.path)
    );
  },
  rateGate(connection) {
    // The connector's own gate: keyed by the key, at least 500 ms apart.
    return {
      key: text(connection.config?.api_key),
      minDelayMs: Math.max(
        500,
        Number(connection.settings?.rate_limit_delay_ms) || 200,
      ),
    };
  },
  secrets: config => [text(config.api_key)],
  secretHeaders: () => ["authorization"],
};

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const stripe: CredentialType = {
  type: "stripe",
  baseUrl(config) {
    const configured = text(config.api_base_url);
    return trimSlash(configured || "https://api.stripe.com");
  },
  authorize(request, config) {
    request.headers.authorization = `Bearer ${text(config.api_key)}`;
  },
  idempotencyHeader: "idempotency-key",
  bodyEncoding: "form",
  rateGate: connection => defaultGate(connection),
  secrets: config => [text(config.api_key)],
  secretHeaders: () => ["authorization"],
};

// ---------------------------------------------------------------------------
// Wise
// ---------------------------------------------------------------------------

const wise: CredentialType = {
  type: "wise",
  baseUrl(config) {
    const configured = text(config.api_base_url);
    return trimSlash(configured || "https://api.wise.com");
  },
  authorize(request, config) {
    request.headers.authorization = `Bearer ${text(config.api_key)}`;
  },
  rateGate: connection => defaultGate(connection),
  secrets: config => [text(config.api_key), text(config.sca_private_key)],
  secretHeaders: () => ["authorization"],
};

// ---------------------------------------------------------------------------
// Generic HTTP API
// ---------------------------------------------------------------------------

export const HTTP_AUTH_SCHEMES = [
  "bearer",
  "header",
  "basic",
  "query",
  "none",
] as const;
export type HttpAuthScheme = (typeof HTTP_AUTH_SCHEMES)[number];

function httpScheme(config: Config): HttpAuthScheme {
  const scheme = text(config.auth_scheme) as HttpAuthScheme;
  return HTTP_AUTH_SCHEMES.includes(scheme) ? scheme : "bearer";
}

/**
 * Any HTTP API: a base URL and one way to authenticate. With `graphql` on,
 * a POST whose operation is a query reads; a mutation writes.
 */
export const http: CredentialType = {
  type: "http",
  baseUrl: config => trimSlash(text(config.base_url)),
  authorize(request, config) {
    switch (httpScheme(config)) {
      case "bearer":
        request.headers.authorization = `Bearer ${text(config.token)}`;
        return;
      case "header":
        request.headers[text(config.header_name).toLowerCase() || "x-api-key"] =
          text(config.token);
        return;
      case "basic":
        request.headers.authorization = basic(
          text(config.username),
          text(config.password),
        );
        return;
      case "query":
        request.url.searchParams.set(
          text(config.query_param) || "api_key",
          text(config.token),
        );
        return;
      case "none":
        return;
    }
  },
  reads(request, config) {
    return (
      config.graphql === true &&
      request.method === "POST" &&
      isGraphqlReadBody(request.body)
    );
  },
  rateGate: connection => defaultGate(connection),
  secrets: config => [text(config.token), text(config.password)],
  secretHeaders(config) {
    const names = ["authorization"];
    if (httpScheme(config) === "header") {
      names.push(text(config.header_name).toLowerCase() || "x-api-key");
    }
    return names;
  },
};

const CREDENTIAL_TYPES = new Map<string, CredentialType>(
  [close, stripe, wise, http].map(t => [t.type, t]),
);

/** The credential type of a connection type, if Mako has one. */
export function credentialTypeFor(type: string): CredentialType | null {
  return CREDENTIAL_TYPES.get(type) ?? null;
}

/** Every credential type, for listings. */
export function credentialTypes(): string[] {
  return [...CREDENTIAL_TYPES.keys()];
}
