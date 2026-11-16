/**
 * Close webhooks, connector side. A port of the read-only half of
 * `api/src/connectors/close/webhooks.ts` plus `CloseConnector`'s
 * `extractWebhookCdcRecords`: event selectors, event to entity mapping,
 * signature verification and the change records one event yields.
 *
 * Nothing here talks to Close. Provisioning (create or adopt the Close
 * webhook, store its signing key) is a write with the connection's key and
 * stays in the API's connection gateway; see the PR body for the design.
 *
 * `handleWebhookBatch` is the box-side contract: the API hands a boxed run a
 * batch of stored, already-verified events and gets back, per event, either
 * the change records or the reason there are none. Entity filtering by the
 * flow's selection, `_dataSourceId`/`_syncedAt` stamping and the CDC write
 * stay in the API, as they do for in-process connectors today.
 */
import crypto from "node:crypto";
import { normalizeClosePayload } from "./records.ts";

export type WebhookOperation = "upsert" | "delete";

export interface WebhookEventMapping {
  entity: string;
  operation: WebhookOperation;
}

/** One change, as `NormalizedCdcRecord` carries it, with an ISO `sourceTs`. */
export interface WebhookChangeRecord {
  entity: string;
  recordId: string;
  operation: WebhookOperation;
  payload: Record<string, unknown>;
  sourceTs: string;
  source: "webhook";
  changeId: string;
}

const SELECTOR_ACTIONS: Array<[objectType: string, actions: string[]]> = [
  ["lead", ["created", "updated", "deleted", "merged"]],
  ["contact", ["created", "updated", "deleted"]],
  ["membership", ["activated", "deactivated"]],
  ["opportunity", ["created", "updated", "deleted"]],
  ["activity.call", ["created", "updated", "deleted", "answered", "completed"]],
  ["activity.email", ["created", "updated", "deleted", "sent"]],
  ["activity.email_thread", ["created", "updated", "deleted"]],
  ["activity.sms", ["created", "updated", "deleted", "sent"]],
  ["activity.note", ["created", "updated", "deleted"]],
  [
    "activity.meeting",
    [
      "created",
      "updated",
      "deleted",
      "scheduled",
      "started",
      "completed",
      "canceled",
    ],
  ],
  ["activity.lead_status_change", ["created", "updated", "deleted"]],
  ["activity.opportunity_status_change", ["created", "updated", "deleted"]],
  ["activity.task_completed", ["created", "updated", "deleted"]],
  ["activity.custom_activity", ["created", "updated", "deleted"]],
  ["custom_fields.lead", ["created", "updated", "deleted"]],
  ["custom_fields.contact", ["created", "updated", "deleted"]],
  ["custom_fields.opportunity", ["created", "updated", "deleted"]],
  ["custom_fields.activity", ["created", "updated", "deleted"]],
  ["custom_fields.custom_object", ["created", "updated", "deleted"]],
  ["custom_fields.shared", ["created", "updated", "deleted"]],
  ["custom_activity_type", ["created", "updated", "deleted"]],
  ["custom_object_type", ["created", "updated", "deleted"]],
  ["custom_object", ["created", "updated", "deleted"]],
  ["status.lead", ["created", "updated", "deleted"]],
  ["status.opportunity", ["created", "updated", "deleted"]],
  ["group", ["created", "updated", "deleted"]],
];

const SELECTORS = SELECTOR_ACTIONS.flatMap(([object_type, actions]) =>
  actions.map(action => ({ object_type, action })),
);

/** Every event this connector subscribes to, `object_type.action`. */
export function closeSupportedWebhookEvents(): string[] {
  return SELECTORS.map(s => `${s.object_type}.${s.action}`);
}

const ACTIVITY_SUBTYPE_TO_OBJECT_TYPE: Record<string, string> = {
  call: "activity.call",
  email: "activity.email",
  emailthread: "activity.email_thread",
  sms: "activity.sms",
  note: "activity.note",
  meeting: "activity.meeting",
  leadstatuschange: "activity.lead_status_change",
  opportunitystatuschange: "activity.opportunity_status_change",
  taskcompleted: "activity.task_completed",
  customactivity: "activity.custom_activity",
};

const ENTITY_TO_OBJECT_TYPES: Record<string, string[]> = {
  leads: ["lead"],
  contacts: ["contact"],
  users: ["membership"],
  opportunities: ["opportunity"],
  custom_fields: [
    "custom_fields.lead",
    "custom_fields.contact",
    "custom_fields.opportunity",
    "custom_fields.activity",
    "custom_fields.custom_object",
    "custom_fields.shared",
  ],
  custom_activity_types: ["custom_activity_type"],
  custom_object_types: ["custom_object_type"],
  custom_objects: ["custom_object"],
  lead_statuses: ["status.lead"],
  opportunity_statuses: ["status.opportunity"],
  groups: ["group"],
};

