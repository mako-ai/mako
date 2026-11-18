/**
 * Wise webhooks as the SDK's `webhooks` definition: how Mako verifies and
 * identifies a delivery (as data), and the batch handler a box runs.
 *
 * Mako's API verifies every delivery before it stores it. Wise signs with
 * its own RSA keys (SHA256withRSA over the raw body, base64 in
 * `X-Signature-SHA256`), so the declaration carries Wise's two public keys,
 * production and sandbox; a delivery that either key verifies is valid, as
 * in-process. A test notification (`X-Test-Notification: true`, sent when a
 * subscription is created) is answered unsigned and stored under an event
 * type nothing maps, as in-process. The event id is `X-Delivery-Id`.
 *
 * The handler starts from `handleWebhookBatch` (the in-process mapping,
 * parity-tested), then fills what a Wise payload leaves out. A Wise event
 * carries a state change, not the object: a `transfers#state-change` upsert
 * has the transfer's id, profile, account and states and nothing else, and
 * the extraction sets the columns it lacks to null. Written as is, those
 * nulls overwrite the row (a key that is absent is left alone since PR
 * 1347; a null is not), and a new row lands with them NULL. RealAdvisor's
 * warehouse shows it: 5 of 5 webhook-written transfers have `targetValue`,
 * `sourceCurrency`, `created` and `user` NULL.
 *
 * - An upsert whose payload lacks, or has null for, any of its entity's
 *   REST columns (`WISE_WEBHOOK_FILL`) gets one GET of the object. The GET
 *   result is shaped as `read` emits it. Every key the payload lacks or has
 *   null for is filled from it; the webhook's non-null values win. A column
 *   the object lacks too stays null, as a backfill stores it.
 * - `balance_updates` is webhook-only: its row is the event. Never filled.
 * - An id that is not a Wise id (digits) is refused before any request.
 * - 404 (gone since): the record is dropped; an event left with none is
 *   `skipped`.
 * - Budget spent: `deferred`, retried later without counting the attempt.
 * - Each fill read is one attempt, ending with the budget: the box command
 *   is killed at 60 s. A 429, 5xx, network error or timeout is `deferred`.
 * - Any other failure: `extract_failed`.
 *
 * A partial record is never answered unfilled.
 */
import type {
  Context,
  WebhookDefinition,
  WebhookEvent,
  WebhookOutcome,
  WebhookVerification,
} from "@makoai/connector-sdk";
import { type WiseClient, WiseHttpError, isTransientError } from "./client.ts";
import { withStringId } from "./records.ts";
import {
  WISE_PRODUCTION_PUBLIC_KEY,
  WISE_SANDBOX_PUBLIC_KEY,
  WISE_SUPPORTED_WEBHOOK_EVENTS,
  WISE_TEST_NOTIFICATION_EVENT,
  handleWebhookBatch,
  type WebhookChangeRecord,
} from "./webhooks.ts";

/** `verifyWiseWebhook` as data. The API test runs both on the same deliveries. */
export const WISE_WEBHOOK_VERIFICATION: WebhookVerification = {
  scheme: "rsa-sha256",
  publicKeys: [WISE_PRODUCTION_PUBLIC_KEY, WISE_SANDBOX_PUBLIC_KEY],
  signatureHeader: "x-signature-sha256",
  signatureEncoding: "base64",
  testNotification: {
    header: "x-test-notification",
    value: "true",
    eventType: WISE_TEST_NOTIFICATION_EVENT,
  },
};

/**
 * The event id in-process `verifyWiseWebhook` gives a delivery that has no
 * `X-Delivery-Id`: type, resource id and time, else the subscription id.
 */
export function wiseFallbackEventId(
  body: Record<string, unknown>,
  eventType: string | undefined,
): string | undefined {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const resource = (data.resource ?? {}) as Record<string, unknown>;
  const resourceId =
    resource.id != null
      ? String(resource.id)
      : data.balance_id != null
        ? String(data.balance_id)
        : undefined;
  const occurredAt =
    typeof data.occurred_at === "string" ? data.occurred_at : "";
  const stepId = data.step_id != null ? String(data.step_id) : "";
  if (eventType && resourceId) {
    return `${eventType}:${resourceId}:${occurredAt || stepId || body.sent_at || ""}`;
  }
  return typeof body.subscription_id === "string"
    ? body.subscription_id
    : undefined;
}

/** Mako's id for a body it found no declared id for: a SHA-1 of the body. */
const BODY_HASH_ID = /^[0-9a-f]{40}$/;

