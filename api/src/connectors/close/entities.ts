/**
 * The Close entity catalog: which entities exist, how each maps onto a
 * Close endpoint or Search API object type, the base fields the Search API
 * requests, and what incremental sync each supports.
 */
import type {
  EntityMetadata,
  IncrementalCapabilities,
} from "../base/BaseConnector";

// Close.com activity types
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

export function closeAvailableEntities(): string[] {
  const baseEntities = [
    "leads",
    "opportunities",
    "contacts",
    "users",
    "custom_fields",
    "custom_activity_types",
    "custom_object_types",
    "custom_objects",
    "lead_statuses",
    "opportunity_statuses",
    "outcomes",
    "groups",
  ];

  const activitySubEntities = CLOSE_ACTIVITY_TYPES.map(
    type => `activities:${type.name}`,
  );

  return [...baseEntities, ...activitySubEntities];
}

/** Entity metadata with sub-entities for activities. */
export function closeEntityMetadata(): EntityMetadata[] {
  // Default to `_syncedAt` as the partition field: it is stamped on every
  // destination write (insert/update), so partitions track last-sync time and
  // every entity has a guaranteed, always-populated timestamp to partition on.
  // Per-entity overrides (e.g. `date_created`) remain selectable in the flow UI.
  const defaultLayout = {
    partitionField: "_syncedAt",
    partitionGranularity: "day" as const,
    clusterFields: ["_dataSourceId", "id"],
  };
  // Lookup tables have no stable creation timestamp worth partitioning on.
  const lookupLayout = {
    partitionField: "_syncedAt",
    partitionGranularity: "day" as const,
    clusterFields: ["_dataSourceId", "id"],
  };
  return [
    { name: "leads", label: "Leads", layoutSuggestion: defaultLayout },
    {
      name: "opportunities",
      label: "Opportunities",
      layoutSuggestion: defaultLayout,
    },
    {
      name: "activities",
      label: "Activities",
      description: "All activity types from Close.com",
      layoutSuggestion: {
        partitionField: "_syncedAt",
        partitionGranularity: "day",
        clusterFields: ["_dataSourceId", "id"],
      },
      subEntities: CLOSE_ACTIVITY_TYPES.map(type => ({
        name: type.name,
        label: type.label,
        description: type.description,
      })),
    },
    { name: "contacts", label: "Contacts", layoutSuggestion: defaultLayout },
    { name: "users", label: "Users", layoutSuggestion: defaultLayout },
    {
      name: "custom_fields",
      label: "Custom Fields",
      layoutSuggestion: lookupLayout,
    },
    {
      name: "custom_activity_types",
      label: "Custom Activity Types",
      layoutSuggestion: lookupLayout,
    },
    {
      name: "custom_object_types",
      label: "Custom Object Types",
      layoutSuggestion: lookupLayout,
    },
    {
      name: "custom_objects",
      label: "Custom Objects",
      layoutSuggestion: defaultLayout,
    },
    {
      name: "lead_statuses",
      label: "Lead Statuses",
      layoutSuggestion: lookupLayout,
    },
    {
      name: "opportunity_statuses",
      label: "Opportunity Statuses",
      layoutSuggestion: lookupLayout,
    },
    {
      name: "outcomes",
      label: "Outcomes",
      layoutSuggestion: lookupLayout,
    },
    {
      name: "groups",
      label: "Groups",
      description: "User groups (functional teams, e.g. Sales / CSM)",
      layoutSuggestion: lookupLayout,
    },
  ];
}

export function closeIncrementalCapabilities(): IncrementalCapabilities {
  return {
    supported: true,
    // Search-API entities (leads/contacts/opportunities/activities:*) window
    // on `date_updated` when `since` is set. Offset-fallback entities use
    // `date_updated__gte`. Groups / lookup tables without a time filter
    // stay on the connector fallback only when listed below as none.
    mode: "native",
    perEntity: {
      users: { mode: "native", anchorField: "date_updated__gte" },
      custom_fields: { mode: "native", anchorField: "date_updated__gte" },
      leads: { mode: "native", anchorField: "date_updated" },
      contacts: { mode: "native", anchorField: "date_updated" },
      opportunities: { mode: "native", anchorField: "date_updated" },
      groups: { mode: "none" },
      lead_statuses: { mode: "none" },
      opportunity_statuses: { mode: "none" },
      outcomes: { mode: "none" },
      custom_activity_types: { mode: "none" },
      custom_object_types: { mode: "none" },
      custom_objects: { mode: "none" },
    },
  };
}

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

/** The Search API `object_type` of an entity (the entity itself if unmapped). */
export function closeSearchObjectType(entity: string): string {
  return SEARCH_OBJECT_TYPES[entity] || entity;
}

/** True for the entities the Search API serves. */
export function isCloseSearchEntity(entity: string): boolean {
  return (
    entity === "leads" ||
    entity === "contacts" ||
    entity === "opportunities" ||
    entity.startsWith("activities:")
  );
}

const LIST_ENDPOINTS: Record<string, string> = {
  leads: "/lead/",
  opportunities: "/opportunity/",
  contacts: "/contact/",
  users: "/user/",
};

/** The list endpoint of an entity read with offset pagination. */
export function closeEntityEndpoint(entity: string): string {
  const endpoint = LIST_ENDPOINTS[entity];
  if (!endpoint) throw new Error(`No endpoint for entity: ${entity}`);
  return endpoint;
}

/** Lookup entities: a plain paginated list with no filters. */
export const CLOSE_SIMPLE_ENTITY_ENDPOINTS: Record<string, string> = {
  lead_statuses: "/status/lead/",
  opportunity_statuses: "/status/opportunity/",
  custom_activity_types: "/custom_activity/",
  custom_object_types: "/custom_object_type/",
  outcomes: "/outcome/",
};

/** Every custom-field list endpoint, with the type each one lists. */
export const CLOSE_CUSTOM_FIELD_ENDPOINTS = [
  { endpoint: "/custom_field/lead/", type: "lead" },
  { endpoint: "/custom_field/contact/", type: "contact" },
  { endpoint: "/custom_field/opportunity/", type: "opportunity" },
  { endpoint: "/custom_field/shared/", type: "shared" },
];

/**
 * Base (non-custom) fields the Search API requests per object type. Activity
 * subtypes are not listed: they request exactly the columns their schema
 * declares (closeActivitySearchFields in schema.ts).
 */
export function closeSearchBaseFields(): Record<string, string[]> {
  return {
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
}