/** The events relevant to `entities`; every event when the list is empty. */
export function closeWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return closeSupportedWebhookEvents();
  const relevant = new Set<string>();
  for (const entity of new Set(entities.map(e => e.toLowerCase()))) {
    if (entity.startsWith("activities:")) {
      const objectType =
        ACTIVITY_SUBTYPE_TO_OBJECT_TYPE[entity.slice("activities:".length)];
      if (objectType) relevant.add(objectType);
      continue;
    }
    for (const objectType of ENTITY_TO_OBJECT_TYPES[entity] ?? []) {
      relevant.add(objectType);
    }
  }
  return SELECTORS.filter(s => relevant.has(s.object_type)).map(
    s => `${s.object_type}.${s.action}`,
  );
}

const EVENT_MAPPINGS: Record<string, WebhookEventMapping> = {
  "lead.created": { entity: "leads", operation: "upsert" },
  "lead.updated": { entity: "leads", operation: "upsert" },
  "lead.deleted": { entity: "leads", operation: "delete" },
  "lead.merged": { entity: "leads", operation: "upsert" },
  "contact.created": { entity: "contacts", operation: "upsert" },
  "contact.updated": { entity: "contacts", operation: "upsert" },
  "contact.deleted": { entity: "contacts", operation: "delete" },
  "membership.activated": { entity: "users", operation: "upsert" },
  "membership.deactivated": { entity: "users", operation: "delete" },
  "user.created": { entity: "users", operation: "upsert" },
  "user.updated": { entity: "users", operation: "upsert" },
  "user.deleted": { entity: "users", operation: "delete" },
  "opportunity.created": { entity: "opportunities", operation: "upsert" },
  "opportunity.updated": { entity: "opportunities", operation: "upsert" },
  "opportunity.deleted": { entity: "opportunities", operation: "delete" },
  "group.created": { entity: "groups", operation: "upsert" },
  "group.updated": { entity: "groups", operation: "upsert" },
  "group.deleted": { entity: "groups", operation: "delete" },
};

const ACTIVITY_EVENT_SUBTYPES: Record<string, string> = {
  call: "Call",
  email: "Email",
  email_thread: "EmailThread",
  sms: "SMS",
  note: "Note",
  meeting: "Meeting",
  lead_status_change: "LeadStatusChange",
  opportunity_status_change: "OpportunityStatusChange",
  task_completed: "TaskCompleted",
  custom_activity: "CustomActivity",
};

const TYPE_EVENT_ENTITIES: Record<string, string> = {
  custom_activity_type: "custom_activity_types",
  custom_object_type: "custom_object_types",
};

const operationOf = (action: string): WebhookOperation =>
  action === "deleted" ? "delete" : "upsert";

export function closeWebhookEventMapping(
  eventType: string,
): WebhookEventMapping | null {
  if (EVENT_MAPPINGS[eventType]) return EVENT_MAPPINGS[eventType];
  const activity = eventType.match(
    /^activity\.(\w+)\.(created|updated|sent|deleted|answered|completed|scheduled|started|canceled)$/,
  );
  if (activity) {
    const subType = ACTIVITY_EVENT_SUBTYPES[activity[1]];
    if (subType) {
      return {
        entity: `activities:${subType}`,
        operation: operationOf(activity[2]),
      };
    }
  }
  const cf = eventType.match(/^custom_fields\.\w+\.(created|updated|deleted)$/);
  if (cf) return { entity: "custom_fields", operation: operationOf(cf[1]) };
  const status = eventType.match(
    /^status\.(lead|opportunity)\.(created|updated|deleted)$/,
  );
  if (status) {
    return {
      entity: `${status[1]}_statuses`,
      operation: operationOf(status[2]),
    };
  }
  const type = eventType.match(
    /^(custom_activity_type|custom_object_type)\.(created|updated|deleted)$/,
  );
  if (type) {
    return {
      entity: TYPE_EVENT_ENTITIES[type[1]],
      operation: operationOf(type[2]),
    };
  }
  const co = eventType.match(/^custom_object\.(created|updated|deleted)$/);
  if (co) return { entity: "custom_objects", operation: operationOf(co[1]) };
  return null;
}

/** Entity data of a webhook event. */
export function extractCloseWebhookData(
  event: any,
): { id: string; data: any } | null {
  const inner = event?.event;
  const objectType = inner?.object_type || event?.object_type;
  const data = inner?.data || event?.data;

  if (objectType === "membership" && data && typeof data === "object") {
    const embeddedUser =
      data.user && typeof data.user === "object"
        ? data.user
        : data.user_id
          ? { id: data.user_id }
          : null;
    if (embeddedUser) {
      const userId =
        embeddedUser.id || data.user_id || inner?.object_id || event?.id;
      if (userId) {
        return {
          id: String(userId),
          data: { ...embeddedUser, id: String(userId) },
        };
      }
    }
  }

  const objectId =
    inner?.object_id || event?.object_id || data?.id || event?.id;
  if (data && objectId) {
    return { id: String(objectId), data: { ...data, id: String(objectId) } };
  }
  if (objectId) return { id: String(objectId), data: { id: String(objectId) } };
  return null;
}

