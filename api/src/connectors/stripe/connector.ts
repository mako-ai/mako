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
  WebhookEnrichmentRetryError,
} from "../base/BaseConnector";
import Stripe from "stripe";
import { resolveStripeEntitySchema } from "./schema";
import { loggers } from "../../logging";
import {
  EMBEDDED_CHILD_PARENTS,
  childRowsOf,
  listStripePage,
  type EmbeddedChildEntity,
} from "./lists";
import {
  createStripeWebhookEndpoint,
  resolveStripeProvisionEvents,
  stripeSupportedWebhookEvents,
  stripeWebhookEventMapping,
  stripeWebhookEventsForEntities,
  updateStripeWebhookEndpoints,
  verifyStripeWebhook,
} from "./webhooks";

const logger = loggers.connector("stripe");

// Single source of truth for the Stripe API version so the SDK client and
// webhook provisioning stay in sync. It decides the shape of every synced
// record, so it stays pinned when the SDK's own default moves (the SDK types
// only know its newest version, hence the cast).
export const STRIPE_API_VERSION = "2023-10-16" as Stripe.LatestApiVersion;

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
  // Cards and debit mandates on file, walked per customer. Webhooks carry
  // methods attached to older customers and every detach.
  "payment_methods",
  // Billing detail behind MRR movements (one-off items, scheduled plan
  // changes, discounts) and the self-serve checkout funnel.
  "invoice_items",
  "subscription_schedules",
  "coupons",
  "promotion_codes",
  "checkout_sessions",
  "setup_intents",
  "early_fraud_warnings",
  // Rows inside a parent object: an invoice's lines, a subscription's items.
  // Read with their parent's list page and carried by its webhooks.
  "invoice_line_items",
  "subscription_items",
  // The account's event log. Stripe keeps 30 days; polled only.
  "events",
] as const;

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

    if (!this.sourceConnection.config.api_key) {
      errors.push("Stripe API key is required");
    }

    return { valid: errors.length === 0, errors };
  }

  private getStripeClient(): Stripe {
    if (!this.stripe) {
      if (!this.sourceConnection.config.api_key) {
        throw new Error("Stripe API key not configured");
      }
      this.stripe = new Stripe(this.sourceConnection.config.api_key, {
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
    const baseUrl = this.sourceConnection.config.api_base_url;
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
      // An invoice line has no `created`; it carries its invoice's.
      payload?.invoice_created,
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
      await stripe.accounts.retrieve(null);

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
      { name: "payment_methods", label: "Payment Methods", layoutSuggestion },
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
      {
        name: "invoice_line_items",
        label: "Invoice Line Items",
        layoutSuggestion,
      },
      {
        name: "subscription_items",
        label: "Subscription Items",
        layoutSuggestion,
      },
      { name: "events", label: "Events", layoutSuggestion },
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
      const response = await listStripePage(stripe, entity, {
        limit: batchSize,
        startingAfter,
        since,
      });

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
    // Every page, through the same loop as a chunk: it stops when a page
    // says has_more but yields no cursor to continue from.
    await this.fetchEntityChunk({
      ...options,
      state: undefined,
      maxIterations: Number.POSITIVE_INFINITY,
    });
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
    return verifyStripeWebhook(() => this.getStripeClient(), options);
  }

  getWebhookEventMapping(eventType: string): WebhookEventMapping | null {
    return stripeWebhookEventMapping(eventType);
  }

  getSupportedWebhookEvents(): string[] {
    return stripeSupportedWebhookEvents();
  }

  /**
   * Return only the webhook event strings relevant to the given entities.
   * Falls back to all supported events when the entity list is empty
   * (no explicit selection — subscribe to everything).
   */
  getWebhookEventsForEntities(entities: string[]): string[] {
    return stripeWebhookEventsForEntities(entities);
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
    return createStripeWebhookEndpoint(
      stripe,
      options.endpointUrl,
      this.resolveProvisionEvents(options),
      STRIPE_API_VERSION,
    );
  }

  /**
   * Events a provisioned endpoint should carry: the explicitly requested
   * ones, else those of the flow's enabled entities, restricted to events
   * this connector understands.
   */
  private resolveProvisionEvents(options: ProvisionWebhookOptions): string[] {
    return resolveStripeProvisionEvents(
      options,
      this.getSupportedWebhookEvents(),
      entities => this.getWebhookEventsForEntities(entities),
    );
  }

  supportsWebhookSubscriptionUpdate(): boolean {
    return true;
  }

  /**
   * Retarget the Stripe endpoint(s) that POST to `endpointUrl` to the events
   * of the flow's current entities, keeping their signing secret (see
   * updateStripeWebhookEndpoints).
   */
  async updateWebhookSubscription(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null> {
    const stripe = this.getStripeClient();
    return updateStripeWebhookEndpoints(
      stripe,
      options,
      this.resolveProvisionEvents(options),
    );
  }

  /**
   * An invoice event carries the invoice's `lines`, a subscription event its
   * `items`. When the flow syncs those entities, each child becomes a record
   * with its parent's operation and change. A list longer than the 10 a
   * payload embeds is read whole first; a delete uses what it embeds. A
   * failed read fails the event for a retry, so a parent is never applied
   * without all of its children.
   */
  async enrichWebhookCdcRecords(
    records: NormalizedCdcRecord[],
    options: { isEntityEnabled: (entity: string) => boolean },
  ): Promise<NormalizedCdcRecord[]> {
    const children = (
      Object.entries(EMBEDDED_CHILD_PARENTS) as Array<
        [EmbeddedChildEntity, string]
      >
    ).filter(([child]) => options.isEntityEnabled(child));
    if (children.length === 0) return records;

    const out = [...records];
    for (const record of records) {
      for (const [child, parent] of children) {
        if (record.entity !== parent) continue;
        let rows: Array<Record<string, unknown>> | null;
        try {
          rows = await childRowsOf(
            this.getStripeClient(),
            child,
            (record.payload ?? {}) as Record<string, unknown>,
            { fetchMore: record.operation === "upsert" },
          );
        } catch (error) {
          throw new WebhookEnrichmentRetryError(
            `Could not read the ${child} of Stripe ${parent} ${record.recordId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "fail",
          );
        }
        for (const row of rows ?? []) {
          if (typeof row.id !== "string" || !row.id) continue;
          out.push({
            entity: child,
            recordId: row.id,
            operation: record.operation,
            payload: row,
            sourceTs: this.resolveRecordTimestamp(row),
            source: "webhook",
            changeId: `${record.changeId || record.recordId}:${child}:${row.id}`,
          });
        }
      }
    }
    return out;
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
