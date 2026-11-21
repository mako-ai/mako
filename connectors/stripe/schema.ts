/**
 * Stripe entity schemas, field for field the same as the in-process
 * connector's (`api/src/connectors/stripe/schema.ts`). The parity harness in
 * `fixtures/` fails if the two drift.
 *
 * Two things differ in form, not in meaning:
 * - Mako's system columns (`_mako_*`, `_syncedAt`, `is_deleted`, ...) are not
 *   declared here: a connector cannot declare them over the wire.
 *   `jsonSchemaToEntitySchema` merges all 8 on the box path, as the
 *   in-process schema spreads them, and the parity test checks they match.
 * - A timestamp is a Unix-seconds integer on the wire, exactly as Stripe
 *   returns it. Its JSON Schema says so (`string | integer`, `date-time`), so
 *   the engine still reads it as a timestamp and `mako connector test` does
 *   not flag the integer as a type mismatch.
 */

type FieldType =
  "string" | "timestamp" | "integer" | "number" | "boolean" | "json";
type Fields = Record<string, FieldType>;

const COMMON_STRIPE_SCHEMA: Fields = {
  id: "string",
  object: "string",
  created: "timestamp",
  livemode: "boolean",
  metadata: "json",
};

const CUSTOMER_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  email: "string",
  name: "string",
  description: "string",
  phone: "string",
  currency: "string",
  balance: "integer",
  delinquent: "boolean",
  default_source: "string",
  invoice_prefix: "string",
  tax_exempt: "string",
  test_clock: "string",
  next_invoice_sequence: "integer",
  address: "json",
  shipping: "json",
  discount: "json",
  invoice_settings: "json",
  preferred_locales: "json",
  sources: "json",
  subscriptions: "json",
  tax_ids: "json",
};

const SUBSCRIPTION_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  customer: "string",
  status: "string",
  currency: "string",
  collection_method: "string",
  default_payment_method: "string",
  default_source: "string",
  latest_invoice: "string",
  schedule: "string",
  description: "string",
  start_date: "timestamp",
  current_period_start: "timestamp",
  current_period_end: "timestamp",
  billing_cycle_anchor: "timestamp",
  canceled_at: "timestamp",
  cancel_at: "timestamp",
  ended_at: "timestamp",
  trial_start: "timestamp",
  trial_end: "timestamp",
  cancel_at_period_end: "boolean",
  days_until_due: "integer",
  quantity: "integer",
  items: "json",
  plan: "json",
  discount: "json",
  default_tax_rates: "json",
  pause_collection: "json",
  pending_update: "json",
  automatic_tax: "json",
  cancellation_details: "json",
};

const DISPUTE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  currency: "string",
  charge: "string",
  payment_intent: "string",
  status: "string",
  reason: "string",
  balance_transaction: "string",
  balance_transactions: "json",
  evidence: "json",
  evidence_details: "json",
  is_charge_refundable: "boolean",
  network_reason_code: "string",
};

const CHARGE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  amount_captured: "integer",
  amount_refunded: "integer",
  currency: "string",
  customer: "string",
  status: "string",
  description: "string",
  receipt_email: "string",
  receipt_url: "string",
  receipt_number: "string",
  payment_intent: "string",
  payment_method: "string",
  invoice: "string",
  balance_transaction: "string",
  failure_code: "string",
  failure_message: "string",
  calculated_statement_descriptor: "string",
  statement_descriptor: "string",
  captured: "boolean",
  paid: "boolean",
  refunded: "boolean",
  disputed: "boolean",
  billing_details: "json",
  payment_method_details: "json",
  outcome: "json",
  refunds: "json",
  fraud_details: "json",
  shipping: "json",
};

const INVOICE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  customer: "string",
  subscription: "string",
  status: "string",
  currency: "string",
  number: "string",
  collection_method: "string",
  billing_reason: "string",
  hosted_invoice_url: "string",
  invoice_pdf: "string",
  payment_intent: "string",
  charge: "string",
  customer_email: "string",
  customer_name: "string",
  amount_due: "integer",
  amount_paid: "integer",
  amount_remaining: "integer",
  subtotal: "integer",
  subtotal_excluding_tax: "integer",
  tax: "integer",
  total: "integer",
  total_excluding_tax: "integer",
  starting_balance: "integer",
  ending_balance: "integer",
  attempt_count: "integer",
  period_start: "timestamp",
  period_end: "timestamp",
  due_date: "timestamp",
  paid: "boolean",
  // Out-of-band (e.g. bank transfer) invoices are common in some markets;
  // declaring the type prevents the unknown-field policy from coercing this
  // boolean to a string.
  paid_out_of_band: "boolean",
  attempted: "boolean",
  auto_advance: "boolean",
  lines: "json",
  discount: "json",
  discounts: "json",
  customer_address: "json",
  customer_shipping: "json",
  status_transitions: "json",
  total_tax_amounts: "json",
  automatic_tax: "json",
  transfer_data: "json",
  payment_settings: "json",
  issuer: "json",
  from_invoice: "json",
};

