import {
  type ConnectorFieldSchema,
  type ConnectorEntitySchema,
  MAKO_SYSTEM_FIELDS,
} from "../base/BaseConnector";

const s = (nullable = true): ConnectorFieldSchema => ({
  type: "string",
  nullable,
});
const ts = (nullable = true): ConnectorFieldSchema => ({
  type: "timestamp",
  nullable,
});
const i = (nullable = true): ConnectorFieldSchema => ({
  type: "integer",
  nullable,
});
const n = (nullable = true): ConnectorFieldSchema => ({
  type: "number",
  nullable,
});

const b = (nullable = true): ConnectorFieldSchema => ({
  type: "boolean",
  nullable,
});
const j = (nullable = true): ConnectorFieldSchema => ({
  type: "json",
  nullable,
});

// ---------------------------------------------------------------------------
// Fields common to every Stripe object. `created` is a Unix-seconds epoch
// integer in the raw payload but is declared as `timestamp`; the CDC
// normalizer coerces numeric epochs (seconds) into Dates.
// ---------------------------------------------------------------------------

const COMMON_STRIPE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  object: s(),
  created: ts(),
  livemode: b(),
  metadata: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const CUSTOMER_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  email: s(),
  name: s(),
  description: s(),
  phone: s(),
  currency: s(),
  balance: i(),
  delinquent: b(),
  default_source: s(),
  invoice_prefix: s(),
  tax_exempt: s(),
  test_clock: s(),
  next_invoice_sequence: i(),
  address: j(),
  shipping: j(),
  discount: j(),
  invoice_settings: j(),
  preferred_locales: j(),
  sources: j(),
  subscriptions: j(),
  tax_ids: j(),
};

export const SUBSCRIPTION_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  customer: s(),
  status: s(),
  currency: s(),
  collection_method: s(),
  default_payment_method: s(),
  default_source: s(),
  latest_invoice: s(),
  schedule: s(),
  description: s(),
  start_date: ts(),
  current_period_start: ts(),
  current_period_end: ts(),
  billing_cycle_anchor: ts(),
  canceled_at: ts(),
  cancel_at: ts(),
  ended_at: ts(),
  trial_start: ts(),
  trial_end: ts(),
  cancel_at_period_end: b(),
  days_until_due: i(),
  quantity: i(),
  items: j(),
  plan: j(),
  discount: j(),
  default_tax_rates: j(),
  pause_collection: j(),
  pending_update: j(),
  automatic_tax: j(),
  cancellation_details: j(),
};

export const DISPUTE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  currency: s(),
  charge: s(),
  payment_intent: s(),
  status: s(),
  reason: s(),
  balance_transaction: s(),
  balance_transactions: j(),
  evidence: j(),
  evidence_details: j(),
  is_charge_refundable: b(),
  network_reason_code: s(),
};

export const CHARGE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  amount_captured: i(),
  amount_refunded: i(),
  currency: s(),
  customer: s(),
  status: s(),
  description: s(),
  receipt_email: s(),
  receipt_url: s(),
  receipt_number: s(),
  payment_intent: s(),
  payment_method: s(),
  invoice: s(),
  balance_transaction: s(),
  failure_code: s(),
  failure_message: s(),
  calculated_statement_descriptor: s(),
  statement_descriptor: s(),
  captured: b(),
  paid: b(),
  refunded: b(),
  disputed: b(),
  billing_details: j(),
  payment_method_details: j(),
  outcome: j(),
  refunds: j(),
  fraud_details: j(),
  shipping: j(),
};

export const INVOICE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  customer: s(),
  subscription: s(),
  status: s(),
  currency: s(),
  number: s(),
  collection_method: s(),
  billing_reason: s(),
  hosted_invoice_url: s(),
  invoice_pdf: s(),
  payment_intent: s(),
  charge: s(),
  customer_email: s(),
  customer_name: s(),
  amount_due: i(),
  amount_paid: i(),
  amount_remaining: i(),
  subtotal: i(),
  subtotal_excluding_tax: i(),
  tax: i(),
  total: i(),
  total_excluding_tax: i(),
  starting_balance: i(),
  ending_balance: i(),
  attempt_count: i(),
  period_start: ts(),
  period_end: ts(),
  due_date: ts(),
  paid: b(),
  // Out-of-band (e.g. bank transfer) invoices are common in some markets;
  // declaring the type prevents the unknown-field policy from coercing this
  // boolean to a string.
  paid_out_of_band: b(),
  attempted: b(),
  auto_advance: b(),
  lines: j(),
  discount: j(),
  discounts: j(),
  customer_address: j(),
  customer_shipping: j(),
  status_transitions: j(),
  total_tax_amounts: j(),
  automatic_tax: j(),
  transfer_data: j(),
  payment_settings: j(),
  issuer: j(),
  from_invoice: j(),
};

