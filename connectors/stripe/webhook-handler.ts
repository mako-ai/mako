/**
 * Stripe webhooks as the SDK's `webhooks` definition: how Mako verifies a
 * delivery (as data), and the batch handler a box runs.
 *
 * Mako's API verifies every delivery with the flow's signing secret before
 * it stores it. The secret never reaches a box, so this file holds no
 * verification code. `STRIPE_WEBHOOK_VERIFICATION` declares Stripe's scheme
 * instead, and the API test runs it against `stripe.webhooks.constructEvent`
 * on the same deliveries.
 *
 * Mapping is the in-process connector's (`webhooks.ts` here, parity-tested):
 * the record is `event.data.object`, its id the object's id, its change id
 * the event id, its time the object's `created`.
 *
 * A record is never answered partial, because a missing column is written
 * as NULL:
 * - A Stripe snapshot event carries the whole object, as a list row has it.
 *   It passes through untouched, with no request.
 * - An upsert that lacks a column a list row always has
 *   (`STRIPE_WEBHOOK_FILL_FIELDS`), or a thin event that only names its
 *   object (`related_object`), gets one GET of that object. The fetched
 *   object is the row, over the event's keys. It is at least as new as the
 *   event, so a fill that runs late (deferred, retried) never writes stale
 *   values over a newer event's row. A Stripe row's time is its `created`,
 *   which never moves, so the last write wins. A column the object omits
 *   too is NULL, as a backfill stores it.
 * - 404 (deleted since): the record is dropped and the event `skipped`.
 *   Its delete event follows.
 * - Fill budget spent, 429, 5xx or no answer: the event is `deferred`.
 *   Mako refunds the attempt, up to its 5 deferrals, so a Stripe incident
 *   does not use up the event's retries.
 * - Any other 4xx: `extract_failed`, retried up to Mako's 5 attempts.
 */
import Stripe from "stripe";
import { completeRefund } from "./refunds.ts";
import type {
  Context,
  WebhookChangeRecord,
  WebhookDefinition,
  WebhookEvent,
  WebhookOutcome,
  WebhookVerification,
} from "@makoai/connector-sdk";
import {
  PAYMENT_METHOD_TYPE_FIELDS,
  STRIPE_ENTITY_SCHEMA_MAP,
} from "./schema.ts";
import {
  CHECKOUT_LINE_ITEM_ENTITY,
  CHILD_PARENTS,
  childNeedsRequest,
  childRowsOf,
  type ChildEntity,
} from "./lists.ts";
import {
  stripeRecordTimestamp,
  stripeSupportedWebhookEvents,
  stripeWebhookEventMapping,
} from "./webhooks.ts";

/**
 * `stripe.webhooks.constructEvent` as data: `Stripe-Signature` carries
 * `t=<seconds>` and `v1=<hex>`, an HMAC-SHA256 of `<t>.<raw body>` under the
 * `whsec_...` secret's bytes. The timestamp is signed; 300 s is Stripe's own
 * default tolerance.
 */
export const STRIPE_WEBHOOK_VERIFICATION: WebhookVerification = {
  scheme: "stripe-v1",
  signatureHeader: "stripe-signature",
  secretEncoding: "utf8",
  toleranceSeconds: 300,
};

/**
 * Columns of the schema that Stripe returns only when asked to `expand`
 * them, at API version 2023-10-16. Neither a list row nor a webhook payload
 * has them, so their absence never makes a payload partial.
 * `charges.refunds` and `payment_intents.charges` left their objects in
 * 2022-11-15. Balance
 * transactions and early fraud warnings have no `metadata`.
 */
export const STRIPE_NOT_RETURNED: Readonly<Record<string, readonly string[]>> =
  {
    customers: ["sources", "subscriptions", "tax_ids"],
    plans: ["tiers"],
    prices: ["tiers", "currency_options"],
    coupons: ["applies_to", "currency_options"],
    charges: ["refunds"],
    payment_intents: ["charges"],
    early_fraud_warnings: ["metadata"],
    // A line has no `created`; a subscription item has no `livemode`.
    invoice_line_items: ["created"],
    subscription_items: ["livemode"],
    events: ["metadata"],
    // A payment method holds only its own type's key. `allow_redisplay` and
    // `radar_options` are newer than the pinned API version.
    payment_methods: [
      ...PAYMENT_METHOD_TYPE_FIELDS,
      "allow_redisplay",
      "radar_options",
    ],
  };

/** How to GET one object of each entity that has webhook events. */
const RETRIEVE: Readonly<
  Record<string, (stripe: Stripe, id: string) => Promise<unknown>>
