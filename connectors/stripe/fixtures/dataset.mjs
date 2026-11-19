/**
 * The Stripe account the cassettes were recorded from: a deterministic,
 * test-mode (`livemode: false`) dataset in Stripe's 2023-10-16 object shapes.
 *
 * No Stripe test key is configured for this repository, so nothing here came
 * from a real account. The shapes follow the in-process connector's unit-test
 * fixtures (`api/src/connectors/stripe/connector.test.ts`) and Stripe's API
 * reference. Every id is synthetic; there is no secret to redact.
 *
 * Sizes are chosen to exercise what breaks parity: two pages (customers,
 * payouts), a page of exactly 100 (payment_intents), an empty list
 * (setup_intents), child lists longer than one page (a payout and a customer
 * with 101 each), and canceled subscriptions that Stripe hides unless asked
 * for `status=all`.
 *
 * Only `parity.mjs --record` reads this file.
 */

// 2025-01-01T00:00:00Z. Objects are spread over the following 21 months.
const BASE = 1735689600;
const SPAN = 21 * 30 * 86400;

/** mulberry32: a small seeded PRNG, so a re-record writes identical files. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = n => String(n).padStart(4, "0");
const pick = (random, list) => list[Math.floor(random() * list.length)];
const amount = random => Math.round(random() * 2000) * 100 + 900;
const CURRENCIES = ["eur", "chf", "eur", "pln", "eur"];

/** `count` objects of `make(i, random, created)`, created spread over time. */
function series(seed, count, make) {
  const random = rng(seed);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const created = BASE + Math.floor((SPAN * i) / (count + 1));
    out.push(make(i, random, created));
  }
  return out;
}

const common = (object, id, created, random) => ({
  id,
  object,
  created,
  livemode: false,
  metadata: random() < 0.3 ? { source: "fixture", tier: "pro" } : {},
});

const address = i => ({
  city: pick(rng(i), ["Lausanne", "Paris", "Madrid", "Milano", "Warszawa"]),
  country: pick(rng(i + 1), ["CH", "FR", "ES", "IT", "PL"]),
  line1: `${i} Fixture Street`,
  line2: null,
  postal_code: String(1000 + i),
  state: null,
});

/**
 * An invoice line in Stripe's 2023-10-16 shape. It has no `created` and no
 * invoice id: the connectors add `invoice`, `invoice_id`, `invoice_created`.
 */
const invoiceLine = (invoice, n, value, created) => ({
  id: `il_fx${invoice}_${pad(n)}`,
  object: "line_item",
  amount: value,
  amount_excluding_tax: value,
  currency: "eur",
  description: `1 × Fixture Plan (at €${value / 100} / month)`,
  discount_amounts: [],
  discountable: true,
  discounts: [],
  invoice_item: null,
  livemode: false,
  metadata: {},
  period: { end: created, start: created - 30 * 86400 },
  plan: { id: "price_fx0001", object: "plan", amount: value },
  price: { id: "price_fx0001", object: "price", unit_amount: value },
  proration: false,
  proration_details: { credited_items: null },
  quantity: 1,
  subscription: `sub_fx${invoice}`,
  subscription_item: `si_fx${invoice}`,
  tax_amounts: [],
  tax_rates: [],
  type: "subscription",
  unit_amount_excluding_tax: String(value),
});

/** A subscription item in Stripe's 2023-10-16 shape: no `livemode`, no period. */
const subscriptionItem = (subscription, n, created, price) => ({
  id: n === 1 ? `si_fx${subscription}` : `si_fx${subscription}_${pad(n)}`,
  object: "subscription_item",
  billing_thresholds: null,
  created,
  discounts: [],
  metadata: {},
  plan: { id: price, object: "plan", amount: 5900 },
  price: { id: price, object: "price", unit_amount: 5900 },
  quantity: n,
  subscription: `sub_fx${subscription}`,
  tax_rates: [],
});

/** Embedded lists hold 10 rows; the rest is on the child endpoint. */
const EMBEDDED = 10;
const embedded = (rows, url) => ({
  object: "list",
  data: rows.slice(0, EMBEDDED),
  has_more: rows.length > EMBEDDED,
  total_count: rows.length,
  url,
});

