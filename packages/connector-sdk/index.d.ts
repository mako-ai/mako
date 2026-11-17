/** A field's type, as a shorthand name or a raw JSON Schema fragment. */
export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "timestamp"
  | "json"
  | Record<string, unknown>;

export type EntitySchema = Record<string, FieldType>;

export interface HttpOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  /** Minimum milliseconds between requests, for a vendor with a hard rate limit. */
  minIntervalMs?: number;
  timeoutMs?: number;
}

export interface Http {
  request(url: string, options?: RequestInit): Promise<Response>;
  json<T = unknown>(url: string, options?: RequestInit): Promise<T>;
  get<T = unknown>(url: string, options?: RequestInit): Promise<T>;
  post<T = unknown>(url: string, body?: unknown, options?: RequestInit): Promise<T>;
}

export type PaginationStyle = "cursor" | "offset" | "page" | "link";

export interface PaginateOptions {
  fetchPage(args: {
    cursor: unknown;
    page: number;
    offset: number;
    pageSize: number;
  }): Promise<unknown>;
  style?: PaginationStyle;
  /** Dotted path to the array of records in the response, e.g. `"data.items"`. */
  recordsPath?: string;
  /** Dotted path to the next cursor, for `style: "cursor"`. */
  cursorPath?: string;
  /** Dotted path to the next URL, for `style: "link"`. */
  linkPath?: string;
  pageSize?: number;
  startCursor?: unknown;
  startPage?: number;
  maxPages?: number;
}

export interface Context<Config = Record<string, unknown>> {
  config: Config;
  /** Whatever this entity's last `read` returned as state. `{}` on a first run. */
  state: Record<string, unknown>;
  entity?: string;
  http: Http;
  paginate(options: PaginateOptions): AsyncGenerator<{
    records: unknown[];
    cursor: unknown;
    hasMore: boolean;
  }>;
  log(message: unknown): void;
  createHttp(options: HttpOptions): Http;
}

export interface ReadBatch {
  records: unknown[];
  /** The position to resume from AFTER these records. Omit to keep the current state. */
  state?: Record<string, unknown>;
  /** Whether another batch exists after this one. Required for exact chunk boundaries. */
  hasMore: boolean;
}

export interface EntityDefinition<Config = Record<string, unknown>> {
  label?: string;
  description?: string;
  /** Field names that identify a row, used as the destination's merge key. */
  primaryKey?: string[];
  schema?: EntitySchema;
  /** Declare a field here to make the entity incrementally syncable. */
  cursorField?: string;
  /**
   * What `read` does with `state.mako.since` (ISO 8601), which Mako sets on an
   * incremental sync: filter on a real update time (`native`), on creation
   * time only (`created-anchor`), or after reading everything
   * (`client-filter`). Omit when the entity ignores `since`.
   */
  incremental?: "native" | "client-filter" | "created-anchor";
  /** How a warehouse destination should partition and cluster the table. */
  layout?: {
    partitionField?: string;
    partitionGranularity?: "day" | "hour" | "month" | "year";
    clusterFields?: string[];
  };
  /** For APIs whose fields differ per account; overrides `schema`. */
  discoverSchema?(ctx: Context<Config>): Promise<EntitySchema> | EntitySchema;
  /** Yield one page at a time. Stop when there is nothing left. */
  read(ctx: Context<Config>, state: Record<string, unknown>): AsyncGenerator<ReadBatch>;
}

/**
 * How Mako verifies a delivery's signature, in its API, before storing it.
 * Data, never code: the signing secret stays in Mako and no box sees it.
 */
/**
 * Stripe's scheme: `t=<unix seconds>,v1=<hex>[,v1=...]` in one header, each
 * `v1` an HMAC-SHA256 of `<t>.<raw body>` under the secret's UTF-8 bytes.
 * The timestamp is always signed; `toleranceSeconds` (1 to 86400) bounds it.
 */
export interface StripeV1WebhookVerification {
  scheme: "stripe-v1";
  /** Lowercase name of the header, e.g. `"stripe-signature"`. */
  signatureHeader: string;
  secretEncoding: "utf8";
  toleranceSeconds: number;
}

export type WebhookVerification =
  | HmacWebhookVerification
  | StripeV1WebhookVerification
  | SharedSecretWebhookVerification;

/**
 * A vendor that does not sign: it sends the secret itself in a header
 * (Claap's `X-Claap-Webhook-Secret`). Mako compares it in constant time.
 */
export interface SharedSecretWebhookVerification {
  scheme: "shared-secret";
  /** Lowercase name of the header that carries the secret. */
  secretHeader: string;
}

export interface HmacWebhookVerification {
  scheme: "hmac-sha256";
  /** How the stored signing secret becomes the HMAC key. */
  secretEncoding: "hex" | "base64" | "utf8";
  /**
   * The signed bytes, in order: `"body"` (the raw request body),
   * `"header:<lowercase name>"` or `"literal:<text>"`. Must include `"body"`.
   */
  signedPayload: string[];
  /** Lowercase name of the header that carries the signature. */
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  /**
   * A query parameter that carries the signature (PandaDoc's `?signature=`).
   * Read first; `signatureHeader` is the fallback.
   */
  signatureQuery?: string;
  /** Text before the signature in its header, e.g. `"sha256="`. */
  signaturePrefix?: string;
  /**
   * A header with the send time in Unix seconds, and the window around now
   * it must fall in (1 to 86400). Declared together. Mako then refuses a
   * delivery without the header or outside the window.
   */
  timestampHeader?: string;
  toleranceSeconds?: number;
}

