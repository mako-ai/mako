/**
 * Stripe webhooks: event → entity mapping, signature verification through
 * the SDK, and webhook endpoint provisioning.
 */
import Stripe from "stripe";
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  UpdateWebhookSubscriptionOptions,
  WebhookEventMapping,
  WebhookHandlerOptions,
  WebhookVerificationResult,
} from "../base/BaseConnector";
import { rawWebhookBody } from "../base/webhook-signature";
import { loggers } from "../../logging";

const logger = loggers.connector("stripe");

const upsert = (entity: string): WebhookEventMapping => ({
  entity,
  operation: "upsert",
});
const remove = (entity: string): WebhookEventMapping => ({
  entity,
  operation: "delete",
});

/**
 * Every event Mako subscribes to, in subscription order, with the entity it
 * writes. balance_transactions, payout_balance_transactions and
 * customer_balance_transactions have no Stripe events: polled only.
 */
const EVENTS: Array<[event: string, mapping: WebhookEventMapping]> = [
  // Customers
  ["customer.created", upsert("customers")],
  ["customer.updated", upsert("customers")],
  ["customer.deleted", remove("customers")],
  // Subscriptions
  ["customer.subscription.created", upsert("subscriptions")],
  ["customer.subscription.updated", upsert("subscriptions")],
  ["customer.subscription.deleted", remove("subscriptions")],
  // Charges/Payments
  ["charge.succeeded", upsert("charges")],
  ["charge.failed", upsert("charges")],
  ["charge.captured", upsert("charges")],
  ["charge.refunded", upsert("charges")],
  ["charge.updated", upsert("charges")],
  // Disputes (status lost/won/open + amount for revenue netting)
  ["charge.dispute.created", upsert("disputes")],
  ["charge.dispute.updated", upsert("disputes")],
  ["charge.dispute.closed", upsert("disputes")],
  ["charge.dispute.funds_withdrawn", upsert("disputes")],
  ["charge.dispute.funds_reinstated", upsert("disputes")],
  // Payment Intents
  ["payment_intent.succeeded", upsert("payment_intents")],
  ["payment_intent.payment_failed", upsert("payment_intents")],
  ["payment_intent.created", upsert("payment_intents")],
  ["payment_intent.canceled", upsert("payment_intents")],
  // Invoices
  ["invoice.created", upsert("invoices")],
  ["invoice.finalized", upsert("invoices")],
  ["invoice.paid", upsert("invoices")],
  ["invoice.payment_failed", upsert("invoices")],
  ["invoice.updated", upsert("invoices")],
  ["invoice.deleted", remove("invoices")],
  // Products
  ["product.created", upsert("products")],
  ["product.updated", upsert("products")],
  ["product.deleted", remove("products")],
  // Prices (modern API → `prices` entity)
  ["price.created", upsert("prices")],
  ["price.updated", upsert("prices")],
  ["price.deleted", remove("prices")],
  // Plans (legacy API → `plans` entity, kept for back-compat)
  ["plan.created", upsert("plans")],
  ["plan.updated", upsert("plans")],
  ["plan.deleted", remove("plans")],
  // Payouts (status moves pending → in_transit → paid/failed)
  ["payout.created", upsert("payouts")],
  ["payout.updated", upsert("payouts")],
  ["payout.paid", upsert("payouts")],
  ["payout.failed", upsert("payouts")],
  ["payout.canceled", upsert("payouts")],
  ["payout.reconciliation_completed", upsert("payouts")],
  // Refunds (`charge.refund.updated` carries a Refund object)
  ["refund.created", upsert("refunds")],
  ["refund.updated", upsert("refunds")],
  ["charge.refund.updated", upsert("refunds")],
  // Credit notes
  ["credit_note.created", upsert("credit_notes")],
  ["credit_note.updated", upsert("credit_notes")],
  ["credit_note.voided", upsert("credit_notes")],
  // Invoice items. No `invoiceitem.updated`: Stripe rejects it as deprecated
  // on webhook endpoints, which fails the whole create/update request.
  ["invoiceitem.created", upsert("invoice_items")],
  ["invoiceitem.deleted", remove("invoice_items")],
  // Subscription schedules
  ["subscription_schedule.created", upsert("subscription_schedules")],
  ["subscription_schedule.updated", upsert("subscription_schedules")],
  ["subscription_schedule.released", upsert("subscription_schedules")],
  ["subscription_schedule.completed", upsert("subscription_schedules")],
  ["subscription_schedule.canceled", upsert("subscription_schedules")],
  ["subscription_schedule.aborted", upsert("subscription_schedules")],
  ["subscription_schedule.expiring", upsert("subscription_schedules")],
  // Coupons & promotion codes
  ["coupon.created", upsert("coupons")],
  ["coupon.updated", upsert("coupons")],
  ["coupon.deleted", remove("coupons")],
  ["promotion_code.created", upsert("promotion_codes")],
  ["promotion_code.updated", upsert("promotion_codes")],
  // Checkout sessions
  ["checkout.session.completed", upsert("checkout_sessions")],
  ["checkout.session.expired", upsert("checkout_sessions")],
  ["checkout.session.async_payment_succeeded", upsert("checkout_sessions")],
  ["checkout.session.async_payment_failed", upsert("checkout_sessions")],
  // Setup intents
  ["setup_intent.created", upsert("setup_intents")],
  ["setup_intent.succeeded", upsert("setup_intents")],
  ["setup_intent.setup_failed", upsert("setup_intents")],
  ["setup_intent.requires_action", upsert("setup_intents")],
  ["setup_intent.canceled", upsert("setup_intents")],
  // Radar early fraud warnings
  ["radar.early_fraud_warning.created", upsert("early_fraud_warnings")],
  ["radar.early_fraud_warning.updated", upsert("early_fraud_warnings")],
];

