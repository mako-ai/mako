import {
  type ConnectorEntitySchema,
  type ConnectorFieldSchema,
  MAKO_SYSTEM_FIELDS,
} from "../base/BaseConnector";

const s = (nullable = true): ConnectorFieldSchema => ({
  type: "string",
  nullable,
});
const ts = (nullable = true): ConnectorFieldSchema => ({
  type: "timestamp",
  nullable,
});
const n = (nullable = true): ConnectorFieldSchema => ({
  type: "number",
  nullable,
});
const b = (nullable = true): ConnectorFieldSchema => ({
  type: "boolean",
  nullable,
});
const j = (nullable = true): ConnectorFieldSchema => ({
  type: "json",
  nullable,
});

export const ORGANIZATION_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  name: s(),
  plan: s(),
  stage: s(),
  kind: s(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const USER_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  role: s(),
  organization: s(),
  user_uri: s(),
  user_email: s(),
  user_name: s(),
  user_slug: s(),
  user_timezone: s(),
  user_scheduling_url: s(),
  user_avatar_url: s(),
  user_locale: s(),
  user: j(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const GROUP_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  name: s(),
  organization: s(),
  member_count: n(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const EVENT_TYPE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  name: s(),
  slug: s(),
  type: s(),
  kind: s(),
  active: b(),
  color: s(),
  duration: n(),
  duration_options: j(),
  booking_method: s(),
  admin_managed: b(),
  scheduling_url: s(),
  secret: b(),
  is_paid: b(),
  locale: s(),
  position: n(),
  pooling_type: s(),
  internal_note: s(),
  description_plain: s(),
  description_html: s(),
  profile: j(),
  custom_questions: j(),
  locations: j(),
  created_at: ts(),
  updated_at: ts(),
  deleted_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const SCHEDULED_EVENT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  name: s(),
  status: s(),
  start_time: ts(),
  end_time: ts(),
  event_type: s(),
  location: j(),
  event_guests: j(),
  event_memberships: j(),
  invitees_counter: j(),
  cancellation: j(),
  meeting_notes_html: s(),
  meeting_notes_plain: s(),
  calendar_event: j(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const INVITEE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  event: s(),
  email: s(),
  name: s(),
  first_name: s(),
  last_name: s(),
  status: s(),
  timezone: s(),
  cancel_url: s(),
  reschedule_url: s(),
  rescheduled: b(),
  scheduling_method: s(),
  text_reminder_number: s(),
  invitee_scheduled_by: s(),
  old_invitee: s(),
  new_invitee: s(),
  routing_form_submission: s(),
  no_show: j(),
  cancellation: j(),
  payment: j(),
  questions_and_answers: j(),
  tracking: j(),
  scheduled_event: j(),
  reconfirmation: j(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const CONTACT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uri: s(),
  organization: s(),
  name: s(),
  first_name: s(),
  last_name: s(),
  email: s(),
  phone_number: s(),
  title: s(),
  company: s(),
  source: s(),
  notes: s(),
  owner: s(),
  avatar_url: s(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  organizations: ORGANIZATION_SCHEMA,
  users: USER_SCHEMA,
  groups: GROUP_SCHEMA,
  event_types: EVENT_TYPE_SCHEMA,
  scheduled_events: SCHEDULED_EVENT_SCHEMA,
  invitees: INVITEE_SCHEMA,
  contacts: CONTACT_SCHEMA,
};

export function resolveCalendlyEntitySchema(
  entity: string,
): ConnectorEntitySchema | null {
  const fields = ENTITY_SCHEMA_MAP[entity];
  if (!fields) return null;

  return {
    entity,
    fields: { ...fields },
    unknownFieldPolicy: "string",
    keyColumns: ["id"],
  };
}
