/**
 * Client-side flow (database sync) agent tools.
 *
 * These tools have no `execute` function — the AI SDK forwards the call to the
 * browser, which mutates the flow form state and returns the result via
 * `addToolOutput`. Field names are derived from the unified db-flow-form schema
 * (the single source of truth), so the model can only target real fields.
 */

import { tool } from "ai";
import { z } from "zod";
import { FIELD_PATHS, TYPE_COERCION_SCHEMA } from "@mako/schemas";

const getFormStateSchema = z.object({});

/**
 * Structured value type for set_form_field.
 *
 * Instead of z.any() (which gives the LLM no type hints and causes it to
 * stringify arrays), we define a union of the actual types the LLM should
 * return. This ensures the AI SDK sends a proper JSON schema to the model, so
 * arrays come back as arrays, objects as objects, etc.
 *
 * See: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
 */
const formFieldValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z
    .array(TYPE_COERCION_SCHEMA)
    .describe("Array of type coercions (for typeCoercions field)"),
  z.array(z.string()).describe("Array of strings (e.g., keyColumns)"),
  z
    .object({
      trackingColumn: z.string(),
      trackingType: z.enum(["timestamp", "numeric"]),
    })
    .describe("Incremental config object"),
  z
    .object({
      keyColumns: z.array(z.string()),
      strategy: z.enum(["update", "ignore", "replace"]),
    })
    .describe("Conflict config object"),
  z
    .object({
      mode: z.enum(["offset", "keyset"]),
      keysetColumn: z.string().optional(),
      keysetDirection: z.enum(["asc", "desc"]).optional(),
    })
    .describe("Pagination config object"),
]);

// Type-safe field names derived from the unified schema
const setFormFieldSchema = z.object({
  fieldName: z
    .enum(FIELD_PATHS as unknown as [string, ...string[]])
    .describe(
      'Nested field path to update (e.g., "databaseSource.query", "schedule.cron", "tableDestination.tableName")',
    ),
  value: formFieldValue.describe(
    "New value for the field. Arrays and objects must be actual JSON, NOT stringified.",
  ),
});

const setMultipleFieldsSchema = z.object({
  fields: z
    .record(z.string(), formFieldValue)
    .describe("Object with nested field paths as keys and new values"),
});

const createFlowTabSchema = z.object({
  title: z
    .string()
    .optional()
    .describe(
      'Optional title for the new flow tab (default: "New Database Sync")',
    ),
});

const listFlowTabsSchema = z.object({});

/**
 * Client-side flow tools (no execute function = client-side execution).
 */
export const clientFlowTools = {
  get_form_state: tool({
    description:
      "Get the current form configuration values. Use this to understand what the user has already configured.",
    inputSchema: getFormStateSchema,
  }),

  set_form_field: tool({
    description:
      "Deprecated alias of set_multiple_fields — update a single form field " +
      "using a nested path. Prefer set_multiple_fields, which handles one or " +
      "many fields.",
    inputSchema: setFormFieldSchema,
  }),

  set_multiple_fields: tool({
    description:
      "Update one or more form fields at once. Use nested field paths as " +
      'keys, e.g. "databaseSource.query", "schedule.cron", ' +
      '"tableDestination.tableName", or "typeCoercions" (column mappings ' +
      "array). Arrays and objects must be actual JSON, NOT stringified.",
    inputSchema: setMultipleFieldsSchema,
  }),

  create_flow_tab: tool({
    description:
      "Create a new database sync flow tab in the editor. Use this when the user wants to create a new sync flow from scratch. Returns the new tab ID.",
    inputSchema: createFlowTabSchema,
  }),

  list_flow_tabs: tool({
    description:
      "List all open flow editor tabs. Returns tab ID, title, flow type, and whether it's the active tab. Use this to see existing flow configurations.",
    inputSchema: listFlowTabsSchema,
  }),
};
