/**
 * PandaDoc on @makoai/connector-sdk: `spec`, `check`, `discover`, `read` and
 * `webhooks`.
 *
 * A port of the in-process connector in `api/src/connectors/pandadoc/`, with
 * the same 4 entities, schemas, pagination, document hydration and
 * incremental modes. `fixtures/parity.mjs` runs both against the same
 * recorded PandaDoc responses and compares them entity by entity.
 *
 * Read state is `{ page, totalProcessed, mako: { since } }`, the in-process
 * `FetchState` fields:
 * - `documents` and `templates` page with `?count=&page=`. `page` is the next
 *   page while more remain, and the last page read once the list ends.
 * - `contacts` and `members` come whole in one response.
 * - `mako.since` (ISO 8601) is Mako's incremental anchor. Documents send it
 *   as `modified_from`; templates and members keep rows whose
 *   `date_modified` is at or after it; contacts ignore it.
 *
 * Document hydration: the list returns a shallow projection, so every listed
 * document is re-read from `/details`, 5 at a time, with the rate-limit
 * delay between groups. A failed detail read keeps the list projection. A
 * hydrating chunk reads at most 2 pages, then ends with `hasMore: true`.
 * `fetch_document_details: false` turns hydration off.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import {
  PANDADOC_DEFAULT_BASE_URL,
  PandaDocHttpError,
  createPandaDocClient,
  type PandaDocClient,
} from "./client.ts";
import { pandaDocJsonSchema, ENTITY_FIELDS } from "./schema.ts";
import {
  PANDADOC_WEBHOOK_EVENTS,
  PANDADOC_WEBHOOK_VERIFICATION,
  handlePandaDocWebhookBatch,
} from "./webhooks.ts";

/** The in-process defaults for `sync_batch_size` and `rate_limit_delay_ms`. */
const PAGE_SIZE = 100;
const MAX_PAGE_LIMIT = 100;
const RATE_LIMIT_DELAY_MS = 200;
const DOCUMENT_DETAIL_CONCURRENCY = 5;
const DETAIL_HYDRATION_MAX_PAGES_PER_CHUNK = 2;

interface PandaDocConfig {
  api_key: string;
  api_base_url?: string;
  fetch_document_details?: boolean | string;
  /** Rows per page, from `settings.sync_batch_size` (set by Mako). */
  __page_size?: number;
  /** Delay between pages, from `settings.rate_limit_delay_ms`. */
  __rate_limit_delay_ms?: number;
}

interface ReadState {
  page?: number;
  totalProcessed?: number;
  mako?: { since?: string };
}

type Entity = "documents" | "templates" | "contacts" | "members";

const LIST_PATH: Record<Entity, string> = {
  documents: "/public/v1/documents",
  templates: "/public/v1/templates",
  contacts: "/public/v1/contacts",
  members: "/public/v1/members",
};

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** `clampPageSize(batchSize, 100, 100)`, as in-process. */
function pageSize(config: PandaDocConfig): number {
  const value = Number(config.__page_size);
  const size = Number.isFinite(value) && value > 0 ? value : PAGE_SIZE;
  return Math.min(Math.max(size, 1), MAX_PAGE_LIMIT);
}

function rateLimitDelay(config: PandaDocConfig): number {
  const value = Number(config.__rate_limit_delay_ms);
  return Number.isFinite(value) && value > 0 ? value : RATE_LIMIT_DELAY_MS;
}

function hydrates(config: PandaDocConfig): boolean {
  const value = config.fetch_document_details;
  return value !== false && value !== "false";
}

function client(ctx: Context<PandaDocConfig>): PandaDocClient {
  return createPandaDocClient({
    apiKey: ctx.config.api_key,
    baseUrl: ctx.config.api_base_url,
    log: message => ctx.log(message),
  });
}