export interface WebhookBatchOptions {
  /**
   * The entities the flow syncs, when Mako sends them. Records for any
   * other entity are dropped anyway; a handler may skip the work.
   */
  enabledEntities?: string[];
}

/** One stored delivery, as Mako hands it to `handleBatch`. */
export interface WebhookEvent {
  /** The vendor's event id, unique within the flow. Echo it back. */
  eventId: string;
  eventType: string;
  rawPayload: unknown;
  /** When Mako received it, ISO 8601. */
  receivedAt?: string;
}

/** One row change. Mako stamps `_dataSourceId`, `_syncedAt` and filters by entity. */
export interface WebhookChangeRecord {
  /** A declared entity. Records for any other entity are dropped. */
  entity: string;
  recordId: string;
  operation: "upsert" | "delete";
  /** The whole row, as `read` emits it. A partial row writes NULLs: re-fetch it. */
  payload: Record<string, unknown>;
  /** The change's time, ISO 8601. Defaults to the row's own time. */
  sourceTs?: string;
  /** Idempotency key; the vendor's event id is a good one. */
  changeId?: string;
}

export type WebhookOutcome =
  | { eventId: string; outcome: "records"; records: WebhookChangeRecord[] }
  /** The connector does not handle this event type: nothing to write. */
  | { eventId: string; outcome: "unmapped" }
  /** A handled type whose payload yielded no record: Mako marks it failed. */
  | { eventId: string; outcome: "extract_failed"; reason?: string }
  /** Nothing to write on purpose, e.g. a re-fetch found the row gone. */
  | { eventId: string; outcome: "skipped"; reason?: string }
  /** Not now, e.g. a request budget is spent. Retried later, the attempt not counted. */
  | { eventId: string; outcome: "deferred"; reason?: string };

export interface WebhookDefinition<Config = Record<string, unknown>> {
  verification: WebhookVerification;
  /** Every event type the connector handles, for subscribing at the vendor. */
  events?: string[];
  /**
   * Where a delivery's event id sits in its JSON body, as a dotted path
   * (`"eventId"`, `"event.id"`). Mako dedupes deliveries on it. Without it,
   * or when the path holds no id, Mako uses `id`, then `event.id`, then a
   * SHA-1 of the raw body.
   */
  eventIdPath?: string;
  /** Where the event type sits, as a dotted path (`"event.type"`, `"0.event"`). */
  eventTypePath?: string;
  /**
   * A batch in, one outcome per event out, in the same order. Runs in a box
   * with the connection's credential in `ctx.config`, so a handler can
   * re-fetch a row whose payload is partial.
   */
  handleBatch(
    ctx: Context<Config>,
    events: WebhookEvent[],
    options: WebhookBatchOptions,
  ): Promise<WebhookOutcome[]> | WebhookOutcome[];
}

export interface ConnectorDefinition<Config = Record<string, unknown>> {
  /** Lowercase slug; the connector's identity. */
  name: string;
  version: string;
  title?: string;
  documentationUrl?: string;
  config?: {
    required?: string[];
    /** JSON Schema properties. Mark secrets with `airbyte_secret: true`. */
    properties?: Record<string, Record<string, unknown>>;
  };
  /** Throw with the vendor's message, or return false, when the credential is bad. */
  check?(ctx: Context<Config>): Promise<unknown>;
  entities: Record<string, EntityDefinition<Config>>;
  /** Webhook deliveries, verified by Mako and handed over in batches. */
  webhooks?: WebhookDefinition<Config>;
}

export interface Connector {
  readonly __makoConnector: 1;
  spec(): Record<string, unknown>;
  check(ctx: Context): Promise<{ status: "SUCCEEDED" | "FAILED"; message?: string }>;
  discover(ctx: Context): Promise<Array<Record<string, unknown>>>;
  entityNames(): string[];
  entity(name: string): EntityDefinition | undefined;
  hasWebhooks(): boolean;
  handleWebhooks(
    ctx: Context,
    events: WebhookEvent[],
    options?: WebhookBatchOptions,
  ): Promise<WebhookOutcome[]>;
}

export function defineConnector<Config = Record<string, unknown>>(
  definition: ConnectorDefinition<Config>,
): Connector;

export function createHttp(options?: HttpOptions & { log?: (message: string) => void }): Http;
export function paginate(options: PaginateOptions): AsyncGenerator<{
  records: unknown[];
  cursor: unknown;
  hasMore: boolean;
}>;
export function pick(object: unknown, path?: string): unknown;
export function schemaToJsonSchema(schema?: EntitySchema): Record<string, unknown>;
export function fieldToJsonSchema(field: FieldType): Record<string, unknown>;
export function run(argv?: string[]): Promise<number>;
export function main(argv?: string[]): Promise<void>;
export function parseArgs(argv: string[]): { command: string; options: Record<string, string | true> };

export class HttpError extends Error {
  status: number;
  url: string;
  body: string;
}
