/**
 * Wise webhooks: the in-process mapping (`api/src/connectors/wise/webhooks.ts`
 * and `WiseConnector.extractWebhookCdcRecords`), ported unchanged and held
 * to it by the parity harness: event types, event -> entity mapping, payload
 * -> change records, and the RSA-SHA256 check as a reference.
 *
 * Mako's API verifies deliveries from the declaration in
 * `webhook-handler.ts`, never with `verifyWiseWebhook`: it stays here as the
 * reference that declaration must agree with.
 */
import crypto from "node:crypto";
import { withStringId, wiseRecordTimestamp } from "./records.ts";

export interface WebhookEventMapping {
  entity: string;
  operation: "upsert" | "delete";
}

export interface WebhookChangeRecord {
  entity: string;
  recordId: string;
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  sourceTs: string;
  source: "webhook";
  changeId: string;
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** A header value by name, ignoring case; the first one when repeated. */
function headerValue(
  headers: HeaderBag | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

const rawWebhookBody = (payload: unknown): string =>
  typeof payload === "string" ? payload : JSON.stringify(payload);

interface WebhookHandlerOptions {
  payload: unknown;
  headers: HeaderBag;
  secret?: string;
}

type WebhookVerificationResult =
  { valid: true; event: any } | { valid: false; error: string };

// Wise signs webhooks with RSA-SHA256 (not a shared HMAC secret).
// https://docs.wise.com/guides/developer/webhooks/event-handling
export const WISE_PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Ni85BhVvZOodM9epgW3F
bA5Q1SexvAF1PPjX4JpMstak/QhAgl1qMSqEevL8cmUeTgcMuVWCJmlge9h7B1CS
D4rtlimGZozG39rUBDg6Qt2K+P4wBfLblL0k4C4YUdLnpGYEDIth+i8XsRpFlogx
CAFyH9+knYsDbR43UJ9shtc42Ybd40Afihj8KnYKXzchyQ42aC8aZ/h5hyZ28yVy
Oj3Vos0VdBIs/gAyJ/4yyQFCXYte64I7ssrlbGRaco4nKF3HmaNhxwyKyJafz19e
HwIDAQAB
-----END PUBLIC KEY-----`;

export const WISE_SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Ordered public keys used for RSA-SHA256 webhook verification. Prefer
 * sandbox when the base URL is sandbox (or the flow secret is literally
 * "sandbox"); always fall back to the other environment so a misconfigured
 * base URL does not hard-fail delivery.
 */
export function wiseWebhookPublicKeys(
  sandboxBaseUrl: boolean,
  secret?: string,
): string[] {
  const preferSandbox =
    sandboxBaseUrl ||
    (typeof secret === "string" && secret.trim().toLowerCase() === "sandbox");
  return preferSandbox
    ? [WISE_SANDBOX_PUBLIC_KEY, WISE_PRODUCTION_PUBLIC_KEY]
    : [WISE_PRODUCTION_PUBLIC_KEY, WISE_SANDBOX_PUBLIC_KEY];
}

export const WISE_SUPPORTED_WEBHOOK_EVENTS = [
  "transfers#state-change",
  "transfers#refund",
  "transfers#payout-failure",
  "transfers#active-cases",
  "balances#update",
  "balances#account-state-change",
  "profiles#state-change",
  "recipients#state-change",
] as const;

/** Event type a Wise test notification is recorded under (maps to nothing). */
export const WISE_TEST_NOTIFICATION_EVENT = "wise#test-notification";

const EVENT_MAPPINGS: Record<string, WebhookEventMapping> = {
  "transfers#state-change": { entity: "transfers", operation: "upsert" },
  "transfers#refund": { entity: "transfers", operation: "upsert" },
  "transfers#payout-failure": { entity: "transfers", operation: "upsert" },
  "transfers#active-cases": { entity: "transfers", operation: "upsert" },
  "balances#update": { entity: "balance_updates", operation: "upsert" },
  // Wise's own webhook screen offers "Account deposit events" but not
  // balances#update, so a hand-made subscription lands here
  "balances#credit": { entity: "balance_updates", operation: "upsert" },
  "balances#account-state-change": {
    entity: "balances",
    operation: "upsert",
  },
  "profiles#state-change": { entity: "profiles", operation: "upsert" },
  "recipients#state-change": { entity: "recipients", operation: "upsert" },
};

export function wiseWebhookEventMapping(
  eventType: string,
): WebhookEventMapping | null {
  return EVENT_MAPPINGS[eventType] ?? null;
}

/**
 * Verify a delivery and shape it as an event. A test notification (sent
 * when a subscription is created) is answered whatever its signature;
 * everything else must verify against one of `publicKeys()` (asked for
 * only once a signature is present).
 */
export function verifyWiseWebhook(
  options: WebhookHandlerOptions,
  publicKeys: () => string[],
): WebhookVerificationResult {
  const { payload, headers } = options;

  // Creating a subscription makes Wise POST a test notification (dummy
  // data, `X-Test-Notification: true`) to check the URL answers. Answer it
  // whatever its signature, as an event no entity maps: its dummy record
  // must never land in a table, and refusing it could fail the creation.
  const testNotification = headerValue(headers, "X-Test-Notification");
  if (testNotification?.trim().toLowerCase() === "true") {
    const deliveryId = headerValue(headers, "X-Delivery-Id");
    return {
      valid: true,
      event: {
        type: WISE_TEST_NOTIFICATION_EVENT,
        event_type: WISE_TEST_NOTIFICATION_EVENT,
        id: deliveryId ? `test:${deliveryId}` : `test:${crypto.randomUUID()}`,
      },
    };
  }

  const signature = headerValue(headers, "X-Signature-SHA256");
  if (!signature) {
    return {
      valid: false,
      error: "Missing X-Signature-SHA256 header",
    };
  }

  const rawBody = rawWebhookBody(payload);

  let verified = false;
  for (const publicKey of publicKeys()) {
    try {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(rawBody);
      verifier.end();
      if (verifier.verify(publicKey, signature, "base64")) {
        verified = true;
        break;
      }
    } catch {
      // A key node cannot read: try the next one, as in-process.
    }
  }

  // Test notifications sent during subscription setup may arrive without a
  // usable signature in some environments — still require a valid signature
  // when present; reject when verification fails.
  if (!verified) {
    return { valid: false, error: "Invalid Wise webhook signature" };
  }

  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    const eventType =
      typeof parsed?.event_type === "string"
        ? parsed.event_type
        : typeof parsed?.type === "string"
          ? parsed.type
          : undefined;

    const deliveryId = headerValue(headers, "X-Delivery-Id");
    const data = (parsed?.data ?? {}) as Record<string, unknown>;
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

    const eventId =
      deliveryId ||
      (eventType && resourceId
        ? `${eventType}:${resourceId}:${occurredAt || stepId || parsed?.sent_at || ""}`
        : parsed?.subscription_id);

    return {
      valid: true,
      event: {
        ...parsed,
        type: eventType,
        event_type: eventType,
        id: eventId,
      },
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Failed to parse webhook",
    };
  }
}

const TRANSFER_EVENTS = new Set([
  "transfers#state-change",
  "transfers#refund",
  "transfers#payout-failure",
  "transfers#active-cases",
]);

/** The record a webhook event carries, keyed as its entity's table is. */
export function extractWiseWebhookData(
  event: any,
): { id: string; data: Record<string, unknown> } | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const eventType =
    typeof event.event_type === "string"
      ? event.event_type
      : typeof event.type === "string"
        ? event.type
        : undefined;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const resource = (data.resource ?? {}) as Record<string, unknown>;

  if (eventType === "balances#update" || eventType === "balances#credit") {
    // balances#credit (2.0.0) has no balance_id or step_id: only the
    // balance account in `resource`, so its id adds the currency
    const balanceId =
      data.balance_id ??
      (eventType === "balances#credit" && resource.id != null
        ? `${resource.id}:${data.currency ?? ""}`
        : resource.id);
    const stepId = data.step_id;
    const occurredAt = data.occurred_at;
    if (balanceId == null) return null;

    const id = String(
      stepId != null
        ? `${balanceId}:${stepId}`
        : `${balanceId}:${occurredAt ?? event.sent_at ?? event.id ?? ""}`,
    );

    return {
      id,
      data: withStringId({
        id,
        balance_id:
          data.balance_id == null
            ? null
            : typeof data.balance_id === "number"
              ? data.balance_id
              : Number(data.balance_id),
        profile_id: resource.profile_id ?? null,
        resource_id: resource.id ?? null,
        resource_type: resource.type ?? null,
        amount: data.amount ?? null,
        currency: data.currency ?? null,
        channel_name: data.channel_name ?? null,
        transaction_type:
          data.transaction_type ??
          (eventType === "balances#credit" ? "credit" : null),
        transfer_reference: data.transfer_reference ?? null,
        post_transaction_balance_amount:
          data.post_transaction_balance_amount ?? null,
        step_id: data.step_id ?? null,
        occurred_at: data.occurred_at ?? null,
        subscription_id: event.subscription_id ?? null,
        event_type: eventType,
        schema_version: event.schema_version ?? null,
        sent_at: event.sent_at ?? null,
      }),
    };
  }

  if (eventType && TRANSFER_EVENTS.has(eventType)) {
    // payout-failure 5.0.0 has no `resource`: `data.transfer_id` instead
    const transferId = resource.id ?? data.transfer_id;
    if (transferId == null) return null;
    const id = String(transferId);
    return {
      id,
      data: withStringId({
        id,
        profile_id: resource.profile_id ?? data.profile_id ?? null,
        account_id: resource.account_id ?? null,
        status: data.current_state ?? data.status ?? null,
        current_state: data.current_state ?? null,
        previous_state: data.previous_state ?? null,
        occurred_at: data.occurred_at ?? null,
        failure_reason_code:
          data.failure_reason_code ?? data.failureReasonCode ?? null,
        failure_description:
          data.failure_description ?? data.failureDescription ?? null,
        refund_amount:
          resource.refund_amount ?? data.amount ?? data.refund_amount ?? null,
        refund_currency:
          resource.refund_currency ??
          data.currency ??
          data.refund_currency ??
          null,
        hasActiveIssues: data.has_active_issues ?? data.hasActiveIssues ?? null,
        details: data.details ?? data.active_cases ?? null,
      }),
    };
  }

  if (eventType === "balances#account-state-change") {
    const balanceId = resource.id ?? data.balance_id ?? data.id;
    if (balanceId == null) return null;
    return {
      id: String(balanceId),
      data: withStringId({
        id: String(balanceId),
        profileId:
          resource.profile_id != null ? String(resource.profile_id) : null,
        current_state: data.current_state ?? null,
        previous_state: data.previous_state ?? null,
        occurred_at: data.occurred_at ?? null,
        ...data,
      }),
    };
  }

  if (eventType === "profiles#state-change") {
    const profileId = resource.id ?? data.profile_id ?? data.id;
    if (profileId == null) return null;
    return {
      id: String(profileId),
      data: withStringId({
        id: String(profileId),
        currentState: data.current_state ?? data.currentState ?? null,
        previous_state: data.previous_state ?? null,
        occurred_at: data.occurred_at ?? null,
        ...data,
      }),
    };
  }

  if (eventType === "recipients#state-change") {
    // 4.0.0 nests the recipient under `resource.data`; `resource.id` there
    // is the event's own id, not the recipient's
    const nested = (resource.data ?? {}) as Record<string, unknown>;
    const recipientId =
      nested.recipientId ?? resource.id ?? data.account_id ?? data.id;
    if (recipientId == null) return null;
    return {
      id: String(recipientId),
      data: withStringId({
        id: String(recipientId),
        profileId:
          nested.profileId ?? resource.profile_id ?? data.profile_id ?? null,
        current_state: nested.state ?? data.current_state ?? null,
        previous_state: data.previous_state ?? null,
        occurred_at: resource.occurred_at ?? data.occurred_at ?? null,
        ...data,
      }),
    };
  }

  // Generic fallback
  const fallbackId = resource.id ?? data.id;
  if (fallbackId == null) return null;
  return {
    id: String(fallbackId),
    data: withStringId({ id: String(fallbackId), ...data }),
  };
}

/** The in-process `getWebhookEventsForEntities`. */
export function wiseWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return [...WISE_SUPPORTED_WEBHOOK_EVENTS];
  const wanted = new Set(entities.map(e => e.toLowerCase()));
  return WISE_SUPPORTED_WEBHOOK_EVENTS.filter(eventType => {
    const mapping = wiseWebhookEventMapping(eventType);
    return mapping ? wanted.has(mapping.entity.toLowerCase()) : false;
  });
}

/**
 * The in-process `resolveRecordTimestamp`: Wise's own time fields, then the
 * base connector's, then now.
 */
export function wiseSourceTimestamp(payload?: Record<string, unknown>): Date {
  const own = wiseRecordTimestamp(payload);
  if (own) return own;
  for (const candidate of [
    payload?.date_updated,
    payload?.updated_at,
    payload?.updatedAt,
    payload?.date_modified,
    payload?.date_created,
    payload?.created_at,
    payload?.createdAt,
    payload?.timestamp,
    payload?._syncedAt,
  ]) {
    if (!candidate) continue;
    const date =
      candidate instanceof Date ? candidate : new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(Date.now());
}

/** The in-process `WiseConnector.extractWebhookCdcRecords`. */
export function wiseWebhookChangeRecords(
  event: any,
  eventType?: string,
): WebhookChangeRecord[] {
  const resolvedEventType =
    eventType || event?.type || event?.event_type || event?.action;
  if (!resolvedEventType) return [];
  const mapping = wiseWebhookEventMapping(resolvedEventType);
  if (!mapping) return [];
  const extracted = extractWiseWebhookData(event);
  if (!extracted) return [];
  const sourceTs = wiseSourceTimestamp(extracted.data);
  return [
    {
      entity: mapping.entity,
      recordId: extracted.id,
      operation: mapping.operation,
      payload: extracted.data,
      sourceTs: sourceTs.toISOString(),
      source: "webhook",
      changeId:
        event?.id ||
        event?.event_id ||
        `${resolvedEventType}:${extracted.id}:${sourceTs.toISOString()}`,
    },
  ];
}

/** One stored event, as Mako hands it to a box. */
export interface WebhookBatchEvent {
  eventId: string;
  eventType: string;
  rawPayload: unknown;
}

export type WebhookEventOutcome =
  | { eventId: string; outcome: "records"; records: WebhookChangeRecord[] }
  | { eventId: string; outcome: "unmapped" }
  | { eventId: string; outcome: "extract_failed" };

/**
 * A batch in, one outcome per event out, in order, as the in-process ingest
 * reads each event: unmapped type, no record (extract failed), or records.
 */
export function handleWebhookBatch(
  events: WebhookBatchEvent[],
): WebhookEventOutcome[] {
  return events.map(({ eventId, eventType, rawPayload }) => {
    if (!wiseWebhookEventMapping(eventType)) {
      return { eventId, outcome: "unmapped" };
    }
    const records = wiseWebhookChangeRecords(rawPayload, eventType);
    return records.length === 0
      ? { eventId, outcome: "extract_failed" }
      : { eventId, outcome: "records", records };
  });
}
