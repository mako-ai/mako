import { z } from "zod";

/**
 * Abstract column types used by the connector output.
 * These are mapped to driver-specific SQL types in the write pipeline.
 */
export const columnTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "json",
  "array",
]);

export type ColumnType = z.infer<typeof columnTypeSchema>;

/**
 * Schema definition for a single entity column.
 */
export const entityColumnSchema = z.object({
  name: z.string(),
  type: columnTypeSchema,
  nullable: z.boolean().optional().default(true),
  primaryKey: z.boolean().optional().default(false),
});

export type EntityColumn = z.infer<typeof entityColumnSchema>;

/**
 * Schema definition for an entity (table).
 */
export const entitySchemaDefinition = z.object({
  name: z.string(),
  columns: z.array(entityColumnSchema),
  primaryKey: z.array(z.string()).optional(),
});

export type EntitySchema = z.infer<typeof entitySchemaDefinition>;

/**
 * A batch of records to flush to a destination table.
 */
export const flushBatchSchema = z.object({
  entity: z.string(),
  records: z.array(z.record(z.unknown())),
  schema: entitySchemaDefinition.optional(),
});

export type FlushBatch = z.infer<typeof flushBatchSchema>;

/**
 * The full output returned by a connector's `pull()` function.
 */
export const connectorOutputSchema = z.object({
  batches: z.array(flushBatchSchema),
  state: z.record(z.unknown()).passthrough().optional().default({}),
  hasMore: z.boolean().optional().default(false),
  logs: z
    .array(
      z.object({
        level: z.enum(["debug", "info", "warn", "error"]),
        message: z.string(),
        timestamp: z.string().optional(),
        data: z.unknown().optional(),
      }),
    )
    .optional()
    .default([]),
});

export type ConnectorOutput = z.infer<typeof connectorOutputSchema>;

/**
 * Input context passed to the connector's `pull()` function.
 */
export const connectorInputSchema = z.object({
  config: z.record(z.unknown()).optional().default({}),
  secrets: z.record(z.string()).optional().default({}),
  state: z.record(z.unknown()).optional().default({}),
  trigger: z
    .object({
      type: z.enum(["manual", "cron", "webhook"]),
      payload: z.unknown().optional(),
    })
    .optional()
    .default({ type: "manual" }),
});

export type ConnectorInput = z.infer<typeof connectorInputSchema>;

/**
 * Validates connector output from sandbox execution.
 * Returns parsed output on success, or an error message on failure.
 */
export function validateConnectorOutput(
  raw: unknown,
):
  | { success: true; data: ConnectorOutput }
  | { success: false; error: string } {
  const result = connectorOutputSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = result.error.issues
    .map(i => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { success: false, error: `Invalid connector output: ${issues}` };
}
