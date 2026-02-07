/**
 * Unified Database Flow Form Schema
 *
 * SINGLE SOURCE OF TRUTH for:
 * - MongoDB/Mongoose validation
 * - API route validation
 * - Frontend form types and validation
 * - Agent context injection
 * - Agent tool field names
 * - Generated prompt documentation
 *
 * The form uses the SAME nested structure as the database.
 * No more translation layers!
 */

import { z } from "zod";

// =============================================================================
// Field Metadata for Agent Integration
// =============================================================================

type FieldCategory =
  | "source"
  | "destination"
  | "schedule"
  | "sync"
  | "schema"
  | "pagination";

interface FieldMeta {
  /** Description shown to the agent and in generated docs */
  description: string;
  /** Whether to include this field in the agent's runtime context */
  injectInContext: boolean;
  /** Category for grouping in documentation */
  category: FieldCategory;
  /** Example value for documentation */
  example?: string;
  /** Format hint for special rendering (e.g., SQL code blocks) */
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

// =============================================================================
// THE SINGLE SOURCE OF TRUTH - Schema Definition with Agent Metadata
// =============================================================================

/**
 * Database Source Configuration
 */
export const DATABASE_SOURCE_FIELDS = {
  connectionId: agentField(
    z.string().min(1, "Source connection ID is required"),
    {
      description: "Source database connection ID",
      injectInContext: true,
      category: "source",
    },
  ),
  database: agentField(z.string().optional(), {
    description: "Source database name (for cluster mode or BigQuery dataset)",
    injectInContext: true,
    category: "source",
  }),
  query: agentField(z.string().min(1, "SQL query is required"), {
    description:
      "SQL query with template placeholders ({{limit}}, {{offset}}, etc.)",
    injectInContext: true,
    category: "source",
    format: "code",
  }),
} as const;

/**
 * Table Destination Configuration
 */
export const TABLE_DESTINATION_FIELDS = {
  connectionId: agentField(
    z.string().min(1, "Destination connection ID is required"),
    {
      description: "Destination database connection ID",
      injectInContext: true,
      category: "destination",
    },
  ),
  database: agentField(z.string().optional(), {
    description: "Destination database name (for cluster mode)",
    injectInContext: true,
    category: "destination",
  }),
  schema: agentField(z.string().optional(), {
    description:
      "Destination schema (PostgreSQL) or dataset (BigQuery) - REQUIRED for BigQuery",
    injectInContext: true,
    category: "destination",
  }),
  tableName: agentField(z.string().min(1, "Table name is required"), {
    description: "Target table name where data will be written",
    injectInContext: true,
    category: "destination",
  }),
  createIfNotExists: agentField(z.boolean().default(true), {
    description: "Auto-create table if it doesn't exist",
    injectInContext: false,
    category: "destination",
  }),
} as const;

/**
 * Schedule Configuration
 */
export const SCHEDULE_FIELDS = {
  enabled: agentField(z.boolean().default(false), {
    description: "Enable automatic scheduled runs",
    injectInContext: true,
    category: "schedule",
  }),
  cron: agentField(
    z
      .string()
      .optional()
      .refine(
        val => {
          if (!val) return true;
          const parts = val.trim().split(/\s+/);
          return parts.length === 5 || parts.length === 6;
        },
        { message: "Invalid cron expression. Must have 5 or 6 fields." },
      ),
    {
      description:
        "Cron expression for scheduling (e.g., '0 6 * * *' for daily at 6 AM)",
      injectInContext: true,
      category: "schedule",
      example: "0 6 * * *",
      format: "cron",
    },
  ),
  timezone: agentField(z.string().default("UTC"), {
    description: "Timezone for the schedule",
    injectInContext: true,
    category: "schedule",
    example: "America/New_York",
  }),
} as const;

/**
 * Incremental Sync Configuration
 */
export const INCREMENTAL_CONFIG_FIELDS = {
  trackingColumn: agentField(z.string().min(1, "Tracking column is required"), {
    description: "Column to track for incremental updates (e.g., 'updated_at')",
    injectInContext: true,
    category: "sync",
  }),
  trackingType: agentField(z.enum(["timestamp", "numeric"]), {
    description: "Type of the tracking column",
    injectInContext: true,
    category: "sync",
  }),
  lastValue: agentField(z.string().optional(), {
    description: "Last synced value (managed by system)",
    injectInContext: false,
    category: "sync",
  }),
} as const;

/**
 * Conflict Resolution Configuration
 */
export const CONFLICT_CONFIG_FIELDS = {
  keyColumns: agentField(
    z.array(z.string().min(1)).min(1, "At least one key column is required"),
    {
      description: "Columns that form the unique key for conflict detection",
      injectInContext: true,
      category: "sync",
    },
  ),
  strategy: agentField(
    z.enum(["update", "ignore", "replace"]).default("update"),
    {
      description:
        "How to handle conflicts: update (update existing), ignore (skip), replace (delete and insert)",
      injectInContext: true,
      category: "sync",
    },
  ),
} as const;

/**
 * Pagination Configuration
 */
export const PAGINATION_CONFIG_FIELDS = {
  mode: agentField(z.enum(["offset", "keyset"]).default("offset"), {
    description:
      "Pagination strategy: offset (LIMIT/OFFSET) or keyset (WHERE col > last_value)",
    injectInContext: true,
    category: "pagination",
  }),
  keysetColumn: agentField(z.string().optional(), {
    description: "Column for keyset pagination (required if mode is 'keyset')",
    injectInContext: true,
    category: "pagination",
  }),
  keysetDirection: agentField(z.enum(["asc", "desc"]).default("asc"), {
    description: "Sort direction for keyset pagination",
    injectInContext: false,
    category: "pagination",
  }),
  lastKeysetValue: agentField(z.string().optional(), {
    description: "Last keyset value (managed by system)",
    injectInContext: false,
    category: "pagination",
  }),
} as const;

/**
 * Type Coercion (Column Mapping) Configuration
 */
export const TYPE_COERCION_SCHEMA = z.object({
  column: z.string().min(1, "Column name is required"),
  sourceType: z.string().optional(),
  targetType: z.string(),
  format: z.string().optional(),
  nullValue: z.unknown().optional(),
  nullable: z.boolean().optional(),
  transformer: z
    .enum(["lowercase", "uppercase", "trim", "json_parse", "json_stringify"])
    .optional(),
});

export type TypeCoercion = z.infer<typeof TYPE_COERCION_SCHEMA>;

/**
 * Top-level form fields
 */
export const TOP_LEVEL_FIELDS = {
  syncMode: agentField(z.enum(["full", "incremental"]).default("full"), {
    description:
      "Sync strategy: full (replace all) or incremental (only new/changed)",
    injectInContext: true,
    category: "sync",
  }),
  batchSize: agentField(z.number().min(100).max(50000).default(2000), {
    description: "Number of rows per batch (100-50000)",
    injectInContext: true,
    category: "sync",
  }),
  typeCoercions: agentField(z.array(TYPE_COERCION_SCHEMA).optional(), {
    description: "Column type mappings for the destination table",
    injectInContext: true,
    category: "schema",
    format: "json",
  }),
} as const;

// =============================================================================
// Build Zod Schemas from Field Definitions
// =============================================================================

function buildZodObject<T extends Record<string, AgentField<z.ZodTypeAny>>>(
  fields: T,
): z.ZodObject<{ [K in keyof T]: T[K]["schema"] }> {
  const shape = {} as Record<string, z.ZodTypeAny>;
  for (const [key, field] of Object.entries(fields)) {
    shape[key] = field.schema;
  }
  return z.object(shape) as z.ZodObject<{ [K in keyof T]: T[K]["schema"] }>;
}

export const DatabaseSourceSchema = buildZodObject(DATABASE_SOURCE_FIELDS);
export const TableDestinationSchema = buildZodObject(TABLE_DESTINATION_FIELDS);
export const ScheduleConfigSchema = buildZodObject(SCHEDULE_FIELDS);
export const IncrementalConfigSchema = buildZodObject(
  INCREMENTAL_CONFIG_FIELDS,
);
export const ConflictConfigSchema = buildZodObject(CONFLICT_CONFIG_FIELDS);
export const PaginationConfigSchema = buildZodObject(PAGINATION_CONFIG_FIELDS);

/**
 * Complete Database Flow Form Schema
 * This IS the form data structure AND the API payload structure
 */
export const DbFlowFormSchema = z.object({
  // Source configuration
  databaseSource: DatabaseSourceSchema,

  // Destination configuration
  tableDestination: TableDestinationSchema,

  // Schedule configuration
  schedule: ScheduleConfigSchema.optional().default({
    enabled: false,
    timezone: "UTC",
  }),

  // Sync mode
  syncMode: TOP_LEVEL_FIELDS.syncMode.schema,

  // Optional configurations (only present when relevant)
  incrementalConfig: IncrementalConfigSchema.optional(),
  conflictConfig: ConflictConfigSchema.optional(),
  paginationConfig: PaginationConfigSchema.optional(),

  // Type coercions / column mappings
  typeCoercions: TOP_LEVEL_FIELDS.typeCoercions.schema,

  // Batch size
  batchSize: TOP_LEVEL_FIELDS.batchSize.schema,
});

export type DbFlowFormData = z.infer<typeof DbFlowFormSchema>;

// =============================================================================
// Field Paths - All valid paths for agent tools
// =============================================================================

/**
 * All valid field paths that can be set via agent tools
 * These are the exact paths used by React Hook Form
 */
export const FIELD_PATHS = [
  // Database source
  "databaseSource.connectionId",
  "databaseSource.database",
  "databaseSource.query",

  // Table destination
  "tableDestination.connectionId",
  "tableDestination.database",
  "tableDestination.schema",
  "tableDestination.tableName",
  "tableDestination.createIfNotExists",

  // Schedule
  "schedule.enabled",
  "schedule.cron",
  "schedule.timezone",

  // Top-level
  "syncMode",
  "batchSize",

  // Incremental config
  "incrementalConfig",
  "incrementalConfig.trackingColumn",
  "incrementalConfig.trackingType",

  // Conflict config
  "conflictConfig",
  "conflictConfig.keyColumns",
  "conflictConfig.strategy",

  // Pagination config
  "paginationConfig",
  "paginationConfig.mode",
  "paginationConfig.keysetColumn",
  "paginationConfig.keysetDirection",

  // Type coercions (set as array)
  "typeCoercions",
] as const;

export type FieldPath = (typeof FIELD_PATHS)[number];

// =============================================================================
// Field Metadata Access
// =============================================================================

type FieldDefinitions = {
  databaseSource: typeof DATABASE_SOURCE_FIELDS;
  tableDestination: typeof TABLE_DESTINATION_FIELDS;
  schedule: typeof SCHEDULE_FIELDS;
  incrementalConfig: typeof INCREMENTAL_CONFIG_FIELDS;
  conflictConfig: typeof CONFLICT_CONFIG_FIELDS;
  paginationConfig: typeof PAGINATION_CONFIG_FIELDS;
  syncMode: (typeof TOP_LEVEL_FIELDS)["syncMode"];
  batchSize: (typeof TOP_LEVEL_FIELDS)["batchSize"];
  typeCoercions: (typeof TOP_LEVEL_FIELDS)["typeCoercions"];
};

const FIELD_DEFINITIONS: FieldDefinitions = {
  databaseSource: DATABASE_SOURCE_FIELDS,
  tableDestination: TABLE_DESTINATION_FIELDS,
  schedule: SCHEDULE_FIELDS,
  incrementalConfig: INCREMENTAL_CONFIG_FIELDS,
  conflictConfig: CONFLICT_CONFIG_FIELDS,
  paginationConfig: PAGINATION_CONFIG_FIELDS,
  syncMode: TOP_LEVEL_FIELDS.syncMode,
  batchSize: TOP_LEVEL_FIELDS.batchSize,
  typeCoercions: TOP_LEVEL_FIELDS.typeCoercions,
};

/**
 * Get metadata for a field path
 */
export function getFieldMeta(path: string): FieldMeta | undefined {
  const parts = path.split(".");

  if (parts.length === 1) {
    // Top-level field
    const field = FIELD_DEFINITIONS[parts[0] as keyof FieldDefinitions];
    if (field && "meta" in field) {
      return field.meta;
    }
    return undefined;
  }

  if (parts.length === 2) {
    const [section, fieldName] = parts;
    const sectionDef = FIELD_DEFINITIONS[section as keyof FieldDefinitions];
    if (
      sectionDef &&
      typeof sectionDef === "object" &&
      fieldName in sectionDef
    ) {
      const field = (sectionDef as Record<string, AgentField<z.ZodTypeAny>>)[
        fieldName
      ];
      return field?.meta;
    }
  }

  return undefined;
}

// =============================================================================
// Context Fields - Fields to inject into agent context
// =============================================================================

/**
 * Field paths that should be included in the agent's runtime context
 * Derived from field metadata (injectInContext: true)
 */
export const CONTEXT_FIELDS = FIELD_PATHS.filter(path => {
  const meta = getFieldMeta(path);
  return meta?.injectInContext === true;
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set a nested value in an object using dot notation
 * Returns a new object (immutable)
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split(".");
  const result = { ...obj };

  if (parts.length === 1) {
    result[parts[0]] = value;
    return result;
  }

  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    } else {
      current[part] = { ...(current[part] as Record<string, unknown>) };
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
  return result;
}

// =============================================================================
// Documentation Generation
// =============================================================================

/**
 * Format a value for display in the context
 */
export function formatContextValue(
  path: string,
  value: unknown,
  meta: FieldMeta,
): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const displayPath = path;

  if (meta.format === "code" && typeof value === "string") {
    return `**${displayPath}:**\n\`\`\`sql\n${value}\n\`\`\`\n`;
  }

  if (meta.format === "json" || Array.isArray(value)) {
    return `**${displayPath}:** ${JSON.stringify(value)}\n`;
  }

  return `**${displayPath}:** ${value}\n`;
}

/**
 * Generate field documentation for the agent prompt
 * Grouped by category with descriptions
 */
export function generateFieldDocs(): string {
  const categoryLabels: Record<FieldCategory, string> = {
    source: "Source Configuration",
    destination: "Destination Configuration",
    schedule: "Schedule Configuration",
    sync: "Sync Settings",
    schema: "Schema Mapping",
    pagination: "Pagination Settings",
  };

  const categoryOrder: FieldCategory[] = [
    "source",
    "destination",
    "schedule",
    "sync",
    "pagination",
    "schema",
  ];

  // Group fields by category
  const byCategory: Record<
    FieldCategory,
    Array<{ path: string; meta: FieldMeta }>
  > = {
    source: [],
    destination: [],
    schedule: [],
    sync: [],
    schema: [],
    pagination: [],
  };

  for (const path of FIELD_PATHS) {
    const meta = getFieldMeta(path);
    if (meta) {
      byCategory[meta.category].push({ path, meta });
    }
  }

  // Generate documentation
  let docs = "";

  for (const category of categoryOrder) {
    const fields = byCategory[category];
    if (fields.length === 0) continue;

    docs += `\n**${categoryLabels[category]}:**\n`;
    docs += `| Field | Description |\n`;
    docs += `|-------|-------------|\n`;

    for (const { path, meta } of fields) {
      const example = meta.example ? ` (e.g., \`${meta.example}\`)` : "";
      docs += `| \`${path}\` | ${meta.description}${example} |\n`;
    }
  }

  return docs;
}

/**
 * Generate a Zod enum schema for valid field paths
 * Use this in agent tool definitions for type-safe field names
 */
export function getFieldPathsEnum() {
  return z.enum(FIELD_PATHS as unknown as [string, ...string[]]);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate form data with detailed error messages
 */
export function validateDbFlowForm(
  data: unknown,
):
  | { success: true; data: DbFlowFormData }
  | { success: false; errors: string[] } {
  const result = DbFlowFormSchema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map(issue => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { success: false, errors };
}

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default form values for a new flow
 */
export const DEFAULT_FLOW_FORM_VALUES: DbFlowFormData = {
  databaseSource: {
    connectionId: "",
    database: undefined,
    query: "",
  },
  tableDestination: {
    connectionId: "",
    database: undefined,
    schema: undefined,
    tableName: "",
    createIfNotExists: true,
  },
  schedule: {
    enabled: false,
    cron: undefined,
    timezone: "UTC",
  },
  syncMode: "full",
  batchSize: 2000,
  incrementalConfig: undefined,
  conflictConfig: undefined,
  paginationConfig: undefined,
  typeCoercions: undefined,
};