const PRODUCT_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  updated: "timestamp",
  name: "string",
  description: "string",
  type: "string",
  default_price: "string",
  url: "string",
  unit_label: "string",
  statement_descriptor: "string",
  tax_code: "string",
  active: "boolean",
  shippable: "boolean",
  images: "json",
  package_dimensions: "json",
  features: "json",
  marketing_features: "json",
};

// Legacy plans (stripe.plans.list). Retained for back-compat; `price.*`
// webhook events now target the `prices` entity instead.
const PLAN_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  nickname: "string",
  product: "string",
  currency: "string",
  interval: "string",
  usage_type: "string",
  billing_scheme: "string",
  aggregate_usage: "string",
  amount_decimal: "string",
  active: "boolean",
  amount: "integer",
  interval_count: "integer",
  trial_period_days: "integer",
  tiers: "json",
  tiers_mode: "json",
  transform_usage: "json",
};

const PAYMENT_INTENT_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  amount_received: "integer",
  amount_capturable: "integer",
  currency: "string",
  customer: "string",
  status: "string",
  description: "string",
  receipt_email: "string",
  payment_method: "string",
  latest_charge: "string",
  invoice: "string",
  client_secret: "string",
  capture_method: "string",
  confirmation_method: "string",
  setup_future_usage: "string",
  cancellation_reason: "string",
  statement_descriptor: "string",
  canceled_at: "timestamp",
  payment_method_types: "json",
  charges: "json",
  next_action: "json",
  last_payment_error: "json",
  automatic_payment_methods: "json",
  payment_method_options: "json",
  shipping: "json",
  amount_details: "json",
};

// Modern prices (stripe.prices.list) — target for `price.*` webhook events.
const PRICE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  nickname: "string",
  product: "string",
  currency: "string",
  type: "string",
  billing_scheme: "string",
  tax_behavior: "string",
  tiers_mode: "string",
  lookup_key: "string",
  unit_amount_decimal: "string",
  active: "boolean",
  unit_amount: "integer",
  recurring: "json",
  tiers: "json",
  transform_quantity: "json",
  custom_unit_amount: "json",
  currency_options: "json",
};

// ---------------------------------------------------------------------------
// Money movement. Amounts are integers in the currency's minor unit (cents),
// exactly as Stripe returns them.
// ---------------------------------------------------------------------------

const BALANCE_TRANSACTION_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  available_on: "timestamp",
  balance_type: "string",
  currency: "string",
  description: "string",
  exchange_rate: "number",
  fee: "integer",
  fee_details: "json",
  net: "integer",
  reporting_category: "string",
  source: "string",
  status: "string",
  type: "string",
};

/** Balance transactions listed per payout; `payout` is injected by the connector. */
const PAYOUT_BALANCE_TRANSACTION_SCHEMA: Fields = {
  ...BALANCE_TRANSACTION_SCHEMA,
  payout: "string",
};

const PAYOUT_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  arrival_date: "timestamp",
  automatic: "boolean",
  balance_transaction: "string",
  currency: "string",
  description: "string",
  destination: "string",
  failure_balance_transaction: "string",
  failure_code: "string",
  failure_message: "string",
  method: "string",
  original_payout: "string",
  reconciliation_status: "string",
  reversed_by: "string",
  source_type: "string",
  statement_descriptor: "string",
  status: "string",
  type: "string",
};

const REFUND_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  balance_transaction: "string",
  charge: "string",
  currency: "string",
  description: "string",
  failure_balance_transaction: "string",
  failure_reason: "string",
  payment_intent: "string",
  reason: "string",
  receipt_number: "string",
  status: "string",
  destination_details: "json",
};

const CREDIT_NOTE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  amount_shipping: "integer",
  currency: "string",
  customer: "string",
  customer_balance_transaction: "string",
  discount_amount: "integer",
  discount_amounts: "json",
  effective_at: "timestamp",
  invoice: "string",
  lines: "json",
  memo: "string",
  number: "string",
  out_of_band_amount: "integer",
  pdf: "string",
  reason: "string",
  refund: "string",
  status: "string",
  subtotal: "integer",
  subtotal_excluding_tax: "integer",
  tax_amounts: "json",
  total: "integer",
  total_excluding_tax: "integer",
  type: "string",
  voided_at: "timestamp",
};

