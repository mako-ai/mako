/**
 * Stripe on @makoai/connector-sdk: `spec`, `check`, `discover` and `read`.
 *
 * A port of the in-process connector in `api/src/connectors/stripe/`.
 * `fixtures/parity.mjs` compares the shared entities against recorded responses.
 * The boxed connector also reads Checkout Session line items.
 *
 * Read state is `{ cursor, mako: { since } }`:
 * - `cursor` is Stripe's `starting_after`, the in-process `FetchState.cursor`.
 *   Nested entities carry the last parent id.
 * - `mako.since` (ISO 8601) is the incremental anchor, sent as `created[gte]`.
 *   Mako owns the `mako` key. The
 *   connector never moves it. The engine passes `since` to the in-process
 *   connector as `options.since`; `SandboxedConnector` puts the same value
 *   into the stream state on every chunk.
 *
 * Webhooks: Mako's API verifies each delivery against the `stripe-v1`
 * scheme this folder declares, then hands verified events to the box in
 * batches (`webhook-handler.ts`). The API also creates the Stripe endpoint
 * with the connection's key and keeps its signing secret on the flow. No
 * box sees that secret.
 */
import Stripe from "stripe";
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import { listStripePage } from "./lists.ts";
import { STRIPE_ENTITY_SCHEMA_MAP, stripeJsonSchema } from "./schema.ts";
import {
  STRIPE_WEBHOOK_FILL_TIMEOUT_MS,
  stripeWebhookDefinition,
} from "./webhook-handler.ts";

/** Pinned: it decides the shape of every record. Same as the in-process one. */
const STRIPE_API_VERSION = "2023-10-16" as Stripe.LatestApiVersion;
const STRIPE_DEFAULT_HOST = "api.stripe.com";

/** The in-process defaults for `sync_batch_size` and `rate_limit_delay_ms`. */
const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;

interface StripeConfig {
  api_key: string;
  api_base_url?: string;
  /**
   * Rows per page. Not in the credential form: `SandboxedConnector` sets it
   * from the batch size the engine knows (`settings.sync_batch_size`), as the
   * in-process connector reads it. Like the SDK's own `__http`, a `__` key is
   * set by Mako, never by a user.
   */
  __page_size?: number;
  /** Delay between pages, from `settings.rate_limit_delay_ms`. */
  __rate_limit_delay_ms?: number;
}

function rateLimitDelay(config: StripeConfig): number {
  const value = Number(config.__rate_limit_delay_ms);
  return Number.isFinite(value) && value > 0 ? value : RATE_LIMIT_DELAY_MS;
}

/** The in-process `layoutSuggestion`: rows are upserted in place. */
const LAYOUT = {
  partitionField: "_syncedAt",
  partitionGranularity: "day" as const,
  clusterFields: ["_dataSourceId", "id"],
};

function pageSize(config: StripeConfig): number {
  const value = Number(config.__page_size);
  return Number.isInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE
    ? value
    : PAGE_SIZE;
}

interface StripeReadState {
  cursor?: string;
  /** Mako's own keys; `since` is the incremental anchor. */
  mako?: { since?: string };
}

/** Entity, label, and whether `since` applies (cursor `created`). */
const ENTITIES: Array<[name: string, label: string, incremental: boolean]> = [
  ["customers", "Customers", true],
  ["subscriptions", "Subscriptions", true],
  ["disputes", "Disputes", true],
  ["charges", "Charges", true],
  ["invoices", "Invoices", true],
  ["products", "Products", true],
  ["plans", "Plans", true],
  ["prices", "Prices", true],
  ["payment_intents", "Payment Intents", true],
  ["balance_transactions", "Balance Transactions", true],
  ["payouts", "Payouts", true],
  ["payout_balance_transactions", "Payout Balance Transactions", true],
  ["refunds", "Refunds", true],
  ["credit_notes", "Credit Notes", true],
  // No account-wide list: every customer is re-walked, `since` is ignored.
  ["customer_balance_transactions", "Customer Balance Transactions", false],
  // Walked per customer; `since` bounds the walk by the customer's
  // `created`, webhooks carry cards attached to older customers.
  ["payment_methods", "Payment Methods", true],
  ["invoice_items", "Invoice Items", true],
  ["subscription_schedules", "Subscription Schedules", true],
  ["coupons", "Coupons", true],
  ["promotion_codes", "Promotion Codes", true],
  ["checkout_sessions", "Checkout Sessions", true],
  ["checkout_sessions_line_items", "Checkout Session Line Items", true],
  ["setup_intents", "Setup Intents", true],
  ["early_fraud_warnings", "Early Fraud Warnings", true],
  // Rows inside a parent object: an invoice's lines, a subscription's items.
  // Read with their parent's list page, `since` on the parent's `created`,
  // and carried by the parent's webhooks.
  ["invoice_line_items", "Invoice Line Items", true],
  ["subscription_items", "Subscription Items", true],
  // The account's event log. Stripe keeps 30 days; polled only.
  ["events", "Events", true],
];

