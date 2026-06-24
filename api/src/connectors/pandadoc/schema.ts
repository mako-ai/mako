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
const b = (nullable = true): ConnectorFieldSchema => ({
  type: "boolean",
  nullable,
});
const j = (nullable = true): ConnectorFieldSchema => ({
  type: "json",
  nullable,
});

// ---------------------------------------------------------------------------
// Entity schemas
//
// PandaDoc list endpoints return a shallow projection; webhooks (and the
// document details endpoint) deliver the richer nested objects. We declare the
// union of fields seen across both and lean on `unknownFieldPolicy: "string"`
// for anything the API adds later, so backfill rows and webhook rows converge
// on the same table.
// ---------------------------------------------------------------------------

export const DOCUMENT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  status: s(),
  version: s(),
  autonumbering_sequence_name: s(),
  date_created: ts(),
  date_modified: ts(),
  date_completed: ts(),
  date_status_changed: ts(),
  date_sent: ts(),
  expiration_date: ts(),
  created_by: j(),
  sent_by: j(),
  template: j(),
  metadata: j(),
  tokens: j(),
  fields: j(),
  products: j(),
  pricing: j(),
  grand_total: j(),
  total: s(),
  tags: j(),
  recipients: j(),
  approvers: j(),
  linked_objects: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const TEMPLATE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  version: s(),
  date_created: ts(),
  date_modified: ts(),
  content_date_modified: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const CONTACT_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  email: s(),
  first_name: s(),
  last_name: s(),
  company: s(),
  job_title: s(),
  phone: s(),
  country: s(),
  state: s(),
  street_address: s(),
  city: s(),
  postal_code: s(),
  ...MAKO_SYSTEM_FIELDS,
};

export const MEMBER_SCHEMA: Record<string, ConnectorFieldSchema> = {
  // PandaDoc members carry no `id`; the connector derives one from
  // `membership_id` so the key column stays consistent across entities.
  id: { type: "string", required: true },
  user_id: s(),
  membership_id: s(),
  email: s(),
  first_name: s(),
  last_name: s(),
  is_active: b(),
  workspace: s(),
  workspace_name: s(),
  emails_verified: b(),
  email_verified: b(),
  role: s(),
  user_license: s(),
  date_created: ts(),
  date_modified: ts(),
  ...MAKO_SYSTEM_FIELDS,
};

export const ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  documents: DOCUMENT_SCHEMA,
  templates: TEMPLATE_SCHEMA,
  contacts: CONTACT_SCHEMA,
  members: MEMBER_SCHEMA,
};

export function resolvePandaDocEntitySchema(
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
