/**
 * Close webhook subscriptions, as Mako provisions them for a boxed Close
 * connector (workspace/webhook-provisioners.ts): the HTTP client on the
 * per-key rate gate, the supported event selectors, entity → events, and
 * create / adopt of the webhook on the flow's URL.
 */
import axios, { AxiosInstance, AxiosResponse } from "axios";
import type {
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
} from "../base/BaseConnector";
import {
  getErrorStatus,
  isRetryableHttpError,
  withHttpRetry,
} from "../base/http-retry";
import { throttledRequest } from "../rate-gate";
import { loggers } from "../../logging";

const logger = loggers.connector("close");

export const CLOSE_DEFAULT_BASE_URL = "https://api.close.com/api/v1";

/**
 * Retries per Close request (shared policy in base/http-retry.ts). Close
 * rate limits are per key and frequent during bulk syncs, and its
 * Retry-After is honoured, so allow more than the default.
 */
const CLOSE_MAX_RETRIES = 8;

/** Minimum spacing between provisioning requests on the key's rate gate. */
const CLOSE_PROVISIONING_MIN_DELAY_MS = 500;

/**
 * Whether a Close request only reads, so repeating it is harmless: a GET,
 * the search API (a POST that reads), or a POST tunnelled as GET via
 * `x-http-method-override`.
 */
function isCloseReadRequest(
  method: string,
  endpoint: string,
  args: unknown[],
): boolean {
  if (method === "get") return true;
  if (method !== "post") return false;
  if (endpoint === "/data/search/") return true;
  const config = args[2] as { headers?: Record<string, unknown> } | undefined;
  const override = config?.headers?.["x-http-method-override"];
  return typeof override === "string" && override.toUpperCase() === "GET";
}

const WRAPPED_METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * The Close client: basic auth with the API key, every verb through the
 * per-key rate gate (shared with syncs and the connection proxy) and the
 * shared retry policy.
 */
export function createCloseClient(options: {
  apiKey: string;
  /** Minimum spacing between requests on this key's rate gate. */
  minDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}): AxiosInstance {
  const { apiKey, minDelayMs, sleep } = options;
  // The rate gate's key as the connection proxy keys it (trimmed,
  // connections/callable.ts), so sync and proxy wait at one gate.
  const gateKey = String(apiKey).trim();

  const rawClient = axios.create({
    baseURL: CLOSE_DEFAULT_BASE_URL,
    auth: {
      username: apiKey,
      password: "",
    },
    headers: {
      "Content-Type": "application/json",
    },
  });

  // Wrap get/post/put/patch/delete through the per-API-key throttle
  // so concurrent flows sharing the same key don't blast the rate limit.
  return new Proxy(rawClient, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (
        typeof val !== "function" ||
        typeof prop !== "string" ||
        !WRAPPED_METHODS.includes(prop)
      ) {
        return val;
      }
      return (...args: unknown[]) => {
        const endpoint = typeof args[0] === "string" ? args[0] : "";
        return withHttpRetry(
          () =>
            throttledRequest(
              gateKey,
              () => val.apply(target, args) as Promise<AxiosResponse>,
              minDelayMs,
            ),
          {
            maxRetries: CLOSE_MAX_RETRIES,
            // Outside the gate: a backoff wait never holds it.
            sleep: ms => sleep(ms),
            // Reads retry on 429/5xx/network. A write is retried only
            // on 429 (not processed), never after a 5xx or a dropped
            // connection, which may have applied it.
            isRetryable: error =>
              isCloseReadRequest(prop, endpoint, args)
                ? isRetryableHttpError(error)
                : getErrorStatus(error) === 429,
            onRetry: ({ status, attempt, delayMs }) => {
              logger.warn("Close API request retrying", {
                endpoint,
                status,
                attempt,
                delayMs,
              });
            },
          },
        );
      };
    },
  });
}

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
 * (workspace/webhook-provisioners.ts) to retarget a flow on save.
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
 * Close provisioning on the connection's key (api.close.com): create, or
 * adopt the webhook already on the URL. `api` replaces the client in tests.
 */
export function closeWebhookProvisioning(apiKey: string, api?: AxiosInstance) {
  const client =
    api ??
    createCloseClient({
      apiKey,
      minDelayMs: CLOSE_PROVISIONING_MIN_DELAY_MS,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
  return {
    create: (options: ProvisionWebhookOptions) =>
      provisionCloseWebhook(client, options, closeWebhookEventsForEntities),
    update: (options: ProvisionWebhookOptions) =>
      adoptCloseWebhook(client, options, closeWebhookEventsForEntities),
  };
}