/** Invoice and Checkout line items use the parent's creation time. */
const CURSOR_FIELD: Record<string, string> = {
  invoice_line_items: "invoice_created",
  checkout_sessions_line_items: "checkout_session_created",
};

/**
 * Host, protocol and port from `api_base_url`, as the in-process connector
 * derives them. Unset, unparseable or Stripe's own host means the default.
 */
function hostConfig(
  baseUrl: unknown,
  log: (message: string) => void,
): Pick<Stripe.StripeConfig, "host" | "protocol" | "port"> {
  if (!baseUrl || typeof baseUrl !== "string") return {};
  try {
    const url = new URL(baseUrl);
    if (url.hostname === STRIPE_DEFAULT_HOST) return {};
    const protocol = url.protocol.replace(/:$/, "");
    return {
      host: url.hostname,
      protocol: protocol === "http" ? "http" : "https",
      ...(url.port ? { port: Number(url.port) } : {}),
    };
  } catch {
    log(`Ignoring invalid Stripe api_base_url: ${baseUrl}`);
    return {};
  }
}

function stripeClient(
  ctx: Context<StripeConfig>,
  options: Pick<Stripe.StripeConfig, "timeout" | "maxNetworkRetries"> = {},
): Stripe {
  if (!ctx.config.api_key) throw new Error("Stripe API key is required");
  return new Stripe(ctx.config.api_key, {
    apiVersion: STRIPE_API_VERSION,
    ...options,
    ...hostConfig(ctx.config.api_base_url, message => ctx.log(message)),
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseSince(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.mako.since is not a date: ${value}`);
  }
  return date;
}

function entity(
  name: string,
  label: string,
  incremental: boolean,
): EntityDefinition<StripeConfig> {
  return {
    label,
    primaryKey: ["id"],
    ...(incremental
      ? {
          cursorField: CURSOR_FIELD[name] ?? "created",
          incremental: "created-anchor" as const,
        }
      : {}),
    layout: LAYOUT,
    schema: STRIPE_ENTITY_SCHEMA_MAP[name],
    // A whole JSON Schema, so `id` can be required. The SDK passes an object
    // schema through unchanged; its type only names the shorthand form.
    discoverSchema: () => stripeJsonSchema(name) as unknown as EntitySchema,
    async *read(ctx, rawState) {
      const state = rawState as StripeReadState;
      const stripe = stripeClient(ctx);
      const anchor = state.mako?.since;
      const since = incremental ? parseSince(anchor) : undefined;
      let cursor = typeof state.cursor === "string" ? state.cursor : undefined;
      let first = true;

      while (true) {
        if (!first) await sleep(rateLimitDelay(ctx.config));
        first = false;

        const page = await listStripePage(stripe, name, {
          limit: pageSize(ctx.config),
          startingAfter: cursor,
          since,
        });
        const nextCursor =
          page.nextCursor ?? page.data[page.data.length - 1]?.id;
        const hasMore = page.has_more && Boolean(nextCursor);
        if (hasMore) cursor = nextCursor;

        yield {
          records: page.data,
          state: {
            ...(cursor ? { cursor } : {}),
            ...(anchor ? { mako: { since: anchor } } : {}),
          },
          hasMore,
        };
        if (!hasMore) return;
      }
    },
  };
}

export default defineConnector<StripeConfig>({
  name: "stripe",
  version: "1.4.0",
  title: "Stripe",
  documentationUrl: "https://docs.stripe.com/api",
  config: {
    required: ["api_key"],
    properties: {
      api_key: {
        type: "string",
        title: "API Key",
        description: "Your Stripe secret API key",
        airbyte_secret: true,
        order: 0,
      },
      api_base_url: {
        type: "string",
        title: "API Base URL",
        default: "https://api.stripe.com",
        order: 1,
      },
    },
  },
  async check(ctx) {
    await stripeClient(ctx).accounts.retrieve(null);
    return true;
  },
  entities: Object.fromEntries(
    ENTITIES.map(([name, label, incremental]) => [
      name,
      entity(name, label, incremental),
    ]),
  ),
  // Verified by Mako's API, handled here in batches (webhook-handler.ts).
  webhooks: stripeWebhookDefinition<StripeConfig>(ctx => ({
    stripe: () =>
      stripeClient(ctx, {
        timeout: STRIPE_WEBHOOK_FILL_TIMEOUT_MS,
        maxNetworkRetries: 0,
      }),
    log: message => ctx.log(message),
  })),
});
