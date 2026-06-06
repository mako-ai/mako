import { tool } from "ai";
import { z } from "zod";

export const REVERSE_ETL_FIELD_PATHS = [
  "name",
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
  "pagination",
  "schedule.enabled",
  "schedule.cron",
  "schedule.timezone",
  "safety.maxRowsPerRun",
  "safety.dryRunRequiredBeforeActivate",
  "safety.batchSize",
] as const;

const transformSchema = z.object({
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

const mappingSchema = z.object({
  target: z.string(),
  source: z.object({
    column: z.string().optional(),
    const: z.unknown().optional(),
    transform: transformSchema.optional(),
  }),
  required: z.boolean().optional(),
  onConflict: z.enum(["overwrite", "fill_empty", "ignore"]).optional(),
});

const formFieldValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(mappingSchema),
  z.record(z.string(), z.unknown()),
]);

export const clientReverseEtlTools = {
  get_reverse_etl_form_state: tool({
    description:
      "Get the current Reverse ETL form state, including source query, destination connector, mappings, schedule, and safety settings.",
    inputSchema: z.object({}),
  }),

  set_reverse_etl_form_field: tool({
    description:
      "Update one Reverse ETL form field by nested path. Use mappings as a real JSON array, not a string.",
    inputSchema: z.object({
      fieldName: z.enum(
        REVERSE_ETL_FIELD_PATHS as unknown as [string, ...string[]],
      ),
      value: formFieldValue,
    }),
  }),

  set_reverse_etl_multiple_fields: tool({
    description: "Update multiple Reverse ETL form fields at once.",
    inputSchema: z.object({
      fields: z.record(z.string(), formFieldValue),
    }),
  }),

  create_reverse_etl_tab: tool({
    description: "Create a new Reverse ETL editor tab.",
    inputSchema: z.object({
      title: z.string().optional(),
    }),
  }),

  list_reverse_etl_tabs: tool({
    description: "List open Reverse ETL editor tabs.",
    inputSchema: z.object({}),
  }),
};
