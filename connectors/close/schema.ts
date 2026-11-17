/**
 * Close entity schemas, field for field the same as the in-process
 * connector's (`api/src/connectors/close/schema.ts`), plus the folder-only
 * columns the harness declares in `FOLDER_ONLY` (`users.is_active`). The
 * parity harness in `fixtures/` fails if the two drift otherwise.
 *
 * Mako's system columns (`_mako_*`, `_syncedAt`, `is_deleted`, ...) are not
 * declared here: the box path adds them (PR 1284 merges them in
 * `jsonSchemaToEntitySchema`). The parity test compares vendor fields only.
 */

export type FieldType = "string" | "timestamp" | "number" | "boolean" | "json";
type Fields = Record<string, FieldType>;

export function mapCloseFieldType(closeType: string): FieldType {
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
    default:
      return "string";
  }
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

const COMMON_ACTIVITY: Fields = {
  id: "string",
  _type: "string",
  lead_id: "string",
  contact_id: "string",
  user_id: "string",
  user_name: "string",
  created_by: "string",
  created_by_name: "string",
  updated_by: "string",
  updated_by_name: "string",
  organization_id: "string",
  date_created: "timestamp",
  date_updated: "timestamp",
  activity_at: "timestamp",
  users: "json",
};

const LEAD_STATUS_CHANGE: Fields = {
  old_status_id: "string",
  old_status_label: "string",
  old_status_type: "string",
  new_status_id: "string",
  new_status_label: "string",
  new_status_type: "string",
  created_by_agent_id: "string",
  updated_by_agent_id: "string",
};

const OPPORTUNITY_STATUS_CHANGE: Fields = {
  ...LEAD_STATUS_CHANGE,
  opportunity_id: "string",
  old_pipeline_id: "string",
  old_pipeline_name: "string",
  new_pipeline_id: "string",
  new_pipeline_name: "string",
};

const MEETING: Fields = {
  title: "string",
  starts_at: "timestamp",
  ends_at: "timestamp",
  location: "string",
  duration: "number",
  actual_duration: "number",
  is_recurring: "boolean",
  status: "string",
  source: "string",
  note: "string",
  summary: "string",
  outcome_id: "string",
  outcome_reason: "string",
  outcome_autofill_confidence: "string",
  outcome_autofill_reasoning: "string",
  notetaker_id: "string",
  notetaker_states: "string",
  agent_config_id: "string",
  playbook_id: "string",
  playbook_reason: "string",
  conversation_type_id: "string",
  conversation_type_reason: "string",
  connected_account_id: "string",
  provider_calendar_event_id: "string",
  provider_calendar_type: "string",
  calendar_event_link: "string",
  user_note: "string",
  user_note_html: "string",
  user_note_date_updated: "timestamp",
  attendees: "json",
  attached_call_ids: "json",
  calendar_event_uids: "json",
  conference_links: "json",
  integrations: "json",
  provider_calendar_ids: "json",
  user_note_mentions: "json",
};

const CALL: Fields = {
  direction: "string",
  phone: "string",
  local_phone: "string",
  local_phone_formatted: "string",
  remote_phone: "string",
  remote_phone_formatted: "string",
  local_country_iso: "string",
  remote_country_iso: "string",
  status: "string",
  disposition: "string",
  call_method: "string",
  cost: "string",
  source: "string",
  note: "string",
  note_html: "string",
  recording_url: "string",
  voicemail_url: "string",
  outcome_id: "string",
  outcome_reason: "string",
  outcome_autofill_confidence: "string",
  outcome_autofill_reasoning: "string",
  transferred_from: "string",
  transferred_from_user_id: "string",
  transferred_to: "string",
  transferred_to_user_id: "string",
  forwarded_to: "string",
  caller_id_reason: "string",
  agent_config_id: "string",
  notetaker_id: "string",
  dialer_id: "string",
  dialer_saved_search_id: "string",
  playbook_id: "string",
  playbook_reason: "string",
  conversation_type_id: "string",
  conversation_type_reason: "string",
  sequence_id: "string",
  sequence_name: "string",
  sequence_subscription_id: "string",
  parent_meeting_id: "string",
  recording_expires_at: "timestamp",
  duration: "number",
  voicemail_duration: "number",
  recording_duration: "number",
  date_answered: "timestamp",
  note_date_updated: "timestamp",
  has_recording: "boolean",
  is_forwarded: "boolean",
  is_joinable: "boolean",
  is_to_group_number: "boolean",
  coach_legs: "json",
  note_mentions: "json",
  recording_history: "json",
  recording_transcript: "string",
  voicemail_transcript: "string",
};