export const PRODUCT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  updated: ts(),
  name: s(),
  description: s(),
  type: s(),
  default_price: s(),
  url: s(),
  unit_label: s(),
  statement_descriptor: s(),
  tax_code: s(),
  active: b(),
  shippable: b(),
  images: j(),
  package_dimensions: j(),
  features: j(),
  marketing_features: j(),
};

// Legacy plans (stripe.plans.list). Retained for back-compat; `price.*`
// webhook events now target the `prices` entity instead.
export const PLAN_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  nickname: s(),
  product: s(),
  currency: s(),
  interval: s(),
  usage_type: s(),
  billing_scheme: s(),
  aggregate_usage: s(),
  amount_decimal: s(),
  active: b(),
  amount: i(),
  interval_count: i(),
  trial_period_days: i(),
  tiers: j(),
  tiers_mode: j(),
  transform_usage: j(),
};

export const PAYMENT_INTENT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  amount_received: i(),
  amount_capturable: i(),
  currency: s(),
  customer: s(),
  status: s(),
  description: s(),
  receipt_email: s(),
  payment_method: s(),
  latest_charge: s(),
  invoice: s(),
  client_secret: s(),
  capture_method: s(),
  confirmation_method: s(),
  setup_future_usage: s(),
  cancellation_reason: s(),
  statement_descriptor: s(),
  canceled_at: ts(),
  payment_method_types: j(),
  charges: j(),
  next_action: j(),
  last_payment_error: j(),
  automatic_payment_methods: j(),
  payment_method_options: j(),
  shipping: j(),
  amount_details: j(),
};

// Modern prices (stripe.prices.list) — target for `price.*` webhook events.
export const PRICE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  nickname: s(),
  product: s(),
  currency: s(),
  type: s(),
  billing_scheme: s(),
  tax_behavior: s(),
  tiers_mode: s(),
  lookup_key: s(),
  unit_amount_decimal: s(),
  active: b(),
  unit_amount: i(),
  recurring: j(),
  tiers: j(),
  transform_quantity: j(),
  custom_unit_amount: j(),
  currency_options: j(),
};

// ---------------------------------------------------------------------------
// Money movement. Amounts are integers in the currency's minor unit (cents),
// exactly as Stripe returns them.
// ---------------------------------------------------------------------------

export const BALANCE_TRANSACTION_SCHEMA: Record<string, ConnectorFieldSchema> =
  {
    ...COMMON_STRIPE_SCHEMA,
    amount: i(),
    available_on: ts(),
    currency: s(),
    description: s(),
    exchange_rate: n(),
    fee: i(),
    fee_details: j(),
    net: i(),
    reporting_category: s(),
    source: s(),
    status: s(),
    type: s(),
  };

/** Balance transactions listed per payout; `payout` is injected by the connector. */
export const PAYOUT_BALANCE_TRANSACTION_SCHEMA: Record<
  string,
  ConnectorFieldSchema
> = {
  ...BALANCE_TRANSACTION_SCHEMA,
  payout: s(),
};

export const PAYOUT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  arrival_date: ts(),
  automatic: b(),
  balance_transaction: s(),
  currency: s(),
  description: s(),
  destination: s(),
  failure_balance_transaction: s(),
  failure_code: s(),
  failure_message: s(),
  method: s(),
  original_payout: s(),
  reconciliation_status: s(),
  reversed_by: s(),
  source_type: s(),
  statement_descriptor: s(),
  status: s(),
  type: s(),
};

export const REFUND_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  balance_transaction: s(),
  charge: s(),
  currency: s(),
  description: s(),
  failure_balance_transaction: s(),
  failure_reason: s(),
  payment_intent: s(),
  reason: s(),
  receipt_number: s(),
  status: s(),
  destination_details: j(),
};

