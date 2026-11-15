/**
 * Close webhooks: the supported event selectors, event → entity mapping,
 * payload extraction, signature verification and subscription provisioning.
 */
import axios, { AxiosInstance } from "axios";
import crypto from "node:crypto";
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  WebhookEventMapping,
  WebhookHandlerOptions,
  WebhookVerificationResult,
} from "../base/BaseConnector";
import { rawWebhookBody } from "../base/webhook-signature";
import { loggers } from "../../logging";

const logger = loggers.connector("close");

type CloseWebhookSelector = {
  object_type: string;
  action: string;
};

/** Close returns the HMAC key as `signature_key` on create/list/get. */
function extractCloseSigningSecret(
  webhook: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!webhook || typeof webhook !== "object") return undefined;
  const candidate =
    webhook.signature_key ?? webhook.signing_secret ?? webhook.secret;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

const SELECTOR_ACTIONS: Array<[objectType: string, actions: string[]]> = [
  ["lead", ["created", "updated", "deleted", "merged"]],
  ["contact", ["created", "updated", "deleted"]],
  // Close has no `user` webhook object_type — membership activated/deactivated
  // carries embedded user data (see Close "List of Event Types").
  ["membership", ["activated", "deactivated"]],
  ["opportunity", ["created", "updated", "deleted"]],
  // `updated` is how manually-logged calls (source "External") get their real
  // duration (created with duration 0, then updated on save), and how native
  // calls get recording_url/has_recording after the recording lands. Without
  // this selector those fields freeze at their creation values.
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

// Close webhook selectors from official event list.
const CLOSE_SUPPORTED_WEBHOOK_SELECTORS: CloseWebhookSelector[] =
  SELECTOR_ACTIONS.flatMap(([object_type, actions]) =>
    actions.map(action => ({ object_type, action })),
  );

const CLOSE_SUPPORTED_WEBHOOK_SELECTOR_KEYS = new Set(
  CLOSE_SUPPORTED_WEBHOOK_SELECTORS.map(
    selector => `${selector.object_type}:${selector.action}`,
  ),
);

const selectorEvent = (selector: CloseWebhookSelector) =>
  `${selector.object_type}.${selector.action}`;

export function closeSupportedWebhookEvents(): string[] {
  return CLOSE_SUPPORTED_WEBHOOK_SELECTORS.map(selectorEvent);
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

/**
 * Only the webhook event strings relevant to the given entities. Falls back
 * to all supported events when the entity list is empty (i.e. no explicit
 * selection — sync everything).
 */
export function closeWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return closeSupportedWebhookEvents();

  const entitySet = new Set(entities.map(e => e.toLowerCase()));
  const relevantObjectTypes = new Set<string>();

  for (const entity of entitySet) {
    if (entity.startsWith("activities:")) {
      const subType = entity.slice("activities:".length).toLowerCase();
      const objType = ACTIVITY_SUBTYPE_TO_OBJECT_TYPE[subType];
      if (objType) relevantObjectTypes.add(objType);
      continue;
    }

    const mapped = ENTITY_TO_OBJECT_TYPES[entity];
    if (mapped) {
      for (const ot of mapped) relevantObjectTypes.add(ot);
    }
  }

  return CLOSE_SUPPORTED_WEBHOOK_SELECTORS.filter(selector =>
    relevantObjectTypes.has(selector.object_type),
  ).map(selectorEvent);
}

const EVENT_MAPPINGS: Record<string, WebhookEventMapping> = {
  // Leads
  "lead.created": { entity: "leads", operation: "upsert" },
  "lead.updated": { entity: "leads", operation: "upsert" },
  "lead.deleted": { entity: "leads", operation: "delete" },
  "lead.merged": { entity: "leads", operation: "upsert" },

  // Contacts
  "contact.created": { entity: "contacts", operation: "upsert" },
  "contact.updated": { entity: "contacts", operation: "upsert" },
  "contact.deleted": { entity: "contacts", operation: "delete" },

  // Users — Close emits membership events (not user.*). Keep legacy
  // user.* mappings so any older payloads still route to the users entity.
  "membership.activated": { entity: "users", operation: "upsert" },
  "membership.deactivated": { entity: "users", operation: "delete" },
  "user.created": { entity: "users", operation: "upsert" },
  "user.updated": { entity: "users", operation: "upsert" },
  "user.deleted": { entity: "users", operation: "delete" },

  // Opportunities
  "opportunity.created": { entity: "opportunities", operation: "upsert" },
  "opportunity.updated": { entity: "opportunities", operation: "upsert" },
  "opportunity.deleted": { entity: "opportunities", operation: "delete" },

  // Groups (functional teams). `group.updated` also fires on member add/remove.
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

const operationOf = (action: string): WebhookEventMapping["operation"] =>
  action === "deleted" ? "delete" : "upsert";

export function closeWebhookEventMapping(
  eventType: string,
): WebhookEventMapping | null {
  if (EVENT_MAPPINGS[eventType]) return EVENT_MAPPINGS[eventType];

  // Activity sub-type events: "activity.note.created" → entity "activities:Note"
  const activityMatch = eventType.match(
    /^activity\.(\w+)\.(created|updated|sent|deleted|answered|completed|scheduled|started|canceled)$/,
  );
  if (activityMatch) {
    const subType = ACTIVITY_EVENT_SUBTYPES[activityMatch[1]];
    if (subType) {
      return {
        entity: `activities:${subType}`,
        operation: operationOf(activityMatch[2]),
      };
    }
  }

  // Custom fields events: "custom_fields.lead.created" → entity "custom_fields"
  const cfMatch = eventType.match(
    /^custom_fields\.\w+\.(created|updated|deleted)$/,
  );
  if (cfMatch) {
    return { entity: "custom_fields", operation: operationOf(cfMatch[1]) };
  }

  // Status events: "status.lead.created" → entity "lead_statuses"
  const statusMatch = eventType.match(
    /^status\.(lead|opportunity)\.(created|updated|deleted)$/,
  );
  if (statusMatch) {
    return {
      entity: `${statusMatch[1]}_statuses`,
      operation: operationOf(statusMatch[2]),
    };
  }

  // Custom object/activity type events
  const typeMatch = eventType.match(
    /^(custom_activity_type|custom_object_type)\.(created|updated|deleted)$/,
  );
  if (typeMatch) {
    return {
      entity: TYPE_EVENT_ENTITIES[typeMatch[1]],
      operation: operationOf(typeMatch[2]),
    };
  }

  // Custom object events
  const coMatch = eventType.match(/^custom_object\.(created|updated|deleted)$/);
  if (coMatch) {
    return { entity: "custom_objects", operation: operationOf(coMatch[1]) };
  }

  return null;
}

/** Entity data of a webhook event. */
export function extractCloseWebhookData(
  event: any,
): { id: string; data: any } | null {
  // Close webhook payload: {subscription_id, event: {object_type, action, data: {...}}}
  // Prefer object_id from wrapper, then fall back to nested payload ids.
  const innerEvent = event?.event;
  const objectType = innerEvent?.object_type || event?.object_type;
  const data = innerEvent?.data || event?.data;

  // Membership events embed the user record; CDC writes the users entity.
  if (objectType === "membership" && data && typeof data === "object") {
    const embeddedUser =
      data.user && typeof data.user === "object"
        ? data.user
        : data.user_id
          ? { id: data.user_id }
          : null;
    if (embeddedUser) {
      const userId =
        embeddedUser.id || data.user_id || innerEvent?.object_id || event?.id;
      if (userId) {
        return {
          id: String(userId),
          data: { ...embeddedUser, id: String(userId) },
        };
      }
    }
  }

  const objectId =
    innerEvent?.object_id || event?.object_id || data?.id || event?.id;

  if (data && objectId) {
    return { id: String(objectId), data: { ...data, id: String(objectId) } };
  }

  // Delete/merge events can come without data payload.
  if (objectId) {
    return { id: String(objectId), data: { id: String(objectId) } };
  }

  return null;
}

/**
 * Verify a delivery: HMAC-SHA256 under the hex-decoded key, over the
 * `close-sig-timestamp` header followed by the raw body (no separator).
 */
export function verifyCloseWebhook(
  options: WebhookHandlerOptions,
): WebhookVerificationResult {
  const { payload, headers, secret } = options;

  const sigHash = headers["close-sig-hash"];
  const sigTimestamp = headers["close-sig-timestamp"];

  if (!sigHash || typeof sigHash !== "string") {
    return { valid: false, error: "Missing close-sig-hash header" };
  }

  if (!sigTimestamp || typeof sigTimestamp !== "string") {
    return { valid: false, error: "Missing close-sig-timestamp header" };
  }

  if (!secret) {
    return { valid: false, error: "Missing webhook secret" };
  }

  try {
    const body = rawWebhookBody(payload);
    // Close: HMAC-SHA256(hex_decoded_key, timestamp + body) — no separator
    const data = sigTimestamp + body;
    const keyBytes = Buffer.from(secret, "hex");
    const expectedSignature = crypto
      .createHmac("sha256", keyBytes)
      .update(data, "utf-8")
      .digest("hex");

    if (
      !crypto.timingSafeEqual(
        Buffer.from(sigHash),
        Buffer.from(expectedSignature),
      )
    ) {
      return { valid: false, error: "Invalid signature" };
    }

    const event = typeof payload === "string" ? JSON.parse(payload) : payload;
    return { valid: true, event };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Failed to verify webhook",
    };
  }
}

function parseEventSelector(eventType: string): CloseWebhookSelector | null {
  const value = eventType.trim();
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator >= value.length - 1) return null;

  const objectType = value.slice(0, separator).trim();
  const action = value.slice(separator + 1).trim();
  if (!objectType || !action) return null;

  return { object_type: objectType, action };
}