/**
 * A stored event as the in-process connector holds it. Mako stores the raw
 * body, keyed by `X-Delivery-Id` (`eventIdHeader`), or by a SHA-1 of the
 * body when the header is missing, and typed by `event_type`. In-process
 * `verifyWiseWebhook` adds `type`, `event_type` and `id` (the header, else
 * its own fallback) to the body, and the extraction reads them.
 */
export function inProcessWiseEvent(event: WebhookEvent): WebhookEvent {
  const raw = event.rawPayload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return event;
  const body = raw as Record<string, unknown>;
  const id = BODY_HASH_ID.test(event.eventId)
    ? wiseFallbackEventId(body, event.eventType)
    : event.eventId;
  return {
    ...event,
    rawPayload: {
      ...body,
      type: event.eventType,
      ...("event_type" in body ? { event_type: event.eventType } : {}),
      ...(id !== undefined ? { id } : {}),
    },
  };
}

type Row = Record<string, unknown>;

/** A Wise numeric id, the only thing that goes into a fill URL. */
const WISE_ID = /^\d{1,20}$/;

interface FillSpec {
  /** Columns `read` fills that a webhook may leave out or null. */
  fields: readonly string[];
  /** The object's path, or why it cannot be built. */
  path(payload: Row, id: string): string | { error: string };
  /** The GET result shaped as `read` emits it. */
  shape(object: Row, payload: Row): Row;
}

const idPart = (value: unknown, what: string): string | { error: string } => {
  const text = value == null ? "" : String(value);
  return WISE_ID.test(text)
    ? text
    : { error: `Not a Wise ${what} id: ${JSON.stringify(text).slice(0, 80)}` };
};

/**
 * Per entity: the REST columns whose absence triggers a fill, the object to
 * read, and how `read` shapes it. Webhook-only columns (states,
 * `occurred_at`, failure and refund details) never trigger one.
 */
export const WISE_WEBHOOK_FILL: Readonly<Record<string, FillSpec>> = {
  transfers: {
    fields: [
      "user",
      "targetAccount",
      "sourceAccount",
      "quote",
      "quoteUuid",
      "reference",
      "rate",
      "created",
      "business",
      "transferRequest",
      "hasActiveIssues",
      "sourceCurrency",
      "sourceValue",
      "targetCurrency",
      "targetValue",
      "customerTransactionId",
      "details",
    ],
    path: (_payload, id) => {
      const transfer = idPart(id, "transfer");
      return typeof transfer === "string"
        ? `/v1/transfers/${transfer}`
        : transfer;
    },
    // `readTransfers`: profile_id is the business, else the profile read.
    shape: (object, payload) =>
      withStringId({
        ...object,
        profile_id:
          object.business ?? object.profile_id ?? payload.profile_id ?? null,
      }),
  },
  balances: {
    fields: [
      "currency",
      "type",
      "name",
      "icon",
      "investmentState",
      "creationTime",
      "modificationTime",
      "visible",
      "primary",
      "groupId",
      "recipientId",
      "amount",
      "reservedAmount",
      "cashAmount",
      "totalWorth",
    ],
    path: (payload, id) => {
      const profile = idPart(payload.profileId, "profile");
      if (typeof profile !== "string") return profile;
      const balance = idPart(id, "balance");
      return typeof balance === "string"
        ? `/v4/profiles/${profile}/balances/${balance}`
        : balance;
    },
    shape: (object, payload) =>
      withStringId({ ...object, profileId: String(payload.profileId) }),
  },
  profiles: {
    fields: [
      "publicId",
      "userId",
      "type",
      "email",
      "createdAt",
      "updatedAt",
      "version",
      "fullName",
      "address",
      "contactDetails",
    ],
    path: (_payload, id) => {
      const profile = idPart(id, "profile");
      return typeof profile === "string" ? `/v2/profiles/${profile}` : profile;
    },
    shape: object => withStringId(object),
  },
  recipients: {
    fields: [
      "creatorId",
      "currency",
      "country",
      "type",
      "legalEntityType",
      "active",
      "name",
      "details",
      "accountSummary",
      "longAccountSummary",
      "hash",
    ],
    path: (_payload, id) => {
      const account = idPart(id, "recipient");
      return typeof account === "string" ? `/v2/accounts/${account}` : account;
    },
    shape: object => withStringId(object),
  },
};

/** Read time one batch may spend on fills; past it, events are deferred. */
export const WISE_WEBHOOK_FILL_BUDGET_MS = 40_000;

export interface WiseWebhookDeps {
  api: WiseClient;
  log: (message: string) => void;
  budgetMs?: number;
  now?: () => number;
}

