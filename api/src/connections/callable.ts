/**
 * Which source connections Mako can call, and how.
 *
 * Code, not stored. For each connection type the proxy may call
 * (connections/proxy.service.ts), its call profile says where requests go
 * (`baseUrl`, a path must stay under it), which credential it sends and how
 * (`credential`), and which requests other than GET, HEAD and OPTIONS only
 * read (`reads`). Built-in connectors keep their own client and auth for
 * syncing; nothing here is used by a sync.
 *
 * A type is listed here only when it is safe to forward arbitrary paths
 * under its base URL with its credential.
 */
import type { ISourceConnection } from "../database/workspace-schema";
import { CUSTOM_API_TYPE } from "./kinds";

// ---------------------------------------------------------------------------
// Credential types: how a key is sent with a request
// ---------------------------------------------------------------------------

/**
 * Four ways, whatever the service: a bearer token, an API key in a header or
 * in the query string, or basic auth. A connector fixes its own (Close sends
 * its key as basic auth, Stripe and Wise as a bearer token); a Custom API
 * connection picks one.
 */
const CREDENTIAL_TYPES = [
  "bearer",
  "api_key_header",
  "api_key_query",
  "basic",
] as const;
type CredentialTypeId = (typeof CREDENTIAL_TYPES)[number];

/** One filled-in credential, as a request needs it. */
export type Credential =
  | { type: "bearer"; token: string }
  | { type: "api_key_header"; token: string; header: string }
  | { type: "api_key_query"; token: string; param: string }
  | { type: "basic"; username: string; password: string }
  /** No credential (a public API). */
  | { type: "none" };

/**
 * Add `credential` to a request's headers (lower-case names) or URL, and
 * return every value it put on the wire (a whole header value, a basic-auth
 * payload, a query value as encoded), to scrub exactly those from the answer.
 */
export function applyCredential(
  credential: Credential,
  headers: Record<string, string>,
  url: URL,
): string[] {
  switch (credential.type) {
    case "bearer": {
      const header = `Bearer ${credential.token}`;
      headers.authorization = header;
      return [header, credential.token];
    }
    case "api_key_header":
      headers[credential.header.toLowerCase()] = credential.token;
      return [credential.token];
    case "api_key_query":
      url.searchParams.set(credential.param, credential.token);
      return [
        credential.token,
        // As the query string carries it.
        new URLSearchParams([["v", credential.token]]).toString().slice(2),
      ];
    case "basic": {
      const payload = Buffer.from(
        `${credential.username}:${credential.password}`,
      ).toString("base64");
      const header = `Basic ${payload}`;
      headers.authorization = header;
      return [header, payload];
    }
    case "none":
      return [];
  }
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
  /** The full URL, query string included, when resolved. */
  url?: URL;
  /**
   * The caller's `x-http-method-override`, upper case. Never forwarded as
   * sent: a profile may put back the one value it reads (`extraHeaders`).
   */
  methodOverride?: string;
}

type Config = ISourceConnection["config"];
type GateConnection = Pick<ISourceConnection, "_id" | "config" | "settings">;

export interface CallableConnection {
  type: string;
  /** Where every request goes; a path must stay under it. */
  baseUrl(config: Config): string;
  /** The credential and the way it is sent. */
  credential(config: Config): Credential;
  /** A request other than GET, HEAD or OPTIONS that only reads. */
  reads?(request: RequestShape, config: Config): boolean;
  /**
   * True when only `reads` decides, for this config: GET, HEAD and OPTIONS
   * are not reads by themselves (a GraphQL endpoint runs what it is sent).
   */
  onlyReads?(config: Config): boolean;
  /** Headers the profile itself puts on a request, after the caller's. */
  extraHeaders?(request: RequestShape): Record<string, string>;
  /** How an object body is sent. Default JSON. */
  bodyEncoding?: "json" | "form";
  /**
   * The rate gate a request waits at (connectors/rate-gate.ts): the same key
   * as the built-in connector's, where it has one, so sync and proxy share it.
   * Default: one gate per connection (`rateGateOf`).
   */
  rateGate?(connection: GateConnection): { key: string; minDelayMs: number };
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
  if (SAFE_METHODS.has(request.method) && !callable.onlyReads?.(config)) {
    return true;
  }
  return callable.reads?.(request, config) === true;
}

/** Every value that must never appear in an answer. */
export function secretsOf(callable: CallableConnection, config: Config) {
  const credential = callable.credential(config);
  const carried =
    credential.type === "none"
      ? []
      : credential.type === "basic"
        ? [credential.password, credential.username]
        : [credential.token];
  return [...carried, ...(callable.otherSecrets?.(config) ?? [])].filter(
    Boolean,
  );
}

