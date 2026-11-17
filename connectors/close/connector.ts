/**
 * Close CRM on @makoai/connector-sdk: `spec`, `check`, `discover` and `read`.
 *
 * A port of the in-process connector in `api/src/connectors/close/`, with the
 * same 22 entities, schemas, cursors, pagination and rate-limit policy.
 * Nothing runs it in production yet. `fixtures/parity.mjs` runs both against
 * the same recorded Close responses and compares them entity by entity.
 *
 * Read state per entity:
 * - Search API entities (leads, contacts, opportunities, 10 activity types):
 *   the in-process window position, see `search.ts`.
 * - Offset lists (users, groups, 5 lookups): `{ offset }`, see `lists.ts`.
 *   Users also get `is_active` from the organization's memberships, and a
 *   deactivated user is marked deleted (see `memberships.ts`).
 * - `custom_fields`: one batch, no state. Every custom-field type Close
 *   lists, activity and custom-object fields included (see `lists.ts`).
 * - `custom_objects`: nothing, as in-process (Close needs a lead id per
 *   request, so it is webhook-only).
 *
 * `since` (ISO 8601) is the incremental anchor. It comes from
 * `state.mako.since`, which `SandboxedConnector` sets on every chunk (or a
 * bare `state.since` from a hand run). The connector never moves it.
 *
 * Caller-set config keys, never in the credential form (like the SDK's own
 * `__http`): `__base_url`, `__page_size` (the in-process `sync_batch_size`;
 * on the Search API it lowers the 200-row page, which in-process ignores)
 * and `__rate_limit_delay_ms` (the in-process `rate_limit_delay_ms`).
 * Search pages also shrink by themselves when one is too large for a chunk
 * (see `search.ts`).
 *
 * The webhook half is in `webhooks.ts`, exported below as `webhook`.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import {
  CLOSE_ACTIVITY_TYPES,
  CLOSE_BASE_ENTITIES,
  CLOSE_LOOKUP_ENDPOINTS,
  type ReadKind,
} from "./catalog.ts";
import { type CloseClient, createCloseClient } from "./client.ts";
import { CloseCustomFieldCache } from "./custom-fields.ts";
import { readAllCustomFields, readOffsetList } from "./lists.ts";
import { readMembershipStatus, withMembershipStatus } from "./memberships.ts";
import { closeBaseFields, closeJsonSchema } from "./schema.ts";
import {
  CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
  type SearchState,
  readCloseSearch,
  searchPageSize,
} from "./search.ts";
import {
  closeSupportedWebhookEvents,
  closeWebhookChangeRecords,
  closeWebhookEventMapping,
  closeWebhookEventsForEntities,
  handleWebhookBatch,
  verifyCloseWebhook,
} from "./webhooks.ts";

interface CloseConfig {
  api_key: string;
  __base_url?: string;
  __page_size?: number;
  __rate_limit_delay_ms?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_RATE_LIMIT_DELAY_MS = 200;
/** Close's own floor between requests, in-process too. */
const MIN_REQUEST_SPACING_MS = 500;

const positiveInt = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const pageSize = (config: CloseConfig) =>
  positiveInt(config.__page_size, DEFAULT_PAGE_SIZE);
const rateLimitDelay = (config: CloseConfig) =>
  positiveInt(config.__rate_limit_delay_ms, DEFAULT_RATE_LIMIT_DELAY_MS);

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The host the key may be sent to. Tenant config reaches the box unfiltered
 * today, so `__base_url` is honoured only for Close itself or a loopback
 * address (the fixture server). Anything else is refused, never used: the
 * stored key must not follow a URL a connection editor typed.
 */
export function closeBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("__base_url is not a URL");
  }
  const close = url.protocol === "https:" && url.hostname === "api.close.com";
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!close && !loopback) {
    throw new Error(
      "__base_url must be https://api.close.com or a loopback address",
    );
  }
  return String(value);
}

/** One client per process: the gate is per key, and a box holds one key. */
let client: CloseClient | undefined;
function closeClient(ctx: Context<CloseConfig>): CloseClient {
  if (!ctx.config.api_key) throw new Error("Close API key not configured");
  client ??= createCloseClient({
    apiKey: ctx.config.api_key,
    baseUrl: closeBaseUrl(ctx.config.__base_url),
    minDelayMs: Math.max(MIN_REQUEST_SPACING_MS, rateLimitDelay(ctx.config)),
    log: message => ctx.log(message),
  });
  return client;
}

let customFieldCache: CloseCustomFieldCache | undefined;
function customFields(ctx: Context<CloseConfig>): CloseCustomFieldCache {
  customFieldCache ??= new CloseCustomFieldCache(() => closeClient(ctx));
  return customFieldCache;
}

/** Per process, like the in-process instance field: only ever shrinks. */
const selectorBudget = { size: CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH };

