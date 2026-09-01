import {
  MAKO_SYSTEM_FIELDS,
  type ConnectorEntitySchema,
  type ConnectorFieldSchema,
} from "../base/BaseConnector";

const GCS_FILE_FIELDS: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", nullable: false, required: true },
  _source_key: { type: "string", nullable: false },
  _source_generation: { type: "string", nullable: true },
  _source_updated_at: { type: "timestamp", nullable: true },
};

/**
 * CSV columns are inferred at sync time. Declare the stable system fields and
 * accept unknown CSV columns as strings.
 */
export function resolveGcsEntitySchema(entity: string): ConnectorEntitySchema {
  return {
    entity,
    fields: {
      ...GCS_FILE_FIELDS,
      ...MAKO_SYSTEM_FIELDS,
    },
    unknownFieldPolicy: "string",
    keyColumns: ["id"],
  };
}