> = {
  customers: (s, id) => s.customers.retrieve(id),
  subscriptions: (s, id) => s.subscriptions.retrieve(id),
  charges: (s, id) => s.charges.retrieve(id),
  disputes: (s, id) => s.disputes.retrieve(id),
  payment_intents: (s, id) => s.paymentIntents.retrieve(id),
  invoices: (s, id) => s.invoices.retrieve(id),
  products: (s, id) => s.products.retrieve(id),
  prices: (s, id) => s.prices.retrieve(id),
  plans: (s, id) => s.plans.retrieve(id),
  payouts: (s, id) => s.payouts.retrieve(id),
  refunds: (s, id) => s.refunds.retrieve(id),
  credit_notes: (s, id) => s.creditNotes.retrieve(id),
  invoice_items: (s, id) => s.invoiceItems.retrieve(id),
  subscription_schedules: (s, id) => s.subscriptionSchedules.retrieve(id),
  coupons: (s, id) => s.coupons.retrieve(id),
  promotion_codes: (s, id) => s.promotionCodes.retrieve(id),
  checkout_sessions: (s, id) => s.checkout.sessions.retrieve(id),
  setup_intents: (s, id) => s.setupIntents.retrieve(id),
  early_fraud_warnings: (s, id) => s.radar.earlyFraudWarnings.retrieve(id),
  payment_methods: (s, id) => s.paymentMethods.retrieve(id),
};

/**
 * Per entity with events, the columns a whole object always carries: the
 * schema's columns less the ones Stripe never returns unexpanded.
 */
export const STRIPE_WEBHOOK_FILL_FIELDS: Readonly<
  Record<string, readonly string[]>
> = Object.fromEntries(
  Object.keys(RETRIEVE).map(entity => {
    const skip = new Set(STRIPE_NOT_RETURNED[entity] ?? []);
    // Stripe omits the reason on a complete refund once it is no longer pending.
    if (entity === "refunds") skip.add("pending_reason");
    return [
      entity,
      Object.keys(STRIPE_ENTITY_SCHEMA_MAP[entity]).filter(f => !skip.has(f)),
    ];
  }),
);

/**
 * Read time one batch may spend on fills. Mako ends a batch's box command at
 * 60 s; past this the remaining events are `deferred`.
 */
export const STRIPE_WEBHOOK_FILL_BUDGET_MS = 40_000;

/**
 * One fill GET's deadline, with no network retry. A GET started just inside
 * the budget still ends by 50 s, under the 60 s batch limit.
 */
export const STRIPE_WEBHOOK_FILL_TIMEOUT_MS = 10_000;

/**
 * An object id that may go into a request path. Stripe's own ids are
 * `<prefix>_<alphanumerics>`; coupons and plans may carry a merchant's id,
 * so any printable id is let through, but never `.` or `..` (the SDK
 * percent-encodes the rest).
 */
const SAFE_ID = /^[\x21-\x7e]{1,255}$/;
const safeId = (id: string) => SAFE_ID.test(id) && id !== "." && id !== "..";