type Filled =
  | { kind: "record"; record: WebhookChangeRecord }
  | { kind: "gone" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

const isAbsent = (payload: Row, field: string) =>
  !(field in payload) ||
  payload[field] === null ||
  payload[field] === undefined;

async function fillRecord(
  deps: WiseWebhookDeps,
  record: WebhookChangeRecord,
  remainingMs: () => number,
): Promise<Filled> {
  const spec = WISE_WEBHOOK_FILL[record.entity];
  const payload =
    record.payload && typeof record.payload === "object"
      ? record.payload
      : null;
  if (!spec || record.operation !== "upsert" || !payload) {
    return { kind: "record", record };
  }
  if (!spec.fields.some(field => isAbsent(payload, field))) {
    return { kind: "record", record };
  }
  const path = spec.path(payload, record.recordId);
  if (typeof path !== "string") return { kind: "failed", reason: path.error };
  if (remainingMs() <= 0) {
    return {
      kind: "deferred",
      reason: `Wise fill budget for this batch is spent; ${record.entity} ${record.recordId} waits for a retry`,
    };
  }

  let object: Row;
  try {
    const fetched = await deps.api.get(path, undefined, undefined, {
      once: true,
      timeoutMs: remainingMs(),
    });
    object =
      fetched && typeof fetched === "object" && !Array.isArray(fetched)
        ? (fetched as Row)
        : {};
  } catch (error) {
    if (error instanceof WiseHttpError && error.status === 404) {
      deps.log(
        `Wise ${record.entity} ${record.recordId} is gone; skipping its upsert`,
      );
      return { kind: "gone" };
    }
    // Rate limited, a 5xx, a slow socket: not now. Deferred, so a busy
    // vendor never uses up the event's attempts.
    if (isTransientError(error)) {
      return {
        kind: "deferred",
        reason: `Wise could not be read now; ${record.entity} waits for a retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return {
      kind: "failed",
      reason: `Could not read Wise ${record.entity} ${record.recordId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const shaped = spec.shape(object, payload);
  const filled: Row = { ...payload };
  for (const [key, value] of Object.entries(shaped)) {
    if (isAbsent(filled, key)) filled[key] = value;
  }
  for (const field of spec.fields) {
    if (!(field in filled) || filled[field] === undefined) filled[field] = null;
  }
  return { kind: "record", record: { ...record, payload: filled } };
}

/** A batch in, one outcome per event out, in order. */
export async function handleWiseWebhookBatch(
  deps: WiseWebhookDeps,
  events: WebhookEvent[],
): Promise<WebhookOutcome[]> {
  const outcomes = handleWebhookBatch(
    events.map(({ eventId, eventType, rawPayload }) => ({
      eventId,
      eventType,
      rawPayload,
    })),
  ) as WebhookOutcome[];

  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? WISE_WEBHOOK_FILL_BUDGET_MS;
  const startedAt = now();
  // What is left of the budget: each fill read is one attempt that ends
  // with it, so a batch answers before its box command is killed.
  const remainingMs = () => budgetMs - (now() - startedAt);

  const out: WebhookOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.outcome !== "records") {
      out.push(outcome);
      continue;
    }
    const records: WebhookChangeRecord[] = [];
    let gone = 0;
    let stop: WebhookOutcome | null = null;
    for (const record of outcome.records as WebhookChangeRecord[]) {
      const filled = await fillRecord(deps, record, remainingMs);
      if (filled.kind === "record") records.push(filled.record);
      else if (filled.kind === "gone") gone++;
      else {
        stop =
          filled.kind === "deferred"
            ? {
                eventId: outcome.eventId,
                outcome: "deferred",
                reason: filled.reason,
              }
            : {
                eventId: outcome.eventId,
                outcome: "extract_failed",
                reason: filled.reason,
              };
        break;
      }
    }
    if (stop) out.push(stop);
    else if (records.length > 0) out.push({ ...outcome, records });
    else {
      out.push({
        eventId: outcome.eventId,
        outcome: "skipped",
        reason: `Wise no longer has ${gone} object(s) of this event (404)`,
      });
    }
  }
  return out;
}

/** The SDK's `webhooks` definition, given how this process reaches Wise. */
export function wiseWebhookDefinition<Config>(
  deps: (ctx: Context<Config>) => WiseWebhookDeps,
): WebhookDefinition<Config> {
  return {
    verification: WISE_WEBHOOK_VERIFICATION,
    eventIdHeader: "x-delivery-id",
    eventTypePath: "event_type",
    events: [...WISE_SUPPORTED_WEBHOOK_EVENTS],
    handleBatch: (ctx, events) =>
      handleWiseWebhookBatch(deps(ctx), events.map(inProcessWiseEvent)),
  };
}
