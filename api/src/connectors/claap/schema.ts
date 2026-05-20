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
const j = (nullable = true): ConnectorFieldSchema => ({
  type: "json",
  nullable,
});

export const RECORDING_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  title: s(),
  state: s(),
  source: s(),
  url: s(),
  thumbnailUrl: s(),
  createdAt: ts(),
  durationSeconds: n(),
  labels: j(),
  channel: j(),
  recorder: j(),
  workspace: j(),
  meeting: j(),
  transcripts: j(),
  video: j(),
  actionItems: j(),
  companies: j(),
  crmInfo: j(),
  deal: j(),
  insightTemplates: j(),
  keyTakeaways: j(),
  outlines: j(),
  ...MAKO_SYSTEM_FIELDS,
};

export const WORKSPACE_SCHEMA: Record<string, ConnectorFieldSchema> = {
  id: { type: "string", required: true },
  name: s(),
  createdAt: ts(),
  membersCount: n(),
  recordingsCount: n(),
  ...MAKO_SYSTEM_FIELDS,
};

export const ENTITY_SCHEMA_MAP: Record<
  string,
  Record<string, ConnectorFieldSchema>
> = {
  recordings: RECORDING_SCHEMA,
  workspace: WORKSPACE_SCHEMA,
};

export function resolveClaapEntitySchema(
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
