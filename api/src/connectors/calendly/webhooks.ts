/**
 * Calendly webhooks: organization-scoped subscriptions, signature
 * verification (`Calendly-Webhook-Signature: t=…,v1=…`), event mapping and
 * payload → CDC records.
 */
import type {
  NormalizedCdcRecord,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  WebhookEventMapping,
  WebhookHandlerOptions,
  WebhookVerificationResult,
} from "../base/BaseConnector";
import { headerValue } from "../base/http-client";
import {
  hmacHex,
  rawWebhookBody,
  timingSafeEqualHex,
} from "../base/webhook-signature";
import {
  formatCalendlyApiError,
  uuidFromUri,
  withId,
  type CalendlyContext,
} from "./client";

const WEBHOOK_MAX_SKEW_SECONDS = 3 * 60;

export const CALENDLY_SUPPORTED_WEBHOOK_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "event_type.created",
  "event_type.updated",
] as const;

type SupportedWebhookEvent = (typeof CALENDLY_SUPPORTED_WEBHOOK_EVENTS)[number];

const EVENT_MAPPINGS: Record<string, WebhookEventMapping> = {
  "invitee.created": { entity: "invitees", operation: "upsert" },
  "invitee.canceled": { entity: "invitees", operation: "upsert" },
  "invitee_no_show.created": { entity: "invitees", operation: "upsert" },
  "event_type.created": { entity: "event_types", operation: "upsert" },
  "event_type.updated": { entity: "event_types", operation: "upsert" },
};

export function calendlyWebhookEventMapping(
  eventType: string,
): WebhookEventMapping | null {
  const mapping = EVENT_MAPPINGS[eventType];
  return mapping ? { ...mapping } : null;
}

export function calendlyWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return [...CALENDLY_SUPPORTED_WEBHOOK_EVENTS];
  const normalized = new Set(entities.map(e => e.toLowerCase()));
  const events = new Set<SupportedWebhookEvent>();

  if (normalized.has("invitees")) {
    events.add("invitee.created");
    events.add("invitee.canceled");
    events.add("invitee_no_show.created");
  }
  if (normalized.has("scheduled_events")) {
    events.add("invitee.created");
    events.add("invitee.canceled");
  }
  if (normalized.has("event_types")) {
    events.add("event_type.created");
    events.add("event_type.updated");
  }

  return Array.from(events);
}

/** Create the organization-scoped subscription for the flow URL. */
export async function provisionCalendlyWebhook(
  ctx: CalendlyContext,
  options: ProvisionWebhookOptions,
  eventsForEntities: (entities: string[]) => string[],
): Promise<ProvisionWebhookResult> {
  const api = ctx.api();
  const { organization_uri } = await ctx.currentUser();

  const requestedEvents = Array.isArray(options.events)
    ? options.events
        .map(event => event.trim())
        .filter(event => event.length > 0)
    : [];

  const effectiveEvents =
    requestedEvents.length > 0
      ? requestedEvents
      : eventsForEntities(options.enabledEntities ?? []);

  const events = effectiveEvents.filter(event =>
    (CALENDLY_SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event),
  );

  if (events.length === 0) {
    throw new Error(
      requestedEvents.length > 0
        ? `No valid Calendly webhook events configured. Calendly only emits: ${CALENDLY_SUPPORTED_WEBHOOK_EVENTS.join(", ")}`
        : "No webhook events resolved for the selected entities",
    );
  }

  const payload = {
    url: options.endpointUrl,
    events,
    organization: organization_uri,
    scope: "organization",
  };

  try {
    const response = await ctx.execute(() =>
      api.post("/webhook_subscriptions", payload),
    );
    const resource = (response.data as { resource?: Record<string, unknown> })
      ?.resource;
    const providerWebhookId =
      uuidFromUri(resource?.uri) || String(resource?.uri ?? "");
    if (!providerWebhookId) {
      throw new Error(
        "Calendly webhook created but no subscription URI returned by API",
      );
    }
    const signingSecret =
      typeof resource?.signing_key === "string"
        ? (resource.signing_key as string)
        : undefined;
    return {
      providerWebhookId,
      endpointUrl: options.endpointUrl,
      signingSecret,
    };
  } catch (error) {
    throw new Error(
      `Failed to create Calendly webhook subscription: ${formatCalendlyApiError(error)}`,
      { cause: error },
    );
  }
}

/** `t=…,v1=…` → { t, v1 } (whitespace trimmed, malformed parts dropped). */
function parseSignatureHeader(header: string): Record<string, string> {
  return header.split(",").reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split("=");
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
}

/**
 * HMAC-SHA256 of `${t}.${body}` under the subscription's signing key, with
 * the timestamp no more than WEBHOOK_MAX_SKEW_SECONDS away.
 */