function parseSince(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.mako.since is not a date: ${value}`);
  }
  return date;
}

/** Members have no `id`: `membership_id` stands in, as in-process. */
function withId(
  entity: Entity,
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record == null) return record;
  if (typeof record.id === "string" && record.id.length > 0) return record;
  if (entity === "members" && typeof record.membership_id === "string") {
    return { ...record, id: record.membership_id };
  }
  return record;
}

/** Templates and members keep rows modified at or after `since`. */
function mapRecords(
  entity: Entity,
  results: Record<string, unknown>[],
  since?: Date,
): Record<string, unknown>[] {
  let records = results.map(item => withId(entity, item));
  if (since && (entity === "templates" || entity === "members")) {
    const sinceMs = since.getTime();
    records = records.filter(record => {
      const value = record.date_modified;
      const ts = typeof value === "string" ? new Date(value).getTime() : NaN;
      return Number.isFinite(ts) ? ts >= sinceMs : false;
    });
  }
  return records;
}

/** List projection merged with `/details`, 5 at a time; a failure keeps the projection. */
async function hydrate(
  ctx: Context<PandaDocConfig>,
  api: PandaDocClient,
  records: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const enriched = [...records];
  for (
    let start = 0;
    start < enriched.length;
    start += DOCUMENT_DETAIL_CONCURRENCY
  ) {
    const group = enriched.slice(start, start + DOCUMENT_DETAIL_CONCURRENCY);
    await Promise.all(
      group.map(async (record, offset) => {
        const id =
          typeof record.id === "string" && record.id.length > 0
            ? record.id
            : undefined;
        if (!id) return;
        try {
          const detail = await api.get<unknown>(
            `/public/v1/documents/${encodeURIComponent(id)}/details`,
          );
          if (detail && typeof detail === "object") {
            enriched[start + offset] = withId("documents", {
              ...record,
              ...(detail as Record<string, unknown>),
            });
          }
        } catch (error) {
          ctx.log(
            `Failed to fetch PandaDoc document details for ${id}; keeping the list projection: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
    if (start + DOCUMENT_DETAIL_CONCURRENCY < enriched.length) {
      await sleep(rateLimitDelay(ctx.config));
    }
  }
  return enriched;
}

const resultsOf = (body: unknown): Record<string, unknown>[] => {
  const results = (body as { results?: unknown })?.results;
  return Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
};

/** `documents` and `templates`: `?count=&page=`, a short page ends the list. */
async function* readPaginated(
  ctx: Context<PandaDocConfig>,
  entity: "documents" | "templates",
  state: ReadState,
) {
  const api = client(ctx);
  const anchor = state.mako?.since;
  const since = parseSince(anchor);
  const count = pageSize(ctx.config);
  const hydrating = entity === "documents" && hydrates(ctx.config);
  const cap = hydrating
    ? DETAIL_HYDRATION_MAX_PAGES_PER_CHUNK
    : Number.MAX_SAFE_INTEGER;
  const mako = anchor ? { mako: { since: anchor } } : {};

  let page = typeof state.page === "number" ? state.page : 1;
  let total =
    typeof state.totalProcessed === "number" ? state.totalProcessed : 0;
  let pages = 0;

  while (true) {
    const params: Record<string, string | number | undefined> = { count, page };
    if (entity === "documents") {
      params.order_by = "date_modified";
      if (since) params.modified_from = since.toISOString();
    }
    const results = resultsOf(await api.get(LIST_PATH[entity], params));
    let records = mapRecords(entity, results, since);
    if (hydrating && records.length > 0) {
      records = await hydrate(ctx, api, records);
    }
    total += records.length;
    pages++;

    if (results.length < count) {
      yield {
        records,
        state: { page, totalProcessed: total, ...mako },
        hasMore: false,
      };
      return;
    }
    page++;
    yield {
      records,
      state: { page, totalProcessed: total, ...mako },
      hasMore: true,
    };
    // A hydrating chunk stops at 2 pages, as in-process; the next chunk
    // resumes at `page`.
    if (pages >= cap) return;
    await sleep(rateLimitDelay(ctx.config));
  }
}

