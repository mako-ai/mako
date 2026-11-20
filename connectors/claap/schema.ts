/**
 * Claap entity schemas, field for field the same as the deleted in-process
 * connector's. The golden files and the API test hold them in place. Mako's
 * system columns are merged in on the box path.
 */

type FieldType = "string" | "timestamp" | "number" | "boolean" | "json";
type Fields = Record<string, FieldType>;

export const RECORDING_FIELDS: Fields = {
  id: "string",
  title: "string",
  state: "string",
  source: "string",
  url: "string",
  thumbnailUrl: "string",
  createdAt: "timestamp",
  durationSeconds: "number",
  labels: "json",
  channel: "json",
  recorder: "json",
  workspace: "json",
  meeting: "json",
  transcripts: "json",
  video: "json",
  actionItems: "json",
  companies: "json",
  crmInfo: "json",
  deal: "json",
  aiFields: "json",
  insightTemplates: "json",
  keyTakeaways: "json",
  outlines: "json",
};

/** One row per recording and transcript language; `id` is `<recordingId>:<langIso2>`. */
export const RECORDING_TRANSCRIPT_FIELDS: Fields = {
  id: "string",
  recordingId: "string",
  langIso2: "string",
  isTranscript: "boolean",
  isActive: "boolean",
  transcriptText: "string",
  segments: "json",
  segmentCount: "number",
  charCount: "number",
  fetchStatus: "string",
  fetchError: "string",
  fetchedAt: "timestamp",
  recordingCreatedAt: "timestamp",
};

export const WORKSPACE_FIELDS: Fields = {
  id: "string",
  name: "string",
  createdAt: "timestamp",
  membersCount: "number",
  recordingsCount: "number",
};

export const ENTITY_FIELDS: Record<string, Fields> = {
  recordings: RECORDING_FIELDS,
  recording_transcripts: RECORDING_TRANSCRIPT_FIELDS,
  workspace: WORKSPACE_FIELDS,
};

/** Non-null columns besides `id`, as the deleted in-process schema marked them. */
const NOT_NULL: Record<string, string[]> = {
  recording_transcripts: [
    "recordingId",
    "langIso2",
    "fetchStatus",
    "fetchedAt",
  ],
};

const JSON_SCHEMA_TYPES: Record<FieldType, Record<string, unknown>> = {
  string: { type: ["null", "string"] },
  timestamp: { type: ["null", "string"], format: "date-time" },
  number: { type: ["null", "number"] },
  boolean: { type: ["null", "boolean"] },
  json: { type: ["null", "object", "array", "string", "number", "boolean"] },
};

/** The stream's JSON Schema: `id` required, plus the in-process non-null columns. */
export function claapJsonSchema(entity: string): Record<string, unknown> {
  const fields = ENTITY_FIELDS[entity];
  if (!fields) throw new Error(`Unsupported entity: ${entity}`);
  const notNull = new Set(NOT_NULL[entity] ?? []);
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(fields)) {
    if (name === "id") {
      properties[name] = { type: "string" };
    } else if (notNull.has(name)) {
      const base = JSON_SCHEMA_TYPES[type];
      properties[name] = {
        ...base,
        type: (base.type as string[]).filter(t => t !== "null"),
      };
    } else {
      properties[name] = { ...JSON_SCHEMA_TYPES[type] };
    }
  }
  return {
    type: "object",
    additionalProperties: true,
    required: ["id"],
    properties,
  };
}
