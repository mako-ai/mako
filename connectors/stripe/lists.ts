/**
 * Stripe list pages, one entry per entity. A port of
 * `api/src/connectors/stripe/lists.ts`: the same calls, the same parameters,
 * the same nested walks. The parity harness checks the two send identical
 * requests.
 *
 * Every top-level list takes `limit`, `starting_after` and `created[gte]` (for
 * incremental reads). The nested entities page over their parent list.
 */
import type Stripe from "stripe";

/** Stripe caps `autoPagingToArray` at 10,000 items. A single payout or customer
 * never comes close (a payout groups a few days of transactions). */
const CHILD_LIST_MAX = 10_000;

/** Customers per page for payment_methods: one extra call per customer. */
export const PAYMENT_METHOD_PARENT_PAGE = 25;
const CHECKOUT_SESSION_PARENT_PAGE = 25;

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

const TOP_LEVEL_LISTERS: Record<string, Lister> = {
  customers: (s, p) => s.customers.list(p),
  // Stripe defaults to excluding canceled/incomplete_expired subs; without
  // `status: "all"` the backfill silently drops all churned subscriptions.
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
  // Stripe keeps events for 30 days: a backfill reaches 30 days back.
  events: (s, p) => s.events.list(p),
};

/**
 * Entities that live inside a parent object: an invoice's `lines` and a
 * subscription's `items`. A list page of the parent embeds the first 10;
 * a longer list is read from the child endpoint. Webhooks on the parent
 * carry the same embedded list, so both paths share `childRowsOf`.
 */
export const EMBEDDED_CHILD_PARENTS = {
  invoice_line_items: "invoices",
  subscription_items: "subscriptions",
} as const;

export type EmbeddedChildEntity = keyof typeof EMBEDDED_CHILD_PARENTS;

export const isEmbeddedChild = (
  entity: string,
): entity is EmbeddedChildEntity =>
  Object.prototype.hasOwnProperty.call(EMBEDDED_CHILD_PARENTS, entity);

/** Where the parent embeds the child list. */
export const EMBEDDED_CHILD_KEY: Record<EmbeddedChildEntity, string> = {
  invoice_line_items: "lines",
  subscription_items: "items",
};

type StripeRow = Record<string, unknown> & { id?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The embedded list under `key`, or null when the parent has none. */
function embeddedList(
  parent: StripeRow,
  key: string,
): { data: StripeRow[]; has_more: boolean } | null {
  const list = parent[key];
  if (!isRecord(list) || !Array.isArray(list.data)) return null;
  return {
    data: list.data.filter(isRecord) as StripeRow[],
    has_more: list.has_more === true,
  };
}

/** Whether the parent's embedded list is cut short, so reading it costs a call. */
export function childListIsPartial(
  entity: EmbeddedChildEntity,
  parent: StripeRow,
): boolean {
  return embeddedList(parent, EMBEDDED_CHILD_KEY[entity])?.has_more === true;
}

/**
 * The child rows of one parent object, every one of them: the embedded list
 * when it is whole, else the child endpoint's full list.
 * - invoice_line_items: a line carries no invoice id or time at API version
 *   2023-10-16, so `invoice`, `invoice_id` (the Airbyte column) and
 *   `invoice_created` come from the invoice.
 * - subscription_items: an item carries its `subscription`. Its billing
 *   period lives on the subscription at this API version, so
 *   `current_period_start` and `current_period_end` come from there, as the
 *   Airbyte stream had them on every item.
 * Null when the parent embeds no list (a deleted or thin object). With
 * `fetchMore: false` only the embedded rows come back, with no request.
 */
export async function childRowsOf(
  stripe: Stripe,
  entity: EmbeddedChildEntity,
  parent: StripeRow,
  { fetchMore = true }: { fetchMore?: boolean } = {},
): Promise<StripeRow[] | null> {
  const parentId = typeof parent.id === "string" ? parent.id : undefined;
  if (!parentId) return null;
  const list = embeddedList(parent, EMBEDDED_CHILD_KEY[entity]);
  if (!list) return null;
  const readAll = list.has_more && fetchMore;
  if (entity === "invoice_line_items") {
    const lines = readAll
      ? ((await stripe.invoices
          .listLineItems(parentId, { limit: 100 })
          .autoPagingToArray({
            limit: CHILD_LIST_MAX,
          })) as unknown as StripeRow[])
      : list.data;
    return lines.map(line => ({
      ...line,
      invoice: parentId,
      invoice_id: parentId,
      invoice_created: parent.created ?? null,
    }));
  }
  const items = readAll
    ? ((await stripe.subscriptionItems
        .list({ subscription: parentId, limit: 100 })
        .autoPagingToArray({
          limit: CHILD_LIST_MAX,
        })) as unknown as StripeRow[])
    : list.data;
  return items.map(item => ({
    ...item,
    subscription: item.subscription ?? parentId,
    current_period_start:
      item.current_period_start ?? parent.current_period_start ?? null,
    current_period_end:
      item.current_period_end ?? parent.current_period_end ?? null,
  }));
}

export const NESTED_ENTITIES = [
  "payout_balance_transactions",
  "customer_balance_transactions",
  "payment_methods",
] as const;

type NestedEntity = (typeof NESTED_ENTITIES)[number];

const isNested = (entity: string): entity is NestedEntity =>
  (NESTED_ENTITIES as readonly string[]).includes(entity);

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
  if (isNested(entity)) return fetchNestedPage(stripe, entity, request);
  if (isEmbeddedChild(entity))
    return fetchChildPage(
      stripe,
      EMBEDDED_CHILD_PARENTS[entity],
      request,
      parent => childRowsOf(stripe, entity, parent),
    );
  if (entity === "checkout_sessions_line_items")
    return fetchChildPage(
      stripe,
      "checkout_sessions",
      {
        ...request,
        limit: Math.min(request.limit, CHECKOUT_SESSION_PARENT_PAGE),
      },
      parent => checkoutLineItems(stripe, parent),
    );
  const lister = TOP_LEVEL_LISTERS[entity];
  if (!lister) throw new Error(`Unsupported entity: ${entity}`);
  return lister(stripe, listParams(request));
}