const EVENT_MAPPINGS = new Map(EVENTS);

export function stripeWebhookEventMapping(
  eventType: string,
): WebhookEventMapping | null {
  const mapping = EVENT_MAPPINGS.get(eventType);
  return mapping ? { ...mapping } : null;
}

export function stripeSupportedWebhookEvents(): string[] {
  return EVENTS.map(([event]) => event);
}

/**
 * Only the events of the given entities. No entities means no explicit
 * selection: every supported event.
 */
export function stripeWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return stripeSupportedWebhookEvents();
  const entitySet = new Set(entities.map(e => e.toLowerCase()));
  return EVENTS.filter(([, mapping]) =>
    entitySet.has(mapping.entity.toLowerCase()),
  ).map(([event]) => event);
}

/** Verify a delivery with the SDK (`stripe-signature` + endpoint secret). */
export function verifyStripeWebhook(
  stripe: () => Stripe,
  options: WebhookHandlerOptions,
): WebhookVerificationResult {
  const { payload, headers, secret } = options;

  // Never log the header set: it carries the signature and, for other
  // senders, bearer tokens. Presence is all a log needs.
  const signature = headers["stripe-signature"];
  logger.debug("Stripe webhook verification started", {
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
    const client = stripe();

    // Stripe requires the raw body as a string or Buffer
    // The payload should already be a string from the webhook route
    const rawBody = rawWebhookBody(payload);

    logger.info("Calling stripe.webhooks.constructEvent");
    const event = client.webhooks.constructEvent(
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
 * Events a provisioned endpoint should carry: the explicitly requested
 * ones, else those of the flow's enabled entities, restricted to the
 * `supported` events this connector understands.
 */
export function resolveStripeProvisionEvents(
  options: ProvisionWebhookOptions,
  supported: string[],
  eventsForEntities: (entities: string[]) => string[],
): string[] {
  const requestedEvents = Array.isArray(options.events)
    ? options.events
        .map(event => event.trim())
        .filter((event): event is string => event.length > 0)
    : [];

  const supportedSet = new Set(supported);
  const effectiveEvents = (
    requestedEvents.length > 0
      ? requestedEvents
      : eventsForEntities(options.enabledEntities ?? [])
  ).filter(event => supportedSet.has(event));

  if (effectiveEvents.length === 0) {
    throw new Error(
      requestedEvents.length > 0
        ? `No valid Stripe webhook events configured. Unsupported events: ${requestedEvents.join(", ")}`
        : "No webhook events resolved for the selected entities",
    );
  }
  return effectiveEvents;
}

function describeStripeError(error: unknown): string {
  return error instanceof Stripe.errors.StripeError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

/** Create a webhook endpoint for `effectiveEvents` on the flow URL. */
export async function createStripeWebhookEndpoint(
  stripe: Stripe,
  endpointUrl: string,
  effectiveEvents: string[],
  apiVersion: Stripe.LatestApiVersion,
): Promise<ProvisionWebhookResult> {
  try {
    const endpoint = await stripe.webhookEndpoints.create({
      url: endpointUrl,
      enabled_events:
        effectiveEvents as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
      api_version: apiVersion,
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
    throw new Error(
      `Failed to create Stripe webhook subscription: ${describeStripeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Retarget the Stripe endpoint(s) that POST to `endpointUrl` to
 * `effectiveEvents`, keeping their signing secret.
 *
 * Every endpoint on that URL is updated, not just one: flows provisioned
 * before ids were stored may have duplicates from earlier re-provisioning,
 * and Stripe never reveals a secret after creation, so there is no way to
 * tell which duplicate the flow's stored secret belongs to.
 */
export async function updateStripeWebhookEndpoints(
  stripe: Stripe,
  options: UpdateWebhookSubscriptionOptions,
  effectiveEvents: string[],
): Promise<ProvisionWebhookResult | null> {
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
    throw new Error(
      `Failed to update Stripe webhook subscription: ${describeStripeError(error)}`,
      { cause: error },
    );
  }
}
