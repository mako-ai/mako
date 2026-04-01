import {
  type ConnectorFieldSchema,
  type ConnectorEntitySchema,
  MAKO_SYSTEM_FIELDS,
} from "../base/BaseConnector";

export function mapCloseFieldType(
  closeType: string,
): ConnectorFieldSchema["type"] {
  switch (closeType) {
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "date":
    case "datetime":
      return "timestamp";
    case "checkbox":
      return "boolean";
    case "text":
    case "textarea":
    case "hidden":
    case "choices":
    case "user":
    case "contact":
    case "custom_object":
      return "string";
    default:
      return "string";
  }
}

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

// ---------------------------------------------------------------------------
// Common activity fields shared across all activity types
// ---------------------------------------------------------------------------

export const COMMON_ACTIVITY_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  _type: s(),
  lead_id: s(),
  contact_id: s(),
  user_id: s(),
  user_name: s(),
  created_by: s(),
  created_by_name: s(),
  updated_by: s(),
  updated_by_name: s(),
  organization_id: s(),
  date_created: ts(),
  date_updated: ts(),
  activity_at: ts(),
  users: j(),
  ...MAKO_SYSTEM_FIELDS,
};

// ---------------------------------------------------------------------------
// Activity entity schemas
// ---------------------------------------------------------------------------

export const LEAD_STATUS_CHANGE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  old_status_id: s(),
  old_status_label: s(),
  old_status_type: s(),
  new_status_id: s(),
  new_status_label: s(),
  new_status_type: s(),
};

export const MEETING_SCHEMA: Record<string, ConnectorFieldSchema> = {
  title: s(),
  starts_at: ts(),
  ends_at: ts(),
  location: s(),
  duration: n(),
  actual_duration: n(),
  is_recurring: b(),
  status: s(),
  source: s(),
  note: s(),
  summary: s(),
  outcome_id: s(),
  outcome_reason: s(),
  outcome_autofill_confidence: s(),
  outcome_autofill_reasoning: s(),
  notetaker_id: s(),
  playbook_id: s(),
  playbook_reason: s(),
  conversation_type_id: s(),
  conversation_type_reason: s(),
  connected_account_id: s(),
  provider_calendar_event_id: s(),
  provider_calendar_type: s(),
  calendar_event_link: s(),
  user_note: s(),
  user_note_html: s(),
  user_note_date_updated: ts(),
  attendees: j(),
  attached_call_ids: j(),
  calendar_event_uids: j(),
  conference_links: j(),
  integrations: j(),
  provider_calendar_ids: j(),
  user_note_mentions: j(),
};

export const CALL_SCHEMA: Record<string, ConnectorFieldSchema> = {
  direction: s(),
  phone: s(),
  local_phone: s(),
  local_phone_formatted: s(),
  remote_phone: s(),
  remote_phone_formatted: s(),
  local_country_iso: s(),
  remote_country_iso: s(),
  status: s(),
  disposition: s(),
  call_method: s(),
  cost: s(),
  source: s(),
  note: s(),
  note_html: s(),
  recording_url: s(),
  voicemail_url: s(),
  outcome_id: s(),
  outcome_reason: s(),
  outcome_autofill_confidence: s(),
  outcome_autofill_reasoning: s(),
  transferred_from: s(),
  transferred_from_user_id: s(),
  transferred_to: s(),
  transferred_to_user_id: s(),
  forwarded_to: s(),
  agent_config_id: s(),
  notetaker_id: s(),
  dialer_id: s(),
  dialer_saved_search_id: s(),
  playbook_id: s(),
  playbook_reason: s(),
  conversation_type_id: s(),
  conversation_type_reason: s(),
  sequence_id: s(),
  sequence_name: s(),
  sequence_subscription_id: s(),
  parent_meeting_id: s(),
  recording_expires_at: ts(),
  duration: n(),
  voicemail_duration: n(),
  recording_duration: n(),
  date_answered: ts(),
  note_date_updated: ts(),
  has_recording: b(),
  is_forwarded: b(),
  is_joinable: b(),
  is_to_group_number: b(),
  coach_legs: j(),
  note_mentions: j(),
  recording_history: j(),
};

