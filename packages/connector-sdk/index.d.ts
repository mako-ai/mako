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
 * Data, never code: a signing secret stays in Mako and no box sees it.
 */
export interface WebhookVerification {
  /**
   * `hmac-sha256` under the flow's signing secret, or `rsa-sha256` against
   * the vendor's public keys (`publicKeys`), which needs no secret.
   */
  scheme: "hmac-sha256" | "rsa-sha256";
  /** HMAC only: how the stored signing secret becomes the HMAC key. */
  secretEncoding?: "hex" | "base64" | "utf8";
  /** RSA only: 1 to 4 PEM public keys. A signature any one verifies is valid. */
  publicKeys?: string[];
  /**
   * The signed bytes, in order: `"body"` (the raw request body),
   * `"header:<lowercase name>"`, `"param:<key>"` (a value of the signature
   * header, with `signatureParam`) or `"literal:<text>"`. Must include `"body"`.
   */
  signedPayload: string[];
  /** Lowercase name of the header that carries the signature. */
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  /** Text before the signature in its header, e.g. `"sha256="`. */
  signaturePrefix?: string;
  /**
   * The signature header is `key=value` pairs joined by commas
   * (`t=1492774577,v1=5257a8...`); the signature is this key's value. A
   * key given twice counts once, the last.
   */
  signatureParam?: string;
  /**
   * A header with the send time in Unix seconds, and the window around now
   * it must fall in (1 to 86400). Declared together. Mako then refuses a
   * delivery without the header or outside the window.
   */
  timestampHeader?: string;
  /** As `timestampHeader`, for a send time inside the signature header. */
  timestampParam?: string;
  toleranceSeconds?: number;
  /**
   * The vendor's test ping: a delivery whose `header` equals `value`
   * (ignoring case) is answered without a signature and stored under
   * `eventType` with no payload, so a handler can answer it `unmapped`.
   */
  testNotification?: { header: string; value: string; eventType: string };
}

/**
 * Where a stored delivery's event id and type come from. Mako reads them
 * when it stores the delivery, adds them to the stored payload as `id` and
 * `type`, and deduplicates vendor retries on the id.
 */
export interface WebhookDelivery {
  /** Lowercase name of a header with the vendor's delivery id. */
  idHeader?: string;
  /** Else, dotted body paths whose values, joined with ":", are the id. */
  idFields?: string[];
  /** Dotted body path to the event type. */
  typeField?: string;
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
  /** Where each delivery's event id and type come from. */
  delivery?: WebhookDelivery;
  /** Every event type the connector handles, for subscribing at the vendor. */
  events?: string[];
  /**
   * A batch in, one outcome per event out, in the same order. Runs in a box
   * with the connection's credential in `ctx.config`, so a handler can
   * re-fetch a row whose payload is partial.
   */
  handleBatch(
    ctx: Context<Config>,
    events: WebhookEvent[],
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
  handleWebhooks(ctx: Context, events: WebhookEvent[]): Promise<WebhookOutcome[]>;
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
