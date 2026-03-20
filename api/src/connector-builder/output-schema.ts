import { z } from "zod";

export const connectorStateSchema = z.object({}).passthrough();

export const connectorColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean().optional(),
  description: z.string().optional(),
});

export const entitySchema = z.object({
  entity: z.string(),
  description: z.string().optional(),
  primaryKey: z.array(z.string()).default([]),
  columns: z.array(connectorColumnSchema).default([]),
});

export const flushBatchSchema = z.object({
  entity: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())).default([]),
  schema: entitySchema.optional(),
});

export const connectorExecutionLogSchema = z.object({
  level: z.string().default("info"),
  message: z.string(),
  timestamp: z.string().optional(),
});

export const connectorOutputSchema = z.object({
  hasMore: z.boolean().default(false),
  state: connectorStateSchema.default({}),
  batches: z.array(flushBatchSchema).default([]),
  schemas: z.array(entitySchema).default([]),
  logs: z.array(connectorExecutionLogSchema).default([]),
  metrics: z
    .object({
      rowCount: z.number().optional(),
      durationMs: z.number().optional(),
    })
    .optional(),
});

export type ConnectorState = z.infer<typeof connectorStateSchema>;
export type ConnectorColumn = z.infer<typeof connectorColumnSchema>;
export type EntitySchema = z.infer<typeof entitySchema>;
export type FlushBatch = z.infer<typeof flushBatchSchema>;
export type ConnectorExecutionLog = z.infer<typeof connectorExecutionLogSchema>;
export type ConnectorOutput = z.infer<typeof connectorOutputSchema>;