const EMAIL: Fields = {
  direction: "string",
  status: "string",
  subject: "string",
  body_text: "string",
  body_html: "string",
  body_preview: "string",
  sender: "string",
  thread_id: "string",
  template_id: "string",
  template_name: "string",
  email_account_id: "string",
  in_reply_to_id: "string",
  send_as_id: "string",
  bulk_email_action_id: "string",
  sequence_id: "string",
  sequence_name: "string",
  sequence_subscription_id: "string",
  followup_sequence_id: "string",
  followup_sequence_delay: "string",
  agent_action_reason: "string",
  agent_config_id: "string",
  ai_draft: "string",
  date_sent: "timestamp",
  date_scheduled: "timestamp",
  has_reply: "boolean",
  followup_sequence_add_cc_bcc: "boolean",
  need_smtp_credentials: "boolean",
  to: "json",
  cc: "json",
  bcc: "json",
  envelope: "json",
  opens: "json",
  opens_summary: "json",
  attachments: "json",
  message_ids: "json",
  references: "json",
  send_attempts: "json",
  body_html_quoted: "json",
  body_text_quoted: "json",
  users: "json",
};

const EMAIL_THREAD: Fields = {
  latest_normalized_subject: "string",
  summary: "string",
  n_emails: "number",
  email_ids: "string",
  importance: "json",
  latest_emails: "json",
  participants: "json",
};

const SMS: Fields = {
  direction: "string",
  status: "string",
  text: "string",
  local_phone: "string",
  local_phone_formatted: "string",
  remote_phone: "string",
  remote_phone_formatted: "string",
  local_country_iso: "string",
  remote_country_iso: "string",
  cost: "string",
  source: "string",
  template_id: "string",
  error_message: "string",
  caller_id_mode: "string",
  caller_id_reason: "string",
  agent_action_reason: "string",
  agent_config_id: "string",
  sequence_id: "string",
  sequence_name: "string",
  sequence_subscription_id: "string",
  date_sent: "timestamp",
  date_scheduled: "timestamp",
  attachments: "json",
};

const NOTE: Fields = {
  title: "string",
  note: "string",
  note_html: "string",
  note_date_updated: "timestamp",
  source: "string",
  agent_action_reason: "string",
  agent_config_id: "string",
  pinned: "boolean",
  pinned_at: "timestamp",
  attachments: "json",
  note_mentions: "json",
};

const TASK_COMPLETED: Fields = {
  task_id: "string",
  task_text: "string",
  task_assigned_to: "string",
  task_assigned_to_name: "string",
};

const CUSTOM_ACTIVITY: Fields = {
  custom_activity_type_id: "string",
  status: "string",
  source: "string",
  last_published_at: "timestamp",
  mentions_updated_at: "timestamp",
  pinned: "boolean",
  pinned_at: "timestamp",
  mentions: "json",
};

export const ACTIVITY_SCHEMA_MAP: Record<string, Fields> = {
  "activities:LeadStatusChange": LEAD_STATUS_CHANGE,
  "activities:OpportunityStatusChange": OPPORTUNITY_STATUS_CHANGE,
  "activities:Meeting": MEETING,
  "activities:Call": CALL,
  "activities:Email": EMAIL,
  "activities:EmailThread": EMAIL_THREAD,
  "activities:SMS": SMS,
  "activities:Note": NOTE,
  "activities:TaskCompleted": TASK_COMPLETED,
  "activities:CustomActivity": CUSTOM_ACTIVITY,
};

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

const LEAD: Fields = {
  id: "string",
  name: "string",
  display_name: "string",
  description: "string",
  status_id: "string",
  status_label: "string",
  source: "string",
  url: "string",
  html_url: "string",
  created_by: "string",
  created_by_name: "string",
  updated_by: "string",
  updated_by_name: "string",
  organization_id: "string",
  date_created: "timestamp",
  date_updated: "timestamp",
  addresses: "json",
  contacts: "json",
  contact_ids: "json",
  opportunities: "json",
  tasks: "json",
  integration_links: "json",
  custom: "json",
  primary_email: "json",
  primary_phone: "json",
};

const CONTACT: Fields = {
  id: "string",
  name: "string",
  display_name: "string",
  title: "string",
  lead_id: "string",
  organization_id: "string",
  timezone: "string",
  timezone_source: "string",
  lead_suggestions_operation_id: "string",
  created_by: "string",
  updated_by: "string",
  date_created: "timestamp",
  date_updated: "timestamp",
  emails: "json",
  phones: "json",
  urls: "json",
  integration_links: "json",
  custom: "json",
};