/** `contacts` and `members`: the whole list in one response. */
async function* readWhole(
  ctx: Context<PandaDocConfig>,
  entity: "contacts" | "members",
  state: ReadState,
) {
  const anchor = state.mako?.since;
  const records = mapRecords(
    entity,
    resultsOf(await client(ctx).get(LIST_PATH[entity])),
    parseSince(anchor),
  );
  yield {
    records,
    state: {
      totalProcessed: records.length,
      ...(anchor ? { mako: { since: anchor } } : {}),
    },
    hasMore: false,
  };
}

const LAYOUT = (partitionField: string) => ({
  partitionField,
  partitionGranularity: "day" as const,
  clusterFields: ["_dataSourceId", "id"],
});

function entity(
  name: Entity,
  label: string,
  description: string,
  extra: Partial<EntityDefinition<PandaDocConfig>>,
): EntityDefinition<PandaDocConfig> {
  return {
    label,
    description,
    primaryKey: ["id"],
    schema: Object.fromEntries(
      Object.entries(ENTITY_FIELDS[name]).map(([field, type]) => [field, type]),
    ),
    // A whole JSON Schema, so `id` can be required.
    discoverSchema: () => pandaDocJsonSchema(name) as unknown as EntitySchema,
    read: (ctx, state) =>
      name === "documents" || name === "templates"
        ? readPaginated(ctx, name, state as ReadState)
        : readWhole(ctx, name, state as ReadState),
    ...extra,
  };
}

export default defineConnector<PandaDocConfig>({
  name: "pandadoc",
  version: "1.0.0",
  title: "PandaDoc",
  documentationUrl: "https://developers.pandadoc.com/reference/about",
  config: {
    required: ["api_key"],
    properties: {
      api_key: {
        type: "string",
        title: "API Key",
        description:
          "PandaDoc API Key (generate in the Developer Dashboard). Used as `Authorization: API-Key <key>`.",
        airbyte_secret: true,
        order: 0,
      },
      api_base_url: {
        type: "string",
        title: "API Base URL",
        default: PANDADOC_DEFAULT_BASE_URL,
        order: 1,
      },
      fetch_document_details: {
        type: "boolean",
        title: "Fetch full document details",
        default: true,
        description:
          "Hydrate each document with its full detail (fields, tokens, metadata, pricing, products, recipients) during backfill. The document list endpoint omits these. Disable to reduce API calls if you hit rate limits.",
        order: 2,
      },
    },
  },
  async check(ctx) {
    await client(ctx).get(LIST_PATH.documents, { count: 1, page: 1 });
    return true;
  },
  entities: {
    documents: entity(
      "documents",
      "Documents",
      "PandaDoc documents with status, recipients, and pricing",
      {
        cursorField: "date_modified",
        incremental: "native",
        layout: LAYOUT("date_created"),
      },
    ),
    templates: entity("templates", "Templates", "Document templates", {
      cursorField: "date_modified",
      incremental: "client-filter",
      layout: LAYOUT("date_created"),
    }),
    contacts: entity("contacts", "Contacts", "Workspace contacts directory", {
      layout: LAYOUT("_syncedAt"),
    }),
    members: entity("members", "Members", "Workspace members (users)", {
      cursorField: "date_modified",
      incremental: "client-filter",
      layout: LAYOUT("date_created"),
    }),
  },
  webhooks: {
    verification: PANDADOC_WEBHOOK_VERIFICATION,
    events: PANDADOC_WEBHOOK_EVENTS,
    eventTypePath: "0.event",
    handleBatch: (ctx, events) =>
      handlePandaDocWebhookBatch(
        {
          api: client(ctx),
          pauseMs: rateLimitDelay(ctx.config),
          sleep,
          log: message => ctx.log(message),
        },
        events,
      ),
  },
});

export { PandaDocHttpError };
