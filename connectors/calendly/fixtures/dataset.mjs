/**
 * A synthetic Calendly account for the fixture harness. No real data: every
 * name is made up and every address is @example.com. URIs use the
 * placeholder host `BASE`, which the fixture server swaps for its own URL.
 *
 * What it exercises:
 * - 210 scheduled events, so the invitees walk loads 3 pages of 100; events
 *   97 to 103 share one start time across the first page boundary.
 * - Events with `invitees_counter.total` 0 (no request), one event of 105
 *   invitees (two pages at count 100), and one whose invitees answer 404.
 * - Rows without `updated_at` in groups, event types and contacts, which an
 *   incremental read drops.
 * - Rows updated before and after `SINCE`.
 */
export const BASE = "https://calendly.local";

const pad = (n, width = 6) => String(n).padStart(width, "0");
const uuid = (prefix, n) => `${prefix}${pad(n, 10)}`;
const iso = ms => new Date(ms).toISOString().replace(".000Z", ".000000Z");

/** The day the timeline starts; `SINCE` in the harness is 2026-08-01. */
const T0 = Date.parse("2026-06-01T08:00:00Z");
const HOUR = 3600_000;

export const ORG_URI = `${BASE}/organizations/${uuid("ORG", 1)}`;
export const USER_URI = `${BASE}/users/${uuid("USR", 1)}`;

/** The event whose invitee listing answers 404 (deleted since). */
export const GONE_EVENT = 77;
/** The event with 105 invitees. */
export const BIG_EVENT = 50;