function normalizeEventSelectors(eventTypes: string[]) {
  const unique = new Map<string, CloseWebhookSelector>();
  const unsupported: string[] = [];
  for (const eventType of eventTypes) {
    const parsed = parseEventSelector(eventType);
    if (!parsed) {
      unsupported.push(eventType);
      continue;
    }

    const key = `${parsed.object_type}:${parsed.action}`;
    if (!CLOSE_SUPPORTED_WEBHOOK_SELECTOR_KEYS.has(key)) {
      unsupported.push(eventType);
      continue;
    }

    unique.set(key, parsed);
  }
  return { selectors: Array.from(unique.values()), unsupported };
}

function describeProvisioningError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;

    const directError =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
          ? data.message
          : typeof data === "string"
            ? data
            : undefined;

    const serialized =
      !directError && data && typeof data === "object"
        ? JSON.stringify(data)
        : undefined;

    const detail = directError || serialized || error.message;
    return status ? `HTTP ${status}: ${detail}` : detail;
  }

  return error instanceof Error ? error.message : String(error);
}

const webhookIdOf = (webhook: Record<string, unknown>): unknown =>
  webhook.id || webhook._id || webhook.subscription_id || webhook.webhook_id;

/**
 * Create (or adopt, when one already targets the URL) the Close webhook
 * for `options.endpointUrl`, returning its id and signing key.
 * `eventsForEntities` resolves the events when none are requested.
 */