export const EMAIL_SCHEMA: Record<string, ConnectorFieldSchema> = {
  direction: s(),
  status: s(),
  subject: s(),
  body_text: s(),
  body_html: s(),
  body_preview: s(),
  sender: s(),
  thread_id: s(),
  template_id: s(),
  template_name: s(),
  email_account_id: s(),
  in_reply_to_id: s(),
  send_as_id: s(),
  bulk_email_action_id: s(),
  sequence_id: s(),
  sequence_name: s(),
  sequence_subscription_id: s(),
  followup_sequence_id: s(),
  followup_sequence_delay: s(),
  agent_action_reason: s(),
  agent_config_id: s(),
  ai_draft: s(),
  date_sent: ts(),
  date_scheduled: ts(),
  has_reply: b(),
  followup_sequence_add_cc_bcc: b(),
  need_smtp_credentials: b(),
  to: j(),
  cc: j(),
  bcc: j(),
  envelope: j(),
  opens: j(),
  opens_summary: j(),
  attachments: j(),
  message_ids: j(),
  references: j(),
  send_attempts: j(),
  body_html_quoted: j(),
  body_text_quoted: j(),
  users: j(),
};

export const EMAIL_THREAD_SCHEMA: Record<string, ConnectorFieldSchema> = {
  latest_normalized_subject: s(),
  summary: s(),
  n_emails: n(),
  importance: j(),
  latest_emails: j(),
  participants: j(),
};

export const SMS_SCHEMA: Record<string, ConnectorFieldSchema> = {
  direction: s(),
  status: s(),
  text: s(),
  local_phone: s(),
  local_phone_formatted: s(),
  remote_phone: s(),
  remote_phone_formatted: s(),
  local_country_iso: s(),
  remote_country_iso: s(),
  cost: s(),
  source: s(),
  template_id: s(),
  error_message: s(),
  agent_action_reason: s(),
  agent_config_id: s(),
  sequence_id: s(),
  sequence_name: s(),
  sequence_subscription_id: s(),
  date_sent: ts(),
  date_scheduled: ts(),
  attachments: j(),
};

export const NOTE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  title: s(),
  note: s(),
  note_html: s(),
  source: s(),
  pinned: b(),
  pinned_at: ts(),
  attachments: j(),
  note_mentions: j(),
};

export const TASK_COMPLETED_SCHEMA: Record<string, ConnectorFieldSchema> = {};

export const CUSTOM_ACTIVITY_SCHEMA: Record<string, ConnectorFieldSchema> = {
  custom_activity_type_id: s(),
  status: s(),
  source: s(),
  last_published_at: ts(),
  mentions_updated_at: ts(),
  pinned: b(),
  pinned_at: ts(),
  mentions: j(),
};

// ---------------------------------------------------------------------------
// Core entity schemas
// ---------------------------------------------------------------------------

export const LEAD_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  display_name: s(),
  description: s(),
  status_id: s(),
  status_label: s(),
  source: s(),
  url: s(),
  html_url: s(),
  created_by: s(),
  created_by_name: s(),
  updated_by: s(),
  updated_by_name: s(),
  organization_id: s(),
  date_created: ts(),
  date_updated: ts(),
  addresses: j(),
  contacts: j(),
  contact_ids: j(),
  opportunities: j(),
  tasks: j(),
  integration_links: j(),
  custom: j(),
  primary_email: j(),
  primary_phone: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const CONTACT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  display_name: s(),
  title: s(),
  lead_id: s(),
  organization_id: s(),
  timezone: s(),
  timezone_source: s(),
  created_by: s(),
  updated_by: s(),
  date_created: ts(),
  date_updated: ts(),
  emails: j(),
  phones: j(),
  urls: j(),
  integration_links: j(),
  custom: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const OPPORTUNITY_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  lead_id: s(),
  lead_name: s(),
  contact_id: s(),
  contact_name: s(),
  status_id: s(),
  status_label: s(),
  status_type: s(),
  status_display_name: s(),
  pipeline_id: s(),
  pipeline_name: s(),
  user_id: s(),
  user_name: s(),
  value_currency: s(),
  value_formatted: s(),
  value_period: s(),
  note: s(),
  created_by: s(),
  created_by_name: s(),
  updated_by: s(),
  updated_by_name: s(),
  organization_id: s(),
  stall_status: s(),
  date_created: ts(),
  date_updated: ts(),
  date_won: ts(),
  date_lost: ts(),
  value: n(),
  annualized_value: n(),
  expected_value: n(),
  annualized_expected_value: n(),
  confidence: n(),
  is_stalled: b(),
  integration_links: j(),
  attachments: j(),
  custom: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const USER_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  first_name: s(),
  last_name: s(),
  email: s(),
  image: s(),
  google_profile_image_url: s(),
  last_used_timezone: s(),
  email_verified_at: ts(),
  date_created: ts(),
  date_updated: ts(),
  organizations: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const CUSTOM_FIELD_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  type: s(),
  description: s(),
  organization_id: s(),
  created_by: s(),
  updated_by: s(),
  referenced_custom_type_id: s(),
  is_shared: b(),
  accepts_multiple_values: b(),
  always_visible: b(),
  enrichment_enabled: b(),
  back_reference_is_visible: b(),
  api_create_only: b(),
  date_created: ts(),
  date_updated: ts(),
  choices: j(),
  associations: j(),
  editable_with_roles: j(),
  enrichment_options: j(),
  custom_field_type: s(),
  ...MAKO_SYSTEM_FIELDS,
};