/**
 * One page of a nested entity. Stripe has no account-wide list for these:
 * - payout_balance_transactions: page over payouts and inject `payout`, the
 *   only place the payout id exists. Filtering payouts by `created` is
 *   complete, because a payout is created after every transaction it pays.
 * - customer_balance_transactions: listed per customer. Old customers keep
 *   receiving credit, so `since` cannot bound the walk and is ignored.
 * - payment_methods: listed per customer. `GET /v1/payment_methods` without
 *   a customer returns Treasury methods only. `since` bounds the customer
 *   walk by the customer's `created`: a backfill walks every customer, a
 *   scheduled sync only the new ones. A card attached to an older customer
 *   arrives by `payment_method.attached` instead. Only attached methods come
 *   back: a detached one keeps its last row, updated by its webhook.
 *   A parent page holds at most PAYMENT_METHOD_PARENT_PAGE customers, so a
 *   10-page chunk makes at most 250 calls and ends well inside the box's
 *   10-minute command limit. Every page ends in a cursor, so a long walk
 *   resumes across chunks and runs.
 * Returns the parent cursor as `nextCursor`.
 */
async function fetchNestedPage(
  stripe: Stripe,
  entity: NestedEntity,
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

  const paymentMethods = entity === "payment_methods";
  const customers = await stripe.customers.list(
    paymentMethods
      ? listParams({
          ...options,
          limit: Math.min(options.limit, PAYMENT_METHOD_PARENT_PAGE),
        })
      : {
          limit: options.limit,
          ...(options.startingAfter && {
            starting_after: options.startingAfter,
          }),
        },
  );
  for (const customer of customers.data) {
    const children = paymentMethods
      ? await stripe.customers
          .listPaymentMethods(customer.id, { limit: 100 })
          .autoPagingToArray({ limit: CHILD_LIST_MAX })
      : await stripe.customers
          .listBalanceTransactions(customer.id, { limit: 100 })
          .autoPagingToArray({ limit: CHILD_LIST_MAX });
    records.push(...children);
  }
  return {
    data: records,
    has_more: customers.has_more,
    nextCursor: customers.data[customers.data.length - 1]?.id,
  };
}

/**
 * Read every child of each parent on one parent page. The parent cursor
 * advances only after all its child pages have been read.
 */
async function fetchChildPage(
  stripe: Stripe,
  parentEntity: string,
  options: StripePageRequest,
  childrenOf: (parent: StripeRow) => Promise<StripeRow[] | null>,
): Promise<StripePage> {
  const parents = await listStripePage(stripe, parentEntity, options);
  const records: StripePage["data"] = [];
  for (const parent of parents.data as StripeRow[]) {
    records.push(...((await childrenOf(parent)) ?? []));
  }
  return {
    data: records,
    has_more: parents.has_more,
    nextCursor: parents.data[parents.data.length - 1]?.id,
  };
}

async function checkoutLineItems(
  stripe: Stripe,
  session: StripeRow,
): Promise<StripeRow[]> {
  const { id, created, expires_at } = session;
  if (!id || typeof created !== "number" || !Number.isInteger(created))
    throw new Error(
      "Stripe Checkout Session is missing its id or creation date",
    );
  const records: StripeRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await stripe.checkout.sessions.listLineItems(id, {
      limit: 100,
      expand: ["data.discounts", "data.taxes"],
      ...(cursor && { starting_after: cursor }),
    });
    for (const item of page.data) {
      if (!item.id || seen.has(item.id))
        throw new Error(
          "Stripe Checkout line-item pagination returned a missing or repeated id",
        );
      seen.add(item.id);
      records.push({
        ...item,
        checkout_session_id: id,
        checkout_session_created: created,
        checkout_session_expires_at: expires_at ?? null,
      });
    }
    if (!page.has_more) return records;
    cursor = page.data.at(-1)?.id;
    if (!cursor)
      throw new Error("Stripe Checkout line-item pagination did not advance");
  }
}
