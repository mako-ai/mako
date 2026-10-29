/**
 * Which source connections Mako can call, and how.
 *
 * Code, not stored. For each connection type the proxy may call
 * (connections/proxy.service.ts), its call profile says where requests go
 * (`baseUrl`, a path must stay under it), which credential it sends and how
 * (`credential`, one of the credential types in credential-types.ts), which
 * requests other than GET, HEAD and OPTIONS only read (`reads`), and its
 * vendor's idempotency header. Built-in connectors keep their own client and
 * auth for syncing; nothing here is used by a sync.
 *
 * A type is listed here only when it is safe to forward arbitrary paths
 * under its base URL with its credential.
 */
import type { ISourceConnection } from "../database/workspace-schema";
import {
  CREDENTIAL_TYPES,
  credentialHeaders,
  credentialSecrets,
  type Credential,
  type CredentialTypeId,
} from "./credential-types";
import { CUSTOM_API_TYPE } from "./kinds";

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

export interface CallableConnection {
  type: string;
  /** Where every request goes; a path must stay under it. */
  baseUrl(config: Config): string;
  /** The credential and the way it is sent. */
  credential(config: Config): Credential;
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
  /** Stored secrets the credential does not carry, also never passed back. */
  otherSecrets?(config: Config): string[];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether `request` only reads, for a connection of this profile. */
export function isReadRequest(
  callable: CallableConnection,
  request: RequestShape,
  config: Config,
): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  return callable.reads?.(request, config) === true;
}

/** Every value that must never appear in an answer. */
export function secretsOf(callable: CallableConnection, config: Config) {
  return [
    ...credentialSecrets(callable.credential(config)),
    ...(callable.otherSecrets?.(config) ?? []),
  ].filter(Boolean);
}

/** Header names the credential may travel in. */
export function secretHeadersOf(callable: CallableConnection, config: Config) {
  return credentialHeaders(callable.credential(config));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function defaultGate(connection: Pick<ISourceConnection, "_id" | "settings">): {
  key: string;
  minDelayMs: number;
} {
  return {
    key: `connection:${String(connection._id)}`,
    minDelayMs: Number(connection.settings?.rate_limit_delay_ms) || 0,
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
// Built-in connectors: each fixes its own credential type
// ---------------------------------------------------------------------------

/** The base URL the built-in Close connector uses (connectors/close). */
const CLOSE_BASE_URL = "https://api.close.com/api/v1";

const close: CallableConnection = {
  type: "close",
  baseUrl: () => CLOSE_BASE_URL,
  // Close: the API key as the basic-auth username, no password.
  credential: config => ({
    type: "basic",
    username: text(config.api_key),
    password: "",
  }),
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
};

const stripe: CallableConnection = {
  type: "stripe",
  baseUrl: config =>
    trimSlash(text(config.api_base_url) || "https://api.stripe.com"),
  credential: config => ({ type: "bearer", token: text(config.api_key) }),
  idempotencyHeader: "idempotency-key",
  bodyEncoding: "form",
  rateGate: connection => defaultGate(connection),
};

const wise: CallableConnection = {
  type: "wise",
  baseUrl: config =>
    trimSlash(text(config.api_base_url) || "https://api.wise.com"),
  credential: config => ({ type: "bearer", token: text(config.api_key) }),
  rateGate: connection => defaultGate(connection),
  otherSecrets: config => [text(config.sca_private_key)],
};

// ---------------------------------------------------------------------------
// Custom API: an address and a credential type the person picks
// ---------------------------------------------------------------------------

/** The credential type a Custom API connection picked; bearer when unset. */
export function customApiCredentialType(
  config: Config,
): CredentialTypeId | "none" {
  const picked = text(config.auth_type) as CredentialTypeId | "none";
  return picked === "none" || CREDENTIAL_TYPES.includes(picked as never)
    ? picked
    : "bearer";
}

/**
 * Any HTTP API: an address, one credential type and its key. With `graphql`
 * on, a POST whose operation is a query reads; a mutation writes.
 */
export const customApi: CallableConnection = {
  type: CUSTOM_API_TYPE,
  baseUrl: config => trimSlash(text(config.base_url)),
  credential(config): Credential {
    const token = text(config.token);
    switch (customApiCredentialType(config)) {
      case "bearer":
        return { type: "bearer", token };
      case "api_key_header":
        return {
          type: "api_key_header",
          token,
          header: text(config.header_name) || "X-API-Key",
        };
      case "api_key_query":
        return {
          type: "api_key_query",
          token,
          param: text(config.query_param) || "api_key",
        };
      case "basic":
        return {
          type: "basic",
          username: text(config.username),
          password: text(config.password),
        };
      case "none":
        return { type: "none" };
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
};

const CALLABLE = new Map<string, CallableConnection>(
  [close, stripe, wise, customApi].map(c => [c.type, c]),
);

/** How Mako calls a connection of `type`, or null when it cannot yet. */
export function callableFor(type: string): CallableConnection | null {
  return CALLABLE.get(type) ?? null;
}
