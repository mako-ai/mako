import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  WebhookVerificationResult,
  WebhookHandlerOptions,
  WebhookEventMapping,
  EntityMetadata,
  NormalizedCdcRecord,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  UpdateWebhookSubscriptionOptions,
  type WebhookCapabilities,
  type IncrementalCapabilities,
  type ConnectorEntitySchema,
} from "../base/BaseConnector";
import Stripe from "stripe";
import { resolveStripeEntitySchema } from "./schema";
import { loggers } from "../../logging";

const logger = loggers.connector("stripe");

// Single source of truth for the Stripe API version so the SDK client and
// webhook provisioning stay in sync.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2023-10-16";

const STRIPE_DEFAULT_HOST = "api.stripe.com";

// Entities that can be backfilled and webhook-materialized.
const STRIPE_ENTITIES = [
  "customers",
  "subscriptions",
  "disputes",
  "charges",
  "invoices",
  "products",
  "plans",
  "prices",
  "payment_intents",
  // Money movement: what Stripe actually settled, kept and paid out. Needed to
  // reconcile cash collected → fees → payouts → bank, and to date refunds and
  // credit notes when they happen rather than on the original invoice.
  "balance_transactions",
  "payouts",
  "payout_balance_transactions",
  "refunds",
  "credit_notes",
  "customer_balance_transactions",
  // Billing detail behind MRR movements (one-off items, scheduled plan
  // changes, discounts) and the self-serve checkout funnel.
  "invoice_items",
  "subscription_schedules",
  "coupons",
  "promotion_codes",
  "checkout_sessions",
  "setup_intents",
  "early_fraud_warnings",
] as const;

// Stripe caps `autoPagingToArray` at 10,000 items. A single payout or customer
// never comes close (a payout groups a few days of transactions).
const CHILD_LIST_MAX = 10_000;

export class StripeConnector extends BaseConnector {
  private stripe: Stripe | null = null;

