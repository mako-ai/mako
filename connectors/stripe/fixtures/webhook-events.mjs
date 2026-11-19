/**
 * Synthetic Stripe webhook events, one per event type the connector
 * subscribes to, built from the recorded (synthetic) cassettes: each event's
 * `data.object` is a list row of its entity, as a Stripe snapshot event
 * carries it. No real payload is used. The signing secret is a test value.
 */
import { loadCassettes } from "./harness.mjs";

/** A `whsec_` secret, as Stripe returns on endpoint create. A test value. */
export const TEST_SIGNING_SECRET =
  "whsec_test_0123456789abcdefABCDEF0123456789";

/** 2026-11-16T11:00:00Z, the fixtures' delivery time. */
export const SENT_AT = 1794826800;

/** The event-type prefix of each entity's events. */
const OBJECT_OF = [
  ["customer.subscription.", "subscriptions"],
  ["customer.", "customers"],
  ["charge.dispute.", "disputes"],
  ["charge.refund.", "refunds"],
  ["charge.", "charges"],
  ["payment_intent.", "payment_intents"],
  ["invoiceitem.", "invoice_items"],
  ["invoice.", "invoices"],
  ["product.", "products"],
  ["price.", "prices"],
  ["plan.", "plans"],
  ["payout.", "payouts"],
  ["refund.", "refunds"],
  ["credit_note.", "credit_notes"],
  ["subscription_schedule.", "subscription_schedules"],
  ["coupon.", "coupons"],
  ["promotion_code.", "promotion_codes"],
  ["checkout.session.", "checkout_sessions"],
  ["setup_intent.", "setup_intents"],
  ["radar.early_fraud_warning.", "early_fraud_warnings"],
  ["payment_method.", "payment_methods"],
];

export function entityOfEvent(eventType) {
  return OBJECT_OF.find(([prefix]) => eventType.startsWith(prefix))?.[1];
}

/** The cassette list path of each entity. */
export const LIST_PATH = {
  customers: "customers",
  subscriptions: "subscriptions",
  charges: "charges",
  disputes: "disputes",
  payment_intents: "payment_intents",
  invoices: "invoices",
  products: "products",
  prices: "prices",
  plans: "plans",
  payouts: "payouts",
  refunds: "refunds",
  credit_notes: "credit_notes",
  invoice_items: "invoiceitems",
  subscription_schedules: "subscription_schedules",
  coupons: "coupons",
  promotion_codes: "promotion_codes",
  checkout_sessions: "checkout/sessions",
  setup_intents: "setup_intents",
  early_fraud_warnings: "radar/early_fraud_warnings",
  // Listed per customer: `/v1/customers/<id>/payment_methods`.
  payment_methods: /^customers\/[^/]+\/payment_methods$/,
};

/** The cassettes hold no setup intent: one in Stripe's 2023-10-16 shape. */
const SETUP_INTENT = {
  id: "seti_fx0001",
  object: "setup_intent",
  created: 1767225600,
  livemode: false,
  metadata: {},
  application: null,
  automatic_payment_methods: null,
  cancellation_reason: null,
  client_secret: "seti_fx0001_secret_fixture",
  customer: "cus_fx0001",
  description: null,
  flow_directions: null,
  last_setup_error: null,
  latest_attempt: null,
  mandate: null,
  next_action: null,
  on_behalf_of: null,
  payment_method: "pm_fx0001",
  payment_method_configuration_details: null,
  payment_method_options: {},
  payment_method_types: ["card"],
  single_use_mandate: null,
  status: "succeeded",
  usage: "off_session",
};

/** Every list row of every entity, by entity, from the cassettes. */
export function rowsByEntity(interactions = loadCassettes()) {
  const out = {};
  for (const [entity, listPath] of Object.entries(LIST_PATH)) {
    out[entity] = [];
    for (const [request, response] of interactions) {
      const url = request.replace(/^GET /, "");
      const route = url.replace(/^\/v1\//, "").split("?")[0];
      const matches =
        listPath instanceof RegExp
          ? listPath.test(route)
          : url.startsWith(`/v1/${listPath}?`);
      if (!matches) continue;
      for (const row of response.body?.data ?? []) {
        if (row?.object && !out[entity].some(r => r.id === row.id)) {
          out[entity].push(row);
        }
      }
    }
  }
  if (out.setup_intents.length === 0) out.setup_intents.push(SETUP_INTENT);
  return out;
}

/**
 * One snapshot event per type, `data.object` a row of its entity (the n-th
 * event of an entity takes its n-th row), as Stripe delivers it.
 */
export function buildWebhookEvents(eventTypes, rows = rowsByEntity()) {
  const used = {};
  return eventTypes.map((eventType, i) => {
    const entity = entityOfEvent(eventType);
    if (!entity) throw new Error(`No entity for ${eventType}`);
    const n = (used[entity] = (used[entity] ?? -1) + 1);
    const list = rows[entity];
    const object = structuredClone(list[n % list.length]);
    const eventId = `evt_fx${String(i + 1).padStart(4, "0")}`;
    return {
      eventId,
      eventType,
      receivedAt: new Date(SENT_AT * 1000).toISOString(),
      rawPayload: {
        id: eventId,
        object: "event",
        api_version: "2023-10-16",
        created: SENT_AT,
        data: { object },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: eventType,
      },
    };
  });
}
