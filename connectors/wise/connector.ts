/**
 * Wise on @makoai/connector-sdk: `spec`, `check`, `discover`, `read` and
 * `webhook`.
 *
 * A port of the in-process connector in `api/src/connectors/wise/`, with the
 * same 7 entities, schemas, requests, pagination, chunk positions, retry
 * policy and webhook mapping. Nothing runs it in production yet.
 * `fixtures/parity.mjs` runs both against the same recorded Wise responses
 * and compares them entity by entity.
 *
 * Read state per entity is the in-process `FetchState.metadata`, key for
 * key (`profileIds`, `profileIndex`, then `offset`, `seekPosition`,
 * `cursor` or the statement walk), plus Mako's `mako.since`, which the
 * connector carries unchanged. See `fetchers.ts`.
 *
 * Caller-set config keys, never in the credential form: `__page_size` (the
 * in-process `batchSize` or `sync_batch_size`) and `__rate_limit_delay_ms`
 * (the pause between pages, default 200 ms).
 *
 * `cursorField` is declared where it names the row's own time, so the box
 * path resolves each row's source timestamp from the field the in-process
 * resolver reads first (`modificationTime`, `created`, `updatedOn`,
 * `date`). Only `incremental` makes an entity incremental.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import { type WiseClient, createWiseClient } from "./client.ts";
import {
  type ReadBatch,
  type WiseReadContext,
  profileLister,
  readActivities,
  readBalanceStatements,
  readBalances,
  readProfiles,
  readRecipients,
  readTransfers,
} from "./fetchers.ts";
import { wiseJsonSchema, wiseShorthandSchema } from "./schema.ts";
import {
  extractWiseWebhookData,
  handleWebhookBatch,
  verifyWiseWebhook,
  wiseWebhookChangeRecords,
  wiseWebhookEventMapping,
  wiseWebhookEventsForEntities,
  wiseWebhookPublicKeys,
  WISE_SUPPORTED_WEBHOOK_EVENTS,
} from "./webhooks.ts";
import { wiseWebhookDefinition } from "./webhook-handler.ts";

interface WiseConfig {
  api_key: string;
  profile_id?: string;
  sca_private_key?: string;
  api_base_url?: string;
  __page_size?: number;
  __rate_limit_delay_ms?: number;
}

const DEFAULT_RATE_LIMIT_DELAY_MS = 200;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

function rateLimitDelay(config: WiseConfig): number {
  const n = Number(config.__rate_limit_delay_ms);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_LIMIT_DELAY_MS;
}

/** The in-process `validateConfig`. */
function configErrors(config: WiseConfig): string[] {
  const errors: string[] = [];
  if (!config.api_key) errors.push("Wise API token is required");
  const profileId = config.profile_id;
  if (
    profileId != null &&
    profileId !== "" &&
    !/^\d+$/.test(String(profileId).trim())
  ) {
    errors.push("Wise profile_id must be a numeric profile id");
  }
  return errors;
}

