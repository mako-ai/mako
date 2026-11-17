/**
 * Synthetic Calendly webhook deliveries, built from the synthetic dataset.
 * No real payload is used. The signing key is a fixed test value.
 *
 * A Calendly delivery body is `{ event, created_at, created_by, payload }`.
 * Mako stores it as the in-process `verifyCalendlyWebhook` returns it: the
 * body plus `type` (its `event`) and `id` (`<created_at>:<payload.uri>`).
 * `buildWebhookEvents` returns events in that stored shape.
 */
import crypto from "node:crypto";
import { BASE, buildDataset } from "./dataset.mjs";

/** A test value, not a real key. Calendly keys are text, used as UTF-8. */
export const TEST_SIGNING_KEY = "calendly_fixture_signing_key_000001";

/** The fixed send time of every delivery, Unix seconds (2025-11-16T11:00:00Z). */
export const DELIVERY_TIMESTAMP = 1763290800;

/**
 * The embedded `scheduled_event` as Calendly's webhook sends it: no
 * `calendar_event` (absent from 29,984 of 29,984 webhook payloads in
 * RealAdvisor's warehouse), `cancellation` only when canceled.
 */
export function webhookScheduledEvent(row) {
  const { calendar_event: _calendarEvent, ...rest } = row;
  return rest;
}

/**
 * An event type as Calendly's webhook sends it: no `slug`, `profile` or
 * `internal_note` (11 of 11 webhook-written rows lacked them).
 */
export function webhookEventType(row) {
  const { slug: _slug, profile: _profile, internal_note: _note, ...rest } = row;
  return rest;
}

/** The stored event for a delivery body, as the API stores it. */
export function storedEvent(body) {
  const uri = body?.payload?.uri;
  return {
    ...body,
    type: typeof body?.event === "string" ? body.event : undefined,
    id:
      typeof uri === "string" ? `${body?.created_at ?? ""}:${uri}` : undefined,
  };
}

/** `{ eventId, eventType, rawPayload }` per case, in the stored shape. */
export function buildWebhookEvents() {
  const dataset = buildDataset();
  const events = dataset.lists["/scheduled_events"];
  const types = dataset.lists["/event_types"];
  const inviteeOf = n =>
    dataset.invitees.get(events[n].uri.split("/").pop())[0];
  const out = [];
  let n = 0;
  const push = (eventType, body) => {
    n++;
    const stored = storedEvent(body);
    out.push({
      eventId: stored.id ?? `fixture-event-${n}`,
      eventType,
      rawPayload: stored,
    });
  };
  const envelope = (event, payload, at) => ({
    event,
    created_at: at,
    created_by: `${BASE}/users/USR0000000001`,
    ...(payload === undefined ? {} : { payload }),
  });

  // An invitee booked: the invitee and its scheduled event.
  push(
    "invitee.created",
    envelope(
      "invitee.created",
      { ...inviteeOf(0), scheduled_event: webhookScheduledEvent(events[0]) },
      "2026-11-01T10:00:00.000000Z",
    ),
  );
  // A cancellation, on a canceled event.
  const canceled = events.find(e => e.status === "canceled");
  const canceledIndex = events.indexOf(canceled);
  push(
    "invitee.canceled",
    envelope(
      "invitee.canceled",
      {
        ...inviteeOf(canceledIndex),
        status: "canceled",
        cancellation: {
          canceled_by: "Invitee",
          reason: "Moved",
          canceler_type: "invitee",
        },
        scheduled_event: webhookScheduledEvent(canceled),
      },
      "2026-11-02T10:00:00.000000Z",
    ),
  );
  push(
    "invitee_no_show.created",
    envelope(
      "invitee_no_show.created",
      {
        ...inviteeOf(4),
        no_show: {
          uri: `${BASE}/invitee_no_shows/NS1`,
          created_at: "2026-11-03T10:00:00.000000Z",
        },
        scheduled_event: webhookScheduledEvent(events[4]),
      },
      "2026-11-03T10:00:00.000000Z",
    ),
  );
  push(
    "event_type.created",
    envelope(
      "event_type.created",
      webhookEventType(types[0]),
      "2026-11-04T10:00:00.000000Z",
    ),
  );
  push(
    "event_type.updated",
    envelope(
      "event_type.updated",
      webhookEventType(types[2]),
      "2026-11-05T10:00:00.000000Z",
    ),
  );
  // An invitee without its scheduled event: the invitee alone.
  const { scheduled_event: _s, ...bare } = inviteeOf(5);
  push(
    "invitee.created",
    envelope("invitee.created", bare, "2026-11-06T10:00:00.000000Z"),
  );
  // A type the connector does not map.
  push(
    "routing_form_submission.created",
    envelope(
      "routing_form_submission.created",
      {
        uri: `${BASE}/routing_form_submissions/RFS1`,
        questions_and_answers: [],
      },
      "2026-11-07T10:00:00.000000Z",
    ),
  );
  // Mapped, but nothing to extract: no payload, and an event type without uri.
  push(
    "invitee.created",
    envelope("invitee.created", undefined, "2026-11-08T10:00:00.000000Z"),
  );
  const { uri: _uri, ...noUri } = webhookEventType(types[1]);
  push(
    "event_type.updated",
    envelope("event_type.updated", noUri, "2026-11-09T10:00:00.000000Z"),
  );
  return out;
}

const sign = (key, t, body) =>
  crypto.createHmac("sha256", key).update(`${t}.${body}`, "utf8").digest("hex");

/**
 * Signature cases for one delivery body, all sent at DELIVERY_TIMESTAMP
 * (check them with the clock at that instant): a valid one, and every way
 * the in-process check refuses one.
 */
export function buildDeliveries(body) {
  const payload = JSON.stringify(body);
  const t = String(DELIVERY_TIMESTAMP);
  const good = sign(TEST_SIGNING_KEY, t, payload);
  const header = value => ({ "calendly-webhook-signature": value });
  const stale = String(DELIVERY_TIMESTAMP - 600);
  return [
    {
      name: "valid",
      payload,
      headers: header(`t=${t},v1=${good}`),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "valid, spaces after commas",
      payload,
      headers: header(`t=${t}, v1=${good}`),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "tampered body",
      payload: payload.replace("invitee", "invitex"),
      headers: header(`t=${t},v1=${good}`),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "wrong key",
      payload,
      headers: header(
        `t=${t},v1=${sign("another_fixture_signing_key_0002", t, payload)}`,
      ),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "timestamp changed",
      payload,
      headers: header(`t=${Number(t) + 1},v1=${good}`),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "stale (10 minutes old)",
      payload,
      headers: header(
        `t=${stale},v1=${sign(TEST_SIGNING_KEY, stale, payload)}`,
      ),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no v1",
      payload,
      headers: header(`t=${t}`),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no t",
      payload,
      headers: header(`v1=${good}`),
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no signature header",
      payload,
      headers: {},
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no secret",
      payload,
      headers: header(`t=${t},v1=${good}`),
      secret: undefined,
    },
  ];
}
