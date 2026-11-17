/**
 * Calendly webhooks as the SDK's `webhooks` definition.
 *
 * Mako's API verifies every delivery before it stores it, from the scheme
 * declared below as data (HMAC-SHA256 of `t.body` under the subscription's
 * signing key, `Calendly-Webhook-Signature: t=…,v1=…`, 3 minutes of skew).
 * The key never reaches a box. The stored event is the body plus `type`
 * (its `event`) and `id` (`<created_at>:<payload.uri>`), the shape the
 * in-process `verifyCalendlyWebhook` stores.
 *
 * The handler maps each event as the in-process `calendlyWebhookCdcRecords`
 * does: an invitee event yields the invitee and its embedded scheduled
 * event, an event_type event yields the event type.
 *
 * Then it fills what Calendly leaves out. A row a webhook writes first
 * lands without those columns, and a key sent null overwrites (an absent
 * key is left alone on an existing row since PR 1347). In RealAdvisor's warehouse,
 * 29,901 of 29,984 webhook-written scheduled events had `calendar_event`
 * NULL, and 11 of 11 webhook-written event types had `slug` and `profile`
 * NULL. Invitee payloads carry every invitee column. So:
 *
 * - A scheduled_events or event_types upsert that lacks (absent or null)
 *   any of its REST columns gets one `GET /scheduled_events/<uuid>` or
 *   `GET /event_types/<uuid>`, built from the record's own URI. Only the
 *   absent or null keys are filled; the webhook's non-null values win. A
 *   column the object lacks too stays null, as a backfill stores it.
 * - 404 (deleted since): the record is dropped. An event left with no
 *   record is `skipped`.
 * - Budget spent: the event is `deferred`, retried later uncounted.
 * - Each fill read is one attempt, ending with the budget: the box command
 *   is killed at 60 s. A 429, 5xx, network error or timeout is `deferred`.
 * - Any other failure: `extract_failed`. Mako retries it up to its usual 5
 *   attempts.
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
import {
  CalendlyHttpError,
  isTransientError,
  calendlyRelativePath,
  uuidFromUri,
  withId,
  type CalendlyClient,
} from "./client.ts";
import { EVENT_TYPE_FIELDS, SCHEDULED_EVENT_FIELDS } from "./schema.ts";

export const CALENDLY_SUPPORTED_WEBHOOK_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "event_type.created",
  "event_type.updated",
] as const;

const EVENT_MAPPINGS: Record<
  string,
  { entity: string; operation: "upsert" | "delete" }
> = {
  "invitee.created": { entity: "invitees", operation: "upsert" },
  "invitee.canceled": { entity: "invitees", operation: "upsert" },
  "invitee_no_show.created": { entity: "invitees", operation: "upsert" },
  "event_type.created": { entity: "event_types", operation: "upsert" },
  "event_type.updated": { entity: "event_types", operation: "upsert" },
};

export function calendlyWebhookEventMapping(
  eventType: string,
): { entity: string; operation: "upsert" | "delete" } | null {
  const mapping = EVENT_MAPPINGS[eventType];
  return mapping ? { ...mapping } : null;
}

/** The events to subscribe for a flow's entities; all for none. */
export function calendlyWebhookEventsForEntities(entities: string[]): string[] {
  if (entities.length === 0) return [...CALENDLY_SUPPORTED_WEBHOOK_EVENTS];
  const normalized = new Set(entities.map(e => e.toLowerCase()));
  const events = new Set<string>();
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

/**
 * `verifyCalendlyWebhook` as data: Calendly's header is Stripe's format,
 * `t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `<t>.<raw body>` under
 * the signing key's UTF-8 bytes, within 3 minutes.
 */
export const CALENDLY_WEBHOOK_VERIFICATION: WebhookVerification = {
  scheme: "stripe-v1",
  signatureHeader: "calendly-webhook-signature",
  secretEncoding: "utf8",
  toleranceSeconds: 180,
};

/**
 * A stored event as the in-process connector holds it: Mako stores the raw
 * body, keyed `<created_at>:<payload.uri>` and typed by `event`, as
 * in-process `verifyCalendlyWebhook` names it; in-process adds those to
 * the body as `id` and `type`.
 */
export function inProcessCalendlyEvent(event: WebhookEvent): WebhookEvent {
  const raw = event.rawPayload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return event;
  return {
    ...event,
    rawPayload: {
      ...(raw as Record<string, unknown>),
      type: event.eventType,
      id: event.eventId,
    },
  };
}

/** One change record, as the SDK's `WebhookChangeRecord`. */
export interface WebhookChangeRecord {
  entity: string;
  recordId: string;
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  sourceTs?: string;
  changeId?: string;
}

/**
 * The record's own time, as in-process `BaseConnector.resolveRecordTimestamp`
 * reads it (Calendly does not override it): the first parseable of these
 * fields, else now.
 */
export function calendlyRecordTimestamp(
  payload?: Record<string, unknown>,
): Date {
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
 * The change records of one stored event: a port of in-process
 * `calendlyWebhookCdcRecords`.
 */
export function calendlyWebhookChangeRecords(
  event: unknown,
  eventType: string | undefined,
): WebhookChangeRecord[] {
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
  ): WebhookChangeRecord => ({
    entity,
    recordId: uuidFromUri(uri),
    operation: "upsert",
    payload: withId(data),
    sourceTs: calendlyRecordTimestamp(data).toISOString(),
    changeId: `${rootCreatedAt ?? resolvedType}:${uri}`,
  });

  if (
    resolvedType === "invitee.created" ||
    resolvedType === "invitee.canceled" ||
    resolvedType === "invitee_no_show.created"
  ) {
    const records: WebhookChangeRecord[] = [];
    const inviteeUri =
      typeof payload.uri === "string" ? payload.uri : undefined;
    if (inviteeUri) records.push(record("invitees", inviteeUri, payload));
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

/**
 * A batch's outcomes before any fill: the in-process mapping, event by
 * event (`unmapped` for a type it does not map, `extract_failed` for a
 * mapped one that yields no record).
 */
export function mapWebhookBatch(
  events: Array<Pick<WebhookEvent, "eventId" | "eventType" | "rawPayload">>,
): WebhookOutcome[] {
  return events.map(({ eventId, eventType, rawPayload }) => {
    if (!calendlyWebhookEventMapping(eventType)) {
      return { eventId, outcome: "unmapped" };
    }
    const records = calendlyWebhookChangeRecords(rawPayload, eventType);
    if (records.length === 0) return { eventId, outcome: "extract_failed" };
    return { eventId, outcome: "records", records };
  });
}

/** The REST object a partial record is filled from, per entity. */
export const CALENDLY_WEBHOOK_FILL: Readonly<
  Record<string, { path: string; fields: readonly string[] }>
> = {
  scheduled_events: {
    path: "/scheduled_events/",
    fields: Object.keys(SCHEDULED_EVENT_FIELDS),
  },
  event_types: {
    path: "/event_types/",
    fields: Object.keys(EVENT_TYPE_FIELDS),
  },
};

/** A Calendly UUID: letters, digits and dashes. */
const CALENDLY_UUID = /^[A-Za-z0-9-]{1,64}$/;

/** Read time one batch may spend on fills (a batch's box command ends at 60 s). */
export const CALENDLY_WEBHOOK_FILL_BUDGET_MS = 40_000;

export interface CalendlyWebhookDeps {
  api: CalendlyClient;
  log: (message: string) => void;
  budgetMs?: number;
  now?: () => number;
}

type Filled =
  | { kind: "record"; record: WebhookChangeRecord }
  | { kind: "gone" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: string };

const missingOf = (
  payload: Record<string, unknown>,
  fields: readonly string[],
) =>
  fields.filter(
    field => payload[field] === undefined || payload[field] === null,
  );

async function fillRecord(
  deps: CalendlyWebhookDeps,
  record: WebhookChangeRecord,
  remainingMs: () => number,
): Promise<Filled> {
  const spec = CALENDLY_WEBHOOK_FILL[record.entity];
  const payload = record.payload;
  if (!spec || record.operation !== "upsert" || !payload) {
    return { kind: "record", record };
  }
  const missing = missingOf(payload, spec.fields);
  if (missing.length === 0) return { kind: "record", record };

  // The URI goes into a request: it must sit under the configured base and
  // name exactly one object of this entity.
  let path: string;
  try {
    path = calendlyRelativePath(deps.api.baseUrl, String(payload.uri ?? ""));
  } catch {
    return {
      kind: "failed",
      reason: `Not a Calendly URI: ${JSON.stringify(payload.uri).slice(0, 120)}`,
    };
  }
  const uuid = path.startsWith(spec.path) ? path.slice(spec.path.length) : "";
  if (!CALENDLY_UUID.test(uuid)) {
    return {
      kind: "failed",
      reason: `Not a Calendly ${record.entity} URI: ${JSON.stringify(payload.uri).slice(0, 120)}`,
    };
  }
  if (remainingMs() <= 0) {
    return {
      kind: "deferred",
      reason: `Calendly fill budget for this batch is spent; ${record.entity} ${uuid} waits for a retry`,
    };
  }

  let fetched: Record<string, unknown>;
  try {
    const response = (await deps.api.get(`${spec.path}${uuid}`, undefined, {
      once: true,
      timeoutMs: remainingMs(),
    })) as { resource?: Record<string, unknown> } | undefined;
    fetched = withId(response?.resource ?? {});
  } catch (error) {
    if (error instanceof CalendlyHttpError && error.status === 404) {
      deps.log(
        `Calendly ${record.entity} ${uuid} is gone; skipping its upsert`,
      );
      return { kind: "gone" };
    }
    // Rate limited, a 5xx, a slow socket: not now. Deferred, so a busy
    // vendor never uses up the event's attempts.
    if (isTransientError(error)) {
      return {
        kind: "deferred",
        reason: `Calendly could not be read now; ${record.entity} waits for a retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const status =
      error instanceof CalendlyHttpError ? ` (HTTP ${error.status})` : "";
    return {
      kind: "failed",
      reason: `Could not read Calendly ${record.entity} ${uuid}${status}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const filled: Record<string, unknown> = { ...payload };
  for (const field of missing) filled[field] = fetched[field] ?? null;
  return { kind: "record", record: { ...record, payload: filled } };
}

/** A batch in, one outcome per event out, in order. */
export async function handleCalendlyWebhookBatch(
  deps: CalendlyWebhookDeps,
  events: WebhookEvent[],
): Promise<WebhookOutcome[]> {
  const outcomes = mapWebhookBatch(events);
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? CALENDLY_WEBHOOK_FILL_BUDGET_MS;
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
        // One record that cannot be filled holds the whole event back.
        stop = {
          eventId: outcome.eventId,
          outcome: filled.kind === "deferred" ? "deferred" : "extract_failed",
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
        reason: `Calendly no longer has ${gone} object(s) of this event (404)`,
      });
    }
  }
  return out;
}

/** The SDK's `webhooks` definition, given how this process reaches Calendly. */
export function calendlyWebhookDefinition<Config>(
  deps: (ctx: Context<Config>) => CalendlyWebhookDeps,
): WebhookDefinition<Config> {
  return {
    verification: CALENDLY_WEBHOOK_VERIFICATION,
    eventIdPath: ["created_at", "payload.uri"],
    eventTypePath: "event",
    events: [...CALENDLY_SUPPORTED_WEBHOOK_EVENTS],
    handleBatch: (ctx, events) =>
      handleCalendlyWebhookBatch(deps(ctx), events.map(inProcessCalendlyEvent)),
  };
}