const CUSTOMER_BALANCE_TRANSACTION_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  credit_note: "string",
  currency: "string",
  customer: "string",
  description: "string",
  ending_balance: "integer",
  invoice: "string",
  type: "string",
};

/**
 * A payment method carries the details of its own `type` under a key of the
 * same name (`card`, `sepa_debit`, ...). These are the types our accounts
 * use, plus the keys the Airbyte stream had, so its readers port one to one.
 */
export const PAYMENT_METHOD_TYPE_FIELDS = [
  "acss_debit",
  "affirm",
  "afterpay_clearpay",
  "alipay",
  "amazon_pay",
  "au_becs_debit",
  "bacs_debit",
  "bancontact",
  "blik",
  "boleto",
  "card",
  "card_present",
  "cashapp",
  "eps",
  "fpx",
  "giropay",
  "grabpay",
  "ideal",
  "interac_present",
  "klarna",
  "link",
  "oxxo",
  "p24",
  "paypal",
  "revolut_pay",
  "sepa_debit",
  "sofort",
  "twint",
  "us_bank_account",
] as const;

const PAYMENT_METHOD_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  customer: "string",
  type: "string",
  allow_redisplay: "string",
  billing_details: "json",
  radar_options: "json",
  ...Object.fromEntries(
    PAYMENT_METHOD_TYPE_FIELDS.map(field => [field, "json" as const]),
  ),
};

// ---------------------------------------------------------------------------
// Billing detail
// ---------------------------------------------------------------------------

const INVOICE_ITEM_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  currency: "string",
  customer: "string",
  date: "timestamp",
  description: "string",
  discountable: "boolean",
  discounts: "json",
  invoice: "string",
  period: "json",
  plan: "json",
  price: "json",
  proration: "boolean",
  quantity: "integer",
  subscription: "string",
  subscription_item: "string",
  tax_rates: "json",
  test_clock: "string",
  unit_amount: "integer",
  unit_amount_decimal: "string",
};

const SUBSCRIPTION_SCHEDULE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  canceled_at: "timestamp",
  completed_at: "timestamp",
  current_phase: "json",
  customer: "string",
  default_settings: "json",
  end_behavior: "string",
  phases: "json",
  released_at: "timestamp",
  released_subscription: "string",
  status: "string",
  subscription: "string",
  test_clock: "string",
};

const COUPON_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount_off: "integer",
  applies_to: "json",
  currency: "string",
  currency_options: "json",
  duration: "string",
  duration_in_months: "integer",
  max_redemptions: "integer",
  name: "string",
  percent_off: "number",
  redeem_by: "timestamp",
  times_redeemed: "integer",
  valid: "boolean",
};

const PROMOTION_CODE_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  active: "boolean",
  code: "string",
  coupon: "json",
  customer: "string",
  expires_at: "timestamp",
  max_redemptions: "integer",
  restrictions: "json",
  times_redeemed: "integer",
};

const CHECKOUT_SESSION_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount_subtotal: "integer",
  amount_total: "integer",
  client_reference_id: "string",
  currency: "string",
  customer: "string",
  customer_details: "json",
  customer_email: "string",
  expires_at: "timestamp",
  invoice: "string",
  mode: "string",
  payment_intent: "string",
  payment_link: "string",
  payment_status: "string",
  status: "string",
  subscription: "string",
  total_details: "json",
  url: "string",
};

const CHECKOUT_SESSION_LINE_ITEM_SCHEMA: Fields = {
  id: "string",
  object: "string",
  amount_discount: "integer",
  amount_subtotal: "integer",
  amount_tax: "integer",
  amount_total: "integer",
  checkout_session_created: "integer",
  checkout_session_expires_at: "integer",
  checkout_session_id: "string",
  checkout_session_updated: "integer",
  currency: "string",
  description: "string",
  discounts: "json",
  price: "json",
  quantity: "integer",
  taxes: "json",
};

const SETUP_INTENT_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  cancellation_reason: "string",
  customer: "string",
  description: "string",
  last_setup_error: "json",
  payment_method: "string",
  payment_method_types: "json",
  status: "string",
  usage: "string",
};

const EARLY_FRAUD_WARNING_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  actionable: "boolean",
  charge: "string",
  fraud_type: "string",
  payment_intent: "string",
};

