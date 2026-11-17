/**
 * A synthetic Close organization, in the shapes Close's API returns.
 *
 * Nothing here comes from a real account. Every name is "Lead 0001"-style,
 * every email is @example.com, every phone is +48 000 000 xxx, and ids are
 * hashes of a counter. The shapes follow Close's API reference and the
 * in-process connector's unit-test fixtures.
 *
 * The data is built to walk every branch of the in-process read path:
 * - leads carry 70 custom fields, more than the 50 selectors the emulator
 *   accepts per request: the first page is refused, the selector budget
 *   halves to 30, and every page needs 2 by-id follow-ups;
 * - 205 leads fall in one 7-day window, so a window spans 2 pages;
 * - 220 calls fall in one half day, past the emulator's 200-row cursor limit
 *   for calls, so the walk hits a cursor error and restarts from the last
 *   value seen;
 * - long empty stretches between rows exercise the binary search;
 * - about one row in five was updated after `SINCE`, for the incremental
 *   walk on `date_updated`;
 * - users, groups and lookups span several pages at 2 rows a page.
 */
import crypto from "node:crypto";

export const ORG = "orga_fixture000000000000000000000000000000";

/** Deterministic Close-style id: `prefix_` + 41 base62 characters. */
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function closeId(prefix, n) {
  const digest = crypto.createHash("sha256").update(`${prefix}:${n}`).digest();
  let out = "";
  for (let i = 0; i < 41; i++) out += ALPHABET[digest[i % 32] % 62];
  return `${prefix}_${out}`;
}

/** A tiny seeded PRNG (mulberry32), so the dataset never changes. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Close's timestamp shape: microseconds and an explicit offset. */
const closeTs = ms =>
  new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");

const DAY = 24 * 60 * 60 * 1000;
const T = iso => Date.parse(iso);
const pad = (n, width = 4) => String(n).padStart(width, "0");

/**
 * `count` creation times: `dense` of them inside one week starting at
 * `denseStart`, the rest spread from `from` to `to`.
 */
function creationTimes(
  random,
  { count, dense, denseStart, from, to, denseDays = 5 },
) {
  const times = [];
  for (let i = 0; i < count; i++) {
    times.push(
      i < dense
        ? T(denseStart) + Math.floor(random() * denseDays * DAY)
        : T(from) + Math.floor(random() * (T(to) - T(from))),
    );
  }
  return times.sort((a, b) => a - b);
}

/** Updated after `SINCE` for about one row in five. */
function updateTime(random, created) {
  if (random() < 0.2) {
    return T("2026-09-02T00:00:00Z") + Math.floor(random() * 60 * DAY);
  }
  return created + Math.floor(random() * 3 * DAY);
}

const FIELD_TYPES = ["text", "number", "date", "choices", "checkbox", "user"];

function customFieldDefs(prefix, count, label, random, extra = {}) {
  return Array.from({ length: count }, (_, i) => {
    const type = FIELD_TYPES[i % FIELD_TYPES.length];
    return {
      id: closeId(prefix, i + 1).replace(/^[a-z]+_/, "cf_"),
      name: `${label} field ${pad(i + 1, 2)}`,
      type,
      description: null,
      organization_id: ORG,
      accepts_multiple_values: type === "choices" && i % 4 === 3,
      choices: type === "choices" ? ["Option A", "Option B"] : undefined,
      date_created: closeTs(T("2024-01-10T09:00:00Z") + i * DAY),
      date_updated: closeTs(
        T("2024-01-10T09:00:00Z") + i * DAY + Math.floor(random() * DAY),
      ),
      created_by: closeId("user", 1),
      updated_by: closeId("user", 1),
      ...extra,
    };
  });
}

function customValue(field, n) {
  switch (field.type) {
    case "number":
      return n * 10;
    case "date":
      return "2025-05-01";
    case "checkbox":
      return n % 2 === 0;
    case "user":
      return closeId("user", (n % 7) + 1);
    case "choices":
      return field.accepts_multiple_values ? ["Option A"] : "Option B";
    default:
      return `Value ${pad(n)}`;
  }
}

