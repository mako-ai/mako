/**
 * Close webhooks: the supported event selectors, event → entity mapping,
 * payload extraction, signature verification and subscription provisioning.
 */
import axios, { AxiosInstance } from "axios";
import {
  WebhookEnrichmentRetryError,
  type ProvisionWebhookOptions,
  type ProvisionWebhookResult,
  type WebhookEventMapping,
  type WebhookHandlerOptions,
  type WebhookVerificationResult,
} from "../base/BaseConnector";
import {
  hmacHex,
  rawWebhookBody,
  timingSafeEqualString,
} from "../base/webhook-signature";
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
    const expectedSignature = hmacHex(Buffer.from(secret, "hex"), data);

    if (!timingSafeEqualString(expectedSignature, sigHash)) {
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

/**
 * Adopt the Close webhook already on `options.endpointUrl`: set its events
 * and return its id and signing key. Resolves to null when none targets the
 * URL, so the caller creates one. Boxed Close connectors use it
 * (workspace/webhook-provisioners.ts); the built-in keeps its button.
 */
export async function adoptCloseWebhook(
  api: AxiosInstance,
  options: ProvisionWebhookOptions,
  eventsForEntities: (entities: string[]) => string[],
): Promise<ProvisionWebhookResult | null> {
  let list: Array<Record<string, unknown>>;
  try {
    const response = await api.get("/webhook/");
    list = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.data?.data)
        ? response.data.data
        : [];
  } catch (error) {
    throw new Error(
      `Failed to list Close webhook subscriptions: ${describeProvisioningError(error)}`,
      { cause: error },
    );
  }
  // The same match provisionCloseWebhook adopts by: `url`, else `endpoint`.
  const existing = list.find(
    item =>
      (item?.url === options.endpointUrl ||
        item?.endpoint === options.endpointUrl) &&
      webhookIdOf(item),
  );
  if (!existing) return null;
  const webhookId = String(webhookIdOf(existing));

  const requested = (options.events ?? [])
    .map(event => event.trim())
    .filter(event => event.length > 0);
  const { selectors } = normalizeEventSelectors(
    requested.length > 0
      ? requested
      : eventsForEntities(options.enabledEntities ?? []),
  );
  if (selectors.length === 0) {
    throw new Error("No valid Close webhook events configured");
  }

  // The event update is the point of adopting: a failed PUT fails the call,
  // so the save reports it, instead of keeping the old event list silently.
  try {
    await api.put(`/webhook/${webhookId}/`, { events: selectors });
  } catch (error) {
    throw new Error(
      `Failed to update the events of Close webhook ${webhookId}: ${describeProvisioningError(error)}`,
      { cause: error },
    );
  }

  let signingSecret = extractCloseSigningSecret(existing);
  if (!signingSecret) {
    try {
      const detail = await api.get(`/webhook/${webhookId}/`);
      signingSecret = extractCloseSigningSecret(detail?.data);
    } catch (error) {
      throw new Error(
        `Failed to read the signing key of Close webhook ${webhookId}: ${describeProvisioningError(error)}`,
        { cause: error },
      );
    }
  }
  return {
    providerWebhookId: webhookId,
    endpointUrl: options.endpointUrl,
    signingSecret,
  };
}

/**
 * Columns a Close webhook leaves out of an object's payload, per entity.
 *
 * Close event payloads are the object's own row without its expansions:
 * `lead.*` carries no `contacts`, `opportunities`, `tasks`, `html_url`,
 * `integration_links`, `primary_email` or `primary_phone`; `contact.*`
 * no `display_name` or `integration_links`; `opportunity.*` no
 * `status_display_name`, `pipeline_name`, `stall_status` or
 * `integration_links`; `activity.email.*` no `body_*_quoted`;
 * `activity.email_thread.*` no `latest_emails`. Checked against Close's
 * event log and against the PL warehouse, where every webhook-written row
 * had these columns NULL and every backfilled row had them filled.
 *
 * The CDC writer replaces the whole row, so an upsert without these keys
 * NULLs them. fillCloseWebhookPartialRecords reads them from the REST
 * object before the record is applied.
 */
export const CLOSE_WEBHOOK_FILL_FIELDS: Readonly<
  Record<string, { path: string; fields: readonly string[] }>
> = {
  leads: {
    path: "/lead/",
    fields: [
      "contacts",
      "opportunities",
      "tasks",
      "html_url",
      "integration_links",
      "primary_email",
      "primary_phone",
    ],
  },
  contacts: {
    path: "/contact/",
    fields: ["display_name", "integration_links"],
  },
  opportunities: {
    path: "/opportunity/",
    fields: [
      "status_display_name",
      "pipeline_name",
      "stall_status",
      "integration_links",
    ],
  },
  "activities:Email": {
    path: "/activity/email/",
    fields: ["body_html_quoted", "body_text_quoted"],
  },
  "activities:EmailThread": {
    path: "/activity/emailthread/",
    fields: ["latest_emails"],
  },
};