const OPPORTUNITY: Fields = {
  id: "string",
  lead_id: "string",
  lead_name: "string",
  contact_id: "string",
  contact_name: "string",
  status_id: "string",
  status_label: "string",
  status_type: "string",
  status_display_name: "string",
  pipeline_id: "string",
  pipeline_name: "string",
  user_id: "string",
  user_name: "string",
  value_currency: "string",
  value_formatted: "string",
  value_period: "string",
  note: "string",
  note_html: "string",
  created_by: "string",
  created_by_name: "string",
  updated_by: "string",
  updated_by_name: "string",
  organization_id: "string",
  stall_status: "string",
  date_created: "timestamp",
  date_updated: "timestamp",
  date_won: "timestamp",
  date_lost: "timestamp",
  value: "number",
  annualized_value: "number",
  expected_value: "number",
  annualized_expected_value: "number",
  confidence: "number",
  is_stalled: "boolean",
  integration_links: "json",
  attachments: "json",
  custom: "json",
};

const USER: Fields = {
  id: "string",
  first_name: "string",
  last_name: "string",
  email: "string",
  image: "string",
  google_profile_image_url: "string",
  last_used_timezone: "string",
  email_verified_at: "timestamp",
  date_created: "timestamp",
  date_updated: "timestamp",
  organizations: "json",
  // Folder only: from the organization's memberships (`memberships.ts`).
  is_active: "boolean",
};

const CUSTOM_FIELD: Fields = {
  id: "string",
  name: "string",
  type: "string",
  description: "string",
  organization_id: "string",
  created_by: "string",
  updated_by: "string",
  referenced_custom_type_id: "string",
  is_shared: "boolean",
  accepts_multiple_values: "boolean",
  always_visible: "boolean",
  enrichment_enabled: "boolean",
  back_reference_is_visible: "boolean",
  api_create_only: "boolean",
  date_created: "timestamp",
  date_updated: "timestamp",
  choices: "json",
  associations: "json",
  editable_with_roles: "json",
  enrichment_options: "json",
  custom_field_type: "string",
};

const CUSTOM_ACTIVITY_TYPE: Fields = {
  id: "string",
  name: "string",
  description: "string",
  organization_id: "string",
  created_by: "string",
  updated_by: "string",
  is_archived: "boolean",
  api_create_only: "boolean",
  date_created: "timestamp",
  date_updated: "timestamp",
  fields: "json",
  editable_with_roles: "json",
  role_permissions: "json",
};

const CUSTOM_OBJECT_TYPE: Fields = {
  id: "string",
  name: "string",
  name_plural: "string",
  description: "string",
  organization_id: "string",
  created_by: "string",
  updated_by: "string",
  api_create_only: "boolean",
  date_created: "timestamp",
  date_updated: "timestamp",
  fields: "json",
  back_reference_fields: "json",
  editable_with_roles: "json",
};

const CUSTOM_OBJECT: Fields = {
  id: "string",
  name: "string",
  organization_id: "string",
  lead_id: "string",
  created_by: "string",
  updated_by: "string",
  custom_object_type_id: "string",
  date_created: "timestamp",
  date_updated: "timestamp",
};

const LEAD_STATUS: Fields = {
  id: "string",
  label: "string",
  color: "string",
  organization_id: "string",
};

const OPPORTUNITY_STATUS: Fields = {
  id: "string",
  label: "string",
  type: "string",
  pipeline_id: "string",
  organization_id: "string",
};

const GROUP: Fields = {
  id: "string",
  name: "string",
  organization_id: "string",
  members: "json",
};

const OUTCOME: Fields = {
  id: "string",
  name: "string",
  description: "string",
  type: "string",
  organization_id: "string",
  created_by: "string",
  updated_by: "string",
  date_created: "timestamp",
  date_updated: "timestamp",
  applies_to: "json",
};

const CORE_ENTITY_SCHEMA_MAP: Record<string, Fields> = {
  leads: LEAD,
  contacts: CONTACT,
  opportunities: OPPORTUNITY,
  users: USER,
  custom_fields: CUSTOM_FIELD,
  custom_activity_types: CUSTOM_ACTIVITY_TYPE,
  custom_object_types: CUSTOM_OBJECT_TYPE,
  custom_objects: CUSTOM_OBJECT,
  lead_statuses: LEAD_STATUS,
  opportunity_statuses: OPPORTUNITY_STATUS,
  outcomes: OUTCOME,
  groups: GROUP,
};