/** One client per process: a box holds one connection, so one token. */
let client: WiseClient | undefined;
function wiseClient(ctx: Context<WiseConfig>): WiseClient {
  if (!ctx.config.api_key) throw new Error("Wise API token not configured");
  client ??= createWiseClient({
    token: ctx.config.api_key,
    baseUrl: ctx.config.api_base_url,
    log: message => ctx.log(message),
  });
  return client;
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

type Reader = (
  ctx: WiseReadContext,
  state: Record<string, unknown>,
) => AsyncGenerator<ReadBatch>;

interface EntitySpec {
  label: string;
  description: string;
  partitionField: string;
  incremental?: "native" | "created-anchor";
  /** The row's own time, read first by the box's timestamp resolver. */
  timeField?: string;
  /** Whether `since` narrows the read (in-process `since instanceof Date`). */
  usesSince?: boolean;
  read: Reader;
}

/** In the in-process `getEntityMetadata` order. */
const ENTITIES: Record<string, EntitySpec> = {
  profiles: {
    label: "Profiles",
    description: "Personal and business profiles accessible to the token",
    partitionField: "createdAt",
    read: ctx => readProfiles(ctx),
  },
  balances: {
    label: "Balances",
    description: "Multi-currency balance accounts (current snapshot)",
    partitionField: "modificationTime",
    timeField: "modificationTime",
    read: readBalances,
  },
  balance_updates: {
    label: "Balance Updates",
    description:
      "Credit/debit ledger from balances#update webhooks (webhook-only; no REST backfill)",
    partitionField: "occurred_at",
    // Wise has no list of balance movements: webhook-only, as in-process.
    read: async function* () {
      yield { records: [], state: {}, hasMore: false };
    },
  },
  transfers: {
    label: "Transfers",
    description: "Outbound and related transfers",
    partitionField: "created",
    incremental: "created-anchor",
    timeField: "created",
    usesSince: true,
    read: readTransfers,
  },
  recipients: {
    label: "Recipients",
    description: "Beneficiary / recipient accounts",
    partitionField: "_syncedAt",
    read: readRecipients,
  },
  activities: {
    label: "Activities",
    description: "Profile activity feed (card payments, transfers, etc.)",
    partitionField: "createdOn",
    incremental: "native",
    timeField: "updatedOn",
    usesSince: true,
    read: readActivities,
  },
  balance_statements: {
    label: "Balance Statements",
    description:
      "Every transaction of every balance (all currencies) from Wise's balance statement, with fees and the running balance after it",
    partitionField: "date",
    incremental: "native",
    timeField: "date",
    usesSince: true,
    read: readBalanceStatements,
  },
};

function entity(name: string, spec: EntitySpec): EntityDefinition<WiseConfig> {
  return {
    label: spec.label,
    description: spec.description,
    primaryKey: ["id"],
    ...(spec.timeField ? { cursorField: spec.timeField } : {}),
    ...(spec.incremental ? { incremental: spec.incremental } : {}),
    layout: {
      partitionField: spec.partitionField,
      partitionGranularity: "day",
      clusterFields: ["_dataSourceId", "id"],
    },
    schema: wiseShorthandSchema(name) as EntitySchema,
    // A whole JSON Schema, so `id` can be required and non-null.
    discoverSchema: () => wiseJsonSchema(name) as unknown as EntitySchema,
    async *read(ctx, rawState) {
      const state = (rawState ?? {}) as Record<string, unknown>;
      if (name === "balance_updates") {
        ctx.log(
          "Skipping balance_updates backfill — entity is webhook-only (balances#update)",
        );
      }
      const readCtx: WiseReadContext = {
        api:
          name === "balance_updates" ? (undefined as never) : wiseClient(ctx),
        configuredProfileId: ctx.config.profile_id,
        scaPrivateKey: ctx.config.sca_private_key,
        pageSize: ctx.config.__page_size,
        pause: () => sleep(rateLimitDelay(ctx.config)),
        since: spec.usesSince ? sinceOf(state) : undefined,
      };
      for await (const batch of spec.read(readCtx, state)) {
        yield { ...batch, state: withSince(state, batch.state) };
      }
    },
  };
}

export default defineConnector<WiseConfig>({
  name: "wise",
  version: "1.0.0",
  title: "Wise",
  documentationUrl: "https://docs.wise.com/api-docs/api-reference",
  config: {
    required: ["api_key"],
    properties: {
      api_key: {
        type: "string",
        title: "API Token",
        description:
          "Wise personal API token or OAuth access token. Used as `Authorization: Bearer <token>`.",
        airbyte_secret: true,
        order: 0,
      },
      profile_id: {
        type: "string",
        title: "Profile ID",
        description:
          "Optional. Restrict sync to one Wise profile. Leave blank to sync every profile the token can access.",
        order: 1,
      },
      sca_private_key: {
        type: "string",
        title: "SCA Private Key",
        description:
          "Optional. PEM private key whose public key is registered in Wise (Settings → API tokens → Manage public keys). Wise asks for it (strong customer authentication) before it serves balance statements on some profiles.",
        // A secret: encrypted, and rendered as a password field. The form
        // translation has no encrypted textarea (in-process: textarea, 6 rows).
        airbyte_secret: true,
        multiline: true,
        order: 2,
      },
      api_base_url: {
        type: "string",
        title: "API Base URL",
        description:
          "Production: https://api.wise.com. Sandbox: https://api.sandbox.transferwise.tech",
        default: "https://api.wise.com",
        order: 3,
      },
    },
  },
  async check(ctx) {
    const errors = configErrors(ctx.config);
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join("; ")}`);
    }
    const api = wiseClient(ctx);
    await api.get("/v1/me");
    await profileLister(api, ctx.config.profile_id).resolveIds();
    return true;
  },
  entities: Object.fromEntries(
    Object.entries(ENTITIES).map(([name, spec]) => [name, entity(name, spec)]),
  ),
  // Verified by Mako's API, handled here in batches (webhook-handler.ts).
  webhooks: wiseWebhookDefinition<WiseConfig>(ctx => ({
    api: wiseClient(ctx),
    log: message => ctx.log(message),
  })),
});

/**
 * The in-process webhook half, for the parity harness
 * (`fixtures/webhook-cli.mjs`). The box runs `webhooks` above.
 */
export const webhook = {
  events: () => [...WISE_SUPPORTED_WEBHOOK_EVENTS],
  eventsForEntities: wiseWebhookEventsForEntities,
  mapping: wiseWebhookEventMapping,
  extract: extractWiseWebhookData,
  verify: (options: {
    payload: string;
    headers: Record<string, string | undefined>;
    secret?: string;
    sandbox?: boolean;
  }) =>
    verifyWiseWebhook(options, () =>
      wiseWebhookPublicKeys(Boolean(options.sandbox), options.secret),
    ),
  changeRecords: wiseWebhookChangeRecords,
  handleBatch: handleWebhookBatch,
};
