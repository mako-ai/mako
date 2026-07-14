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
  type WebhookCapabilities,
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

      if (hasMore && response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
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

      if (hasMore && response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;

        // Rate limiting
        await this.sleep(rateLimitDelay);
      }
    }
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