export function buildDataset() {
  const customers = series(1, 130, (i, r, created) => ({
    ...common("customer", `cus_fx${pad(i)}`, created, r),
    address: r() < 0.6 ? address(i) : null,
    balance: i % 7 === 0 ? -1500 : 0,
    currency: pick(r, CURRENCIES),
    default_source: null,
    delinquent: r() < 0.1,
    description: r() < 0.2 ? `Agency ${i}` : null,
    discount: null,
    email: `customer${i}@example.test`,
    invoice_prefix: `FX${pad(i)}`,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null,
    },
    name: `Fixture Customer ${i}`,
    next_invoice_sequence: 1 + (i % 9),
    phone: r() < 0.5 ? `+4121000${pad(i)}` : null,
    preferred_locales: ["fr"],
    shipping: null,
    tax_exempt: "none",
    test_clock: null,
  }));

  const products = series(2, 6, (i, r, created) => ({
    ...common("product", `prod_fx${pad(i)}`, created, r),
    active: i !== 6,
    default_price: `price_fx${pad(i)}`,
    description: `Plan ${i}`,
    features: [],
    images: [],
    marketing_features: [],
    name: `Fixture Plan ${i}`,
    package_dimensions: null,
    shippable: null,
    statement_descriptor: null,
    tax_code: "txcd_10000000",
    type: "service",
    unit_label: null,
    updated: created + 3600,
    url: null,
  }));

  const prices = series(3, 9, (i, r, created) => ({
    ...common("price", `price_fx${pad(i)}`, created, r),
    active: true,
    billing_scheme: "per_unit",
    currency: "eur",
    custom_unit_amount: null,
    lookup_key: i % 3 === 0 ? `fixture_${i}` : null,
    nickname: `Monthly ${i}`,
    product: `prod_fx${pad(((i - 1) % 6) + 1)}`,
    recurring: {
      aggregate_usage: null,
      interval: "month",
      interval_count: 1,
      trial_period_days: null,
      usage_type: "licensed",
    },
    tax_behavior: "exclusive",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: 4900 + i * 1000,
    unit_amount_decimal: String(4900 + i * 1000),
  }));

  const plans = series(4, 4, (i, r, created) => ({
    ...common("plan", `price_fx${pad(i)}`, created, r),
    active: true,
    aggregate_usage: null,
    amount: 4900 + i * 1000,
    amount_decimal: String(4900 + i * 1000),
    billing_scheme: "per_unit",
    currency: "eur",
    interval: "month",
    interval_count: 1,
    nickname: `Monthly ${i}`,
    product: `prod_fx${pad(i)}`,
    tiers_mode: null,
    transform_usage: null,
    trial_period_days: null,
    usage_type: "licensed",
  }));

  const STATUSES = [
    "active",
    "active",
    "past_due",
    "canceled",
    "trialing",
    "incomplete_expired",
  ];
  // One subscription holds 12 items, more than a payload embeds.
  const subscriptionItemsOf = (i, created) =>
    Array.from({ length: i === 6 ? 12 : 1 }, (_, k) =>
      subscriptionItem(
        pad(i),
        k + 1,
        created + k,
        `price_fx${pad(((i - 1 + k) % 9) + 1)}`,
      ),
    );
  const subscriptions = series(5, 30, (i, r, created) => {
    const status = STATUSES[i % STATUSES.length];
    const ended = status === "canceled" || status === "incomplete_expired";
    return {
      ...common("subscription", `sub_fx${pad(i)}`, created, r),
      automatic_tax: { enabled: false, liability: null },
      billing_cycle_anchor: created,
      cancel_at: null,
      cancel_at_period_end: false,
      canceled_at: ended ? created + 90 * 86400 : null,
      cancellation_details: {
        comment: null,
        feedback: null,
        reason: ended ? "cancellation_requested" : null,
      },
      collection_method: "charge_automatically",
      currency: "eur",
      current_period_end: created + 30 * 86400,
      current_period_start: created,
      customer: `cus_fx${pad(i)}`,
      days_until_due: null,
      default_payment_method: `pm_fx${pad(i)}`,
      default_source: null,
      default_tax_rates: [],
      description: null,
      discount: null,
      ended_at: ended ? created + 90 * 86400 : null,
      items: embedded(
        subscriptionItemsOf(i, created),
        `/v1/subscription_items?subscription=sub_fx${pad(i)}`,
      ),
      latest_invoice: `in_fx${pad(i)}`,
      pause_collection: null,
      pending_update: null,
      plan: {
        id: `price_fx${pad(((i - 1) % 4) + 1)}`,
        object: "plan",
        amount: 5900,
      },
      quantity: 1,
      schedule: null,
      start_date: created,
      status,
      trial_end: status === "trialing" ? created + 14 * 86400 : null,
      trial_start: status === "trialing" ? created : null,
    };
  });

  const charges = series(6, 30, (i, r, created) => {
    const value = amount(r);
    const refunded = i % 11 === 0;
    return {
      ...common("charge", `ch_fx${pad(i)}`, created, r),
      amount: value,
      amount_captured: value,
      amount_refunded: refunded ? value : 0,
      balance_transaction: `txn_fx${pad(i)}`,
      billing_details: {
        address: address(i),
        email: `customer${i}@example.test`,
        name: `Fixture Customer ${i}`,
        phone: null,
      },
      calculated_statement_descriptor: "REALFIXTURE",
      captured: true,
      currency: pick(r, CURRENCIES),
      customer: `cus_fx${pad(((i - 1) % 130) + 1)}`,
      description: `Subscription payment ${i}`,
      disputed: i % 50 === 0,
      failure_code: i % 13 === 0 ? "card_declined" : null,
      failure_message: i % 13 === 0 ? "Your card was declined." : null,
      fraud_details: {},
      invoice: `in_fx${pad(((i - 1) % 40) + 1)}`,
      outcome: {
        network_status: "approved_by_network",
        reason: null,
        risk_level: "normal",
        seller_message: "Payment complete.",
        type: "authorized",
      },
      paid: i % 13 !== 0,
      payment_intent: `pi_fx${pad(((i - 1) % 100) + 1)}`,
      payment_method: `pm_fx${pad(i)}`,
      payment_method_details: {
        card: { brand: "visa", country: "CH", last4: "4242" },
        type: "card",
      },
      receipt_email: null,
      receipt_number: null,
      receipt_url: `https://pay.stripe.test/receipts/ch_fx${pad(i)}`,
      refunded,
      refunds: {
        object: "list",
        data: [],
        has_more: false,
        total_count: 0,
        url: `/v1/charges/ch_fx${pad(i)}/refunds`,
      },
      shipping: null,
      statement_descriptor: null,
      status: i % 13 === 0 ? "failed" : "succeeded",
      // Undeclared in the schema: lands through the unknown-field policy.
      application_fee_amount: null,
    };
  });

  const disputes = series(7, 3, (i, r, created) => ({
    ...common("dispute", `dp_fx${pad(i)}`, created, r),
    amount: 5900,
    balance_transaction: `txn_fxd${pad(i)}`,
    balance_transactions: [],
    charge: `ch_fx${pad(i * 10)}`,
    currency: "eur",
    evidence: { customer_name: null, product_description: null },
    evidence_details: {
      due_by: created + 7 * 86400,
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    },
    is_charge_refundable: false,
    network_reason_code: "4837",
    payment_intent: `pi_fx${pad(i * 30)}`,
    reason: "fraudulent",
    status: pick(r, ["needs_response", "won", "lost"]),
  }));

  // One invoice holds 13 lines, more than a payload embeds.
  const invoiceLinesOf = (i, total, created) =>
    i === 5
      ? Array.from({ length: 13 }, (_, k) =>
          invoiceLine(pad(i), k + 1, 1000 + k * 100, created),
        )
      : [invoiceLine(pad(i), 1, total, created)];
  const invoices = series(8, 40, (i, r, created) => {
    const total = amount(r);
    const paid = i % 9 !== 0;
    return {
      ...common("invoice", `in_fx${pad(i)}`, created, r),
      amount_due: total,
      amount_paid: paid ? total : 0,
      amount_remaining: paid ? 0 : total,
      attempt_count: 1,
      attempted: true,
      auto_advance: false,
      automatic_tax: { enabled: false, liability: null, status: null },
      billing_reason:
        i % 4 === 0 ? "subscription_create" : "subscription_cycle",
      charge: `ch_fx${pad(i)}`,
      collection_method: "charge_automatically",
      currency: "eur",
      customer: `cus_fx${pad(i)}`,
      customer_address: null,
      customer_email: `customer${i}@example.test`,
      customer_name: `Fixture Customer ${i}`,
      customer_shipping: null,
      discount: null,
      discounts: [],
      due_date: null,
      ending_balance: 0,
      from_invoice: null,
      hosted_invoice_url: `https://invoice.stripe.test/i/in_fx${pad(i)}`,
      invoice_pdf: `https://pay.stripe.test/invoice/in_fx${pad(i)}/pdf`,
      issuer: { type: "self" },
      lines: embedded(
        invoiceLinesOf(i, total, created),
        `/v1/invoices/in_fx${pad(i)}/lines`,
      ),
      number: `FX${pad(i)}-0001`,
      paid,
      paid_out_of_band: i % 17 === 0,
      payment_intent: `pi_fx${pad(i)}`,
      payment_settings: {
        default_mandate: null,
        payment_method_options: null,
        payment_method_types: null,
      },
      period_end: created,
      period_start: created - 30 * 86400,
      starting_balance: 0,
      status: paid ? "paid" : "open",
      status_transitions: {
        finalized_at: created,
        marked_uncollectible_at: null,
        paid_at: paid ? created + 60 : null,
        voided_at: null,
      },
      subscription: `sub_fx${pad(i)}`,
      subtotal: total,
      subtotal_excluding_tax: total,
      tax: null,
      total,
      total_excluding_tax: total,
      total_tax_amounts: [],
      transfer_data: null,
    };
  });

  const paymentIntents = series(9, 100, (i, r, created) => {
    const value = amount(r);
    return {
      ...common("payment_intent", `pi_fx${pad(i)}`, created, r),
      amount: value,
      amount_capturable: 0,
      amount_details: { tip: {} },
      amount_received: value,
      automatic_payment_methods: null,
      canceled_at: null,
      cancellation_reason: null,
      capture_method: "automatic",
      client_secret: `pi_fx${pad(i)}_secret_redacted`,
      confirmation_method: "automatic",
      currency: "eur",
      customer: `cus_fx${pad(i)}`,
      description: null,
      invoice: `in_fx${pad(i)}`,
      last_payment_error: null,
      latest_charge: `ch_fx${pad(i)}`,
      next_action: null,
      payment_method: `pm_fx${pad(i)}`,
      payment_method_options: { card: { request_three_d_secure: "automatic" } },
      payment_method_types: ["card"],
      receipt_email: null,
      setup_future_usage: "off_session",
      shipping: null,
      statement_descriptor: null,
      status: "succeeded",
    };
  });

  const balanceTransaction = (id, i, r, created, extra = {}) => {
    const value = amount(r);
    const fee = Math.round(value * 0.029) + 30;
    return {
      ...common("balance_transaction", id, created, r),
      metadata: undefined,
      amount: value,
      available_on: created + 2 * 86400,
      balance_type: "payments",
      currency: "eur",
      description: `Payment ${i}`,
      exchange_rate: i % 5 === 0 ? 1.0834 : null,
      fee,
      fee_details: [
        {
          amount: fee,
          application: null,
          currency: "eur",
          description: "Stripe processing fees",
          type: "stripe_fee",
        },
      ],
      net: value - fee,
      reporting_category: "charge",
      source: `ch_fx${pad(((i - 1) % 30) + 1)}`,
      status: "available",
      type: "charge",
      ...extra,
    };
  };
  const strip = object => {
    // Balance transactions carry no metadata in Stripe's API.
    const { metadata: _metadata, ...rest } = object;
    return rest;
  };

  const balanceTransactions = series(10, 40, (i, r, created) =>
    strip(balanceTransaction(`txn_fx${pad(i)}`, i, r, created)),
  );

  const payouts = series(11, 110, (i, r, created) => ({
    ...common("payout", `po_fx${pad(i)}`, created, r),
    amount: amount(r) * 10,
    arrival_date: created + 2 * 86400,
    automatic: true,
    balance_transaction: `txn_fxpo${pad(i)}`,
    currency: "eur",
    description: "STRIPE PAYOUT",
    destination: "ba_fx0001",
    failure_balance_transaction: null,
    failure_code: null,
    failure_message: null,
    method: "standard",
    original_payout: null,
    reconciliation_status: "completed",
    reversed_by: null,
    source_type: "card",
    statement_descriptor: null,
    status: "paid",
    type: "bank_account",
  }));

  // Transactions per payout: 0 to 2, and 101 on payout 3 (two child pages).
  const payoutTransactions = new Map();
  payouts.forEach((payout, index) => {
    const i = index + 1;
    const r = rng(1000 + i);
    const count = i === 3 ? 101 : i % 3;
    const list = [];
    for (let k = 1; k <= count; k++) {
      list.push(
        strip(
          balanceTransaction(
            `txn_fxp${pad(i)}_${pad(k)}`,
            k,
            r,
            payout.created - k * 600,
          ),
        ),
      );
    }
    payoutTransactions.set(payout.id, list);
  });

  // Customer balance transactions: every 7th customer has 1 or 2, and
  // customer 7 has 101 (two child pages).
  const customerBalance = new Map();
  customers.forEach((customer, index) => {
    const i = index + 1;
    const r = rng(2000 + i);
    const count = i === 7 ? 101 : i % 7 === 0 ? 1 + (i % 2) : 0;
    const list = [];
    for (let k = 1; k <= count; k++) {
      list.push({
        id: `cbtxn_fx${pad(i)}_${pad(k)}`,
        object: "customer_balance_transaction",
        amount: -500 * k,
        created: customer.created + k * 86400,
        credit_note: k % 3 === 0 ? `cn_fx${pad(k)}` : null,
        currency: "eur",
        customer: customer.id,
        description: "Credit",
        ending_balance: -500 * k,
        invoice: null,
        livemode: false,
        metadata: {},
        type: k % 3 === 0 ? "credit_note" : "adjustment",
      });
    }
    customerBalance.set(customer.id, list);
  });

  // Payment methods: every 3rd customer has a card, every 5th a SEPA
  // mandate too, and customer 9 has 101 cards (two child pages).
  const paymentMethods = new Map();
  customers.forEach((customer, index) => {
    const i = index + 1;
    const cards = i === 9 ? 101 : i % 3 === 0 ? 1 : 0;
    const list = [];
    const base = {
      object: "payment_method",
      livemode: false,
      metadata: {},
      customer: customer.id,
      billing_details: {
        address: customer.address,
        email: customer.email,
        name: customer.name,
        phone: null,
      },
    };
    for (let k = 1; k <= cards; k++) {
      list.push({
        ...base,
        id: `pm_fx${pad(i)}_${pad(k)}`,
        created: customer.created + k * 3600,
        type: "card",
        card: {
          brand: k % 2 ? "visa" : "mastercard",
          checks: {
            address_line1_check: null,
            address_postal_code_check: null,
            cvc_check: "pass",
          },
          country: "CH",
          exp_month: 1 + (k % 12),
          exp_year: 2028,
          fingerprint: `fpfx${pad(i)}${pad(k)}`,
          funding: "credit",
          generated_from: null,
          last4: String(4000 + k).slice(-4),
          networks: { available: ["visa"], preferred: null },
          three_d_secure_usage: { supported: true },
          wallet: null,
        },
      });
    }
    if (i % 5 === 0) {
      list.push({
        ...base,
        id: `pm_fx${pad(i)}_sepa`,
        created: customer.created + 7200,
        type: "sepa_debit",
        sepa_debit: {
          bank_code: "37040044",
          branch_code: null,
          country: "DE",
          fingerprint: `fpfx${pad(i)}sepa`,
          generated_from: { charge: null, setup_attempt: null },
          last4: "3000",
        },
      });
    }
    // Newest first, as Stripe lists them.
    list.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    paymentMethods.set(customer.id, list);
  });

  const refunds = series(12, 14, (i, r, created) => ({
    ...common("refund", `re_fx${pad(i)}`, created, r),
    amount: 5900,
    balance_transaction: `txn_fxre${pad(i)}`,
    charge: `ch_fx${pad(i * 11)}`,
    currency: "eur",
    description: null,
    destination_details: {
      card: { reference_status: "available", type: "refund" },
      type: "card",
    },
    failure_balance_transaction: null,
    failure_reason: null,
    payment_intent: `pi_fx${pad(i * 7)}`,
    reason: "requested_by_customer",
    receipt_number: null,
    status: "succeeded",
  }));

  const creditNotes = series(13, 8, (i, r, created) => ({
    ...common("credit_note", `cn_fx${pad(i)}`, created, r),
    amount: 2500,
    amount_shipping: 0,
    currency: "eur",
    customer: `cus_fx${pad(i * 7)}`,
    customer_balance_transaction:
      i % 3 === 0 ? `cbtxn_fx${pad(i * 7)}_0001` : null,
    discount_amount: 0,
    discount_amounts: [],
    effective_at: created,
    invoice: `in_fx${pad(i)}`,
    lines: {
      object: "list",
      data: [],
      has_more: false,
      url: `/v1/credit_notes/cn_fx${pad(i)}/lines`,
    },
    memo: null,
    number: `FX${pad(i)}-CN-01`,
    out_of_band_amount: null,
    pdf: `https://pay.stripe.test/credit_notes/cn_fx${pad(i)}/pdf`,
    reason: "order_change",
    refund: null,
    status: i === 8 ? "void" : "issued",
    subtotal: 2500,
    subtotal_excluding_tax: 2500,
    tax_amounts: [],
    total: 2500,
    total_excluding_tax: 2500,
    type: "pre_payment",
    voided_at: i === 8 ? created + 86400 : null,
  }));

  const invoiceItems = series(14, 12, (i, r, created) => ({
    ...common("invoiceitem", `ii_fx${pad(i)}`, created, r),
    amount: 1500,
    currency: "eur",
    customer: `cus_fx${pad(i)}`,
    date: created,
    description: "One-off setup",
    discountable: true,
    discounts: [],
    invoice: `in_fx${pad(i)}`,
    period: { end: created, start: created },
    plan: null,
    price: { id: `price_fx${pad(1)}`, object: "price" },
    proration: i % 4 === 0,
    quantity: 1,
    subscription: null,
    subscription_item: null,
    tax_rates: [],
    test_clock: null,
    unit_amount: 1500,
    unit_amount_decimal: "1500",
  }));

  const subscriptionSchedules = series(15, 5, (i, r, created) => ({
    ...common("subscription_schedule", `sub_sched_fx${pad(i)}`, created, r),
    canceled_at: null,
    completed_at: i === 5 ? created + 60 * 86400 : null,
    current_phase: { end_date: created + 30 * 86400, start_date: created },
    customer: `cus_fx${pad(i)}`,
    default_settings: {
      billing_cycle_anchor: "automatic",
      collection_method: "charge_automatically",
    },
    end_behavior: "release",
    phases: [
      {
        start_date: created,
        end_date: created + 30 * 86400,
        items: [{ price: `price_fx${pad(i)}`, quantity: 1 }],
      },
    ],
    released_at: null,
    released_subscription: null,
    status: i === 5 ? "completed" : "active",
    subscription: `sub_fx${pad(i)}`,
    test_clock: null,
  }));

  const coupons = series(16, 4, (i, r, created) => ({
    ...common("coupon", `FIXTURE${i}`, created, r),
    amount_off: i % 2 === 0 ? 1000 : null,
    currency: i % 2 === 0 ? "eur" : null,
    duration: "repeating",
    duration_in_months: 3,
    max_redemptions: null,
    name: `Fixture ${i}`,
    // A JSON Schema "number" that happens to be whole on most coupons.
    percent_off: i % 2 === 0 ? null : i === 1 ? 12.5 : 25,
    redeem_by: null,
    times_redeemed: i * 3,
    valid: true,
  }));

  const promotionCodes = series(17, 3, (i, r, created) => ({
    ...common("promotion_code", `promo_fx${pad(i)}`, created, r),
    active: true,
    code: `WELCOME${i}`,
    coupon: { id: `FIXTURE${i}`, object: "coupon", percent_off: 25 },
    customer: null,
    expires_at: null,
    max_redemptions: null,
    restrictions: {
      first_time_transaction: true,
      minimum_amount: null,
      minimum_amount_currency: null,
    },
    times_redeemed: i,
  }));

  const checkoutSessions = series(18, 7, (i, r, created) => ({
    ...common("checkout.session", `cs_test_fx${pad(i)}`, created, r),
    amount_subtotal: 5900,
    amount_total: 5900,
    client_reference_id: null,
    currency: "eur",
    customer: i % 2 ? `cus_fx${pad(i)}` : null,
    customer_details: { email: `customer${i}@example.test`, name: null },
    customer_email: null,
    expires_at: created + 86400,
    invoice: null,
    mode: "subscription",
    payment_intent: null,
    payment_link: null,
    payment_status: i % 3 === 0 ? "unpaid" : "paid",
    status: i % 3 === 0 ? "expired" : "complete",
    subscription: i % 3 === 0 ? null : `sub_fx${pad(i)}`,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    url: null,
  }));

  const setupIntents = [];

  const earlyFraudWarnings = series(19, 2, (i, r, created) => {
    const { metadata: _metadata, ...rest } = common(
      "radar.early_fraud_warning",
      `issfr_fx${pad(i)}`,
      created,
      r,
    );
    return {
      ...rest,
      actionable: i === 1,
      charge: `ch_fx${pad(i * 50)}`,
      fraud_type: "made_with_stolen_card",
      payment_intent: `pi_fx${pad(i * 50)}`,
    };
  });

  // The event log: 120 events, more than one page. Stripe keeps 30 days.
  const EVENT_TYPES = ["invoice.paid", "customer.updated", "charge.succeeded"];
  const events = series(20, 120, (i, r, created) => {
    const { metadata: _metadata, ...rest } = common(
      "event",
      `evt_fx${pad(i)}`,
      created,
      r,
    );
    return {
      ...rest,
      api_version: "2023-10-16",
      data: {
        object: { id: `obj_fx${pad(i)}`, object: "fixture" },
        ...(i % 2 === 0 && { previous_attributes: { status: "open" } }),
      },
      pending_webhooks: i % 3,
      request: {
        id: i % 4 === 0 ? `req_fx${pad(i)}` : null,
        idempotency_key: null,
      },
      type: EVENT_TYPES[i % EVENT_TYPES.length],
    };
  });

  return {
    account: {
      id: "acct_fixture",
      object: "account",
      business_type: "company",
      charges_enabled: true,
      country: "CH",
      default_currency: "chf",
      details_submitted: true,
      email: null,
      payouts_enabled: true,
      type: "standard",
    },
    lists: {
      customers,
      subscriptions,
      charges,
      disputes,
      invoices,
      products,
      plans,
      prices,
      payment_intents: paymentIntents,
      balance_transactions: balanceTransactions,
      payouts,
      refunds,
      credit_notes: creditNotes,
      invoiceitems: invoiceItems,
      subscription_schedules: subscriptionSchedules,
      coupons,
      promotion_codes: promotionCodes,
      "checkout/sessions": checkoutSessions,
      setup_intents: setupIntents,
      "radar/early_fraud_warnings": earlyFraudWarnings,
      events,
    },
    invoiceLines: new Map(
      invoices.map((invoice, k) => [
        invoice.id,
        invoiceLinesOf(k + 1, invoice.total, invoice.created),
      ]),
    ),
    subscriptionItems: new Map(
      subscriptions.map((sub, k) => [
        sub.id,
        subscriptionItemsOf(k + 1, sub.created),
      ]),
    ),
    payoutTransactions,
    customerBalance,
    paymentMethods,
  };
}