export async function provisionCloseWebhook(
  api: AxiosInstance,
  options: ProvisionWebhookOptions,
  eventsForEntities: (entities: string[]) => string[],
): Promise<ProvisionWebhookResult> {
  const requestedEvents = Array.isArray(options.events)
    ? options.events
        .map(event => event.trim())
        .filter((event): event is string => event.length > 0)
    : [];

  const effectiveEvents =
    requestedEvents.length > 0
      ? requestedEvents
      : eventsForEntities(options.enabledEntities ?? []);

  const normalized = normalizeEventSelectors(effectiveEvents);
  if (requestedEvents.length > 0 && normalized.unsupported.length > 0) {
    logger.warn("Ignoring unsupported Close webhook events", {
      unsupportedEvents: normalized.unsupported,
    });
  }

  if (normalized.selectors.length === 0) {
    throw new Error(
      requestedEvents.length > 0
        ? `No valid Close webhook events configured. Unsupported events: ${normalized.unsupported.join(", ")}`
        : "No valid Close webhook events configured",
    );
  }

  const payload: Record<string, unknown> = {
    url: options.endpointUrl,
    verify_ssl: options.verifySsl !== false,
    events: normalized.selectors,
  };

  try {
    // Avoid creating duplicates when the flow already has a provider webhook.
    const existingResponse = await api.get("/webhook/");
    const existingList = Array.isArray(existingResponse?.data)
      ? existingResponse.data
      : Array.isArray(existingResponse?.data?.data)
        ? existingResponse.data.data
        : [];
    const existing = existingList.find((item: any) => {
      const candidateUrl =
        typeof item?.url === "string"
          ? item.url
          : typeof item?.endpoint === "string"
            ? item.endpoint
            : "";
      return candidateUrl === options.endpointUrl;
    });
    if (existing) {
      const existingId = webhookIdOf(existing);
      if (existingId) {
        try {
          await api.put(`/webhook/${existingId}/`, {
            events: normalized.selectors,
          });
          logger.info(
            "Updated Close webhook events for existing subscription",
            {
              webhookId: existingId,
              eventCount: normalized.selectors.length,
            },
          );
        } catch (updateError) {
          logger.warn("Could not update events on existing Close webhook", {
            webhookId: existingId,
            error: updateError,
          });
        }

        // Close includes `signature_key` on list/get responses. Re-use it so
        // re-provisioning (same URL) still fills Mako's Webhook Secret field —
        // the create-only path is the only place that previously returned it.
        let signingSecret = extractCloseSigningSecret(existing);
        if (!signingSecret) {
          try {
            const detailResponse = await api.get(`/webhook/${existingId}/`);
            signingSecret = extractCloseSigningSecret(detailResponse?.data);
          } catch (detailError) {
            logger.warn(
              "Could not fetch signature_key for existing Close webhook",
              {
                webhookId: existingId,
                error: detailError,
              },
            );
          }
        }

        return {
          providerWebhookId: String(existingId),
          endpointUrl: options.endpointUrl,
          signingSecret,
        };
      }
    }

    const response = await api.post("/webhook/", payload);
    const data = response?.data || {};
    const providerWebhookId = webhookIdOf(data);
    if (!providerWebhookId) {
      throw new Error(
        "Close webhook created but no subscription id returned by API",
      );
    }

    return {
      providerWebhookId: String(providerWebhookId),
      endpointUrl: options.endpointUrl,
      signingSecret: extractCloseSigningSecret(data),
    };
  } catch (error) {
    throw new Error(
      `Failed to create Close webhook subscription: ${describeProvisioningError(error)}`,
      { cause: error },
    );
  }
}
