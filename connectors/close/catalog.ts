/**
 * The Close entity catalog, a port of `api/src/connectors/close/entities.ts`:
 * the entities, how each maps onto an endpoint or a Search API object type,
 * and the base fields the Search API requests.
 */

export const CLOSE_ACTIVITY_TYPES = [
  { name: "Email", label: "Email", description: "Email communications" },
  {
    name: "EmailThread",
    label: "Email Thread",
    description: "Email thread activities",
  },
  { name: "Call", label: "Call", description: "Phone calls" },
  { name: "SMS", label: "SMS", description: "Text messages" },
  { name: "Meeting", label: "Meeting", description: "Scheduled meetings" },
  {
    name: "LeadStatusChange",
    label: "Lead Status Change",
    description: "Lead status updates",
  },
  {
    name: "OpportunityStatusChange",
    label: "Opportunity Status Change",
    description: "Opportunity status updates",
  },
  { name: "Note", label: "Note", description: "Manual notes" },
  {
    name: "TaskCompleted",
    label: "Task Completed",
    description: "Completed tasks",
  },
  {
    name: "CustomActivity",
    label: "Custom Activity",
    description: "Custom activity instances",
  },
];

/** Entity name, label, and how it is read. Same order as in-process. */
export type ReadKind =
  "search" | "users" | "groups" | "lookup" | "custom_fields" | "webhook_only";

export const CLOSE_BASE_ENTITIES: Array<[string, string, ReadKind]> = [
  ["leads", "Leads", "search"],
  ["opportunities", "Opportunities", "search"],
  ["contacts", "Contacts", "search"],
  ["users", "Users", "users"],
  ["custom_fields", "Custom Fields", "custom_fields"],
  ["custom_activity_types", "Custom Activity Types", "lookup"],
  ["custom_object_types", "Custom Object Types", "lookup"],
  ["custom_objects", "Custom Objects", "webhook_only"],
  ["lead_statuses", "Lead Statuses", "lookup"],
  ["opportunity_statuses", "Opportunity Statuses", "lookup"],
  ["outcomes", "Outcomes", "lookup"],
  ["groups", "Groups", "groups"],
];

/** Lookup entities: a plain paginated list with no filters. */
export const CLOSE_LOOKUP_ENDPOINTS: Record<string, string> = {
  lead_statuses: "/status/lead/",
  opportunity_statuses: "/status/opportunity/",
  custom_activity_types: "/custom_activity/",
  custom_object_types: "/custom_object_type/",
  outcomes: "/outcome/",
};

/**
 * Every custom-field list `custom_fields` reads, each row tagged with its
 * type. In-process reads the first 4 and gets activity and custom-object
 * fields only from `custom_fields.activity.*` and
 * `custom_fields.custom_object.*` webhooks, with `custom_field_type` null.
 * The folder reads all 6, so a poll alone has them, typed.
 */
export const CLOSE_CUSTOM_FIELD_ENDPOINTS = [
  { endpoint: "/custom_field/lead/", type: "lead" },
  { endpoint: "/custom_field/contact/", type: "contact" },
  { endpoint: "/custom_field/opportunity/", type: "opportunity" },
  { endpoint: "/custom_field/shared/", type: "shared" },
  { endpoint: "/custom_field/activity/", type: "activity" },
  { endpoint: "/custom_field/custom_object_type/", type: "custom_object" },
];

const SEARCH_OBJECT_TYPES: Record<string, string> = {
  leads: "lead",
  contacts: "contact",
  opportunities: "opportunity",
  "activities:Call": "activity.call",
  "activities:Email": "activity.email",
  "activities:EmailThread": "activity.email_thread",
  "activities:SMS": "activity.sms",
  "activities:Meeting": "activity.meeting",
  "activities:Note": "activity.note",
  "activities:LeadStatusChange": "activity.lead_status_change",
  "activities:OpportunityStatusChange": "activity.opportunity_status_change",
  "activities:TaskCompleted": "activity.task_completed",
  "activities:CustomActivity": "activity.custom_activity",
};

export function closeSearchObjectType(entity: string): string {
  return SEARCH_OBJECT_TYPES[entity] || entity;
}

/** Base (non-custom) fields the Search API requests per core object type. */
export const CLOSE_SEARCH_BASE_FIELDS: Record<string, string[]> = {
  lead: [
    "id",
    "name",
    "display_name",
    "description",
    "date_created",
    "date_updated",
    "created_by",
    "created_by_name",
    "updated_by",
    "updated_by_name",
    "organization_id",
    "status_id",
    "status_label",
    "source",
    "first_source",
    "addresses",
    "url",
    "html_url",
    "contacts",
    "contact_ids",
    "opportunities",
    "tasks",
    "integration_links",
    "primary_email",
    "primary_phone",
  ],
  contact: [
    "id",
    "name",
    "display_name",
    "title",
    "emails",
    "phones",
    "urls",
    "lead_id",
    "organization_id",
    "date_created",
    "date_updated",
    "created_by",
    "updated_by",
    "integration_links",
    "timezone",
    "timezone_source",
    "lead_suggestions_operation_id",
  ],
  opportunity: [
    "id",
    "lead_id",
    "lead_name",
    "contact_id",
    "contact_name",
    "status_id",
    "status_label",
    "status_type",
    "status_display_name",
    "pipeline_id",
    "pipeline_name",
    "user_id",
    "user_name",
    "value",
    "value_currency",
    "value_formatted",
    "value_period",
    "annualized_value",
    "expected_value",
    "annualized_expected_value",
    "confidence",
    "note",
    "note_html",
    "date_created",
    "date_updated",
    "date_won",
    "date_lost",
    "created_by",
    "created_by_name",
    "updated_by",
    "updated_by_name",
    "organization_id",
    "integration_links",
    "attachments",
    "is_stalled",
    "stall_status",
  ],
};
