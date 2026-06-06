import { z } from "zod";

type FieldCategory =
  | "source"
  | "destination"
  | "mapping"
  | "schedule"
  | "safety"
  | "pagination";

interface FieldMeta {
  description: string;
  injectInContext: boolean;
  category: FieldCategory;
  example?: string;
  format?: "code" | "json" | "cron";
}

interface AgentField<T extends z.ZodTypeAny> {
  schema: T;
  meta: FieldMeta;
}

function agentField<T extends z.ZodTypeAny>(
  schema: T,
  meta: FieldMeta,
): AgentField<T> {
  return { schema: schema.describe(meta.description), meta };
}

export const TRANSFORM_SCHEMA = z.object({
  ops: z
    .array(
      z.enum([
        "trim",
        "lowercase",
        "uppercase",
        "to_string",
        "to_number",
        "to_iso_date",
      ]),
    )
    .optional(),
  template: z.string().optional(),
  lookupMap: z.record(z.string(), z.string()).optional(),
  defaultValue: z.unknown().optional(),
});

export const MAPPING_SCHEMA = z.object({
  target: z.string().min(1),
  source: z.object({
    column: z.string().optional(),
    const: z.unknown().optional(),
    transform: TRANSFORM_SCHEMA.optional(),
  }),
  required: z.boolean().default(false),
  onConflict: z.enum(["overwrite", "fill_empty", "ignore"]).optional(),
});

export const MATCH_SCHEMA = z.object({
  lookupColumn: z.string().min(1),
  remoteField: z.string().min(1),
  onMultiple: z.enum(["skip", "update_first", "fail"]).default("skip"),
});

export const SOURCE_FIELDS = {
  connectionId: agentField(z.string().min(1), {
    description: "Source database connection ID",
    injectInContext: true,
    category: "source",
  }),
  database: agentField(z.string().optional(), {
    description: "Optional source database or dataset name",
    injectInContext: true,
    category: "source",
  }),
  query: agentField(z.string().min(1), {
    description:
      "SQL query to read rows, with optional {{limit}}, {{offset}}, {{last_sync_value}}, {{keyset_value}} placeholders",
    injectInContext: true,
    category: "source",
    format: "code",
  }),
  primaryKey: agentField(z.string().min(1), {
    description: "Source column that uniquely identifies each outbound row",
    injectInContext: true,
    category: "source",
  }),
} as const;

export const SOURCE_SCHEMA = z.object({
  connectionId: SOURCE_FIELDS.connectionId.schema,
  database: SOURCE_FIELDS.database.schema,
  query: SOURCE_FIELDS.query.schema,
  primaryKey: SOURCE_FIELDS.primaryKey.schema,
});

export const DESTINATION_FIELDS = {
  connectorId: agentField(z.string().min(1), {
    description: "Destination connector ID",
    injectInContext: true,
    category: "destination",
  }),
  entity: agentField(z.string().min(1).default("leads"), {
    description: "Destination entity, for example Close leads",
    injectInContext: true,
    category: "destination",
  }),
  writeMode: agentField(
    z.enum(["create", "update", "upsert"]).default("upsert"),
    {
      description: "Whether to create, update, or upsert destination records",
      injectInContext: true,
      category: "destination",
    },
  ),
  allowCreate: agentField(z.boolean().default(true), {
    description: "Allow creating a new destination record when no match exists",
    injectInContext: true,
    category: "destination",
  }),
  updateFieldStrategy: agentField(
    z.enum(["overwrite", "fill_empty", "ignore"]).default("fill_empty"),
    {
      description:
        "How updates handle existing destination values: overwrite, fill_empty, or ignore",
      injectInContext: true,
      category: "destination",
    },
  ),
  match: agentField(MATCH_SCHEMA, {
    description: "Destination match configuration",
    injectInContext: true,
    category: "destination",
    format: "json",
  }),
} as const;

export const DESTINATION_SCHEMA = z.object({
  connectorId: DESTINATION_FIELDS.connectorId.schema,
  entity: DESTINATION_FIELDS.entity.schema,
  writeMode: DESTINATION_FIELDS.writeMode.schema,
  allowCreate: DESTINATION_FIELDS.allowCreate.schema,
  updateFieldStrategy: DESTINATION_FIELDS.updateFieldStrategy.schema,
  match: DESTINATION_FIELDS.match.schema,
});

