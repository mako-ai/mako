/**
 * PostHog entity schemas, field for field the same as the in-process
 * connector's (`api/src/connectors/posthog/schema.ts`). The parity harness in
 * `fixtures/` fails if the two drift.
 *
 * Two things differ in form, not in meaning:
 * - Mako's system columns (`_mako_*`, `_syncedAt`, `is_deleted`, ...) are not
 *   declared here: a connector cannot declare them over the wire.
 *   `jsonSchemaToEntitySchema` merges all 8 on the box path, as the
 *   in-process schema spreads them, and the parity test checks they match.
 * - Nullability is a JSON Schema type list. A field the in-process schema
 *   marks `nullable: false` (a survey's `name`, a response's `uuid`) has no
 *   `"null"` in its list; every other field has one.
 */

type FieldType = "string" | "timestamp" | "number" | "boolean" | "json";
/** A type, and whether the field may be null (the in-process `nullable`). */
type Field = [type: FieldType, nullable: boolean];
type Fields = Record<string, Field>;

const s = (nullable = true): Field => ["string", nullable];
const ts = (nullable = true): Field => ["timestamp", nullable];
const n = (nullable = true): Field => ["number", nullable];
const b = (nullable = true): Field => ["boolean", nullable];
const j = (nullable = true): Field => ["json", nullable];

/** `id` is the key: required and never null, as in-process. */
interface EntityFields {
  idType: "string" | "number";
  fields: Fields;
}

const SURVEY: EntityFields = {
  idType: "string",
  fields: {
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
  },
};

const SURVEY_RESPONSE: EntityFields = {
  idType: "string",
  fields: {
    uuid: s(false),
    survey_id: s(false),
    distinct_id: s(),
    session_id: s(),
    submitted_at: ts(),
    answers: j(),
    extra: j(),
  },
};

const FEATURE_FLAG: EntityFields = {
  idType: "number",
  fields: {
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
  },
};

const EXPERIMENT: EntityFields = {
  idType: "number",
  fields: {
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
  },
};

const ANNOTATION: EntityFields = {
  idType: "number",
  fields: {
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
  },
};

export const POSTHOG_ENTITY_FIELDS: Record<string, EntityFields> = {
  surveys: SURVEY,
  survey_responses: SURVEY_RESPONSE,
  feature_flags: FEATURE_FLAG,
  experiments: EXPERIMENT,
  annotations: ANNOTATION,
};

const JSON_TYPES: Record<FieldType, Record<string, unknown>> = {
  string: { type: "string" },
  timestamp: { type: "string", format: "date-time" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  json: { type: ["object", "array"] },
};

function property([type, nullable]: Field): Record<string, unknown> {
  const base = JSON_TYPES[type];
  const types = Array.isArray(base.type) ? base.type : [base.type];
  return {
    ...base,
    type: nullable ? ["null", ...types] : types,
  };
}

/** The SDK's shorthand, for `schema` (the cursor-field check reads it). */
export function posthogShorthandSchema(
  entity: string,
): Record<string, FieldType> {
  const definition = POSTHOG_ENTITY_FIELDS[entity];
  if (!definition) throw new Error(`Unsupported entity: ${entity}`);
  return {
    id: definition.idType,
    ...Object.fromEntries(
      Object.entries(definition.fields).map(([name, [type]]) => [name, type]),
    ),
  };
}

/** The stream's JSON Schema. `id` is the only required field. */
export function posthogJsonSchema(entity: string): Record<string, unknown> {
  const definition = POSTHOG_ENTITY_FIELDS[entity];
  if (!definition) throw new Error(`Unsupported entity: ${entity}`);
  const properties: Record<string, unknown> = {
    id: { type: definition.idType },
  };
  for (const [name, field] of Object.entries(definition.fields)) {
    properties[name] = property(field);
  }
  return {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties,
  };
}
