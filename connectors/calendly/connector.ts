/**
 * Calendly on @makoai/connector-sdk: `spec`, `check`, `discover`, `read`
 * and the webhook handler.
 *
 * A port of the in-process connector in `api/src/connectors/calendly/`,
 * with the same 7 entities, schemas, layouts, incremental modes, requests,
 * pagination and retry policy. Nothing runs it in production yet.
 * `fixtures/parity.mjs` runs both against the same recorded Calendly
 * responses and compares them entity by entity.
 *
 * Read state per entity:
 * - `organizations`: none; one request after `/users/me`.
 * - `users`, `groups`, `event_types`, `scheduled_events`, `contacts`:
 *   `{ cursor }`, Calendly's `page_token` (see `fetchers.ts`).
 * - `invitees`: the start-time keyset walk over scheduled events.
 *
 * `since` (ISO 8601) comes from `state.mako.since`, which
 * `SandboxedConnector` sets on every chunk (or a bare `state.since` from a
 * hand run). `scheduled_events` and `invitees` pass it as `min_start_time`;
 * `users`, `groups`, `event_types` and `contacts` keep rows updated at or
 * after it.
 *
 * Caller-set config keys, never in the credential form: `__page_size` (the
 * in-process `sync_batch_size`, Calendly's `count`, 1 to 100) and
 * `__rate_limit_delay_ms` (the pause between pages, 200 ms by default).
 */
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import {
  CALENDLY_DEFAULT_BASE_URL,
  calendlyBaseUrl,
  createCalendlyClient,
  type CalendlyClient,
} from "./client.ts";
import {
  readInvitees,
  readList,
  readOrganization,
  type ListEntity,
  type ReadDeps,
} from "./fetchers.ts";
import { CALENDLY_ENTITIES, calendlyJsonSchema } from "./schema.ts";
import { calendlyWebhookDefinition } from "./webhooks.ts";

interface CalendlyConfig {
  access_token: string;
  api_base_url?: string;
  __page_size?: number;
  __rate_limit_delay_ms?: number;
}

const DEFAULT_RATE_LIMIT_DELAY_MS = 200;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** One client per process: a box holds one connection, so one token. */
let client: CalendlyClient | undefined;
function calendlyClient(ctx: Context<CalendlyConfig>): CalendlyClient {
  if (!ctx.config.access_token) {
    throw new Error("Calendly access token not configured");
  }
  client ??= createCalendlyClient({
    token: ctx.config.access_token,
    baseUrl: calendlyBaseUrl(ctx.config.api_base_url),
    log: message => ctx.log(message),
  });
  return client;
}

/** `/users/me`, once per process, as the in-process instance caches it. */
let me: Promise<{ user_uri: string; organization_uri: string }> | undefined;
function currentUser(ctx: Context<CalendlyConfig>) {
  me ??= (async () => {
    const response = (await calendlyClient(ctx).get("/users/me")) as
      { resource?: Record<string, unknown> } | undefined;
    const resource = response?.resource;
    const userUri = typeof resource?.uri === "string" ? resource.uri : "";
    const orgUri =
      typeof resource?.current_organization === "string"
        ? resource.current_organization
        : "";
    if (!userUri || !orgUri) {
      throw new Error(
        "Could not resolve current user/organization from /users/me",
      );
    }
    return { user_uri: userUri, organization_uri: orgUri };
  })();
  me.catch(() => (me = undefined));
  return me;
}

function rateLimitDelay(config: CalendlyConfig): number {
  const n = Number(config.__rate_limit_delay_ms);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_LIMIT_DELAY_MS;
}

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
  position: Record<string, unknown>,
): Record<string, unknown> {
  const mako = state.mako as Record<string, unknown> | undefined;
  return {
    ...position,
    ...(typeof mako?.since === "string" ? { mako: { since: mako.since } } : {}),
    ...(typeof state.since === "string" ? { since: state.since } : {}),
  };
}

/** The position alone, without the anchor. */
function positionOf(state: Record<string, unknown>): Record<string, unknown> {
  const { mako: _mako, since: _since, ...position } = state;
  return position;
}

function deps(ctx: Context<CalendlyConfig>): ReadDeps {
  return {
    api: calendlyClient(ctx),
    pageSize: ctx.config.__page_size,
    pause: () => sleep(rateLimitDelay(ctx.config)),
    currentUser: () => currentUser(ctx),
    log: message => ctx.log(message),
  };
}

const ENTITIES: Record<
  string,
  EntityDefinition<CalendlyConfig>
> = Object.fromEntries(
  CALENDLY_ENTITIES.map(info => [
    info.name,
    {
      label: info.label,
      description: info.description,
      primaryKey: ["id"],
      ...(info.incremental ? { incremental: info.incremental } : {}),
      layout: {
        partitionField: info.partitionField,
        partitionGranularity: "day" as const,
        clusterFields: ["_dataSourceId", "id"],
      },
      // A whole JSON Schema, so `id` is required and the rest nullable.
      schema: calendlyJsonSchema(info.fields) as unknown as EntitySchema,
      async *read(ctx, rawState) {
        const state = (rawState ?? {}) as Record<string, unknown>;
        const since = sinceOf(state);
        const position = positionOf(state);
        const reader =
          info.name === "organizations"
            ? readOrganization(deps(ctx))
            : info.name === "invitees"
              ? readInvitees(deps(ctx), position, since)
              : readList(deps(ctx), info.name as ListEntity, position, since);
        for await (const batch of reader) {
          yield { ...batch, state: withSince(state, batch.state) };
        }
      },
    } satisfies EntityDefinition<CalendlyConfig>,
  ]),
);

export default defineConnector<CalendlyConfig>({
  name: "calendly",
  version: "1.0.0",
  title: "Calendly",
  documentationUrl: "https://developer.calendly.com/api-docs",
  config: {
    required: ["access_token"],
    properties: {
      access_token: {
        type: "string",
        title: "Personal Access Token",
        description:
          "Calendly PAT or OAuth bearer token. Required scopes: organizations:read, users:read, groups:read, event_types:read, scheduled_events:read, contacts:read. For auto-provisioned webhooks also: webhooks:read and webhooks:write.",
        airbyte_secret: true,
        order: 0,
      },
      api_base_url: {
        type: "string",
        title: "API Base URL",
        default: CALENDLY_DEFAULT_BASE_URL,
        order: 1,
      },
    },
  },
  async check(ctx) {
    await currentUser(ctx);
    return true;
  },
  entities: ENTITIES,
  // Verified by Mako's API, handled here in batches (webhooks.ts).
  webhooks: calendlyWebhookDefinition<CalendlyConfig>(ctx => ({
    api: calendlyClient(ctx),
    log: message => ctx.log(message),
  })),
});
