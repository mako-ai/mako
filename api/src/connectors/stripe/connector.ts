import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
  ResumableFetchOptions,
  FetchState,
  WebhookVerificationResult,
  WebhookHandlerOptions,
  WebhookEventMapping,
} from "../base/BaseConnector";
import Stripe from "stripe";
import { loggers } from "../../logging";

const logger = loggers.connector("stripe");

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
      supportedEntities: [
        "customers",
        "subscriptions",
        "charges",
        "invoices",
        "products",
        "plans",
      ],
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
        apiVersion: "2023-10-16",
      });
    }
    return this.stripe;
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
    return [
      "customers",
      "subscriptions",
      "charges",
      "invoices",
      "products",
      "plans",
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
      "subscription.created": { entity: "subscriptions", operation: "upsert" },
      "subscription.updated": { entity: "subscriptions", operation: "upsert" },
      "subscription.deleted": { entity: "subscriptions", operation: "delete" },

      // Charges/Payments
      "charge.succeeded": { entity: "charges", operation: "upsert" },
      "charge.failed": { entity: "charges", operation: "upsert" },
      "charge.captured": { entity: "charges", operation: "upsert" },
      "charge.refunded": { entity: "charges", operation: "upsert" },
      "charge.updated": { entity: "charges", operation: "upsert" },

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

      // Prices/Plans
      "price.created": { entity: "plans", operation: "upsert" },
      "price.updated": { entity: "plans", operation: "upsert" },
      "price.deleted": { entity: "plans", operation: "delete" },
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
      "subscription.created",
      "subscription.updated",
      "subscription.deleted",
      // Charges
      "charge.succeeded",
      "charge.failed",
      "charge.captured",
      "charge.refunded",
      "charge.updated",
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