export interface StripeWebhookDeps {
  /**
   * A client on the connection's key, with STRIPE_WEBHOOK_FILL_TIMEOUT_MS
   * and no network retries.
   */
  stripe: () => Stripe;
  log: (message: string) => void;
  budgetMs?: number;
  now?: () => number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The event's record before any fill, exactly as the in-process
 * `extractWebhookCdcRecords` builds it; null when it builds none. A thin
 * event (no `data.object`, a `related_object` id) gives an id-only payload
 * marked `thin`, so the fill reads the whole object.
 */
export function stripeChangeRecord(
  event: WebhookEvent,
): { record: WebhookChangeRecord; thin: boolean } | "unmapped" | null {
  const raw = isObject(event.rawPayload) ? event.rawPayload : {};
  const eventType =
    event.eventType || (typeof raw.type === "string" ? raw.type : "");
  const mapping = stripeWebhookEventMapping(eventType);
  if (!mapping) return "unmapped";

  const data = isObject(raw.data) ? raw.data : null;
  const object = data && isObject(data.object) ? data.object : null;
  const related = isObject(raw.related_object) ? raw.related_object : null;
  const changeId =
    typeof raw.id === "string" && raw.id ? raw.id : event.eventId;

  if (object) {
    if (object.id === undefined || object.id === null || object.id === "") {
      return null;
    }
    const sourceTs = stripeRecordTimestamp(object);
    return {
      thin: false,
      record: {
        entity: mapping.entity,
        recordId: String(object.id),
        operation: mapping.operation,
        payload: object,
        ...(sourceTs ? { sourceTs } : {}),
        changeId,
      },
    };
  }
  if (related && typeof related.id === "string" && related.id) {
    return {
      thin: true,
      record: {
        entity: mapping.entity,
        recordId: related.id,
        operation: mapping.operation,
        payload: { id: related.id },
        changeId,
      },
    };
  }
  return null;
}

type Filled =
  | { kind: "record"; record: WebhookChangeRecord }
  | { kind: "gone" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

function isNotFound(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string } | null;
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

async function fillRecord(
  deps: StripeWebhookDeps,
  record: WebhookChangeRecord,
  thin: boolean,
  budgetSpent: () => boolean,
): Promise<Filled> {
  const fields = STRIPE_WEBHOOK_FILL_FIELDS[record.entity];
  const retrieve = RETRIEVE[record.entity];
  if (!fields || !retrieve) return { kind: "record", record };
  // A delete writes the row's tombstone, never its columns: no read.
  if (record.operation !== "upsert") return { kind: "record", record };
  const payload = record.payload;
  const refund = record.entity === "refunds";
  const missing = fields.some(field => !(field in payload));
  if (!thin && !missing) {
    return {
      kind: "record",
      record: refund ? { ...record, payload: completeRefund(payload) } : record,
    };
  }
  if (!safeId(record.recordId)) {
    return {
      kind: "failed",
      reason: `Not a Stripe id: ${JSON.stringify(record.recordId).slice(0, 80)}`,
    };
  }
  if (budgetSpent()) {
    return {
      kind: "deferred",
      reason: `Stripe fill budget for this batch is spent; ${record.entity} ${record.recordId} waits for a retry`,
    };
  }

  let fetched: unknown;
  try {
    fetched = await retrieve(deps.stripe(), record.recordId);
  } catch (error) {
    if (isNotFound(error)) {
      deps.log(
        `Stripe ${record.entity} ${record.recordId} is gone; skipping its upsert`,
      );
      return { kind: "gone" };
    }
    const status = (error as { statusCode?: number })?.statusCode;
    const reason = `Could not read Stripe ${record.entity} ${record.recordId}${
      status ? ` (HTTP ${status})` : ""
    }: ${error instanceof Error ? error.message : String(error)}`;
    // Stripe's side, or no answer: wait, without spending an attempt.
    const transient =
      typeof status !== "number" || status === 429 || status >= 500;
    return { kind: transient ? "deferred" : "failed", reason };
  }
  const object = isObject(fetched) ? fetched : {};
  // Stripe answers a deleted customer with `{ id, object, deleted: true }`.
  if (object.deleted === true) {
    deps.log(
      `Stripe ${record.entity} ${record.recordId} is deleted; skipping its upsert`,
    );
    return { kind: "gone" };
  }

  if (refund && object.id !== record.recordId) {
    return { kind: "failed", reason: "Stripe returned a different refund" };
  }
  // The current object wins. For a refund its omitted reason must clear
  // an older value carried in the event before the fields are merged.
  const current = refund ? completeRefund(object) : object;
  const filled: Record<string, unknown> = thin
    ? { ...current }
    : { ...payload, ...current };
  for (const field of fields) {
    if (!(field in filled))
      filled[field] = field in object ? object[field] : null;
  }
  filled.id = record.recordId;
  const sourceTs = record.sourceTs ?? stripeRecordTimestamp(filled);
  return {
    kind: "record",
    record: { ...record, payload: filled, ...(sourceTs ? { sourceTs } : {}) },
  };
}

type Children =
  | { kind: "records"; records: WebhookChangeRecord[] }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

function eventCreatedAt(
  event: WebhookEvent,
): { seconds: number; iso: string } | null {
  const seconds = isObject(event.rawPayload)
    ? event.rawPayload.created
    : undefined;
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > 253_402_300_799
  )
    return null;
  return { seconds, iso: new Date(seconds * 1000).toISOString() };
}

/**
 * A parent's children inherit its operation and change id. Invoices and
 * subscriptions keep their embedded-list behavior. Checkout lifecycle
 * events refresh their opted-in line items and carry the event's own time.
 * A failed read defers or fails the whole event, so a parent is never
 * written without all of its children.
 */
async function childRecords(
  deps: StripeWebhookDeps,
  parent: WebhookChangeRecord,
  event: WebhookEvent,
  enabled: (entity: string) => boolean,
  budgetSpent: () => boolean,
): Promise<Children> {
  const records: WebhookChangeRecord[] = [];
  for (const [child, parentEntity] of Object.entries(CHILD_PARENTS) as Array<
    [ChildEntity, string]
  >) {
    if (parent.entity !== parentEntity || !enabled(child)) continue;
    const fetchMore =
      parent.operation === "upsert" && childNeedsRequest(child, parent.payload);
    let checkoutTime: ReturnType<typeof eventCreatedAt> = null;
    if (child === CHECKOUT_LINE_ITEM_ENTITY && fetchMore) {
      checkoutTime = eventCreatedAt(event);
      if (!checkoutTime || !safeId(parent.recordId)) {
        return {
          kind: "failed",
          reason:
            "Stripe Checkout event is missing a valid event creation time or Session id",
        };
      }
    }
    if (fetchMore && budgetSpent()) {
      return {
        kind: "deferred",
        reason: `Stripe fill budget for this batch is spent; the ${child} of ${parent.recordId} wait for a retry`,
      };
    }
    let rows: Array<Record<string, unknown>> | null;
    try {
      rows = await childRowsOf(deps.stripe(), child, parent.payload, {
        fetchMore,
        budgetSpent,
      });
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      const reason = `Could not read the ${child} of Stripe ${parentEntity} ${parent.recordId}${
        status ? ` (HTTP ${status})` : ""
      }: ${error instanceof Error ? error.message : String(error)}`;
      const transient =
        typeof status !== "number" || status === 429 || status >= 500;
      return { kind: transient ? "deferred" : "failed", reason };
    }
    for (const row of rows ?? []) {
      if (typeof row.id !== "string" || !row.id) continue;
      const sourceTs = checkoutTime?.iso ?? stripeRecordTimestamp(row);
      records.push({
        entity: child,
        recordId: row.id,
        operation: parent.operation,
        payload: checkoutTime
          ? { ...row, checkout_session_updated: checkoutTime.seconds }
          : row,
        ...(sourceTs ? { sourceTs } : {}),
        changeId: `${parent.changeId || parent.recordId}:${child}:${row.id}`,
      });
    }
  }
  return { kind: "records", records };
}

/** A batch in, one outcome per event out, in order. */
export async function handleStripeWebhookBatch(
  deps: StripeWebhookDeps,
  events: WebhookEvent[],
  options: { enabledEntities?: string[] } = {},
): Promise<WebhookOutcome[]> {
  const enabledSet = options.enabledEntities
    ? new Set(options.enabledEntities)
    : null;
  const enabled = (entity: string) =>
    entity === CHECKOUT_LINE_ITEM_ENTITY
      ? enabledSet?.has(entity) === true
      : !enabledSet || enabledSet.has(entity);
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? STRIPE_WEBHOOK_FILL_BUDGET_MS;
  const startedAt = now();
  const budgetSpent = () => now() - startedAt >= budgetMs;

  const out: WebhookOutcome[] = [];
  for (const event of events) {
    const built = stripeChangeRecord(event);
    if (built === "unmapped") {
      out.push({ eventId: event.eventId, outcome: "unmapped" });
      continue;
    }
    if (!built) {
      out.push({
        eventId: event.eventId,
        outcome: "extract_failed",
        reason: "The Stripe event carries no object id",
      });
      continue;
    }
    const filled = await fillRecord(
      deps,
      built.record,
      built.thin,
      budgetSpent,
    );
    if (filled.kind === "record") {
      const children = await childRecords(
        deps,
        filled.record,
        event,
        enabled,
        budgetSpent,
      );
      if (children.kind === "records") {
        out.push({
          eventId: event.eventId,
          outcome: "records",
          records: [filled.record, ...children.records],
        });
      } else {
        out.push({
          eventId: event.eventId,
          outcome: children.kind === "deferred" ? "deferred" : "extract_failed",
          reason: children.reason,
        });
      }
    } else if (filled.kind === "gone") {
      out.push({
        eventId: event.eventId,
        outcome: "skipped",
        reason: `Stripe no longer has ${built.record.entity} ${built.record.recordId} (404)`,
      });
    } else if (filled.kind === "deferred") {
      out.push({
        eventId: event.eventId,
        outcome: "deferred",
        reason: filled.reason,
      });
    } else {
      out.push({
        eventId: event.eventId,
        outcome: "extract_failed",
        reason: filled.reason,
      });
    }
  }
  return out;
}

/** The SDK's `webhooks` definition, given how this process reaches Stripe. */
export function stripeWebhookDefinition<Config>(
  deps: (ctx: Context<Config>) => StripeWebhookDeps,
): WebhookDefinition<Config> {
  return {
    verification: STRIPE_WEBHOOK_VERIFICATION,
    events: stripeSupportedWebhookEvents(),
    handleBatch: (ctx, events, options) =>
      handleStripeWebhookBatch(deps(ctx), events, options ?? {}),
  };
}
