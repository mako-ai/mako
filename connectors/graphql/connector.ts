/**
 * GraphQL on @makoai/connector-sdk: `spec`, `check`, `discover` and `read`.
 *
 * A port of the in-process connector in `api/src/connectors/graphql/`.
 * Nothing runs it in production yet. `fixtures/parity.mjs` runs both
 * against the same recorded GraphQL responses and compares them query by
 * query.
 *
 * ENTITIES are the flow's queries, one per query (`queryEntities` with
 * `source: "flow"`). Mako puts a flow's `queries` in `config.queries`, as it
 * does for the in-process connector. Each is untyped: rows land as they
 * come, with no declared schema, as in-process.
 *
 * READ STATE mirrors the in-process `FetchState`, so a chunk boundary means
 * the same thing on both sides: `{ offset, cursor, totalProcessed,
 * totalCount }`. `mako.since` (ISO 8601) is the incremental anchor, which
 * Mako owns; the connector copies it forward and never moves it.
 *
 * PAGINATION, as in-process, from the query text:
 * - `$after` or `$cursor` in the query: variables `first` and `after`;
 *   `after` starts at "1970-01-01" for a timestamp or string `$after`, else
 *   0, then follows `cursor_path`;
 * - otherwise `limit` and `offset`, the offset growing by the page size.
 * A page has a next one when `has_next_page_path` holds a truthy value, or,
 * without that path, when it came back full.
 *
 * INCREMENTAL is a client filter, as in-process: rows whose `updated_at`,
 * `updatedAt` or `modified_at` is after `since` are kept. A query with a
 * `$since` variable also gets `since` as ISO 8601, for the server to filter.
 *
 * The first chunk sends the count query once when `total_count_path` is
 * set, as in-process does to report progress. Its answer is kept in the
 * state; a failure is ignored.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type { Context, ReadBatch } from "@makoai/connector-sdk";
import { GraphqlClient, REQUEST_TIMEOUT_MS } from "./client.ts";

/** The in-process defaults: a query's page size and the pause after a page. */
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;

/** The in-process `check` probe, byte for byte. */
const INTROSPECTION_QUERY = `
          query {
            __schema {
              queryType {
                name
              }
            }
          }
        `;

interface GraphqlConfig {
  endpoint?: string;
  headers?: string | Record<string, string>;
  queries?: Array<Record<string, unknown>>;
  /**
   * The batch size a caller asked for (a probe). It wins over a query's
   * `batch_size`, as `options.batchSize` does in-process. The connection's
   * `sync_batch_size` never applies: in-process, a query's own page size
   * (100 when unset) always wins over it.
   */
  __requested_page_size?: number;
  /** Delay between pages, from `settings.rate_limit_delay_ms`. */
  __rate_limit_delay_ms?: number;
}

interface QueryConfig {
  name: string;
  query: string;
  variables?: Record<string, unknown>;
  data_path: string;
  total_count_path: string;
  has_next_page_path: string;
  cursor_path: string;
  batch_size: number;
}

type JsonRecord = Record<string, unknown>;

/** `getQueryConfig`: snake_case or camelCase keys, 100 rows by default. */
export function queryConfig(raw: JsonRecord): QueryConfig {
  const text = (key: string, camel: string) =>
    (raw[key] as string) || (raw[camel] as string) || "";
  return {
    name: String(raw.name),
    query: String(raw.query ?? ""),
    variables: raw.variables as Record<string, unknown> | undefined,
    data_path: text("data_path", "dataPath"),
    total_count_path: text("total_count_path", "totalCountPath"),
    has_next_page_path: text("has_next_page_path", "hasNextPagePath"),
    cursor_path: text("cursor_path", "cursorPath"),
    batch_size: Number(raw.batch_size || raw.batchSize) || PAGE_SIZE,
  };
}

/** `getValueByPath`: a dotted path; a missing step is null. */
export function valueAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    const value = current
      ? (current as Record<string, unknown>)[key]
      : undefined;
    return current && value !== undefined ? value : null;
  }, obj);
}

/** A variable's declared type in the query text: `$after: timestamptz`. */
function variableType(query: string, name: string): string | undefined {
  return new RegExp(`\\$${name}\\s*:\\s*([!\\[\\]\\w_]+)`, "i").exec(
    query,
  )?.[1];
}