function sinceOf(state: Record<string, unknown>): Date | undefined {
  const mako = state.mako as Record<string, unknown> | undefined;
  const value = mako?.since ?? state.since;
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.since is not a date: ${value}`);
  }
  return date;
}

/** The connector's own position, plus the anchor it was given, unchanged. */
function withSince(
  state: Record<string, unknown>,
  position: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const mako = state.mako as Record<string, unknown> | undefined;
  return {
    ...(position ?? {}),
    ...(typeof mako?.since === "string" ? { mako: { since: mako.since } } : {}),
    ...(typeof state.since === "string" ? { since: state.since } : {}),
  };
}

/** The in-process `layoutSuggestion`, the same for every Close entity. */
const LAYOUT = {
  partitionField: "_syncedAt",
  partitionGranularity: "day" as const,
  clusterFields: ["_dataSourceId", "id"],
};

/** Entities whose columns depend on the account's custom fields. */
const CUSTOM_FIELD_ENTITIES = new Set([
  "leads",
  "contacts",
  "opportunities",
  "activities:CustomActivity",
  "custom_objects",
]);

/** Search entities and `users`/`custom_fields` report a native anchor. */
const INCREMENTAL = new Set(["users", "custom_fields"]);

function entity(
  name: string,
  label: string,
  kind: ReadKind,
  description?: string,
): EntityDefinition<CloseConfig> {
  const fields = closeBaseFields(name);
  if (!fields) throw new Error(`No schema for ${name}`);
  const incremental = kind === "search" || INCREMENTAL.has(name);
  return {
    label,
    ...(description ? { description } : {}),
    primaryKey: ["id"],
    // `native` where in-process reports it: the Search entities filter on
    // `date_updated`; users and custom_fields report it but re-read all.
    ...(incremental
      ? { cursorField: "date_updated", incremental: "native" as const }
      : {}),
    layout: LAYOUT,
    schema: fields,
    // A whole JSON Schema, so `id` can be required and custom fields typed.
    async discoverSchema(ctx) {
      let custom: Awaited<ReturnType<CloseCustomFieldCache["forEntity"]>> = [];
      // Without a key (a build's dry-run discover) the base schema stands.
      if (ctx.config.api_key && CUSTOM_FIELD_ENTITIES.has(name)) {
        custom = await customFields(ctx).forEntity(name);
      }
      return closeJsonSchema(name, custom) as unknown as EntitySchema;
    },
    async *read(ctx, rawState) {
      const state = (rawState ?? {}) as Record<string, unknown>;
      const since = sinceOf(state);
      const pause = () => sleep(rateLimitDelay(ctx.config));

      if (kind === "webhook_only") {
        ctx.log(
          "Skipping custom_objects: backfill requires lead_id, use webhooks instead",
        );
        yield { records: [], state: withSince(state, {}), hasMore: false };
        return;
      }

      if (kind === "custom_fields") {
        const records = await readAllCustomFields(closeClient(ctx), message =>
          ctx.log(message),
        );
        yield { records, state: withSince(state, {}), hasMore: false };
        return;
      }

      if (kind === "search") {
        for await (const batch of readCloseSearch(
          {
            api: closeClient(ctx),
            customFields: customFields(ctx),
            log: message => ctx.log(message),
            pause: () =>
              sleep(
                Math.max(MIN_REQUEST_SPACING_MS, rateLimitDelay(ctx.config)),
              ),
            selectorBudget,
            pageSize: searchPageSize(ctx.config.__page_size),
          },
          name,
          state as SearchState,
          since,
        )) {
          yield { ...batch, state: withSince(state, batch.state) };
        }
        return;
      }

      // Deactivation lives on the memberships, not on `/user/`.
      const membership =
        kind === "users"
          ? await readMembershipStatus(closeClient(ctx))
          : undefined;
      const endpoint =
        kind === "users"
          ? "/user/"
          : kind === "groups"
            ? "/group/"
            : CLOSE_LOOKUP_ENDPOINTS[name];
      for await (const batch of readOffsetList({
        api: closeClient(ctx),
        endpoint,
        pageSize: pageSize(ctx.config),
        pause,
        startOffset: Number(state.offset) || 0,
        // `/group/` omits name and members unless asked for them.
        ...(kind === "groups"
          ? { extraParams: { _fields: "id,name,members,organization_id" } }
          : {}),
      })) {
        const records = membership
          ? withMembershipStatus(batch.records, membership)
          : batch.records;
        yield { ...batch, records, state: withSince(state, batch.state) };
      }
    },
  };
}

const ENTITIES: Record<string, EntityDefinition<CloseConfig>> = {
  ...Object.fromEntries(
    CLOSE_BASE_ENTITIES.map(([name, label, kind]) => [
      name,
      entity(name, label, kind),
    ]),
  ),
  ...Object.fromEntries(
    CLOSE_ACTIVITY_TYPES.map(type => [
      `activities:${type.name}`,
      entity(`activities:${type.name}`, type.label, "search", type.description),
    ]),
  ),
};

export default defineConnector<CloseConfig>({
  name: "close",
  version: "1.0.0",
  title: "Close",
  documentationUrl: "https://developer.close.com/",
  config: {
    required: ["api_key"],
    properties: {
      api_key: {
        type: "string",
        title: "API Key",
        description: "Close API Key (generate in Close settings)",
        airbyte_secret: true,
        order: 0,
      },
    },
  },
  async check(ctx) {
    await closeClient(ctx).get("/me/");
    return true;
  },
  entities: ENTITIES,
});

/**
 * The webhook half, in the shape a `webhook` command would call (see the PR
 * body). No SDK command runs it yet; `fixtures/webhook-cli.mjs` stands in.
 */
export const webhook = {
  events: closeSupportedWebhookEvents,
  eventsForEntities: closeWebhookEventsForEntities,
  mapping: closeWebhookEventMapping,
  verify: verifyCloseWebhook,
  changeRecords: closeWebhookChangeRecords,
  handleBatch: handleWebhookBatch,
};