/**
 * An invoice's `lines`, one row per line. A line has no `created`; the
 * invoice's id and `created` are added (`invoice`, `invoice_id`,
 * `invoice_created`), as the Airbyte stream had them.
 */
const INVOICE_LINE_ITEM_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  amount: "integer",
  amount_excluding_tax: "integer",
  currency: "string",
  description: "string",
  discount_amounts: "json",
  discountable: "boolean",
  discounts: "json",
  invoice: "string",
  invoice_id: "string",
  invoice_created: "timestamp",
  invoice_item: "string",
  period: "json",
  plan: "json",
  price: "json",
  proration: "boolean",
  proration_details: "json",
  quantity: "integer",
  subscription: "string",
  subscription_item: "string",
  tax_amounts: "json",
  tax_rates: "json",
  type: "string",
  unit_amount_excluding_tax: "string",
};

/**
 * A subscription's `items`. The billing period comes from the subscription
 * at API version 2023-10-16 (`current_period_start`, `current_period_end`).
 */
const SUBSCRIPTION_ITEM_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  billing_thresholds: "json",
  current_period_end: "timestamp",
  current_period_start: "timestamp",
  discounts: "json",
  plan: "json",
  price: "json",
  quantity: "integer",
  subscription: "string",
  tax_rates: "json",
};

/** `GET /v1/events`: every event of the last 30 days, Stripe's retention. */
const EVENT_SCHEMA: Fields = {
  ...COMMON_STRIPE_SCHEMA,
  api_version: "string",
  data: "json",
  pending_webhooks: "integer",
  request: "json",
  type: "string",
};

export const STRIPE_ENTITY_SCHEMA_MAP: Record<string, Fields> = {
  customers: CUSTOMER_SCHEMA,
  subscriptions: SUBSCRIPTION_SCHEMA,
  disputes: DISPUTE_SCHEMA,
  charges: CHARGE_SCHEMA,
  invoices: INVOICE_SCHEMA,
  products: PRODUCT_SCHEMA,
  plans: PLAN_SCHEMA,
  payment_intents: PAYMENT_INTENT_SCHEMA,
  prices: PRICE_SCHEMA,
  balance_transactions: BALANCE_TRANSACTION_SCHEMA,
  payouts: PAYOUT_SCHEMA,
  payout_balance_transactions: PAYOUT_BALANCE_TRANSACTION_SCHEMA,
  refunds: REFUND_SCHEMA,
  credit_notes: CREDIT_NOTE_SCHEMA,
  customer_balance_transactions: CUSTOMER_BALANCE_TRANSACTION_SCHEMA,
  payment_methods: PAYMENT_METHOD_SCHEMA,
  invoice_items: INVOICE_ITEM_SCHEMA,
  subscription_schedules: SUBSCRIPTION_SCHEDULE_SCHEMA,
  coupons: COUPON_SCHEMA,
  promotion_codes: PROMOTION_CODE_SCHEMA,
  checkout_sessions: CHECKOUT_SESSION_SCHEMA,
  checkout_sessions_line_items: CHECKOUT_SESSION_LINE_ITEM_SCHEMA,
  setup_intents: SETUP_INTENT_SCHEMA,
  early_fraud_warnings: EARLY_FRAUD_WARNING_SCHEMA,
  invoice_line_items: INVOICE_LINE_ITEM_SCHEMA,
  subscription_items: SUBSCRIPTION_ITEM_SCHEMA,
  events: EVENT_SCHEMA,
};

/** Field type -> JSON Schema, as `discover` emits it. */
const JSON_SCHEMA_TYPES: Record<FieldType, Record<string, unknown>> = {
  string: { type: ["null", "string"] },
  // Stripe sends epochs in seconds; `format` makes it a timestamp downstream.
  timestamp: { type: ["null", "string", "integer"], format: "date-time" },
  integer: { type: ["null", "integer"] },
  number: { type: ["null", "number"] },
  boolean: { type: ["null", "boolean"] },
  json: { type: ["null", "object", "array"] },
};

/** The stream's JSON Schema. `id` is the only required, non-null field. */
export function stripeJsonSchema(entity: string): Record<string, unknown> {
  const fields = STRIPE_ENTITY_SCHEMA_MAP[entity];
  if (!fields) throw new Error(`Unsupported entity: ${entity}`);
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(fields)) {
    properties[name] =
      name === "id" ? { type: "string" } : { ...JSON_SCHEMA_TYPES[type] };
  }
  return {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties,
  };
}
