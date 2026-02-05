/**
 * Zod schemas for database-to-database flow configuration
 * Used for validation in API routes and AI agent tools
 */

import { z } from "zod";

/**
 * Pagination configuration schema
 */
export const PaginationConfigSchema = z.object({
  mode: z.enum(["offset", "keyset"]).default("offset"),
  keysetColumn: z.string().optional(),
  keysetDirection: z.enum(["asc", "desc"]).default("asc"),
  lastKeysetValue: z.string().optional(),
}).refine(
  (data) => {
    // If mode is keyset, keysetColumn is required
    if (data.mode === "keyset" && !data.keysetColumn) {
      return false;
    }
    return true;
  },
  {
    message: "keysetColumn is required when pagination mode is 'keyset'",
    path: ["keysetColumn"],
  }
);

/**
 * Type coercion configuration schema
 */
export const TypeCoercionSchema = z.object({
  column: z.string().min(1, "Column name is required"),
  sourceType: z.string().optional(),
  targetType: z.enum([
    "string",
    "integer",
    "number",
    "float",
    "double",
    "boolean",
    "timestamp",
    "date",
    "datetime",
    "json",
  ]),
  format: z.string().optional(),
  nullValue: z.unknown().optional(),
  transformer: z.enum([
    "lowercase",
    "uppercase",
    "trim",
    "json_parse",
    "json_stringify",
  ]).optional(),
});

/**
 * Incremental configuration schema
 */
export const IncrementalConfigSchema = z.object({
  trackingColumn: z.string().min(1, "Tracking column is required"),
  trackingType: z.enum(["timestamp", "numeric"]),
  lastValue: z.string().optional(),
});

/**
 * Conflict resolution configuration schema
 */
export const ConflictConfigSchema = z.object({
  keyColumns: z.array(z.string().min(1)).min(1, "At least one key column is required"),
  strategy: z.enum(["update", "ignore", "replace"]).default("update"),
});

/**
 * Database source configuration schema
 */
export const DatabaseSourceSchema = z.object({
  connectionId: z.string().min(1, "Source connection ID is required"),
  database: z.string().optional(),
  query: z.string().min(1, "SQL query is required"),
});

/**
 * Table destination configuration schema
 */
export const TableDestinationSchema = z.object({
  connectionId: z.string().min(1, "Destination connection ID is required"),
  database: z.string().optional(),
  schema: z.string().optional(),
  tableName: z.string().min(1, "Table name is required"),
  createIfNotExists: z.boolean().default(true),
});

/**
 * Schedule configuration schema
 */
export const ScheduleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  cron: z.string().optional().refine(
    (val) => {
      if (!val) return true;
      const parts = val.trim().split(/\s+/);
      return parts.length === 5 || parts.length === 6;
    },
    { message: "Invalid cron expression. Must have 5 or 6 fields." }
  ),
  timezone: z.string().default("UTC").optional(),
});

/**
 * Complete database flow configuration schema
 * This is the JSON representation of a db-to-db sync flow
 */
export const DbFlowConfigSchema = z.object({
  // Basic info
  name: z.string().min(1, "Flow name is required").optional(),
  description: z.string().optional(),

  // Flow type
  type: z.enum(["scheduled", "webhook"]).default("scheduled"),

  // Source configuration
  sourceType: z.literal("database").default("database"),
  databaseSource: DatabaseSourceSchema,

  // Destination configuration
  tableDestination: TableDestinationSchema,

  // Schedule (optional; enabled flag controls automatic runs)
  schedule: ScheduleConfigSchema.optional(),

  // Sync mode
  syncMode: z.enum(["full", "incremental"]).default("full"),

  // Optional configurations
  incrementalConfig: IncrementalConfigSchema.optional(),
  conflictConfig: ConflictConfigSchema.optional(),
  paginationConfig: PaginationConfigSchema.optional(),
  typeCoercions: z.array(TypeCoercionSchema).optional(),

  // Batch size
  batchSize: z.number().min(100).max(50000).default(2000),

}).refine(
  (data) => {
    // If schedule is enabled, cron is required
    if (data.schedule?.enabled && !data.schedule?.cron) return false;
    return true;
  },
  {
    message: "Schedule cron is required when schedule is enabled",
    path: ["schedule", "cron"],
  }
).refine(
  (data) => {
    // If syncMode is incremental, incrementalConfig is required
    if (data.syncMode === "incremental" && !data.incrementalConfig) {
      return false;
    }
    return true;
  },
  {
    message: "Incremental configuration is required for incremental sync mode",
    path: ["incrementalConfig"],
  }
);

/**
 * Partial schema for updates (all fields optional)
 */
export const DbFlowConfigUpdateSchema = DbFlowConfigSchema.partial();

/**
 * Type exports
 */
export type PaginationConfig = z.infer<typeof PaginationConfigSchema>;
export type TypeCoercion = z.infer<typeof TypeCoercionSchema>;
export type IncrementalConfig = z.infer<typeof IncrementalConfigSchema>;
export type ConflictConfig = z.infer<typeof ConflictConfigSchema>;
export type DatabaseSource = z.infer<typeof DatabaseSourceSchema>;
export type TableDestination = z.infer<typeof TableDestinationSchema>;
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;
export type DbFlowConfig = z.infer<typeof DbFlowConfigSchema>;
export type DbFlowConfigUpdate = z.infer<typeof DbFlowConfigUpdateSchema>;

/**
 * Validate a database flow configuration
 * Returns formatted error messages if validation fails
 */
export function validateDbFlowConfig(
  config: unknown
): { success: true; data: DbFlowConfig } | { success: false; errors: string[] } {
  const result = DbFlowConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { success: false, errors };
}