export const CREDIT_NOTE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  amount_shipping: i(),
  currency: s(),
  customer: s(),
  customer_balance_transaction: s(),
  discount_amount: i(),
  discount_amounts: j(),
  effective_at: ts(),
  invoice: s(),
  lines: j(),
  memo: s(),
  number: s(),
  out_of_band_amount: i(),
  pdf: s(),
  reason: s(),
  refund: s(),
  status: s(),
  subtotal: i(),
  subtotal_excluding_tax: i(),
  tax_amounts: j(),
  total: i(),
  total_excluding_tax: i(),
  type: s(),
  voided_at: ts(),
};

export const CUSTOMER_BALANCE_TRANSACTION_SCHEMA: Record<
  string,
  ConnectorFieldSchema
> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  credit_note: s(),
  currency: s(),
  customer: s(),
  description: s(),
  ending_balance: i(),
  invoice: s(),
  type: s(),
};

// ---------------------------------------------------------------------------
// Billing detail
// ---------------------------------------------------------------------------

export const INVOICE_ITEM_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount: i(),
  currency: s(),
  customer: s(),
  date: ts(),
  description: s(),
  discountable: b(),
  discounts: j(),
  invoice: s(),
  period: j(),
  plan: j(),
  price: j(),
  proration: b(),
  quantity: i(),
  subscription: s(),
  subscription_item: s(),
  tax_rates: j(),
  test_clock: s(),
  unit_amount: i(),
  unit_amount_decimal: s(),
};

export const SUBSCRIPTION_SCHEDULE_SCHEMA: Record<
  string,
  ConnectorFieldSchema
> = {
  ...COMMON_STRIPE_SCHEMA,
  canceled_at: ts(),
  completed_at: ts(),
  current_phase: j(),
  customer: s(),
  default_settings: j(),
  end_behavior: s(),
  phases: j(),
  released_at: ts(),
  released_subscription: s(),
  status: s(),
  subscription: s(),
  test_clock: s(),
};

export const COUPON_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount_off: i(),
  applies_to: j(),
  currency: s(),
  currency_options: j(),
  duration: s(),
  duration_in_months: i(),
  max_redemptions: i(),
  name: s(),
  percent_off: n(),
  redeem_by: ts(),
  times_redeemed: i(),
  valid: b(),
};

export const PROMOTION_CODE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  active: b(),
  code: s(),
  coupon: j(),
  customer: s(),
  expires_at: ts(),
  max_redemptions: i(),
  restrictions: j(),
  times_redeemed: i(),
};

export const CHECKOUT_SESSION_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  amount_subtotal: i(),
  amount_total: i(),
  client_reference_id: s(),
  currency: s(),
  customer: s(),
  customer_details: j(),
  customer_email: s(),
  expires_at: ts(),
  invoice: s(),
  mode: s(),
  payment_intent: s(),
  payment_link: s(),
  payment_status: s(),
  status: s(),
  subscription: s(),
  total_details: j(),
  url: s(),
};

export const SETUP_INTENT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  ...COMMON_STRIPE_SCHEMA,
  cancellation_reason: s(),
  customer: s(),
  description: s(),
  last_setup_error: j(),
  payment_method: s(),
  payment_method_types: j(),
  status: s(),
  usage: s(),
};

export const EARLY_FRAUD_WARNING_SCHEMA: Record<string, ConnectorFieldSchema> =
  {
    ...COMMON_STRIPE_SCHEMA,
    actionable: b(),
    charge: s(),
    fraud_type: s(),
    payment_intent: s(),
  };

export const STRIPE_ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
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
  invoice_items: INVOICE_ITEM_SCHEMA,
  subscription_schedules: SUBSCRIPTION_SCHEDULE_SCHEMA,
  coupons: COUPON_SCHEMA,
  promotion_codes: PROMOTION_CODE_SCHEMA,
  checkout_sessions: CHECKOUT_SESSION_SCHEMA,
  setup_intents: SETUP_INTENT_SCHEMA,
  early_fraud_warnings: EARLY_FRAUD_WARNING_SCHEMA,
};

export function resolveStripeEntitySchema(
  entity: string,
): ConnectorEntitySchema | null {
  const fields = STRIPE_ENTITY_SCHEMA_MAP[entity];
  if (!fields) {
    return null;
  }

  return {
    entity,
    fields,
    unknownFieldPolicy: "string",
    keyColumns: ["id"],
  };
}
