/**
 * Stripe webhook events: which ones Mako subscribes to, and the entity and
 * operation each writes. A copy of the in-process table (deleted); the API
 * test `stripe-folder-webhook-batches.test.ts` holds it to the API's own
 * subscription table in `api/src/webhook-provisioning/stripe.ts`.
 *
 * balance_transactions, payout_balance_transactions,
 * customer_balance_transactions and events have no Stripe events: polled
 * only. invoice_line_items and subscription_items ride on their parent's
 * events (webhook-handler.ts). The API table's comment lists the 6 Stripe
 * events left out, and why.
 */

export interface StripeEventMapping {
  entity: string;
  operation: "upsert" | "delete";
}

const upsert = (entity: string): StripeEventMapping => ({
  entity,
  operation: "upsert",
});
const remove = (entity: string): StripeEventMapping => ({
  entity,
  operation: "delete",
});

/** Every event Mako subscribes to, in subscription order. */
const EVENTS: Array<[event: string, mapping: StripeEventMapping]> = [
  // Customers
  ["customer.created", upsert("customers")],
  ["customer.updated", upsert("customers")],
  ["customer.deleted", remove("customers")],
  // Subscriptions
  ["customer.subscription.created", upsert("subscriptions")],
  ["customer.subscription.updated", upsert("subscriptions")],
  ["customer.subscription.deleted", remove("subscriptions")],
  ["customer.subscription.paused", upsert("subscriptions")],
  ["customer.subscription.resumed", upsert("subscriptions")],
  ["customer.subscription.trial_will_end", upsert("subscriptions")],
  ["customer.subscription.pending_update_applied", upsert("subscriptions")],
  ["customer.subscription.pending_update_expired", upsert("subscriptions")],
  // Charges/Payments
  ["charge.succeeded", upsert("charges")],
  ["charge.failed", upsert("charges")],
  ["charge.captured", upsert("charges")],
  ["charge.refunded", upsert("charges")],
  ["charge.updated", upsert("charges")],
  // An async charge (SEPA, ACH) is created pending and settles days later:
  // charge.pending is its create event. charge.expired ends an uncaptured one.
  ["charge.pending", upsert("charges")],
  ["charge.expired", upsert("charges")],
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
  ["payment_intent.processing", upsert("payment_intents")],
  ["payment_intent.requires_action", upsert("payment_intents")],
  ["payment_intent.amount_capturable_updated", upsert("payment_intents")],
  ["payment_intent.partially_funded", upsert("payment_intents")],
  // Invoices
  ["invoice.created", upsert("invoices")],
  ["invoice.finalized", upsert("invoices")],
  ["invoice.paid", upsert("invoices")],
  ["invoice.payment_failed", upsert("invoices")],
  ["invoice.updated", upsert("invoices")],
  ["invoice.voided", upsert("invoices")],
  ["invoice.marked_uncollectible", upsert("invoices")],
  ["invoice.payment_succeeded", upsert("invoices")],
  ["invoice.payment_action_required", upsert("invoices")],
  ["invoice.finalization_failed", upsert("invoices")],
  ["invoice.sent", upsert("invoices")],
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
  ["refund.failed", upsert("refunds")],
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
  // Payment methods. `detached` carries the method with `customer: null`:
  // an upsert, so the row shows it is no longer on file, as Airbyte's
  // payment_methods keeps it.
  ["payment_method.attached", upsert("payment_methods")],
  ["payment_method.updated", upsert("payment_methods")],
  ["payment_method.automatically_updated", upsert("payment_methods")],
  ["payment_method.detached", upsert("payment_methods")],
  // Radar early fraud warnings
  ["radar.early_fraud_warning.created", upsert("early_fraud_warnings")],
  ["radar.early_fraud_warning.updated", upsert("early_fraud_warnings")],
];

const EVENT_MAPPINGS = new Map(EVENTS);

export function stripeWebhookEventMapping(
  eventType: string,
): StripeEventMapping | null {
  const mapping = EVENT_MAPPINGS.get(eventType);
  return mapping ? { ...mapping } : null;
}

export function stripeSupportedWebhookEvents(): string[] {
  return EVENTS.map(([event]) => event);
}

/**
 * A row's change time, as the in-process `resolveRecordTimestamp`: the first
 * Unix-seconds epoch of `created`, `start_date`, `updated` (milliseconds are
 * read as such). Null when there is none; Mako then uses its own fallback.
 */
export function stripeRecordTimestamp(
  payload: Record<string, unknown>,
): string | null {
  for (const candidate of [
    payload.created,
    // An invoice line has no `created`; it carries its invoice's.
    payload.invoice_created,
    payload.start_date,
    payload.updated,
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const ms = candidate > 1e12 ? candidate : candidate * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}
