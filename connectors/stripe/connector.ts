/**
 * Stripe on @makoai/connector-sdk: `spec`, `check`, `discover` and `read`.
 *
 * A port of the in-process connector in `api/src/connectors/stripe/`, with the
 * same 22 entities, schemas, cursors and pagination. Nothing runs it in
 * production yet. `fixtures/parity.mjs` runs both against the same recorded
 * Stripe responses and compares them entity by entity.
 *
 * Read state is `{ cursor, since }`:
 * - `cursor` is Stripe's `starting_after`, the in-process `FetchState.cursor`.
 *   Nested entities carry the last parent id (payout or customer).
 * - `since` (ISO 8601) is the incremental anchor, sent as `created[gte]`. The
 *   connector never moves it; the caller sets it, as the engine passes
 *   `since` to the in-process connector.
 *
 * Webhooks are not here. RFC connectors-as-code §4 defines `webhook` and
 * `subscribe` commands that the SDK does not implement yet.
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

/** Pinned: it decides the shape of every record. Same as the in-process one. */
const STRIPE_API_VERSION = "2023-10-16" as Stripe.LatestApiVersion;
const STRIPE_DEFAULT_HOST = "api.stripe.com";

/** The in-process defaults for `sync_batch_size` and `rate_limit_delay_ms`. */
const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;

interface StripeConfig {
  api_key: string;
  api_base_url?: string;
}

interface StripeReadState {
  cursor?: string;
  since?: string;
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
  ["invoice_items", "Invoice Items", true],
  ["subscription_schedules", "Subscription Schedules", true],
  ["coupons", "Coupons", true],
  ["promotion_codes", "Promotion Codes", true],
  ["checkout_sessions", "Checkout Sessions", true],
  ["setup_intents", "Setup Intents", true],
  ["early_fraud_warnings", "Early Fraud Warnings", true],
];

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

function stripeClient(ctx: Context<StripeConfig>): Stripe {
  if (!ctx.config.api_key) throw new Error("Stripe API key is required");
  return new Stripe(ctx.config.api_key, {
    apiVersion: STRIPE_API_VERSION,
    ...hostConfig(ctx.config.api_base_url, message => ctx.log(message)),
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseSince(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.since is not a date: ${value}`);
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
    ...(incremental ? { cursorField: "created" } : {}),
    schema: STRIPE_ENTITY_SCHEMA_MAP[name],
    // A whole JSON Schema, so `id` can be required. The SDK passes an object
    // schema through unchanged; its type only names the shorthand form.
    discoverSchema: () => stripeJsonSchema(name) as unknown as EntitySchema,
    async *read(ctx, rawState) {
      const state = rawState as StripeReadState;
      const stripe = stripeClient(ctx);
      const since = incremental ? parseSince(state.since) : undefined;
      let cursor = typeof state.cursor === "string" ? state.cursor : undefined;
      let first = true;

      while (true) {
        if (!first) await sleep(RATE_LIMIT_DELAY_MS);
        first = false;

        const page = await listStripePage(stripe, name, {
          limit: PAGE_SIZE,
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
            ...(state.since ? { since: state.since } : {}),
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
  version: "1.0.0",
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
});