/** `$after` starts at the epoch for a timestamp or string, else 0. */
function defaultAfter(type: string | undefined): string | number {
  if (!type) return 0;
  const t = type.toLowerCase();
  return t.includes("timestamptz") ||
    t.includes("timestamp") ||
    t.includes("string")
    ? "1970-01-01"
    : 0;
}

function pageSize(config: GraphqlConfig, query: QueryConfig): number {
  const requested = Number(config.__requested_page_size);
  return Number(requested || query.batch_size || PAGE_SIZE);
}

function rateLimitDelay(config: GraphqlConfig): number {
  const value = Number(config.__rate_limit_delay_ms);
  return Number.isFinite(value) && value > 0 ? value : RATE_LIMIT_DELAY_MS;
}

function parseSince(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.mako.since is not a date: ${value}`);
  }
  return date;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** `fetchTotalCount`: the query with empty pages; any failure is undefined. */
async function totalCount(
  api: GraphqlClient,
  query: QueryConfig,
  log: (message: string) => void,
): Promise<unknown> {
  try {
    const text = query.query;
    const variables: JsonRecord = { ...(query.variables || {}) };
    if (text.includes("$limit")) variables.limit = 0;
    if (text.includes("$first")) variables.first = 0;
    if (text.includes("$offset")) variables.offset = 0;
    if (text.includes("$after")) {
      variables.after = defaultAfter(variableType(text, "after"));
    }
    const response = await api.query(text, variables, REQUEST_TIMEOUT_MS);
    return valueAt(response, query.total_count_path);
  } catch (error) {
    log(
      `Could not fetch total count: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** One query's pages, as the in-process `fetchEntityChunk` walks them. */
async function* readQuery(
  ctx: Context<GraphqlConfig>,
  raw: JsonRecord,
): AsyncGenerator<ReadBatch> {
  const query = queryConfig(raw);
  const config = ctx.config;
  const api = new GraphqlClient(config, message => ctx.log(message));
  const state = ctx.state as JsonRecord & { mako?: { since?: string } };
  const anchor = state.mako?.since;
  const since = parseSince(anchor);
  const mako = anchor ? { mako: { since: anchor } } : {};
  const batchSize = pageSize(config, query);
  const delay = rateLimitDelay(config);

  // A first chunk has no position yet; in-process, it has no state at all.
  const first = typeof state.offset !== "number";
  let cursor: unknown = (state.cursor as unknown) || null;
  let offset = Number(state.offset ?? 0) || 0;
  let processed = Number(state.totalProcessed ?? 0) || 0;
  let count = state.totalCount as unknown;
  if (first && query.total_count_path) {
    count = await totalCount(api, query, message => ctx.log(message));
  }

  const usesCursor =
    query.query.includes("$after") || query.query.includes("$cursor");
  // In-process returns `cursor || undefined`, and a count it never got as
  // undefined: JSON drops both, and so does this state.
  const position = () => ({
    ...mako,
    offset,
    ...(cursor ? { cursor } : {}),
    totalProcessed: processed,
    ...(count !== undefined && count !== null ? { totalCount: count } : {}),
  });

  for (;;) {
    let variables: JsonRecord = { ...(query.variables || {}) };
    if (usesCursor) {
      variables = {
        ...variables,
        first: Number(batchSize),
        after:
          cursor !== null && cursor !== undefined
            ? cursor
            : defaultAfter(variableType(query.query, "after")),
      };
    } else {
      variables = {
        ...variables,
        limit: Number(batchSize),
        offset: Number(offset),
      };
    }
    if (query.query.includes("$since") && since) {
      variables.since = since.toISOString();
    }

    const response = await api.withRetry(() =>
      api.query(query.query, variables, REQUEST_TIMEOUT_MS),
    );
    const data = valueAt(response, query.data_path);
    if (!Array.isArray(data)) {
      ctx.log(`Data at path ${query.data_path} is not an array`);
      yield { records: [], state: position(), hasMore: false };
      return;
    }

    const rows = since
      ? data.filter((record: JsonRecord) => {
          const updatedAt =
            record?.updated_at || record?.updatedAt || record?.modified_at;
          return Boolean(updatedAt) && new Date(updatedAt as string) > since;
        })
      : data;
    processed += rows.length;

    const hasMore = query.has_next_page_path
      ? Boolean(valueAt(response, query.has_next_page_path))
      : data.length === batchSize;
    if (hasMore) {
      if (usesCursor && query.cursor_path) {
        cursor = valueAt(response, query.cursor_path);
      } else {
        offset += batchSize;
      }
    }
    yield { records: rows, state: position(), hasMore };
    if (!hasMore) return;
    await sleep(delay);
  }
}

export default defineConnector<GraphqlConfig>({
  name: "graphql",
  version: "1.0.0",
  title: "GraphQL",
  documentationUrl: "https://graphql.org/learn/serving-over-http/",
  config: {
    required: ["endpoint"],
    properties: {
      endpoint: {
        type: "string",
        title: "GraphQL Endpoint URL",
        description: "The GraphQL endpoint URL (not encrypted)",
        examples: ["https://api.example.com/graphql"],
        order: 0,
      },
      headers: {
        type: "string",
        title: "Custom Headers (JSON)",
        description:
          "Authentication and custom headers as JSON (encrypted when saved)",
        airbyte_secret: true,
        multiline: true,
        rows: 6,
        examples: [
          `{
  "Authorization": "Bearer your-token-here",
  "X-API-Key": "your-api-key",
  "x-hasura-admin-secret": "your-hasura-secret",
  "X-Custom-Header": "custom-value"
}`,
        ],
        order: 1,
      },
    },
  },

  /**
   * The in-process `testConnection`: the config checks, then one
   * introspection query. GraphQL `errors` fail it.
   */
  async check(ctx) {
    const config = ctx.config;
    const errors: string[] = [];
    if (!config.endpoint) errors.push("GraphQL endpoint is required");
    if (config.headers && typeof config.headers === "string") {
      try {
        JSON.parse(config.headers);
      } catch {
        errors.push("Headers must be valid JSON format");
      }
    }
    if (Array.isArray(config.queries)) {
      config.queries.forEach((query, index) => {
        if (!query?.name) errors.push(`Query ${index + 1} is missing a name`);
        if (!query?.query) {
          errors.push(`Query ${index + 1} is missing the GraphQL query`);
        }
        if (!query?.data_path && !query?.dataPath) {
          errors.push(`Query ${index + 1} is missing the data path`);
        }
      });
    }
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join("; ")}`);
    }
    const api = new GraphqlClient(config, message => ctx.log(message));
    const response = (await api.post({ query: INTROSPECTION_QUERY })) as {
      errors?: unknown;
    };
    if (response && typeof response === "object" && response.errors) {
      throw new Error(
        `GraphQL endpoint returned errors: ${JSON.stringify(response.errors).slice(0, 2_000)}`,
      );
    }
    return true;
  },

  queryEntities: {
    source: "flow",
    incremental: "client-filter",
    form: {
      label: "GraphQL Queries",
      required: true,
      items: {
        required: ["name", "query", "data_path"],
        properties: {
          name: {
            type: "string",
            title: "Entity Name",
            description: "Name for this entity (used for collection naming)",
            examples: ["items"],
          },
          query: {
            type: "string",
            title: "GraphQL Query",
            description:
              "Your GraphQL query with pagination support ($limit/$offset or $first/$after)",
            multiline: true,
            rows: 8,
            examples: [
              "query GetData($limit: Int!, $offset: Int!) {\n  items(limit: $limit, offset: $offset) {\n    id\n    name\n    created_at\n  }\n}",
            ],
          },
          data_path: {
            type: "string",
            title: "Data Path",
            description: "JSONPath to the data array in the response",
            examples: ["data.items"],
          },
          total_count_path: {
            type: "string",
            title: "Total Count Path",
            description: "JSONPath to total count (for progress tracking)",
            examples: ["data.items_aggregate.aggregate.count"],
          },
          has_next_page_path: {
            type: "string",
            title: "Has Next Page Path",
            description: "JSONPath for cursor-based pagination (optional)",
            examples: ["data.items.pageInfo.hasNextPage"],
          },
          cursor_path: {
            type: "string",
            title: "Cursor Path",
            description: "JSONPath for next cursor value (optional)",
            examples: ["data.items.pageInfo.endCursor"],
          },
          batch_size: {
            type: "number",
            title: "Batch Size",
            description: "Number of records per request",
            default: 100,
            examples: ["100"],
          },
        },
      },
    },
    entity: query => ({
      untyped: true,
      incremental: "client-filter",
      read: ctx => readQuery(ctx as Context<GraphqlConfig>, query),
    }),
  },
});