  // Schema describing required configuration for this connector (used by frontend)
  static getConfigSchema() {
    return {
      fields: [
        {
          name: "api_key",
          label: "API Key",
          type: "password",
          required: true,
          helperText: "Your Stripe secret API key",
        },
        {
          name: "api_base_url",
          label: "API Base URL",
          type: "string",
          required: false,
          default: "https://api.stripe.com",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Stripe",
      version: "1.0.0",
      description: "Connector for Stripe payment platform",
      supportedEntities: [...STRIPE_ENTITIES],
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = [...base.errors];

    if (!this.dataSource.config.api_key) {
      errors.push("Stripe API key is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getStripeClient(): Stripe {
    if (!this.stripe) {
      if (!this.dataSource.config.api_key) {
        throw new Error("Stripe API key not configured");
      }
      this.stripe = new Stripe(this.dataSource.config.api_key, {
        apiVersion: STRIPE_API_VERSION,
        ...this.resolveHostConfig(),
      });
    }
    return this.stripe;
  }

  /**
   * Derive Stripe SDK host/protocol/port from the optional `api_base_url`
   * config field so the schema field is actually wired (rule 15). Defaults to
   * Stripe's public API host when unset or unparseable.
   */
  private resolveHostConfig(): Pick<
    Stripe.StripeConfig,
    "host" | "protocol" | "port"
  > {
    const baseUrl = this.dataSource.config.api_base_url;
    if (!baseUrl || typeof baseUrl !== "string") {
      return {};
    }

    try {
      const url = new URL(baseUrl);
      if (url.hostname === STRIPE_DEFAULT_HOST) {
        return {};
      }
      const protocol = url.protocol.replace(/:$/, "");
      return {
        host: url.hostname,
        protocol: protocol === "http" ? "http" : "https",
        ...(url.port ? { port: Number(url.port) } : {}),
      };
    } catch {
      logger.warn("Ignoring invalid Stripe api_base_url", { baseUrl });
      return {};
    }
  }

  async resolveSchema(entity: string): Promise<ConnectorEntitySchema | null> {
    return resolveStripeEntitySchema(entity);
  }

  /**
   * Stripe exposes timestamps as Unix-seconds integers (`created`, `*_at`),
   * not ISO strings. The base resolver only understands string/Date fields, so
   * Stripe records would otherwise default to `new Date()` and corrupt CDC
   * ordering/dedup. Convert numeric epochs (seconds) to Dates here.
   */
  protected resolveRecordTimestamp(payload?: Record<string, unknown>): Date {
    const epochCandidates = [
      payload?.created,
      payload?.start_date,
      (payload as Record<string, unknown> | undefined)?.["updated"],
    ];

    for (const candidate of epochCandidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        // Stripe epochs are seconds; guard against accidental millis.
        const ms = candidate > 1e12 ? candidate : candidate * 1000;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) {
          return date;
        }
      }
    }

    return super.resolveRecordTimestamp(payload);
  }

  /**
   * Stripe `list()` rows and webhook `event.data.object` payloads share the
   * same object shape, so no per-entity flattening is needed. We only re-derive
   * `sourceTs` via the Stripe-aware resolver and pin `recordId` to `id` so
   * backfill rows match webhook records emitted by `extractWebhookCdcRecords`.
   */
  normalizeBackfillRecord(
    entity: string,
    record: Record<string, unknown>,
  ): NormalizedCdcRecord | null {
    const normalized = super.normalizeBackfillRecord(entity, record);
    if (!normalized) {
      return null;
    }

    return {
      ...normalized,
      recordId: String(record.id ?? normalized.recordId),
      sourceTs: this.resolveRecordTimestamp(record),
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const validation = this.validateConfig();
      if (!validation.valid) {
        return {
          success: false,
          message: "Invalid configuration",
          details: validation.errors,
        };
      }

      const stripe = this.getStripeClient();

      // Test connection by fetching account info
      await stripe.accounts.retrieve();

      return {
        success: true,
        message: "Successfully connected to Stripe API",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to connect to Stripe API",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getAvailableEntities(): string[] {
    return [...STRIPE_ENTITIES];
  }

  getEntityMetadata(): EntityMetadata[] {
    // Stripe records are upserted in place; partition on sync time.
    const layoutSuggestion = {
      partitionField: "_syncedAt",
      partitionGranularity: "day" as const,
      clusterFields: ["_dataSourceId", "id"],
    };
    return [
      { name: "customers", label: "Customers", layoutSuggestion },
      { name: "subscriptions", label: "Subscriptions", layoutSuggestion },
      { name: "disputes", label: "Disputes", layoutSuggestion },
      { name: "charges", label: "Charges", layoutSuggestion },
      { name: "invoices", label: "Invoices", layoutSuggestion },
      { name: "products", label: "Products", layoutSuggestion },
      { name: "plans", label: "Plans", layoutSuggestion },
      { name: "prices", label: "Prices", layoutSuggestion },
      { name: "payment_intents", label: "Payment Intents", layoutSuggestion },
      {
        name: "balance_transactions",
        label: "Balance Transactions",
        layoutSuggestion,
      },
      { name: "payouts", label: "Payouts", layoutSuggestion },
      {
        name: "payout_balance_transactions",
        label: "Payout Balance Transactions",
        layoutSuggestion,
      },
      { name: "refunds", label: "Refunds", layoutSuggestion },
      { name: "credit_notes", label: "Credit Notes", layoutSuggestion },
      {
        name: "customer_balance_transactions",
        label: "Customer Balance Transactions",
        layoutSuggestion,
      },
      { name: "invoice_items", label: "Invoice Items", layoutSuggestion },
      {
        name: "subscription_schedules",
        label: "Subscription Schedules",
        layoutSuggestion,
      },
      { name: "coupons", label: "Coupons", layoutSuggestion },
      { name: "promotion_codes", label: "Promotion Codes", layoutSuggestion },
      {
        name: "checkout_sessions",
        label: "Checkout Sessions",
        layoutSuggestion,
      },
      { name: "setup_intents", label: "Setup Intents", layoutSuggestion },
      {
        name: "early_fraud_warnings",
        label: "Early Fraud Warnings",
        layoutSuggestion,
      },
    ];
  }

  /**
   * Check if connector supports resumable fetching
   */
  supportsResumableFetching(): boolean {
    return true;
  }

  /**
   * Fetch a chunk of data with resumable state
   */
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, onBatch, onProgress, since, state } = options;
    const maxIterations = options.maxIterations || 10;

    const stripe = this.getStripeClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    // Initialize or restore state
    let startingAfter: string | undefined = state?.cursor;
    let recordCount = state?.totalProcessed || 0;
    let hasMore = true;
    let iterations = 0;

    // Report initial progress (Stripe doesn't provide total counts)
    if (!state && onProgress) {
      onProgress(0, undefined);
    }

    while (hasMore && iterations < maxIterations) {
      let response: any;

      // Fetch data based on entity type
      switch (entity) {
        case "customers":
          response = await stripe.customers.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "subscriptions":
          response = await stripe.subscriptions.list({
            limit: batchSize,
            // Stripe defaults to excluding canceled/incomplete_expired subs;
            // without `status: "all"` the backfill silently drops all churned
            // subscriptions, corrupting churn/retention/historical-MRR.
            status: "all",
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "charges":
          response = await stripe.charges.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "disputes":
          response = await stripe.disputes.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "invoices":
          response = await stripe.invoices.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "products":
          response = await stripe.products.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "plans":
          response = await stripe.plans.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "prices":
          response = await stripe.prices.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "payment_intents":
          response = await stripe.paymentIntents.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "balance_transactions":
          response = await stripe.balanceTransactions.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "payouts":
          response = await stripe.payouts.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "refunds":
          response = await stripe.refunds.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "credit_notes":
          response = await stripe.creditNotes.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "invoice_items":
          response = await stripe.invoiceItems.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "subscription_schedules":
          response = await stripe.subscriptionSchedules.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "coupons":
          response = await stripe.coupons.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "promotion_codes":
          response = await stripe.promotionCodes.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "checkout_sessions":
          response = await stripe.checkout.sessions.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "setup_intents":
          response = await stripe.setupIntents.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "early_fraud_warnings":
          response = await stripe.radar.earlyFraudWarnings.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "payout_balance_transactions":
        case "customer_balance_transactions":
          response = await this.fetchNestedPage(entity, {
            limit: batchSize,
            startingAfter,
            since,
          });
          break;

        default:
          throw new Error(`Unsupported entity: ${entity}`);
      }

      // Pass batch to callback
      if (response.data.length > 0) {
        await onBatch(response.data);
        recordCount += response.data.length;

        if (onProgress) {
          onProgress(recordCount, undefined);
        }
      }

      // Check for more pages
      hasMore = response.has_more;

      // Nested entities page over their parent list (payouts, customers) and
      // resume from the last parent, not the last child.
      const nextCursor: string | undefined =
        response.nextCursor ?? response.data[response.data.length - 1]?.id;
      if (hasMore && nextCursor) {
        startingAfter = nextCursor;
        iterations++;

        // Rate limiting
        await this.sleep(rateLimitDelay);
      } else {
        // No more data
        break;
      }
    }

    return {
      cursor: startingAfter,
      totalProcessed: recordCount,
      hasMore,
      iterationsInChunk: iterations,
    };
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    const { entity, onBatch, onProgress, since } = options;

    const stripe = this.getStripeClient();
    const batchSize = options.batchSize || this.getBatchSize();
    const rateLimitDelay = options.rateLimitDelay || this.getRateLimitDelay();

    let hasMore = true;
    let startingAfter: string | undefined;
    let recordCount = 0;

    // Report initial progress (Stripe doesn't provide total counts)
    if (onProgress) {
      onProgress(0, undefined);
    }

    while (hasMore) {
      let response: any;

      // Fetch data based on entity type
      switch (entity) {
        case "customers":
          response = await stripe.customers.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "subscriptions":
          response = await stripe.subscriptions.list({
            limit: batchSize,
            // Stripe defaults to excluding canceled/incomplete_expired subs;
            // without `status: "all"` the backfill silently drops all churned
            // subscriptions, corrupting churn/retention/historical-MRR.
            status: "all",
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "charges":
          response = await stripe.charges.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "disputes":
          response = await stripe.disputes.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "invoices":
          response = await stripe.invoices.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "products":
          response = await stripe.products.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "plans":
          response = await stripe.plans.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "prices":
          response = await stripe.prices.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "payment_intents":
          response = await stripe.paymentIntents.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "balance_transactions":
          response = await stripe.balanceTransactions.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "payouts":
          response = await stripe.payouts.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "refunds":
          response = await stripe.refunds.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "credit_notes":
          response = await stripe.creditNotes.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "invoice_items":
          response = await stripe.invoiceItems.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "subscription_schedules":
          response = await stripe.subscriptionSchedules.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "coupons":
          response = await stripe.coupons.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "promotion_codes":
          response = await stripe.promotionCodes.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "checkout_sessions":
          response = await stripe.checkout.sessions.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "setup_intents":
          response = await stripe.setupIntents.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "early_fraud_warnings":
          response = await stripe.radar.earlyFraudWarnings.list({
            limit: batchSize,
            ...(startingAfter && { starting_after: startingAfter }),
            ...(since && {
              created: { gte: Math.floor(since.getTime() / 1000) },
            }),
          });
          break;

        case "payout_balance_transactions":
        case "customer_balance_transactions":
          response = await this.fetchNestedPage(entity, {
            limit: batchSize,
            startingAfter,
            since,
          });
          break;

        default:
          throw new Error(`Unsupported entity: ${entity}`);
      }

      // Pass batch to callback
      if (response.data.length > 0) {
        await onBatch(response.data);
        recordCount += response.data.length;

        if (onProgress) {
          onProgress(recordCount, undefined);
        }
      }

      // Check for more pages
      hasMore = response.has_more;

      // Nested entities page over their parent list (payouts, customers) and
      // resume from the last parent, not the last child.
      const nextCursor: string | undefined =
        response.nextCursor ?? response.data[response.data.length - 1]?.id;
      if (hasMore && nextCursor) {
        startingAfter = nextCursor;

        // Rate limiting
        await this.sleep(rateLimitDelay);
      }
    }
  }

  /**
   * One page of a nested entity. Stripe has no account-wide list for these:
   * - payout_balance_transactions: transactions are only attributed to the
   *   payout that settled them when listed *by payout* (the transaction object
   *   carries no payout id), so page over payouts and inject `payout`. A
   *   payout is created after every transaction it pays out, so filtering
   *   payouts by `created` is complete.
   * - customer_balance_transactions: listed per customer, and old customers
   *   keep receiving new credit, so `since` cannot bound the walk; declared
   *   incremental mode `none`.
   * Returns the parent cursor as `nextCursor`.
   */
  private async fetchNestedPage(
    entity: "payout_balance_transactions" | "customer_balance_transactions",
    options: { limit: number; startingAfter?: string; since?: Date },
  ): Promise<{
    data: Array<Record<string, unknown>>;
    has_more: boolean;
    nextCursor?: string;
  }> {
    const stripe = this.getStripeClient();
    const records: Array<Record<string, unknown>> = [];

    if (entity === "payout_balance_transactions") {
      const payouts = await stripe.payouts.list({
        limit: options.limit,
        ...(options.startingAfter && { starting_after: options.startingAfter }),
        ...(options.since && {
          created: { gte: Math.floor(options.since.getTime() / 1000) },
        }),
      });
      for (const payout of payouts.data) {
        const transactions = await stripe.balanceTransactions
          .list({ payout: payout.id, limit: 100 })
          .autoPagingToArray({ limit: CHILD_LIST_MAX });
        for (const transaction of transactions) {
          records.push({ ...transaction, payout: payout.id });
        }
      }
      return {
        data: records,
        has_more: payouts.has_more,
        nextCursor: payouts.data[payouts.data.length - 1]?.id,
      };
    }

    const customers = await stripe.customers.list({
      limit: options.limit,
      ...(options.startingAfter && { starting_after: options.startingAfter }),
    });
    for (const customer of customers.data) {
      const transactions = await stripe.customers
        .listBalanceTransactions(customer.id, { limit: 100 })
        .autoPagingToArray({ limit: CHILD_LIST_MAX });
      records.push(
        ...(transactions as unknown as Array<Record<string, unknown>>),
      );
    }
    return {
      data: records,
      has_more: customers.has_more,
      nextCursor: customers.data[customers.data.length - 1]?.id,
    };
  }

  /**
   * Check if connector supports webhooks
   */
  supportsWebhooks(): boolean {
    return true;
  }

  /**
   * Verify webhook signature and parse event
   */
  async verifyWebhook(
    options: WebhookHandlerOptions,
  ): Promise<WebhookVerificationResult> {
    const { payload, headers, secret } = options;

    logger.info("Webhook verification started", {
      headers: JSON.stringify(headers, null, 2),
    });

    const signature = headers["stripe-signature"];
    logger.info("Stripe signature header received", {
      signature: signature ? "present" : "missing",
    });

    if (!signature || typeof signature !== "string") {
      logger.error("Missing or invalid stripe-signature header");
      return {
        valid: false,
        error: "Missing stripe-signature header",
      };
    }

    if (!secret) {
      logger.error("Missing webhook secret");
      return {
        valid: false,
        error: "Missing webhook secret",
      };
    }

    logger.info("Webhook verification details", {
      secretFormat: secret.startsWith("whsec_") ? "valid" : "invalid",
      payloadType: typeof payload,
      payloadLength: payload.length,
    });

    try {
      const stripe = this.getStripeClient();

      // Stripe requires the raw body as a string or Buffer
      // The payload should already be a string from the webhook route
      const rawBody =
        typeof payload === "string" ? payload : JSON.stringify(payload);

      logger.info("Calling stripe.webhooks.constructEvent");
      const event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret, // Use the secret as-is, it should be the webhook endpoint secret (whsec_...)
      );

      logger.info("Webhook verification succeeded", {
        eventType: event.type,
        eventId: event.id,
      });

      return {
        valid: true,
        event,
      };
    } catch (err) {
      logger.error("Stripe webhook verification error", {
        error: err,
        errorName: err instanceof Error ? err.name : "unknown",
        errorMessage: err instanceof Error ? err.message : "unknown",
        errorStack: err instanceof Error ? err.stack : "unknown",
      });

      return {
        valid: false,
        error: err instanceof Error ? err.message : "Invalid signature",
      };
    }
  }

  /**
   * Get webhook event mapping
   */
  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    const mappings: Record<string, WebhookEventMapping> = {
      // Customers
      "customer.created": { entity: "customers", operation: "upsert" },
      "customer.updated": { entity: "customers", operation: "upsert" },
      "customer.deleted": { entity: "customers", operation: "delete" },

      // Subscriptions
      "customer.subscription.created": {
        entity: "subscriptions",
        operation: "upsert",
      },
      "customer.subscription.updated": {
        entity: "subscriptions",
        operation: "upsert",
      },
      "customer.subscription.deleted": {
        entity: "subscriptions",
        operation: "delete",
      },

      // Charges/Payments
      "charge.succeeded": { entity: "charges", operation: "upsert" },
      "charge.failed": { entity: "charges", operation: "upsert" },
      "charge.captured": { entity: "charges", operation: "upsert" },
      "charge.refunded": { entity: "charges", operation: "upsert" },
      "charge.updated": { entity: "charges", operation: "upsert" },

      // Disputes (status lost/won/open + amount for revenue netting)
      "charge.dispute.created": { entity: "disputes", operation: "upsert" },
      "charge.dispute.updated": { entity: "disputes", operation: "upsert" },
      "charge.dispute.closed": { entity: "disputes", operation: "upsert" },
      "charge.dispute.funds_withdrawn": {
        entity: "disputes",
        operation: "upsert",
      },
      "charge.dispute.funds_reinstated": {
        entity: "disputes",
        operation: "upsert",
      },

      // Payment Intents
      "payment_intent.succeeded": {
        entity: "payment_intents",
        operation: "upsert",
      },
      "payment_intent.payment_failed": {
        entity: "payment_intents",
        operation: "upsert",
      },
      "payment_intent.created": {
        entity: "payment_intents",
        operation: "upsert",
      },
      "payment_intent.canceled": {
        entity: "payment_intents",
        operation: "upsert",
      },

      // Invoices
      "invoice.created": { entity: "invoices", operation: "upsert" },
      "invoice.finalized": { entity: "invoices", operation: "upsert" },
      "invoice.paid": { entity: "invoices", operation: "upsert" },
      "invoice.payment_failed": { entity: "invoices", operation: "upsert" },
      "invoice.updated": { entity: "invoices", operation: "upsert" },
      "invoice.deleted": { entity: "invoices", operation: "delete" },

      // Products
      "product.created": { entity: "products", operation: "upsert" },
      "product.updated": { entity: "products", operation: "upsert" },
      "product.deleted": { entity: "products", operation: "delete" },

      // Prices (modern API → `prices` entity)
      "price.created": { entity: "prices", operation: "upsert" },
      "price.updated": { entity: "prices", operation: "upsert" },
      "price.deleted": { entity: "prices", operation: "delete" },
      // Plans (legacy API → `plans` entity, kept for back-compat)
      "plan.created": { entity: "plans", operation: "upsert" },
      "plan.updated": { entity: "plans", operation: "upsert" },
      "plan.deleted": { entity: "plans", operation: "delete" },
      // Payouts (status moves pending → in_transit → paid/failed)
      "payout.created": { entity: "payouts", operation: "upsert" },
      "payout.updated": { entity: "payouts", operation: "upsert" },
      "payout.paid": { entity: "payouts", operation: "upsert" },
      "payout.failed": { entity: "payouts", operation: "upsert" },
      "payout.canceled": { entity: "payouts", operation: "upsert" },
      "payout.reconciliation_completed": {
        entity: "payouts",
        operation: "upsert",
      },
      // Refunds (`charge.refund.updated` carries a Refund object)
      "refund.created": { entity: "refunds", operation: "upsert" },
      "refund.updated": { entity: "refunds", operation: "upsert" },
      "charge.refund.updated": { entity: "refunds", operation: "upsert" },
      // Credit notes
      "credit_note.created": { entity: "credit_notes", operation: "upsert" },
      "credit_note.updated": { entity: "credit_notes", operation: "upsert" },
      "credit_note.voided": { entity: "credit_notes", operation: "upsert" },
      // Invoice items
      "invoiceitem.created": { entity: "invoice_items", operation: "upsert" },
      // No `invoiceitem.updated`: Stripe rejects it as deprecated on webhook
      // endpoints, which fails the whole create/update request.
      "invoiceitem.deleted": { entity: "invoice_items", operation: "delete" },
      // Subscription schedules
      "subscription_schedule.created": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      "subscription_schedule.updated": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      "subscription_schedule.released": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      "subscription_schedule.completed": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      "subscription_schedule.canceled": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      "subscription_schedule.aborted": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      "subscription_schedule.expiring": {
        entity: "subscription_schedules",
        operation: "upsert",
      },
      // Coupons & promotion codes
      "coupon.created": { entity: "coupons", operation: "upsert" },
      "coupon.updated": { entity: "coupons", operation: "upsert" },
      "coupon.deleted": { entity: "coupons", operation: "delete" },
      "promotion_code.created": {
        entity: "promotion_codes",
        operation: "upsert",
      },
      "promotion_code.updated": {
        entity: "promotion_codes",
        operation: "upsert",
      },
      // Checkout sessions
      "checkout.session.completed": {
        entity: "checkout_sessions",
        operation: "upsert",
      },
      "checkout.session.expired": {
        entity: "checkout_sessions",
        operation: "upsert",
      },
      "checkout.session.async_payment_succeeded": {
        entity: "checkout_sessions",
        operation: "upsert",
      },
      "checkout.session.async_payment_failed": {
        entity: "checkout_sessions",
        operation: "upsert",
      },
      // Setup intents
      "setup_intent.created": { entity: "setup_intents", operation: "upsert" },
      "setup_intent.succeeded": {
        entity: "setup_intents",
        operation: "upsert",
      },
      "setup_intent.setup_failed": {
        entity: "setup_intents",
        operation: "upsert",
      },
      "setup_intent.requires_action": {
        entity: "setup_intents",
        operation: "upsert",
      },
      "setup_intent.canceled": {
        entity: "setup_intents",
        operation: "upsert",
      },
      // Radar early fraud warnings
      "radar.early_fraud_warning.created": {
        entity: "early_fraud_warnings",
        operation: "upsert",
      },
      "radar.early_fraud_warning.updated": {
        entity: "early_fraud_warnings",
        operation: "upsert",
      },
      // balance_transactions, payout_balance_transactions and
      // customer_balance_transactions have no Stripe events: polled only.
    };

    return mappings[eventType] || null;
  }

  /**
   * Get supported webhook event types
   */
  getSupportedWebhookEvents(): string[] {
    return [
      // Customers
      "customer.created",
      "customer.updated",
      "customer.deleted",
      // Subscriptions
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      // Charges
      "charge.succeeded",
      "charge.failed",
      "charge.captured",
      "charge.refunded",
      "charge.updated",
      // Disputes
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.funds_reinstated",
      // Payment Intents
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "payment_intent.created",
      "payment_intent.canceled",
      // Invoices
      "invoice.created",
      "invoice.finalized",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.updated",
      "invoice.deleted",
      // Products
      "product.created",
      "product.updated",
      "product.deleted",
      // Prices/Plans
      "price.created",
      "price.updated",
      "price.deleted",
      "plan.created",
      "plan.updated",
      "plan.deleted",
      // Payouts
      "payout.created",
      "payout.updated",
      "payout.paid",
      "payout.failed",
      "payout.canceled",
      "payout.reconciliation_completed",
      // Refunds
      "refund.created",
      "refund.updated",
      "charge.refund.updated",
      // Credit notes
      "credit_note.created",
      "credit_note.updated",
      "credit_note.voided",
      // Invoice items
      "invoiceitem.created",
      "invoiceitem.deleted",
      // Subscription schedules
      "subscription_schedule.created",
      "subscription_schedule.updated",
      "subscription_schedule.released",
      "subscription_schedule.completed",
      "subscription_schedule.canceled",
      "subscription_schedule.aborted",
      "subscription_schedule.expiring",
      // Coupons & promotion codes
      "coupon.created",
      "coupon.updated",
      "coupon.deleted",
      "promotion_code.created",
      "promotion_code.updated",
      // Checkout sessions
      "checkout.session.completed",
      "checkout.session.expired",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      // Setup intents
      "setup_intent.created",
      "setup_intent.succeeded",
      "setup_intent.setup_failed",
      "setup_intent.requires_action",
      "setup_intent.canceled",
      // Radar
      "radar.early_fraud_warning.created",
      "radar.early_fraud_warning.updated",
    ];
  }

  /**
   * Return only the webhook event strings relevant to the given entities.
   * Falls back to all supported events when the entity list is empty
   * (no explicit selection — subscribe to everything).
   */
  getWebhookEventsForEntities(entities: string[]): string[] {
    if (entities.length === 0) {
      return this.getSupportedWebhookEvents();
    }

    const entitySet = new Set(entities.map(e => e.toLowerCase()));
    return this.getSupportedWebhookEvents().filter(eventType => {
      const mapping = this.getWebhookEventMapping(eventType);
      return mapping ? entitySet.has(mapping.entity.toLowerCase()) : false;
    });
  }

  /**
   * Check if connector can provision provider webhooks automatically.
   */
  supportsWebhookProvisioning(): boolean {
    return true;
  }

  getWebhookCapabilities(): WebhookCapabilities {
    return {
      supported: true,
      provisioning: {
        supported: true,
        providerLabel: "Stripe",
        storesSecretAutomatically: true,
        actionHint: "and stores its signing secret",
      },
      secretHelpText:
        "Get this from Stripe Dashboard > Webhooks > Your endpoint > Signing secret",
    };
  }

  getIncrementalCapabilities(): IncrementalCapabilities {
    return {
      // `fetchEntityChunk` filters with `created[gte]` on every entity — a
      // poll never re-fetches an object that was updated after it was
      // created (e.g. a subscription that changed plans). Real-time updates
      // only arrive via the webhook trigger.
      supported: true,
      mode: "created-anchor",
      perEntity: {
        // No account-wide list exists; every customer is re-walked on each
        // poll (see `fetchNestedPage`), so `since` is not applied.
        customer_balance_transactions: { mode: "none" },
      },
      warning:
        "Stripe only reports newly created records to polls; updates to existing records require the webhook trigger.",
    };
  }

  /**
   * Create a Stripe webhook endpoint subscribed to the events for the
   * selected entities. Makes `POST /flows/:id/provision-webhook` work
   * end-to-end without manual dashboard setup.
   */
  async createWebhookSubscription(
    options: ProvisionWebhookOptions,
  ): Promise<ProvisionWebhookResult> {
    const stripe = this.getStripeClient();

    const requestedEvents = Array.isArray(options.events)
      ? options.events
          .map(event => event.trim())
          .filter((event): event is string => event.length > 0)
      : [];

    const supported = new Set(this.getSupportedWebhookEvents());
    const effectiveEvents = (
      requestedEvents.length > 0
        ? requestedEvents
        : this.getWebhookEventsForEntities(options.enabledEntities ?? [])
    ).filter(event => supported.has(event));

    if (effectiveEvents.length === 0) {
      throw new Error(
        requestedEvents.length > 0
          ? `No valid Stripe webhook events configured. Unsupported events: ${requestedEvents.join(", ")}`
          : "No webhook events resolved for the selected entities",
      );
    }

    try {
      const endpoint = await stripe.webhookEndpoints.create({
        url: options.endpointUrl,
        enabled_events:
          effectiveEvents as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
        api_version: STRIPE_API_VERSION,
      });

      return {
        providerWebhookId: endpoint.id,
        endpointUrl: endpoint.url,
        signingSecret:
          typeof endpoint.secret === "string" && endpoint.secret.length > 0
            ? endpoint.secret
            : undefined,
      };
    } catch (error) {
      const message =
        error instanceof Stripe.errors.StripeError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(
        `Failed to create Stripe webhook subscription: ${message}`,
      );
    }
  }

  /**
   * Events a provisioned endpoint should carry: the explicitly requested
   * ones, else those of the flow's enabled entities, restricted to events
   * this connector understands.
   */
  private resolveProvisionEvents(options: ProvisionWebhookOptions): string[] {
    const requestedEvents = Array.isArray(options.events)
      ? options.events
          .map(event => event.trim())
          .filter((event): event is string => event.length > 0)
      : [];

    const supported = new Set(this.getSupportedWebhookEvents());
    const effectiveEvents = (
      requestedEvents.length > 0
        ? requestedEvents
        : this.getWebhookEventsForEntities(options.enabledEntities ?? [])
    ).filter(event => supported.has(event));

    if (effectiveEvents.length === 0) {
      throw new Error(
        requestedEvents.length > 0
          ? `No valid Stripe webhook events configured. Unsupported events: ${requestedEvents.join(", ")}`
          : "No webhook events resolved for the selected entities",
      );
    }
    return effectiveEvents;
  }

  supportsWebhookSubscriptionUpdate(): boolean {
    return true;
  }

  /**
   * Retarget the Stripe endpoint(s) that POST to `endpointUrl` to the events
   * of the flow's current entities, keeping their signing secret.
   *
   * Every endpoint on that URL is updated, not just one: flows provisioned
   * before ids were stored may have duplicates from earlier re-provisioning,
   * and Stripe never reveals a secret after creation, so there is no way to
   * tell which duplicate the flow's stored secret belongs to.
   */
  async updateWebhookSubscription(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null> {
    const stripe = this.getStripeClient();
    const effectiveEvents = this.resolveProvisionEvents(options);

    try {
      const endpoints = (
        await stripe.webhookEndpoints
          .list({ limit: 100 })
          .autoPagingToArray({ limit: 1000 })
      ).filter(endpoint => endpoint.url === options.endpointUrl);

      if (endpoints.length === 0) {
        return null;
      }

      // Without a stored id, prefer an endpoint Stripe still considers
      // healthy: duplicates whose secret the flow no longer holds fail every
      // delivery and end up disabled by Stripe.
      const primary =
        endpoints.find(endpoint => endpoint.id === options.providerWebhookId) ??
        endpoints.find(endpoint => endpoint.status === "enabled") ??
        endpoints[0];

      for (const endpoint of endpoints) {
        await stripe.webhookEndpoints.update(endpoint.id, {
          enabled_events:
            effectiveEvents as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
          // Re-enable only the endpoint the flow is bound to: provisioning is
          // an explicit request to receive its events again.
          ...(endpoint.id === primary.id && { disabled: false }),
        });
      }

      if (endpoints.length > 1) {
        logger.warn("Multiple Stripe webhook endpoints share one flow URL", {
          endpointIds: endpoints.map(endpoint => endpoint.id),
          keptId: primary.id,
        });
      }

      return { providerWebhookId: primary.id, endpointUrl: primary.url };
    } catch (error) {
      const message =
        error instanceof Stripe.errors.StripeError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(
        `Failed to update Stripe webhook subscription: ${message}`,
      );
    }
  }

  /**
   * Extract entity data from webhook event
   */
  extractWebhookData(event: any): { id: string; data: any } | null {
    if (!event || !event.data || !event.data.object) {
      return null;
    }

    const data = event.data.object;
    return {
      id: data.id,
      data: data,
    };
  }
}