/** The vendor fields of an entity, before custom fields. */
export function closeBaseFields(entity: string): Fields | null {
  if (entity in ACTIVITY_SCHEMA_MAP) {
    return { ...COMMON_ACTIVITY, ...ACTIVITY_SCHEMA_MAP[entity] };
  }
  return CORE_ENTITY_SCHEMA_MAP[entity] ?? null;
}

/**
 * The Search API `_fields` list of an activity subtype: every column its
 * schema declares. Same rule as the in-process `closeActivitySearchFields`.
 */
/**
 * Fields only Close webhooks carry. Search answers them with null, so asking
 * for them would write null over the webhook value on every poll and resync.
 * They stay in the schema, so webhook rows keep typing them.
 */
const WEBHOOK_ONLY_SEARCH_FIELDS: Record<string, readonly string[]> = {
  "activities:Meeting": ["calendar_event_link"],
};

export function closeActivitySearchFields(entity: string): string[] | null {
  if (!ACTIVITY_SCHEMA_MAP[entity]) return null;
  const skip = new Set(WEBHOOK_ONLY_SEARCH_FIELDS[entity] ?? []);
  return Object.keys({
    ...COMMON_ACTIVITY,
    ...ACTIVITY_SCHEMA_MAP[entity],
  }).filter(field => !skip.has(field));
}

export interface CloseCustomField {
  id: string;
  name: string;
  type: string;
  appliesTo: string;
  acceptsMultipleValues?: boolean;
}

/** `custom.cf_<id>` selectors for every custom field, deduplicated, in order. */
export function closeCustomFieldSelectors(
  customFields: readonly CloseCustomField[],
): string[] {
  const selectors: string[] = [];
  const seen = new Set<string>();
  for (const field of customFields) {
    if (!field.id) continue;
    const selector = `custom.${field.id}`;
    if (seen.has(selector)) continue;
    seen.add(selector);
    selectors.push(selector);
  }
  return selectors;
}

export interface CloseSearchFieldSelectionPlan {
  /** Base fields plus the first batch of custom selectors. */
  primary: string[];
  /** `["id", ...batch]` per follow-up by-id request. */
  supplemental: string[][];
}

/** No request names more than `maxCustomSelectorsPerRequest` selectors. */
export function splitCloseSearchFieldSelection(
  baseFields: readonly string[],
  customFields: readonly CloseCustomField[],
  maxCustomSelectorsPerRequest: number,
): CloseSearchFieldSelectionPlan {
  const base = Array.from(new Set(baseFields));
  if (!base.includes("id")) base.unshift("id");
  const selectors = closeCustomFieldSelectors(customFields);
  const size = Math.max(1, Math.floor(maxCustomSelectorsPerRequest));
  const primary = [...base, ...selectors.slice(0, size)];
  const supplemental: string[][] = [];
  for (let offset = size; offset < selectors.length; offset += size) {
    supplemental.push(["id", ...selectors.slice(offset, offset + size)]);
  }
  return { primary, supplemental };
}

const JSON_SCHEMA_TYPES: Record<FieldType, Record<string, unknown>> = {
  string: { type: ["null", "string"] },
  timestamp: { type: ["null", "string"], format: "date-time" },
  number: { type: ["null", "number"] },
  boolean: { type: ["null", "boolean"] },
  json: { type: ["null", "object", "array"] },
};

/**
 * A stream's JSON Schema: the base fields plus one `custom_<id>` column per
 * custom field, typed as `resolveCloseEntitySchema` types it. `id` is the
 * only required, non-null field.
 */
export function closeJsonSchema(
  entity: string,
  customFields: readonly CloseCustomField[] = [],
): Record<string, unknown> {
  const fields = closeBaseFields(entity);
  if (!fields) throw new Error(`Unsupported entity: ${entity}`);
  const merged: Record<string, FieldType> = { ...fields };
  for (const field of customFields) {
    if (!field.id) continue;
    const key = `custom_${field.id}`;
    if (!(key in merged)) {
      merged[key] = field.acceptsMultipleValues
        ? "json"
        : mapCloseFieldType(field.type);
    }
  }
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(merged)) {
    properties[name] =
      name === "id" ? { type: "string" } : { ...JSON_SCHEMA_TYPES[type] };
  }
  return {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties,
  };
}
