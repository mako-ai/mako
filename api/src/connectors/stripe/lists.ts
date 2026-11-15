/**
 * Stripe list pages, one table entry per entity. Every top-level list takes
 * the same parameters (`limit`, `starting_after`, `created[gte]` for
 * incremental polls); the two nested entities page over their parent list.
 */
import type Stripe from "stripe";

/** Stripe caps `autoPagingToArray` at 10,000 items. A single payout or customer
 * never comes close (a payout groups a few days of transactions). */
const CHILD_LIST_MAX = 10_000;

export interface StripePageRequest {
  limit: number;
  startingAfter?: string;
  since?: Date;
}

export interface StripePage {
  data: Array<{ id?: string }>;
  has_more: boolean;
  /** Nested entities resume from the last parent, not the last child. */
  nextCursor?: string;
}

type ListParams = {
  limit: number;
  starting_after?: string;
  created?: { gte: number };
};

type Lister = (stripe: Stripe, params: ListParams) => Promise<StripePage>;

// Each entry reads its resource off the client at call time, so a partial
// client (tests) only needs the resources it is asked for.
const TOP_LEVEL_LISTERS: Record<string, Lister> = {
  customers: (s, p) => s.customers.list(p),
  // Stripe defaults to excluding canceled/incomplete_expired subs; without
  // `status: "all"` the backfill silently drops all churned subscriptions,
  // corrupting churn/retention/historical-MRR.
  subscriptions: (s, p) => s.subscriptions.list({ ...p, status: "all" }),
  charges: (s, p) => s.charges.list(p),
  disputes: (s, p) => s.disputes.list(p),
  invoices: (s, p) => s.invoices.list(p),
  products: (s, p) => s.products.list(p),
  plans: (s, p) => s.plans.list(p),
  prices: (s, p) => s.prices.list(p),
  payment_intents: (s, p) => s.paymentIntents.list(p),
  balance_transactions: (s, p) => s.balanceTransactions.list(p),
  payouts: (s, p) => s.payouts.list(p),
  refunds: (s, p) => s.refunds.list(p),
  credit_notes: (s, p) => s.creditNotes.list(p),
  invoice_items: (s, p) => s.invoiceItems.list(p),
  subscription_schedules: (s, p) => s.subscriptionSchedules.list(p),
  coupons: (s, p) => s.coupons.list(p),
  promotion_codes: (s, p) => s.promotionCodes.list(p),
  checkout_sessions: (s, p) => s.checkout.sessions.list(p),
  setup_intents: (s, p) => s.setupIntents.list(p),
  early_fraud_warnings: (s, p) => s.radar.earlyFraudWarnings.list(p),
};

function listParams(request: StripePageRequest): ListParams {
  return {
    limit: request.limit,
    ...(request.startingAfter && { starting_after: request.startingAfter }),
    ...(request.since && {
      created: { gte: Math.floor(request.since.getTime() / 1000) },
    }),
  };
}

/** One page of `entity`; throws for an entity Stripe has no list for. */
export function listStripePage(
  stripe: Stripe,
  entity: string,
  request: StripePageRequest,
): Promise<StripePage> {
  if (
    entity === "payout_balance_transactions" ||
    entity === "customer_balance_transactions"
  ) {
    return fetchNestedPage(stripe, entity, request);
  }
  const lister = TOP_LEVEL_LISTERS[entity];
  if (!lister) {
    throw new Error(`Unsupported entity: ${entity}`);
  }
  return lister(stripe, listParams(request));
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
async function fetchNestedPage(
  stripe: Stripe,
  entity: "payout_balance_transactions" | "customer_balance_transactions",
  options: StripePageRequest,
): Promise<StripePage> {
  const records: StripePage["data"] = [];

  if (entity === "payout_balance_transactions") {
    const payouts = await stripe.payouts.list(listParams(options));
    for (const payout of payouts.data) {
      const transactions = await stripe.balanceTransactions
        .list({ payout: payout.id, limit: 100 })
        .autoPagingToArray({ limit: CHILD_LIST_MAX });
      for (const transaction of transactions) {
        const record = { ...transaction, payout: payout.id };
        records.push(record);
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
    records.push(...transactions);
  }
  return {
    data: records,
    has_more: customers.has_more,
    nextCursor: customers.data[customers.data.length - 1]?.id,
  };
}