export function buildDataset() {
  const organization = {
    uri: ORG_URI,
    name: "Fixture Org",
    plan: "teams",
    stage: "paid",
    created_at: iso(T0 - 400 * 24 * HOUR),
    updated_at: iso(T0 + 1000 * HOUR),
  };
  const me = {
    resource: {
      uri: USER_URI,
      name: "Owner One",
      email: "owner.one@example.com",
      current_organization: ORG_URI,
      created_at: iso(T0 - 300 * 24 * HOUR),
      updated_at: iso(T0),
    },
  };

  const users = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    const user = {
      uri: `${BASE}/users/${uuid("USR", n)}`,
      name: `Member ${n}`,
      email: `member.${n}@example.com`,
      slug: `member-${n}`,
      timezone: "Europe/Paris",
      scheduling_url: `https://calendly.example.com/member-${n}`,
      avatar_url: null,
      locale: "en",
      created_at: iso(T0 - 200 * 24 * HOUR),
      updated_at: iso(T0 + n * 400 * HOUR),
    };
    return {
      uri: `${BASE}/organization_memberships/${uuid("MEM", n)}`,
      role: n === 1 ? "owner" : "user",
      user,
      organization: ORG_URI,
      created_at: iso(T0 - 200 * 24 * HOUR),
      updated_at: iso(T0 + n * 400 * HOUR),
    };
  });

  const groups = Array.from({ length: 4 }, (_, i) => {
    const n = i + 1;
    return {
      uri: `${BASE}/groups/${uuid("GRP", n)}`,
      name: `Group ${n}`,
      organization: ORG_URI,
      member_count: n * 2,
      created_at: iso(T0 - 100 * 24 * HOUR),
      // Group 4 carries no update time.
      ...(n === 4 ? {} : { updated_at: iso(T0 + n * 700 * HOUR) }),
    };
  });

  const typeNames = [
    "Valuation",
    "Intro call",
    "Demo",
    "Follow-up",
    "Audit",
    "Kickoff",
    "Zoom tour",
  ];
  const eventTypes = typeNames.map((name, i) => {
    const n = i + 1;
    return {
      uri: `${BASE}/event_types/${uuid("ET", n)}`,
      name,
      slug: name.toLowerCase().replace(/[^a-z]+/g, "-"),
      type: "StandardEventType",
      kind: "solo",
      active: n !== 6,
      color: "#0069ff",
      duration: 15 * n,
      duration_options: n % 2 ? [15, 30] : null,
      booking_method: "instant",
      admin_managed: false,
      scheduling_url: `https://calendly.example.com/t/${n}`,
      secret: false,
      is_paid: false,
      locale: "en",
      position: i,
      pooling_type: null,
      internal_note: n === 3 ? "Fixture note" : null,
      description_plain: `About ${name}`,
      description_html: `<p>About ${name}</p>`,
      profile: {
        type: "User",
        name: "Member 1",
        owner: `${BASE}/users/${uuid("USR", 1)}`,
      },
      custom_questions: [{ name: "Address", type: "string", position: 0 }],
      locations: n % 3 ? [{ kind: "physical", location: "Office" }] : null,
      created_at: iso(T0 - 50 * 24 * HOUR),
      deleted_at: null,
      // Event type 5 carries no update time.
      ...(n === 5
        ? { updated_at: null }
        : { updated_at: iso(T0 + n * 300 * HOUR) }),
    };
  });

  const contacts = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return {
      uri: `${BASE}/contacts/${uuid("CON", n)}`,
      organization: ORG_URI,
      name: `Contact ${n}`,
      first_name: "Contact",
      last_name: String(n),
      email: `contact.${n}@example.com`,
      phone_number: null,
      title: null,
      company: n % 2 ? "Example SA" : null,
      source: "booking",
      notes: null,
      owner: USER_URI,
      avatar_url: null,
      created_at: iso(T0 + n * 100 * HOUR),
      ...(n === 2 ? {} : { updated_at: iso(T0 + n * 500 * HOUR) }),
    };
  });

  const scheduledEvents = [];
  const invitees = new Map();
  for (let i = 1; i <= 210; i++) {
    // Events 97 to 103 start at the same instant.
    const slot = i >= 97 && i <= 103 ? 97 : i;
    const start = T0 + slot * 12 * HOUR;
    const count = i === BIG_EVENT ? 105 : i % 10 === 3 ? 0 : 1 + (i % 3);
    const uri = `${BASE}/scheduled_events/${uuid("EV", i)}`;
    scheduledEvents.push({
      uri,
      name: typeNames[i % typeNames.length],
      status: i % 17 === 0 ? "canceled" : "active",
      start_time: iso(start),
      end_time: iso(start + HOUR),
      event_type: eventTypes[i % eventTypes.length].uri,
      location: { type: "physical", location: "Office" },
      invitees_counter: {
        total: count,
        active: count,
        limit: Math.max(1, count),
      },
      created_at: iso(start - 72 * HOUR),
      updated_at: iso(start - 24 * HOUR),
      event_memberships: [
        { user: USER_URI, user_email: "owner.one@example.com" },
      ],
      event_guests: [],
      meeting_notes_plain: null,
      meeting_notes_html: null,
      calendar_event:
        i % 4 ? { kind: "google", external_id: `ext-${i}` } : null,
      ...(i % 17 === 0
        ? {
            cancellation: {
              canceled_by: "Member 1",
              reason: null,
              canceler_type: "host",
            },
          }
        : {}),
    });
    const rows = [];
    for (let k = 1; k <= count; k++) {
      const id = i * 1000 + k;
      rows.push({
        uri: `${uri}/invitees/${uuid("INV", id)}`,
        event: uri,
        email: `invitee.${id}@example.com`,
        name: `Invitee ${id}`,
        first_name: "Invitee",
        last_name: String(id),
        status: "active",
        timezone: "Europe/Paris",
        cancel_url: `https://calendly.example.com/cancellations/${id}`,
        reschedule_url: `https://calendly.example.com/reschedulings/${id}`,
        rescheduled: false,
        old_invitee: null,
        new_invitee: null,
        questions_and_answers: [
          { question: "Address", answer: `${id} Fixture St`, position: 0 },
        ],
        tracking: { utm_source: k % 2 ? "google" : null, utm_campaign: null },
        text_reminder_number: null,
        no_show: null,
        reconfirmation: null,
        payment: null,
        routing_form_submission: null,
        scheduling_method: null,
        invitee_scheduled_by: null,
        cancellation: null,
        created_at: iso(start - 72 * HOUR + k * 1000),
        updated_at: iso(start - 24 * HOUR + k * 1000),
      });
    }
    invitees.set(uuid("EV", i), rows);
  }

  return {
    me,
    organization,
    lists: {
      "/organization_memberships": users,
      "/groups": groups,
      "/event_types": eventTypes,
      "/scheduled_events": scheduledEvents,
      "/contacts": contacts,
    },
    invitees,
    goneEvent: uuid("EV", GONE_EVENT),
  };
}