/** The base connector's record timestamp: first parseable candidate, else now. */
function resolveRecordTimestamp(payload?: Record<string, unknown>): Date {
  const candidates = [
    payload?.date_updated,
    payload?.updated_at,
    payload?.updatedAt,
    payload?.date_modified,
    payload?.date_created,
    payload?.created_at,
    payload?.createdAt,
    payload?.timestamp,
    payload?._syncedAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date =
      candidate instanceof Date ? candidate : new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

/**
 * The change records of one event: the base connector's
 * `extractWebhookCdcRecords`, then Close's override (event-level source
 * time, normalized payload, Close's nested event id as the change id).
 */
export function closeWebhookChangeRecords(
  event: any,
  eventType?: string,
): WebhookChangeRecord[] {
  const resolvedType =
    eventType || event?.type || event?.event_type || event?.action;
  if (!resolvedType) return [];
  const mapping = closeWebhookEventMapping(resolvedType);
  if (!mapping) return [];
  const extracted = extractCloseWebhookData(event);
  if (!extracted) return [];

  const baseTs = resolveRecordTimestamp(extracted.data);
  const base = {
    entity: mapping.entity,
    recordId: extracted.id,
    operation: mapping.operation,
    payload: extracted.data as Record<string, unknown>,
    source: "webhook" as const,
    changeId:
      event?.id ||
      event?.event_id ||
      event?.eventId ||
      event?.event?.id ||
      `${resolvedType}:${extracted.id}:${baseTs.toISOString()}`,
  };

  const inner = event?.event;
  const candidate =
    inner?.date_updated ||
    inner?.date_created ||
    event?.date_updated ||
    event?.date_created ||
    event?.timestamp;
  const eventTs = candidate ? new Date(String(candidate)) : null;
  if (!eventTs || Number.isNaN(eventTs.getTime())) {
    return [{ ...base, sourceTs: baseTs.toISOString() }];
  }
  return [
    {
      ...base,
      payload: normalizeClosePayload(base.entity, base.payload || {}),
      sourceTs: eventTs.toISOString(),
      changeId:
        inner?.id ||
        event?.id ||
        base.changeId ||
        `${resolvedType || "close.event"}:${base.entity}:${base.recordId}:${eventTs.toISOString()}`,
    },
  ];
}

export interface WebhookVerification {
  valid: boolean;
  event?: unknown;
  error?: string;
}

/**
 * HMAC-SHA256 under the hex-decoded key, over the `close-sig-timestamp`
 * header followed by the raw body, compared in constant time.
 */
export function verifyCloseWebhook(options: {
  payload: string;
  headers: Record<string, string | undefined>;
  secret?: string;
}): WebhookVerification {
  const { payload, headers, secret } = options;
  const sigHash = headers["close-sig-hash"];
  const sigTimestamp = headers["close-sig-timestamp"];
  if (!sigHash || typeof sigHash !== "string") {
    return { valid: false, error: "Missing close-sig-hash header" };
  }
  if (!sigTimestamp || typeof sigTimestamp !== "string") {
    return { valid: false, error: "Missing close-sig-timestamp header" };
  }
  if (!secret) return { valid: false, error: "Missing webhook secret" };
  try {
    const expected = crypto
      .createHmac("sha256", Buffer.from(secret, "hex"))
      .update(sigTimestamp + payload)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sigHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, error: "Invalid signature" };
    }
    return { valid: true, event: JSON.parse(payload) };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Failed to verify webhook",
    };
  }
}

/** One stored event, as the API's `WebhookEvent` holds it. */
export interface WebhookBatchEvent {
  eventId: string;
  eventType: string;
  rawPayload: unknown;
}

export type WebhookEventOutcome =
  | { eventId: string; outcome: "unmapped" }
  | { eventId: string; outcome: "extract_failed" }
  | {
      eventId: string;
      outcome: "records";
      records: WebhookChangeRecord[];
    };

/**
 * A batch in, one outcome per event out, in order. The outcomes are the
 * three branches `webhook-flow.ts` takes today: no mapping (applied, no
 * change), a mapping but no record (EXTRACT_FAILED), or records.
 */
export function handleWebhookBatch(
  events: WebhookBatchEvent[],
): WebhookEventOutcome[] {
  return events.map(({ eventId, eventType, rawPayload }) => {
    if (!closeWebhookEventMapping(eventType)) {
      return { eventId, outcome: "unmapped" };
    }
    const records = closeWebhookChangeRecords(rawPayload, eventType);
    return records.length === 0
      ? { eventId, outcome: "extract_failed" }
      : { eventId, outcome: "records", records };
  });
}
