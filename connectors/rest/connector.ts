/**
 * Generic REST on @makoai/connector-sdk: `spec`, `check`, `discover` and
 * `read`.
 *
 * A port of the in-process connector in `api/src/connectors/rest/`. Nothing
 * runs it in production yet. `fixtures/parity.mjs` runs both against the
 * same recorded HTTP responses and compares them entity by entity.
 *
 * CONFIG is the in-process form, field for field: `api_base_url`, the
 * encrypted `headers` JSON and the `entities` list. Stored connections work
 * unchanged.
 *
 * ENTITIES are the items of `config.entities`, one per item with a `name`
 * (`queryEntities` with `source: "connection"` and `key: "entities"`). Each
 * is untyped: rows land as they come, with no declared schema, as in-process.
 *
 * READ STATE mirrors the in-process `FetchState`, so a chunk boundary means
 * the same thing on both sides: `{ page, offset, cursor, totalProcessed,
 * totalCount }`. `mako.since` (ISO 8601) is the incremental anchor, which
 * Mako owns; the connector copies it forward and never moves it.
 *
 * PAGINATION, as in-process, from the entity's own fields:
 * - `has_more_path` holds a truthy value, or
 * - with `cursor_param` and `next_cursor_path`, the next cursor exists, or
 * - the page came back full (`batch_size` rows).
 * The next request then moves the cursor, else `page_param` by 1, else the
 * offset by the page size.
 *
 * INCREMENTAL is a client filter, as in-process: rows whose `updated_at`,
 * `updatedAt`, `modified_at` or `modifiedAt` is after `since` are kept, and
 * `updated_after` (ISO 8601) is sent unless a static param already sets it.
 *
 * The first chunk sends one extra request when `total_count_path` is set,
 * as in-process does to report progress. A failure of it is ignored.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type { Context, ReadBatch } from "@makoai/connector-sdk";
import { RestClient } from "./client.ts";

/** The in-process defaults: a page's size and the pause after a page. */
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;

interface RestConfig {
  api_base_url?: string;
  headers?: string | Record<string, string>;
  entities?: Array<Record<string, unknown>>;
  /** The batch size a caller asked for (a probe). It wins over an entity's. */
  __requested_page_size?: number;
  /** The connection's `sync_batch_size`, below an entity's own. */
  __page_size?: number;
  /** Delay between pages, from `settings.rate_limit_delay_ms`. */
  __rate_limit_delay_ms?: number;
}

type JsonRecord = Record<string, any>;

interface EntityConfig {
  name: string;
  path: string;
  method: string;
  data_path: string;
  total_count_path: string;
  page_param: string;
  limit_param: string;
  offset_param: string;
  cursor_param: string;
  next_cursor_path: string;
  has_more_path: string;
  batch_size: number | undefined;
  params: JsonRecord | undefined;
  body: JsonRecord | undefined;
}

/** `normalizeJson`: an object, a JSON string of one, else nothing. */
function normalizeJson(value: unknown): JsonRecord | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value === "object") return value as JsonRecord;
  return undefined;
}

/** `getEntityConfig`: snake_case or camelCase keys. */
export function entityConfig(found: JsonRecord): EntityConfig {
  return {
    name: found.name,
    path: found.path,
    method: (found.method || "GET").toUpperCase(),
    data_path: found.data_path || found.dataPath || "",
    total_count_path: found.total_count_path || found.totalCountPath || "",
    page_param: found.page_param || found.pageParam || "",
    limit_param: found.limit_param || found.limitParam || "",
    offset_param: found.offset_param || found.offsetParam || "",
    cursor_param: found.cursor_param || found.cursorParam || "",
    next_cursor_path: found.next_cursor_path || found.nextCursorPath || "",
    has_more_path: found.has_more_path || found.hasMorePath || "",
    batch_size: Number(found.batch_size || found.batchSize) || undefined,
    params: normalizeJson(found.params),
    body: normalizeJson(found.body),
  };
}

/** `getValueByPath`: a dotted path; a missing step is null. */
export function valueAt(obj: any, path: string): any {
  if (!path) return obj;
  return path.split(".").reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
}

