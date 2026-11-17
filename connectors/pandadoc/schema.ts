/**
 * PandaDoc entity schemas, field for field the same as the in-process
 * connector's (`api/src/connectors/pandadoc/schema.ts`). The parity test
 * fails if the two drift.
 *
 * Mako's system columns (`_syncedAt`, `is_deleted`, the `_mako_*` columns,
 * ...) are not declared here: a connector cannot declare them over the wire.
 * `jsonSchemaToEntitySchema` merges all of them on the box path, as the
 * in-process schema spreads `MAKO_SYSTEM_FIELDS`.
 */

type FieldType = "string" | "timestamp" | "boolean" | "json";
type Fields = Record<string, FieldType>;

export const DOCUMENT_FIELDS: Fields = {
  id: "string",
  name: "string",
  status: "string",
  version: "string",
  autonumbering_sequence_name: "string",
  date_created: "timestamp",
  date_modified: "timestamp",
  date_completed: "timestamp",
  date_status_changed: "timestamp",
  date_sent: "timestamp",
  expiration_date: "timestamp",
  created_by: "json",
  sent_by: "json",
  template: "json",
  metadata: "json",
  tokens: "json",
  fields: "json",
  products: "json",
  pricing: "json",
  grand_total: "json",
  total: "string",
  tags: "json",
  recipients: "json",
  approvers: "json",
  linked_objects: "json",
};

export const TEMPLATE_FIELDS: Fields = {
  id: "string",
  name: "string",
  version: "string",
  date_created: "timestamp",
  date_modified: "timestamp",
  content_date_modified: "timestamp",
};

export const CONTACT_FIELDS: Fields = {
  id: "string",
  email: "string",
  first_name: "string",
  last_name: "string",
  company: "string",
  job_title: "string",
  phone: "string",
  country: "string",
  state: "string",
  street_address: "string",
  city: "string",
  postal_code: "string",
};

export const MEMBER_FIELDS: Fields = {
  // Members carry no `id`; the connector copies `membership_id` onto it.
  id: "string",
  user_id: "string",
  membership_id: "string",
  email: "string",
  first_name: "string",
  last_name: "string",
  is_active: "boolean",
  workspace: "string",
  workspace_name: "string",
  emails_verified: "boolean",
  email_verified: "boolean",
  role: "string",
  user_license: "string",
  date_created: "timestamp",
  date_modified: "timestamp",
};

export const ENTITY_FIELDS: Record<string, Fields> = {
  documents: DOCUMENT_FIELDS,
  templates: TEMPLATE_FIELDS,
  contacts: CONTACT_FIELDS,
  members: MEMBER_FIELDS,
};

const JSON_SCHEMA_TYPES: Record<FieldType, Record<string, unknown>> = {
  string: { type: ["null", "string"] },
  timestamp: { type: ["null", "string"], format: "date-time" },
  boolean: { type: ["null", "boolean"] },
  json: { type: ["null", "object", "array", "string", "number", "boolean"] },
};

/** The stream's JSON Schema. `id` is the only required, non-null field. */
export function pandaDocJsonSchema(entity: string): Record<string, unknown> {
  const fields = ENTITY_FIELDS[entity];
  if (!fields) throw new Error(`Unsupported entity: ${entity}`);
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(fields)) {
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
