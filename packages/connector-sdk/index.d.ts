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
  paginate(options: PaginateOptions): AsyncGenerator<{ records: unknown[]; cursor: unknown }>;
  log(message: unknown): void;
  createHttp(options: HttpOptions): Http;
}

export interface ReadBatch {
  records: unknown[];
  /** The position to resume from AFTER these records. Omit to keep the current state. */
  state?: Record<string, unknown>;
}

export interface EntityDefinition<Config = Record<string, unknown>> {
  label?: string;
  description?: string;
  /** Field names that identify a row, used as the destination's merge key. */
  primaryKey?: string[];
  schema?: EntitySchema;
  /** Declare a field here to make the entity incrementally syncable. */
  cursorField?: string;
  /** For APIs whose fields differ per account; overrides `schema`. */
  discoverSchema?(ctx: Context<Config>): Promise<EntitySchema> | EntitySchema;
  /** Yield one page at a time. Stop when there is nothing left. */
  read(ctx: Context<Config>, state: Record<string, unknown>): AsyncGenerator<ReadBatch>;
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
}

export interface Connector {
  readonly __makoConnector: 1;
  spec(): Record<string, unknown>;
  check(ctx: Context): Promise<{ status: "SUCCEEDED" | "FAILED"; message?: string }>;
  discover(ctx: Context): Promise<Array<Record<string, unknown>>>;
  entityNames(): string[];
  entity(name: string): EntityDefinition | undefined;
}

export function defineConnector<Config = Record<string, unknown>>(
  definition: ConnectorDefinition<Config>,
): Connector;

export function createHttp(options?: HttpOptions & { log?: (message: string) => void }): Http;
export function paginate(options: PaginateOptions): AsyncGenerator<{ records: unknown[]; cursor: unknown }>;
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