export const INCREMENTAL_SCHEMA = z.object({
  trackingColumn: z.string().min(1),
  trackingType: z.enum(["timestamp", "numeric", "string"]).default("timestamp"),
  lastValue: z.string().optional(),
});

export const PAGINATION_SCHEMA = z.object({
  mode: z.enum(["offset", "keyset"]).default("offset"),
  keysetColumn: z.string().optional(),
  keysetDirection: z.enum(["asc", "desc"]).default("asc"),
});

export const SCHEDULE_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().optional(),
  timezone: z.string().default("UTC"),
});

export const SAFETY_SCHEMA = z.object({
  maxRowsPerRun: z.number().int().positive().max(50000).default(5000),
  dryRunRequiredBeforeActivate: z.boolean().default(true),
  batchSize: z.number().int().positive().max(1000).default(200),
});

export const REVERSE_FLOW_SPEC_SCHEMA = z.object({
  source: SOURCE_SCHEMA,
  destination: DESTINATION_SCHEMA,
  mappings: z.array(MAPPING_SCHEMA).default([]),
  incremental: INCREMENTAL_SCHEMA.optional(),
  pagination: PAGINATION_SCHEMA.optional(),
  schedule: SCHEDULE_SCHEMA.default({
    enabled: false,
    timezone: "UTC",
  }),
  safety: SAFETY_SCHEMA.default({
    maxRowsPerRun: 5000,
    dryRunRequiredBeforeActivate: true,
    batchSize: 200,
  }),
});

export type TransformSpec = z.infer<typeof TRANSFORM_SCHEMA>;
export type MappingSpec = z.infer<typeof MAPPING_SCHEMA>;
export type MatchSpec = z.infer<typeof MATCH_SCHEMA>;
export type ReverseFlowSpec = z.infer<typeof REVERSE_FLOW_SPEC_SCHEMA>;

export const DEFAULT_REVERSE_FLOW_SPEC: ReverseFlowSpec = {
  source: {
    connectionId: "",
    query: "",
    primaryKey: "",
  },
  destination: {
    connectorId: "",
    entity: "leads",
    writeMode: "upsert",
    allowCreate: true,
    updateFieldStrategy: "fill_empty",
    match: {
      lookupColumn: "email",
      remoteField: "email",
      onMultiple: "skip",
    },
  },
  mappings: [],
  schedule: {
    enabled: false,
    timezone: "UTC",
  },
  safety: {
    maxRowsPerRun: 5000,
    dryRunRequiredBeforeActivate: true,
    batchSize: 200,
  },
};

export const FIELD_PATHS = [
  "source.connectionId",
  "source.database",
  "source.query",
  "source.primaryKey",
  "destination.connectorId",
  "destination.entity",
  "destination.writeMode",
  "destination.allowCreate",
  "destination.updateFieldStrategy",
  "destination.match",
  "destination.match.lookupColumn",
  "destination.match.remoteField",
  "destination.match.onMultiple",
  "mappings",
  "incremental",
  "incremental.trackingColumn",
  "incremental.trackingType",
  "incremental.lastValue",
  "pagination",
  "pagination.mode",
  "pagination.keysetColumn",
  "pagination.keysetDirection",
  "schedule.enabled",
  "schedule.cron",
  "schedule.timezone",
  "safety.maxRowsPerRun",
  "safety.dryRunRequiredBeforeActivate",
  "safety.batchSize",
] as const;

export const CONTEXT_FIELDS = FIELD_PATHS.filter(
  path => !path.endsWith(".lastValue"),
);

export const formFieldValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(MAPPING_SCHEMA),
  MATCH_SCHEMA,
  INCREMENTAL_SCHEMA,
  PAGINATION_SCHEMA,
  SCHEDULE_SCHEMA,
  SAFETY_SCHEMA,
]);

export function validateReverseFlowSpec(input: unknown): ReverseFlowSpec {
  return REVERSE_FLOW_SPEC_SCHEMA.parse(input);
}

export function applyReverseFlowDefaults(input: unknown): ReverseFlowSpec {
  return REVERSE_FLOW_SPEC_SCHEMA.parse({
    ...DEFAULT_REVERSE_FLOW_SPEC,
    ...(typeof input === "object" && input !== null ? input : {}),
  });
}