export const CUSTOM_ACTIVITY_TYPE_SCHEMA: Record<string, ConnectorFieldSchema> =
  {
    id: { type: "string", required: true },
    name: s(),
    description: s(),
    organization_id: s(),
    created_by: s(),
    updated_by: s(),
    is_archived: b(),
    api_create_only: b(),
    date_created: ts(),
    date_updated: ts(),
    fields: j(),
    editable_with_roles: j(),
    role_permissions: j(),
    ...MAKO_SYSTEM_FIELDS,
  };

export const CUSTOM_OBJECT_TYPE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  name_plural: s(),
  description: s(),
  organization_id: s(),
  created_by: s(),
  updated_by: s(),
  api_create_only: b(),
  date_created: ts(),
  date_updated: ts(),
  fields: j(),
  back_reference_fields: j(),
  editable_with_roles: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const LEAD_STATUS_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  label: s(),
  color: s(),
  organization_id: s(),
  ...MAKO_SYSTEM_FIELDS,
};

export const OPPORTUNITY_STATUS_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  label: s(),
  type: s(),
  pipeline_id: s(),
  organization_id: s(),
  ...MAKO_SYSTEM_FIELDS,
};

// ---------------------------------------------------------------------------
// Schema maps for resolveSchema lookup
// ---------------------------------------------------------------------------

export const ACTIVITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  "activities:LeadStatusChange": LEAD_STATUS_CHANGE_SCHEMA,
  "activities:OpportunityStatusChange": LEAD_STATUS_CHANGE_SCHEMA,
  "activities:Meeting": MEETING_SCHEMA,
  "activities:Call": CALL_SCHEMA,
  "activities:Email": EMAIL_SCHEMA,
  "activities:EmailThread": EMAIL_THREAD_SCHEMA,
  "activities:SMS": SMS_SCHEMA,
  "activities:Note": NOTE_SCHEMA,
  "activities:TaskCompleted": TASK_COMPLETED_SCHEMA,
  "activities:CustomActivity": CUSTOM_ACTIVITY_SCHEMA,
};

export const CORE_ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  leads: LEAD_SCHEMA,
  contacts: CONTACT_SCHEMA,
  opportunities: OPPORTUNITY_SCHEMA,
  users: USER_SCHEMA,
  custom_fields: CUSTOM_FIELD_SCHEMA,
  custom_activity_types: CUSTOM_ACTIVITY_TYPE_SCHEMA,
  custom_object_types: CUSTOM_OBJECT_TYPE_SCHEMA,
  lead_statuses: LEAD_STATUS_SCHEMA,
  opportunity_statuses: OPPORTUNITY_STATUS_SCHEMA,
};

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

export interface CloseCustomField {
  id: string;
  name: string;
  type: string;
  appliesTo: string;
  acceptsMultipleValues?: boolean;
}

export function resolveCloseEntitySchema(
  entity: string,
  customFields: CloseCustomField[],
): ConnectorEntitySchema | null {
  let baseFields: Record<string, ConnectorFieldSchema> | undefined;

  if (entity in ACTIVITY_SCHEMA_MAP) {
    baseFields = {
      ...COMMON_ACTIVITY_SCHEMA,
      ...ACTIVITY_SCHEMA_MAP[entity],
    };
  } else if (entity in CORE_ENTITY_SCHEMA_MAP) {
    baseFields = CORE_ENTITY_SCHEMA_MAP[entity];
  }

  if (!baseFields) {
    return null;
  }

  const merged = { ...baseFields };

  for (const field of customFields) {
    if (!field.id) continue;
    const key = `custom_${field.id}`;
    if (!(key in merged)) {
      merged[key] = {
        type: field.acceptsMultipleValues
          ? "json"
          : mapCloseFieldType(field.type),
        nullable: true,
      };
    }
  }

  return {
    entity,
    fields: merged,
    unknownFieldPolicy: "string",
  };
}
