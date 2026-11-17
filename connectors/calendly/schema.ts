/**
 * The Calendly entities: names, labels, descriptions, table layouts and
 * columns, as the in-process `schema.ts` and `getEntityMetadata` declare
 * them. Every column is nullable except `id`, which is required.
 */

type Field = "string" | "timestamp" | "number" | "boolean" | "json";

const JSON_SCHEMA_TYPES: Record<Field, Record<string, unknown>> = {
  string: { type: ["null", "string"] },
  timestamp: { type: ["null", "string"], format: "date-time" },
  number: { type: ["null", "number"] },
  boolean: { type: ["null", "boolean"] },
  json: { type: ["null", "object", "array"] },
};

const s: Field = "string";
const ts: Field = "timestamp";
const n: Field = "number";
const b: Field = "boolean";
const j: Field = "json";

export const ORGANIZATION_FIELDS: Record<string, Field> = {
  uri: s,
  name: s,
  plan: s,
  stage: s,
  kind: s,
  created_at: ts,
  updated_at: ts,
};

export const USER_FIELDS: Record<string, Field> = {
  uri: s,
  role: s,
  organization: s,
  user_uri: s,
  user_email: s,
  user_name: s,
  user_slug: s,
  user_timezone: s,
  user_scheduling_url: s,
  user_avatar_url: s,
  user_locale: s,
  user: j,
  created_at: ts,
  updated_at: ts,
};

export const GROUP_FIELDS: Record<string, Field> = {
  uri: s,
  name: s,
  organization: s,
  member_count: n,
  created_at: ts,
  updated_at: ts,
};

export const EVENT_TYPE_FIELDS: Record<string, Field> = {
  uri: s,
  name: s,
  slug: s,
  type: s,
  kind: s,
  active: b,
  color: s,
  duration: n,
  duration_options: j,
  booking_method: s,
  admin_managed: b,
  scheduling_url: s,
  secret: b,
  is_paid: b,
  locale: s,
  position: n,
  pooling_type: s,
  internal_note: s,
  description_plain: s,
  description_html: s,
  profile: j,
  custom_questions: j,
  locations: j,
  created_at: ts,
  updated_at: ts,
  deleted_at: ts,
};

export const SCHEDULED_EVENT_FIELDS: Record<string, Field> = {
  uri: s,
  name: s,
  status: s,
  start_time: ts,
  end_time: ts,
  event_type: s,
  location: j,
  event_guests: j,
  event_memberships: j,
  invitees_counter: j,
  cancellation: j,
  meeting_notes_html: s,
  meeting_notes_plain: s,
  calendar_event: j,
  created_at: ts,
  updated_at: ts,
};

export const INVITEE_FIELDS: Record<string, Field> = {
  uri: s,
  event: s,
  email: s,
  name: s,
  first_name: s,
  last_name: s,
  status: s,
  timezone: s,
  cancel_url: s,
  reschedule_url: s,
  rescheduled: b,
  scheduling_method: s,
  text_reminder_number: s,
  invitee_scheduled_by: s,
  old_invitee: s,
  new_invitee: s,
  routing_form_submission: s,
  no_show: j,
  cancellation: j,
  payment: j,
  questions_and_answers: j,
  tracking: j,
  scheduled_event: j,
  reconfirmation: j,
  created_at: ts,
  updated_at: ts,
};

export const CONTACT_FIELDS: Record<string, Field> = {
  uri: s,
  organization: s,
  name: s,
  first_name: s,
  last_name: s,
  email: s,
  phone_number: s,
  title: s,
  company: s,
  source: s,
  notes: s,
  owner: s,
  avatar_url: s,
  created_at: ts,
  updated_at: ts,
};

export type CalendlyEntity =
  | "organizations"
  | "users"
  | "groups"
  | "event_types"
  | "scheduled_events"
  | "invitees"
  | "contacts";

export interface CalendlyEntityInfo {
  name: CalendlyEntity;
  label: string;
  description: string;
  partitionField: string;
  fields: Record<string, Field>;
  /** What a read does with `since`, as in-process `perEntity` says. */
  incremental?: "client-filter" | "created-anchor";
}

/** In the in-process order. */
export const CALENDLY_ENTITIES: CalendlyEntityInfo[] = [
  {
    name: "organizations",
    label: "Organizations",
    description: "Calendly organization(s) the token has access to",
    partitionField: "created_at",
    fields: ORGANIZATION_FIELDS,
  },
  {
    name: "users",
    label: "Users (org memberships)",
    description: "Members of the organization with embedded user information",
    partitionField: "created_at",
    fields: USER_FIELDS,
    incremental: "client-filter",
  },
  {
    name: "groups",
    label: "Groups",
    description: "Calendly groups within the organization",
    partitionField: "created_at",
    fields: GROUP_FIELDS,
    incremental: "client-filter",
  },
  {
    name: "event_types",
    label: "Event Types",
    description: "Bookable event types",
    partitionField: "created_at",
    fields: EVENT_TYPE_FIELDS,
    incremental: "client-filter",
  },
  {
    name: "scheduled_events",
    label: "Scheduled Events",
    description: "Booked meetings on the organization calendar",
    partitionField: "start_time",
    fields: SCHEDULED_EVENT_FIELDS,
    incremental: "created-anchor",
  },
  {
    name: "invitees",
    label: "Invitees",
    description: "People booked on scheduled events (nested fetch)",
    partitionField: "created_at",
    fields: INVITEE_FIELDS,
  },
  {
    name: "contacts",
    label: "Contacts",
    description: "Calendly contacts directory",
    partitionField: "created_at",
    fields: CONTACT_FIELDS,
    incremental: "client-filter",
  },
];

/** A stream's JSON Schema: `id` required and non-null, the rest nullable. */
export function calendlyJsonSchema(
  fields: Record<string, Field>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = { id: { type: "string" } };
  for (const [name, type] of Object.entries(fields)) {
    properties[name] = { ...JSON_SCHEMA_TYPES[type] };
  }
  return {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties,
  };
}
