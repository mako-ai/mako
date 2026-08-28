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

export const SURVEY_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(false),
  description: s(),
  type: s(),
  schedule: s(),
  linked_flag_id: n(),
  linked_insight_id: n(),
  linked_flag: j(),
  targeting_flag: j(),
  internal_targeting_flag: j(),
  questions: j(),
  conditions: j(),
  appearance: j(),
  created_at: ts(),
  created_by: j(),
  start_date: ts(),
  end_date: ts(),
  archived: b(),
  responses_limit: n(),
  feature_flag_keys: j(),
  iteration_count: n(),
  iteration_frequency_days: n(),
  iteration_start_dates: j(),
  current_iteration: n(),
  current_iteration_start_date: ts(),
  response_sampling_start_date: ts(),
  response_sampling_interval_type: s(),
  response_sampling_interval: n(),
  response_sampling_limit: n(),
  response_sampling_daily_limits: j(),
  enable_partial_responses: b(),
  enable_iframe_embedding: b(),
  base_language: s(),
  translations: j(),
  user_access_level: s(),
  form_content: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const SURVEY_RESPONSE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  uuid: s(false),
  survey_id: s(false),
  distinct_id: s(),
  session_id: s(),
  submitted_at: ts(),
  answers: j(),
  extra: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const FEATURE_FLAG_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "number", required: true },
  key: s(false),
  name: s(),
  filters: j(),
  active: b(),
  deleted: b(),
  is_simple_flag: b(),
  rollout_percentage: n(),
  ensure_experience_continuity: b(),
  experiment_set: j(),
  surveys: j(),
  features: j(),
  rollback_conditions: j(),
  performed_rollback: b(),
  tags: j(),
  usage_dashboard: n(),
  analytics_dashboards: j(),
  has_enriched_analytics: b(),
  user_access_level: s(),
  status: s(),
  version: n(),
  created_by: j(),
  created_at: ts(),
  last_modified_by: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const EXPERIMENT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "number", required: true },
  name: s(false),
  description: s(),
  type: s(),
  start_date: ts(),
  end_date: ts(),
  feature_flag_key: s(),
  feature_flag: j(),
  holdout: j(),
  holdout_id: n(),
  exposure_criteria: j(),
  parameters: j(),
  filters: j(),
  metrics: j(),
  metrics_secondary: j(),
  secondary_metrics: j(),
  saved_metrics: j(),
  stats_config: j(),
  conclusion: s(),
  conclusion_comment: s(),
  archived: b(),
  deleted: b(),
  created_by: j(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const ANNOTATION_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "number", required: true },
  content: s(),
  date_marker: ts(),
  creation_type: s(),
  scope: s(),
  dashboard_item: n(),
  dashboard_id: n(),
  dashboard_name: s(),
  insight_short_id: s(),
  insight_name: s(),
  insight_derived_name: s(),
  deleted: b(),
  created_by: j(),
  created_at: ts(),
  updated_at: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const BUILTIN_ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  surveys: SURVEY_SCHEMA,
  survey_responses: SURVEY_RESPONSE_SCHEMA,
  feature_flags: FEATURE_FLAG_SCHEMA,
  experiments: EXPERIMENT_SCHEMA,
  annotations: ANNOTATION_SCHEMA,
};

export function resolvePosthogEntitySchema(
  entity: string,
): ConnectorEntitySchema | null {
  const fields = BUILTIN_ENTITY_SCHEMA_MAP[entity];
  if (!fields) return null;

  return {
    entity,
    fields: { ...fields },
    unknownFieldPolicy: "string",
    keyColumns: ["id"],
  };
}