/** The rate gate of `connection`: its profile's, else one per connection. */
export function rateGateOf(
  callable: CallableConnection,
  connection: GateConnection,
): { key: string; minDelayMs: number } {
  return (
    callable.rateGate?.(connection) ?? {
      key: connectionGateKey(connection),
      minDelayMs: Number(connection.settings?.rate_limit_delay_ms) || 0,
    }
  );
}

function connectionGateKey(connection: GateConnection): string {
  return `connection:${String(connection._id)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// GraphQL: a query reads, a mutation or subscription writes
// ---------------------------------------------------------------------------

/**
 * Whether a GraphQL document only queries. Fail closed: the word `mutation`
 * or `subscription` anywhere (an operation, a field, a comment, a string)
 * makes it a write. Comments and strings are not parsed away: a read counted
 * as a write is refused, never the other way round.
 */
export function isGraphqlQuery(document: unknown): boolean {
  if (typeof document !== "string" || !document.trim()) return false;
  return !/\b(mutation|subscription)\b/.test(document);
}

/** The only fields a GraphQL operation that reads may carry. */
const GRAPHQL_OPERATION_KEYS = new Set([
  "query",
  "variables",
  "operationName",
  "extensions",
]);

/**
 * A GraphQL POST body (one operation, or a batch) that only queries: each
 * operation has only the standard fields, and its `query` reads. A string
 * body counts only as compact JSON (what JSON.stringify gives back), so no
 * duplicate key or escaped name can mean something else to the service.
 */
export function isGraphqlReadBody(body: unknown): boolean {
  const parsed = typeof body === "string" ? safeJson(body) : body;
  if (typeof body === "string" && JSON.stringify(parsed) !== body.trim()) {
    return false;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  if (operations.length === 0) return false;
  return operations.every(
    op =>
      !!op &&
      typeof op === "object" &&
      !Array.isArray(op) &&
      Object.keys(op).every(key => GRAPHQL_OPERATION_KEYS.has(key)) &&
      isGraphqlQuery((op as { query?: unknown }).query),
  );
}

/** URL parameters a GraphQL server may run an operation from. */
const GRAPHQL_URL_PARAMS = [
  "query",
  "documentId",
  "doc_id",
  "id",
  "extensions",
];

/**
 * A request to a GraphQL endpoint that only queries: a POST to the endpoint
 * itself, no operation in the URL, and a body that reads. Anything else,
 * a GET included, is a write.
 */
export function isGraphqlRead(request: RequestShape): boolean {
  if (request.method !== "POST") return false;
  if (request.path !== "/" && request.path !== "") return false;
  const params = request.url?.searchParams;
  if (params && GRAPHQL_URL_PARAMS.some(name => params.has(name))) {
    return false;
  }
  return isGraphqlReadBody(request.body);
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

/** A POST the caller asked Close to read as a GET. */
function closeReadsAsGet(request: RequestShape): boolean {
  return request.method === "POST" && request.methodOverride === "GET";
}

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
    // Only a POST can be a read here: Close reads a POST as a GET when told
    // so (the connector lists leads that way), and its search API only
    // searches. Any other method writes, whatever its headers say.
    if (request.method !== "POST") return false;
    if (closeReadsAsGet(request)) return true;
    return /^\/data\/search\/?$/.test(request.path);
  },
  // The caller's override is never forwarded; this is the one Mako sends.
  extraHeaders: (request): Record<string, string> =>
    closeReadsAsGet(request) ? { "x-http-method-override": "GET" } : {},
  rateGate(connection) {
    // The connector's own gate: keyed by the key, at least 500 ms apart.
    return {
      key: text(connection.config?.api_key) || connectionGateKey(connection),
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
  bodyEncoding: "form",
};

const wise: CallableConnection = {
  type: "wise",
  baseUrl: config =>
    trimSlash(text(config.api_base_url) || "https://api.wise.com"),
  credential: config => ({ type: "bearer", token: text(config.api_key) }),
  otherSecrets: config => [text(config.sca_private_key)],
};

// ---------------------------------------------------------------------------
// Custom API: an address and a credential type the person picks
// ---------------------------------------------------------------------------

/** The credential type a Custom API connection picked; bearer when unset. */
function customApiCredentialType(config: Config): CredentialTypeId | "none" {
  const picked = text(config.auth_type) as CredentialTypeId | "none";
  return picked === "none" || CREDENTIAL_TYPES.includes(picked as never)
    ? picked
    : "bearer";
}

/**
 * Any HTTP API: an address, one credential type and its key. With `graphql`
 * on, only a POST of a query to the endpoint itself reads (isGraphqlRead);
 * everything else, a GET included, writes.
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
    return config.graphql === true && isGraphqlRead(request);
  },
  onlyReads: config => config.graphql === true,
};

const CALLABLE = new Map<string, CallableConnection>(
  [close, stripe, wise, customApi].map(c => [c.type, c]),
);

/** How Mako calls a connection of `type`, or null when it cannot yet. */
export function callableFor(type: string): CallableConnection | null {
  return CALLABLE.get(type) ?? null;
}