/** A `custom` object with 6 values picked from `fields`. */
function customValues(fields, random, n) {
  const custom = {};
  for (let k = 0; k < 6 && fields.length > 0; k++) {
    const field = fields[Math.floor(random() * fields.length)];
    custom[field.id] = customValue(field, n);
  }
  return custom;
}

export function buildDataset() {
  const random = rng(20261116);
  const users = Array.from({ length: 7 }, (_, i) => ({
    id: closeId("user", i + 1),
    first_name: "User",
    last_name: pad(i + 1),
    email: `user${pad(i + 1)}@example.com`,
    image: null,
    google_profile_image_url: null,
    last_used_timezone: "Europe/Warsaw",
    email_verified_at: closeTs(T("2024-01-02T08:00:00Z") + i * DAY),
    date_created: closeTs(T("2024-01-02T08:00:00Z") + i * DAY),
    date_updated: closeTs(T("2026-10-01T08:00:00Z") + i * DAY),
    organizations: [ORG],
  }));
  const userAt = n => users[n % users.length];

  const groups = Array.from({ length: 3 }, (_, i) => ({
    id: closeId("group", i + 1),
    name: `Group ${String.fromCharCode(65 + i)}`,
    organization_id: ORG,
    members: users.filter((_, u) => u % 3 === i).map(u => ({ user_id: u.id })),
  }));

  const leadStatuses = [
    "Potential",
    "Bad Fit",
    "Qualified",
    "Customer",
    "Lost",
    "Nurture",
  ].map((label, i) => ({
    id: closeId("stat", i + 1),
    label,
    color: null,
    organization_id: ORG,
  }));
  const pipelineId = closeId("pipe", 1);
  const opportunityStatuses = ["Active", "Won", "Lost", "On hold", "Demo"].map(
    (label, i) => ({
      id: closeId("stat", 100 + i),
      label,
      type: label === "Won" ? "won" : label === "Lost" ? "lost" : "active",
      pipeline_id: pipelineId,
      organization_id: ORG,
    }),
  );
  const outcomes = [
    "Interested",
    "No answer",
    "Call back",
    "Not interested",
  ].map((name, i) => ({
    id: closeId("outcome", i + 1),
    name,
    description: null,
    type: "custom",
    organization_id: ORG,
    created_by: users[0].id,
    updated_by: users[0].id,
    date_created: closeTs(T("2024-02-01T08:00:00Z") + i * DAY),
    date_updated: closeTs(T("2024-02-01T08:00:00Z") + i * DAY),
    applies_to: ["calls", "meetings"],
  }));

  const customFields = {
    lead: customFieldDefs("cfl", 60, "Lead", random),
    contact: customFieldDefs("cfc", 8, "Contact", random),
    opportunity: customFieldDefs("cfo", 12, "Opportunity", random),
    shared: customFieldDefs("cfs", 10, "Shared", random, { is_shared: true }),
    activity: customFieldDefs("cfa", 6, "Activity", random),
    custom_object_type: customFieldDefs("cfx", 3, "Object", random),
  };
  // What `/custom_field_schema/<type>/` returns: the type's own fields plus
  // the shared ones associated with it.
  const schemas = {
    lead: [...customFields.lead, ...customFields.shared],
    contact: [...customFields.contact, ...customFields.shared.slice(0, 4)],
    opportunity: customFields.opportunity,
  };

  const customActivityTypes = Array.from({ length: 3 }, (_, i) => ({
    id: closeId("actitype", i + 1),
    name: `Custom activity ${i + 1}`,
    description: null,
    organization_id: ORG,
    created_by: users[0].id,
    updated_by: users[0].id,
    is_archived: false,
    api_create_only: false,
    date_created: closeTs(T("2024-03-01T08:00:00Z") + i * DAY),
    date_updated: closeTs(T("2024-03-01T08:00:00Z") + i * DAY),
    fields: customFields.activity
      .slice(i * 2, i * 2 + 2)
      .map(f => ({ id: f.id })),
    editable_with_roles: [],
    role_permissions: null,
  }));
  const customObjectTypes = Array.from({ length: 2 }, (_, i) => ({
    id: closeId("cotype", i + 1),
    name: `Object ${i + 1}`,
    name_plural: `Objects ${i + 1}`,
    description: null,
    organization_id: ORG,
    created_by: users[0].id,
    updated_by: users[0].id,
    api_create_only: false,
    date_created: closeTs(T("2024-03-05T08:00:00Z") + i * DAY),
    date_updated: closeTs(T("2024-03-05T08:00:00Z") + i * DAY),
    fields: [],
    back_reference_fields: [],
    editable_with_roles: [],
  }));

  // ---- Search API objects -------------------------------------------------
  const base = (prefix, n, created) => {
    const updated = updateTime(random, created);
    const user = userAt(n);
    return {
      id: closeId(prefix, n),
      organization_id: ORG,
      date_created: closeTs(created),
      date_updated: closeTs(updated),
      created_by: user.id,
      updated_by: user.id,
    };
  };

  const leadTimes = creationTimes(random, {
    count: 215,
    dense: 205,
    denseStart: "2025-06-02T08:00:00Z",
    from: "2024-03-04T08:00:00Z",
    to: "2026-11-10T08:00:00Z",
  });
  const contacts = [];
  const leads = leadTimes.map((created, i) => {
    const n = i + 1;
    const status = leadStatuses[n % leadStatuses.length];
    const user = userAt(n);
    const contactIds = [];
    if (n <= 80) {
      const contact = {
        ...base("cont", n, created + 60_000),
        name: `Contact ${pad(n)}`,
        display_name: `Contact ${pad(n)}`,
        title: n % 3 === 0 ? "Owner" : null,
        lead_id: closeId("lead", n),
        emails: [{ email: `contact${pad(n)}@example.com`, type: "office" }],
        phones: [{ phone: `+48000000${pad(n, 3)}`, type: "mobile" }],
        urls: [],
        integration_links: [],
        timezone: "Europe/Warsaw",
        custom: customValues(
          [...customFields.contact, ...customFields.shared.slice(0, 4)],
          random,
          n,
        ),
      };
      contacts.push(contact);
      contactIds.push(contact.id);
    }
    return {
      ...base("lead", n, created),
      name: `Lead ${pad(n)}`,
      display_name: `Lead ${pad(n)}`,
      description: n % 5 === 0 ? `Synthetic lead ${pad(n)}` : "",
      created_by_name: `User ${pad((n % 7) + 1)}`,
      updated_by_name: `User ${pad((n % 7) + 1)}`,
      status_id: status.id,
      status_label: status.label,
      source: n % 2 === 0 ? "Website" : null,
      addresses:
        n % 4 === 0
          ? [{ label: "business", city: "Fixture City", country: "PL" }]
          : [],
      url: null,
      html_url: `https://app.close.com/lead/${closeId("lead", n)}/`,
      contacts: contactIds.map(id => ({ id })),
      opportunities: [],
      tasks: [],
      integration_links: [],
      primary_email: n <= 80 ? { email: `contact${pad(n)}@example.com` } : null,
      primary_phone: null,
      custom: customValues(schemas.lead, random, n),
      _owner: user.id,
    };
  });

  const opportunities = creationTimes(random, {
    count: 50,
    dense: 0,
    denseStart: "2025-01-06T08:00:00Z",
    from: "2024-05-01T08:00:00Z",
    to: "2026-11-05T08:00:00Z",
  }).map((created, i) => {
    const n = i + 1;
    const lead = leads[(n * 3) % leads.length];
    const status = opportunityStatuses[n % opportunityStatuses.length];
    const user = userAt(n);
    return {
      ...base("oppo", n, created),
      lead_id: lead.id,
      lead_name: lead.name,
      contact_id: null,
      contact_name: null,
      status_id: status.id,
      status_label: status.label,
      status_type: status.type,
      status_display_name: status.label,
      pipeline_id: pipelineId,
      pipeline_name: "Sales",
      user_id: user.id,
      user_name: `${user.first_name} ${user.last_name}`,
      value: n * 1000,
      value_currency: "PLN",
      value_formatted: `PLN${n * 10}`,
      value_period: "one_time",
      annualized_value: n * 1000,
      expected_value: n * 500,
      annualized_expected_value: n * 500,
      confidence: 50,
      note: "",
      date_won: status.type === "won" ? closeTs(created + 5 * DAY) : null,
      date_lost: status.type === "lost" ? closeTs(created + 5 * DAY) : null,
      created_by_name: `User ${pad((n % 7) + 1)}`,
      updated_by_name: `User ${pad((n % 7) + 1)}`,
      integration_links: [],
      attachments: [],
      is_stalled: false,
      stall_status: null,
      custom: customValues(customFields.opportunity, random, n),
    };
  });

  const activity = (type, prefix, options, extra) =>
    creationTimes(random, options).map((created, i) => {
      const n = i + 1;
      const lead = leads[(n * 7) % leads.length];
      const user = userAt(n);
      return {
        ...base(prefix, n, created),
        _type: type,
        lead_id: lead.id,
        contact_id: lead.contacts[0]?.id ?? null,
        user_id: user.id,
        user_name: `${user.first_name} ${user.last_name}`,
        created_by_name: `User ${pad((n % 7) + 1)}`,
        updated_by_name: `User ${pad((n % 7) + 1)}`,
        activity_at: closeTs(created),
        users: [user.id],
        ...extra(n, created, user),
      };
    });

  const sparse = (count, from = "2024-03-04T08:00:00Z") => ({
    count,
    dense: 0,
    denseStart: from,
    from,
    to: "2026-11-10T08:00:00Z",
  });

  const search = {
    lead: leads,
    contact: contacts,
    opportunity: opportunities,
    "activity.call": activity(
      "Call",
      "acti",
      {
        count: 230,
        dense: 220,
        denseDays: 0.5,
        denseStart: "2026-02-02T07:00:00Z",
        from: "2024-04-01T08:00:00Z",
        to: "2026-11-10T08:00:00Z",
      },
      (n, created) => ({
        direction: n % 2 === 0 ? "outbound" : "inbound",
        phone: `+48000000${pad(n % 1000, 3)}`,
        local_phone: "+48000000999",
        remote_phone: `+48000000${pad(n % 1000, 3)}`,
        local_country_iso: "PL",
        remote_country_iso: "PL",
        status: "completed",
        disposition: n % 3 === 0 ? "no-answer" : "answered",
        duration: (n * 37) % 600,
        source: n % 5 === 0 ? "External" : "Close.io",
        note: n % 6 === 0 ? `Call note ${pad(n)}` : "",
        has_recording: n % 4 === 0,
        recording_url: null,
        outcome_id: outcomes[n % outcomes.length].id,
        date_answered: closeTs(created + 5_000),
        cost: "0.01",
      }),
    ),
    "activity.email": activity("Email", "acti_e", sparse(30), (n, created) => ({
      direction: n % 2 === 0 ? "outgoing" : "incoming",
      status: "sent",
      subject: `Subject ${pad(n)}`,
      body_text: `Synthetic email body ${pad(n)}.`,
      body_html: `<p>Synthetic email body ${pad(n)}.</p>`,
      body_preview: `Synthetic email body ${pad(n)}.`,
      sender: `User ${pad(n % 7)} <user${pad((n % 7) + 1)}@example.com>`,
      to: [`contact${pad(n)}@example.com`],
      cc: [],
      bcc: [],
      thread_id: closeId("acti_t", n),
      date_sent: closeTs(created),
      has_reply: n % 3 === 0,
      opens: [],
      attachments: [],
      template_id: null,
    })),
    "activity.email_thread": activity(
      "EmailThread",
      "acti_t",
      sparse(20),
      n => ({
        latest_normalized_subject: `Subject ${pad(n)}`,
        n_emails: (n % 4) + 1,
        email_ids: JSON.stringify([closeId("acti_e", n)]),
        participants: [{ email: `contact${pad(n)}@example.com` }],
        latest_emails: [],
      }),
    ),
    "activity.sms": activity("SMS", "acti_s", sparse(15), (n, created) => ({
      direction: "outbound",
      status: "sent",
      text: `Synthetic text ${pad(n)}`,
      local_phone: "+48000000999",
      remote_phone: `+48000000${pad(n, 3)}`,
      date_sent: closeTs(created),
      attachments: [],
    })),
    "activity.meeting": activity(
      "Meeting",
      "acti_m",
      sparse(12),
      (n, created) => ({
        title: `Meeting ${pad(n)}`,
        starts_at: closeTs(created + DAY),
        ends_at: closeTs(created + DAY + 1_800_000),
        duration: 1800,
        is_recurring: false,
        status: "completed",
        source: "calendar",
        attendees: [{ email: `contact${pad(n)}@example.com`, status: "yes" }],
        conference_links: [],
      }),
    ),
    "activity.lead_status_change": activity(
      "LeadStatusChange",
      "acti_l",
      sparse(12),
      n => {
        const from = leadStatuses[n % leadStatuses.length];
        const to = leadStatuses[(n + 1) % leadStatuses.length];
        return {
          old_status_id: from.id,
          old_status_label: from.label,
          old_status_type: "active",
          new_status_id: to.id,
          new_status_label: to.label,
          new_status_type: "active",
        };
      },
    ),
    "activity.opportunity_status_change": activity(
      "OpportunityStatusChange",
      "acti_o",
      sparse(20),
      n => {
        const from = opportunityStatuses[n % opportunityStatuses.length];
        const to = opportunityStatuses[(n + 1) % opportunityStatuses.length];
        return {
          opportunity_id: opportunities[n % opportunities.length].id,
          old_status_id: from.id,
          old_status_label: from.label,
          old_status_type: from.type,
          new_status_id: to.id,
          new_status_label: to.label,
          new_status_type: to.type,
          old_pipeline_id: pipelineId,
          new_pipeline_id: pipelineId,
        };
      },
    ),
    "activity.note": activity("Note", "acti_n", sparse(15), n => ({
      note: `Synthetic note ${pad(n)}`,
      note_html: `<p>Synthetic note ${pad(n)}</p>`,
      pinned: n % 10 === 0,
      attachments: [],
    })),
    "activity.task_completed": activity(
      "TaskCompleted",
      "acti_k",
      sparse(25),
      n => ({
        task_id: closeId("task", n),
        task_text: `Synthetic task ${pad(n)}`,
        task_assigned_to: userAt(n).id,
      }),
    ),
    "activity.custom_activity": activity(
      "CustomActivity",
      "acti_c",
      sparse(18),
      n => ({
        custom_activity_type_id: customActivityTypes[n % 3].id,
        status: "published",
        pinned: false,
        custom: customValues(customFields.activity, random, n),
      }),
    ),
  };
  for (const lead of leads) delete lead._owner;

  // `GET /organization/{id}/`: users 6 and 7 are deactivated. `/user/`
  // still lists them, as Close does.
  const membership = (user, i) => ({
    id: closeId("memb", i + 1),
    user_id: user.id,
    role_id: "user",
  });
  const organization = {
    id: ORG,
    memberships: users.slice(0, 5).map(membership),
    inactive_memberships: users.slice(5).map((u, i) => membership(u, i + 5)),
  };

  return {
    organization,
    me: {
      id: users[0].id,
      first_name: "User",
      last_name: "0001",
      email: "user0001@example.com",
      organizations: [{ id: ORG, name: "Fixture Org" }],
    },
    lists: {
      "/user/": users,
      "/group/": groups,
      "/status/lead/": leadStatuses,
      "/status/opportunity/": opportunityStatuses,
      "/outcome/": outcomes,
      "/custom_activity/": customActivityTypes,
      "/custom_object_type/": customObjectTypes,
      "/custom_field/lead/": customFields.lead,
      "/custom_field/contact/": customFields.contact,
      "/custom_field/opportunity/": customFields.opportunity,
      "/custom_field/shared/": customFields.shared,
      "/custom_field/activity/": customFields.activity,
      "/custom_field/custom_object_type/": customFields.custom_object_type,
    },
    schemas,
    search,
  };
}