function pageSize(config: RestConfig, entity: EntityConfig): number {
  const requested = Number(config.__requested_page_size);
  const settings = Number(config.__page_size);
  return Number(requested || entity.batch_size || settings || PAGE_SIZE);
}

function rateLimitDelay(config: RestConfig): number {
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

/** `performRequest`: the entity's params, the paging params, `since`. */
async function performRequest(
  client: RestClient,
  def: EntityConfig,
  opts: {
    page?: number;
    limit?: number;
    offset?: number;
    cursor?: string | undefined;
    since?: Date;
  },
): Promise<any> {
  const params: Record<string, any> = { ...(def.params || {}) };

  if (def.limit_param) params[def.limit_param] = opts.limit;
  if (def.page_param) params[def.page_param] = opts.page;
  if (def.offset_param) params[def.offset_param] = opts.offset;
  if (def.cursor_param && opts.cursor) params[def.cursor_param] = opts.cursor;

  if (opts.since) {
    if (
      params["updated_after"] === undefined &&
      params["updatedAfter"] === undefined
    ) {
      params["updated_after"] = opts.since.toISOString();
    }
  }

  return client.request({
    method: def.method,
    path: def.path,
    params,
    body: def.method === "GET" ? undefined : def.body || {},
  });
}

/** One entity's pages, as the in-process `fetchEntityChunk` walks them. */
async function* readEntity(
  ctx: Context<RestConfig>,
  raw: JsonRecord,
): AsyncGenerator<ReadBatch> {
  const def = entityConfig(raw);
  const config = ctx.config;
  const client = new RestClient(config);
  const state = ctx.state as JsonRecord & { mako?: { since?: string } };
  const anchor = state.mako?.since;
  const since = parseSince(anchor);
  const mako = anchor ? { mako: { since: anchor } } : {};
  const batchSize = pageSize(config, def);
  const delay = rateLimitDelay(config);

  // A first chunk has no position yet; in-process, it has no state at all.
  const first = typeof state.page !== "number";
  let page = Number(state.page) || 1;
  let offset = Number(state.offset ?? 0) || 0;
  let cursor: string | undefined = (state.cursor as string) || undefined;
  let processed = Number(state.totalProcessed ?? 0) || 0;
  let totalCount: unknown = state.totalCount;

  if (first && def.total_count_path) {
    try {
      const resp = await performRequest(client, def, {
        page,
        limit: batchSize,
        offset,
        cursor,
        since,
      });
      totalCount = valueAt(resp, def.total_count_path);
    } catch (error) {
      // In-process ignores a failed count probe.
      ctx.log(
        `Could not fetch total count: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // In-process returns `cursor` and a count it never got as undefined: JSON
  // drops both, and so does this state.
  const position = () => ({
    ...mako,
    page,
    offset,
    ...(cursor ? { cursor } : {}),
    totalProcessed: processed,
    ...(totalCount !== undefined && totalCount !== null ? { totalCount } : {}),
  });

  for (;;) {
    const resp = await performRequest(client, def, {
      page,
      limit: batchSize,
      offset,
      cursor,
      since,
    });

    const dataArray = def.data_path ? valueAt(resp, def.data_path) : resp;
    const items: any[] = Array.isArray(dataArray)
      ? dataArray
      : Array.isArray(resp?.data)
        ? resp.data
        : [];

    let filtered = items;
    if (since) {
      filtered = items.filter((r: any) => {
        const ts = r.updated_at || r.updatedAt || r.modified_at || r.modifiedAt;
        return ts ? new Date(ts) > since : false;
      });
    }
    processed += filtered.length;

    let hasMore: boolean;
    if (def.has_more_path) {
      hasMore = !!valueAt(resp, def.has_more_path);
    } else if (def.cursor_param && def.next_cursor_path) {
      const next = valueAt(resp, def.next_cursor_path);
      hasMore = Boolean(next);
      cursor = next || cursor;
    } else {
      hasMore = items.length === batchSize;
    }

    if (hasMore) {
      if (def.cursor_param && def.next_cursor_path) {
        cursor = valueAt(resp, def.next_cursor_path) || cursor;
      } else if (def.page_param) {
        page += 1;
      } else {
        offset += batchSize;
      }
    }
    yield { records: filtered, state: position(), hasMore };
    if (!hasMore) return;
    await sleep(delay);
  }
}

/** The in-process `validateConfig`, minus the checks on the saved record. */
function configErrors(config: RestConfig): string[] {
  const errors: string[] = [];
  if (!config.api_base_url) errors.push("API base URL is required");
  if (!Array.isArray(config.entities) || config.entities.length === 0) {
    errors.push("At least one entity must be configured");
  }
  if (config.headers && typeof config.headers === "string") {
    try {
      JSON.parse(config.headers);
    } catch {
      errors.push("Headers must be valid JSON");
    }
  }
  if (Array.isArray(config.entities)) {
    config.entities.forEach((e, i) => {
      if (e.params && typeof e.params === "string") {
        try {
          JSON.parse(e.params);
        } catch {
          errors.push(`Entity ${i + 1} params must be valid JSON`);
        }
      }
      if (e.body && typeof e.body === "string") {
        try {
          JSON.parse(e.body);
        } catch {
          errors.push(`Entity ${i + 1} body must be valid JSON`);
        }
      }
    });
  }
  return errors;
}

export default defineConnector<RestConfig>({
  name: "rest",
  version: "1.0.0",
  title: "REST",
  documentationUrl: "https://developer.mozilla.org/en-US/docs/Web/HTTP",
  config: {
    required: [],
    properties: {
      api_base_url: {
        type: "string",
        title: "API Base URL",
        description: "Base URL for the REST API",
        examples: ["https://api.example.com"],
      },
      headers: {
        type: "string",
        title: "Headers (JSON)",
        description: "Custom request headers as JSON (encrypted when saved)",
        airbyte_secret: true,
        multiline: true,
        rows: 6,
        examples: [
          `{
  "Authorization": "Bearer <token>",
  "X-API-Key": "<key>"
}`,
        ],
      },
      entities: {
        type: "array",
        title: "Entities",
        items: {
          type: "object",
          required: ["name", "path"],
          properties: {
            name: {
              type: "string",
              title: "Entity Name",
            },
            path: {
              type: "string",
              title: "Endpoint Path",
              examples: ["/items"],
            },
            method: {
              type: "string",
              title: "HTTP Method",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              default: "GET",
            },
            params: {
              type: "string",
              title: "Static Params (JSON)",
              multiline: true,
              rows: 4,
            },
            body: {
              type: "string",
              title: "Request Body (JSON)",
              description:
                "JSON payload sent for POST/PUT/PATCH/DELETE (similar to Postman Body)",
              multiline: true,
              rows: 10,
              examples: [
                `{
  "name": "Example",
  "active": true
}`,
              ],
              showIf: { field: "method", equals: ["POST"] },
            },
            data_path: {
              type: "string",
              title: "Data Path",
              examples: ["data.items"],
            },
            total_count_path: {
              type: "string",
              title: "Total Count Path",
              examples: ["data.total"],
            },
            page_param: {
              type: "string",
              title: "Page Param",
              examples: ["page"],
            },
            limit_param: {
              type: "string",
              title: "Limit Param",
              examples: ["limit"],
            },
            offset_param: {
              type: "string",
              title: "Offset Param",
              examples: ["offset"],
            },
            cursor_param: {
              type: "string",
              title: "Cursor Param",
              examples: ["cursor"],
            },
            next_cursor_path: {
              type: "string",
              title: "Next Cursor Path",
              examples: ["data.next_cursor"],
            },
            has_more_path: {
              type: "string",
              title: "Has More Path",
              examples: ["data.has_more"],
            },
            batch_size: {
              type: "number",
              title: "Batch Size",
              default: 100,
            },
          },
        },
      },
    },
  },

  /**
   * The in-process `testConnection`: the config checks, then `GET /` on the
   * base URL. Any non-2xx answer fails it.
   */
  async check(ctx) {
    const errors = configErrors(ctx.config);
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join("; ")}`);
    }
    const client = new RestClient(ctx.config);
    await client.request({ method: "GET", path: "/", params: {} });
    return true;
  },

  queryEntities: {
    source: "connection",
    key: "entities",
    incremental: "client-filter",
    entity: item => ({
      untyped: true,
      incremental: "client-filter",
      read: ctx => readEntity(ctx as Context<RestConfig>, item),
    }),
  },
});