export function verifyCalendlyWebhook(
  options: WebhookHandlerOptions,
): WebhookVerificationResult {
  const { payload, headers, secret } = options;

  if (!secret) {
    return { valid: false, error: "Missing webhook secret on flow" };
  }

  const sigHeader = headerValue(headers, "Calendly-Webhook-Signature");
  if (!sigHeader) {
    return {
      valid: false,
      error: "Missing Calendly-Webhook-Signature header",
    };
  }

  const { t, v1 } = parseSignatureHeader(sigHeader);
  if (!t || !v1) {
    return {
      valid: false,
      error: "Malformed Calendly-Webhook-Signature header",
    };
  }

  const ts = Number.parseInt(t, 10);
  if (!Number.isFinite(ts)) {
    return {
      valid: false,
      error: "Malformed Calendly-Webhook-Signature header",
    };
  }
  const skewSeconds = Math.abs(Date.now() / 1000 - ts);
  if (skewSeconds > WEBHOOK_MAX_SKEW_SECONDS) {
    return { valid: false, error: "Stale webhook timestamp" };
  }

  try {
    const body = rawWebhookBody(payload);
    const expected = hmacHex(secret, `${t}.${body}`);
    if (!timingSafeEqualHex(expected, v1)) {
      return { valid: false, error: "Invalid signature" };
    }

    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;

    const eventType =
      typeof parsed?.event === "string" ? parsed.event : undefined;
    const resourceUri =
      typeof parsed?.payload?.uri === "string" ? parsed.payload.uri : undefined;

    return {
      valid: true,
      event: {
        ...parsed,
        type: eventType,
        id: resourceUri
          ? `${parsed?.created_at ?? ""}:${resourceUri}`
          : undefined,
      },
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Failed to verify webhook",
    };
  }
}

export function extractCalendlyWebhookData(
  event: unknown,
): { id: string; data: Record<string, unknown> } | null {
  const evt = event as { payload?: Record<string, unknown> } | undefined;
  const payload = evt?.payload;
  if (!payload || typeof payload !== "object") return null;
  const id = uuidFromUri(payload.uri);
  if (!id) return null;
  return { id, data: withId(payload) };
}

/**
 * CDC records of a delivery: an invitee event yields the invitee and its
 * scheduled event; an event_type event yields the event type.
 */
export function calendlyWebhookCdcRecords(
  event: unknown,
  eventType: string | undefined,
  resolveTimestamp: (payload: Record<string, unknown>) => Date,
): NormalizedCdcRecord[] {
  const resolvedType =
    eventType ||
    (typeof (event as { type?: string })?.type === "string"
      ? (event as { type: string }).type
      : typeof (event as { event?: string })?.event === "string"
        ? (event as { event: string }).event
        : undefined);

  if (!resolvedType) return [];

  const rootCreatedAt =
    typeof (event as { created_at?: string })?.created_at === "string"
      ? (event as { created_at: string }).created_at
      : undefined;

  const payload =
    (event as { payload?: Record<string, unknown> })?.payload ?? undefined;
  if (!payload || typeof payload !== "object") return [];

  const record = (
    entity: string,
    uri: string,
    data: Record<string, unknown>,
  ): NormalizedCdcRecord => ({
    entity,
    recordId: uuidFromUri(uri),
    operation: "upsert",
    payload: withId(data),
    sourceTs: resolveTimestamp(data),
    source: "webhook",
    changeId: `${rootCreatedAt ?? resolvedType}:${uri}`,
  });

  if (
    resolvedType === "invitee.created" ||
    resolvedType === "invitee.canceled" ||
    resolvedType === "invitee_no_show.created"
  ) {
    const records: NormalizedCdcRecord[] = [];
    const inviteeUri =
      typeof payload.uri === "string" ? payload.uri : undefined;
    if (inviteeUri) {
      records.push(record("invitees", inviteeUri, payload));
    }

    const scheduledEvent =
      payload.scheduled_event && typeof payload.scheduled_event === "object"
        ? (payload.scheduled_event as Record<string, unknown>)
        : undefined;
    const scheduledEventUri =
      typeof scheduledEvent?.uri === "string"
        ? (scheduledEvent.uri as string)
        : undefined;
    if (scheduledEvent && scheduledEventUri) {
      records.push(
        record("scheduled_events", scheduledEventUri, scheduledEvent),
      );
    }

    return records;
  }

  if (
    resolvedType === "event_type.created" ||
    resolvedType === "event_type.updated"
  ) {
    const uri = typeof payload.uri === "string" ? payload.uri : undefined;
    if (!uri) return [];
    return [record("event_types", uri, payload)];
  }

  return [];
}
