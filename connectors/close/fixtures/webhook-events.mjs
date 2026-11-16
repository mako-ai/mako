/**
 * Synthetic Close webhook deliveries, one per event type the connector
 * subscribes to plus the edge cases, built from the synthetic dataset. No
 * real payload is used. The signing key is a fixed test value.
 */
import crypto from "node:crypto";
import { buildDataset, closeId } from "./dataset.mjs";

/** Hex, as Close's `signature_key` is. A test value, not a real key. */
export const TEST_SIGNING_KEY = "0f".repeat(32);

const OBJECT_SOURCES = {
  lead: "lead",
  contact: "contact",
  opportunity: "opportunity",
  "activity.call": "activity.call",
  "activity.email": "activity.email",
  "activity.email_thread": "activity.email_thread",
  "activity.sms": "activity.sms",
  "activity.note": "activity.note",
  "activity.meeting": "activity.meeting",
  "activity.lead_status_change": "activity.lead_status_change",
  "activity.opportunity_status_change": "activity.opportunity_status_change",
  "activity.task_completed": "activity.task_completed",
  "activity.custom_activity": "activity.custom_activity",
};

function dataFor(dataset, objectType, n) {
  const source = OBJECT_SOURCES[objectType];
  if (source) {
    const rows = dataset.search[source];
    return rows[n % rows.length];
  }
  if (objectType.startsWith("custom_fields.")) {
    const type = objectType.slice("custom_fields.".length);
    return (dataset.lists[
      `/custom_field/${type === "custom_object" ? "custom_object_type" : type}/`
    ] ?? [])[0];
  }
  const lists = {
    custom_activity_type: "/custom_activity/",
    custom_object_type: "/custom_object_type/",
    "status.lead": "/status/lead/",
    "status.opportunity": "/status/opportunity/",
    group: "/group/",
  };
  if (lists[objectType]) return dataset.lists[lists[objectType]][0];
  if (objectType === "custom_object") {
    return {
      id: closeId("custobj", n),
      name: `Object ${n}`,
      organization_id: dataset.me.organizations[0].id,
      lead_id: dataset.search.lead[0].id,
      custom_object_type_id: dataset.lists["/custom_object_type/"][0].id,
      date_created: "2026-10-01T08:00:00.000000+00:00",
      date_updated: "2026-10-02T08:00:00.000000+00:00",
      custom: {
        [dataset.lists["/custom_field/custom_object_type/"][0].id]: "x",
      },
    };
  }
  return null;
}

/** The stored event: `{ eventId, eventType, rawPayload }`. */
export function buildWebhookEvents(events) {
  const dataset = buildDataset();
  const out = [];
  let n = 0;
  const envelope = (objectType, action, data, extra = {}) => {
    n++;
    const at = `2026-11-0${(n % 9) + 1}T10:00:00.${String(n).padStart(6, "0")}+00:00`;
    return {
      subscription_id: "whsub_fixture",
      event: {
        id: closeId("ev", n),
        object_type: objectType,
        action,
        object_id: data?.id,
        organization_id: dataset.me.organizations[0].id,
        date_created: at,
        date_updated: at,
        data,
        previous_data: {},
        ...extra,
      },
    };
  };
  const push = (eventType, rawPayload, eventId = rawPayload?.event?.id) =>
    out.push({
      eventId: eventId ?? `none_${out.length}`,
      eventType,
      rawPayload,
    });

  for (const eventType of events) {
    const dot = eventType.lastIndexOf(".");
    const objectType = eventType.slice(0, dot);
    const action = eventType.slice(dot + 1);
    if (objectType === "membership") {
      const user = dataset.lists["/user/"][n % 7];
      push(
        eventType,
        envelope("membership", action, { id: closeId("memb", n), user }),
      );
      continue;
    }
    const data = dataFor(dataset, objectType, n);
    push(
      eventType,
      envelope(objectType, action, action === "deleted" ? undefined : data, {
        object_id: data?.id,
      }),
    );
  }

  // Legacy user.* events still route to users.
  for (const action of ["created", "updated", "deleted"]) {
    const user = dataset.lists["/user/"][1];
    push(`user.${action}`, envelope("user", action, user));
  }
  // Membership with only a user id.
  push(
    "membership.deactivated",
    envelope("membership", "deactivated", {
      user_id: dataset.lists["/user/"][2].id,
    }),
  );
  // No event-level time: the record time is read from the data.
  {
    const lead = dataset.search.lead[3];
    const payload = envelope("lead", "updated", lead);
    delete payload.event.date_created;
    delete payload.event.date_updated;
    push("lead.updated", payload);
  }
  // Flat dotted custom fields, as some deliveries carry them.
  {
    const contact = { ...dataset.search.contact[2] };
    for (const [id, value] of Object.entries(contact.custom ?? {})) {
      contact[`custom.${id}`] = value;
    }
    delete contact.custom;
    push("contact.updated", envelope("contact", "updated", contact));
  }
  // Merged lead.
  push("lead.merged", envelope("lead", "merged", dataset.search.lead[5]));
  // Nothing to extract: no id anywhere.
  push(
    "lead.updated",
    { event: { object_type: "lead", action: "updated" } },
    "ev_empty",
  );
  // An event type the connector does not map.
  push(
    "export.lead.completed",
    envelope("export.lead", "completed", { id: "expo_1" }),
  );

  return out;
}

/** Signature cases: a valid delivery, a tampered body, missing pieces. */
export function buildDeliveries(event) {
  const payload = JSON.stringify(event);
  const timestamp = "1763290800";
  const sign = (key, body) =>
    crypto
      .createHmac("sha256", Buffer.from(key, "hex"))
      .update(timestamp + body)
      .digest("hex");
  const good = sign(TEST_SIGNING_KEY, payload);
  return [
    {
      name: "valid",
      payload,
      headers: { "close-sig-hash": good, "close-sig-timestamp": timestamp },
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "tampered body",
      payload: payload.replace("whsub_fixture", "whsub_fixturX"),
      headers: { "close-sig-hash": good, "close-sig-timestamp": timestamp },
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "wrong key",
      payload,
      headers: {
        "close-sig-hash": sign("1e".repeat(32), payload),
        "close-sig-timestamp": timestamp,
      },
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no hash header",
      payload,
      headers: { "close-sig-timestamp": timestamp },
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no timestamp header",
      payload,
      headers: { "close-sig-hash": good },
      secret: TEST_SIGNING_KEY,
    },
    {
      name: "no secret",
      payload,
      headers: { "close-sig-hash": good, "close-sig-timestamp": timestamp },
      secret: undefined,
    },
  ];
}