type FillableRecord = {
  entity: string;
  recordId: string;
  operation: string;
  payload?: unknown;
};

/**
 * How long one ingest run may spend reading Close objects for one flow.
 * Webhook ingest is one serial loop across every workspace, so an unbounded
 * fill would let one bulk edit stall every other flow's webhooks. At the
 * fill client's 100 ms gate pause plus ~200 ms per read, 30 s is ~100 reads
 * per flow per 5-minute run (~29k a day). Records past the budget wait for
 * a later run (WebhookEnrichmentRetryError `defer`).
 */
export const CLOSE_WEBHOOK_FILL_BUDGET_MS = Math.max(
  parseInt(process.env.CLOSE_WEBHOOK_FILL_BUDGET_MS || "30000", 10) || 30000,
  1000,
);

/** Gate pause after each fill read (see CloseConnector.getWebhookFillClient). */
export const CLOSE_WEBHOOK_FILL_MIN_DELAY_MS = 100;

/** Wall-clock budget for fill reads, shared by one connector instance. */
export class CloseWebhookFillBudget {
  private spentMs = 0;
  constructor(
    private readonly limitMs: number = CLOSE_WEBHOOK_FILL_BUDGET_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  exhausted(): boolean {
    return this.spentMs >= this.limitMs;
  }

  async spend<T>(work: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await work();
    } finally {
      this.spentMs += this.now() - startedAt;
    }
  }
}

/**
 * Complete partial webhook upserts with the fields Close leaves out (see
 * CLOSE_WEBHOOK_FILL_FIELDS), so applying the record never NULLs them.
 *
 * One `GET /<object>/<id>/?_fields=<missing>` per record that lacks any of
 * its entity's fill fields. The REST object endpoint reads the primary
 * store (the Search API lags and has a 16-request bucket; the object
 * endpoint has 240) and the client waits at the key's shared rate gate.
 * Only absent keys are filled: the webhook's own values win.
 *
 * A partial record is never returned unfilled:
 * - 404 (object deleted or merged after the event): the record is dropped.
 *   Its delete event follows.
 * - Budget spent: WebhookEnrichmentRetryError `defer`. The event waits for
 *   the retry cron (every 30 min) and keeps its retry count.
 * - Any other failure (after the client's retries): `fail`. The event is
 *   marked failed and the retry cron takes it again.
 */
export async function fillCloseWebhookPartialRecords<T extends FillableRecord>(
  api: () => AxiosInstance,
  records: T[],
  options: {
    shouldFill?: (record: T) => boolean;
    budget?: CloseWebhookFillBudget;
  } = {},
): Promise<T[]> {
  const shouldFill = options.shouldFill ?? (() => true);
  const out: T[] = [];
  for (const record of records) {
    const spec = shouldFill(record)
      ? CLOSE_WEBHOOK_FILL_FIELDS[record.entity]
      : undefined;
    const payload =
      record.payload && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : null;
    if (!spec || record.operation !== "upsert" || !payload) {
      out.push(record);
      continue;
    }
    const missing = spec.fields.filter(field => !(field in payload));
    if (missing.length === 0) {
      out.push(record);
      continue;
    }
    if (options.budget?.exhausted()) {
      throw new WebhookEnrichmentRetryError(
        `Close fill budget for this run is spent; ${record.entity} ${record.recordId} waits for the next run`,
        "defer",
      );
    }

    let fetched: Record<string, unknown>;
    try {
      const read = () =>
        api().get(`${spec.path}${encodeURIComponent(record.recordId)}/`, {
          params: { _fields: missing.join(",") },
        });
      const response = options.budget
        ? await options.budget.spend(read)
        : await read();
      fetched = (response?.data ?? {}) as Record<string, unknown>;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 404) {
        logger.info("Close webhook object is gone; skipping its upsert", {
          entity: record.entity,
          recordId: record.recordId,
        });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Could not read the full Close object for a webhook upsert", {
        entity: record.entity,
        recordId: record.recordId,
        status,
        error: message,
      });
      throw new WebhookEnrichmentRetryError(
        `Could not read Close ${record.entity} ${record.recordId}${status ? ` (HTTP ${status})` : ""}: ${message}`,
        "fail",
      );
    }

    const filled: Record<string, unknown> = { ...payload };
    for (const field of missing) {
      // A field Close omits from the object too is stored as NULL, as a
      // backfill would store it.
      filled[field] = field in fetched ? fetched[field] : null;
    }
    out.push({ ...record, payload: filled });
  }
  return out;
}
