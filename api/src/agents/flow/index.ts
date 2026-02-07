/**
 * Flow Agent
 *
 * Database sync configuration assistant for db-to-db flows.
 * Helps users write queries with template placeholders and configure sync settings.
 * Uses shared database discovery tools from agent-lib.
 *
 * IMPORTANT: This agent uses the unified schema from db-flow-form.schema.ts
 * as the single source of truth for field names and context injection.
 */

import { z } from "zod";
import { Types } from "mongoose";
import type {
  AgentFactory,
  AgentMeta,
  AgentContext,
  AgentConfig,
} from "../types";
import { FLOW_PROMPT } from "./prompt";
import { DatabaseConnection } from "../../database/workspace-schema";
import {
  validateQuery as validateQueryService,
  checkQuerySafety,
} from "../../services/destination-writer.service";
import { databaseConnectionService } from "../../services/database-connection.service";

// Import shared database discovery tools from agent-lib
import {
  listConnectionsImpl,
  listDatabasesImpl,
  listTablesImpl,
  inspectTableImpl,
  emptySchema,
  connectionIdSchema,
  connectionAndDbSchema,
  inspectTableSchema,
} from "../../agent-lib/tools/shared/database-discovery";

// Import unified schema for type-safe field names and context injection
import {
  FIELD_PATHS,
  CONTEXT_FIELDS,
  TYPE_COERCION_SCHEMA,
  getNestedValue,
  getFieldMeta,
  formatContextValue,
} from "../../schemas/db-flow-form.schema";

/**
 * Flow agent metadata for UI and routing
 */
export const flowAgentMeta: AgentMeta = {
  id: "flow",
  name: "Sync Config Assistant",
  description: "Helps configure database-to-database sync flows",
  tabKinds: ["flow-editor"],
  flowTypes: ["db-scheduled"],
  enabled: true,
};

/**
 * Parameter schemas for flow-specific tools
 */
const validateQueryParams = z.object({
  connectionId: z.string().describe("Source database connection ID"),
  query: z
    .string()
    .describe("SQL query to validate (without template placeholders)"),
  database: z.string().optional().describe("Database name (for cluster mode)"),
});

const executeQueryParams = z.object({
  connectionId: z.string().describe("Database connection ID"),
  database: z.string().optional().describe("Database name (for cluster mode)"),
  query: z.string().describe("SQL query to execute"),
});

const explainTemplateParams = z.object({
  placeholder: z
    .enum(["limit", "offset", "last_sync_value", "keyset_value"])
    .describe("Template placeholder to explain"),
});

/**
 * Schemas for client-side flow tools
 * Uses FIELD_PATHS from unified schema for type-safe field names
 */
const getFormStateSchema = z.object({});

/**
 * Structured value type for set_form_field.
 *
 * Instead of z.any() (which gives the LLM no type hints and causes it to
 * stringify arrays), we define a union of the actual types the LLM should return.
 * This ensures the AI SDK sends a proper JSON schema to the model, so arrays
 * come back as arrays, objects as objects, etc.
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

/**
 * Schemas for tab management tools (client-side)
 */
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
 * Create tools for flow agent
 * Uses shared database discovery tools from agent-lib
 */
function createFlowTools(workspaceId: string) {
  return {
    // =========================================================================
    // Database Discovery Tools (from shared agent-lib module)
    // =========================================================================

    /**
     * List all database connections in the workspace
     */
    list_connections: {
      description:
        "List all database connections in this workspace. Returns connection ID, name, type, and other details. Use this FIRST to discover available databases before configuring a sync.",
      inputSchema: emptySchema,
      execute: async () => {
        try {
          const connections = await listConnectionsImpl(workspaceId, {
            includeNoSQL: true,
          });
          return connections;
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list connections",
          };
        }
      },
    },

    /**
     * List databases/datasets in a connection
     * For Cloudflare D1: returns both 'id' (UUID) and 'name' (human-readable)
     * Use 'id' for subsequent D1 operations
     */
    list_databases: {
      description:
        "List databases (PostgreSQL/MySQL), datasets (BigQuery), or database files (D1/SQLite) within a connection. IMPORTANT for Cloudflare D1: returns 'id' (UUID) and 'name'. Use the 'id' field for subsequent D1 tool calls.",
      inputSchema: connectionIdSchema,
      execute: async (params: z.infer<typeof connectionIdSchema>) => {
        try {
          const { connectionId } = params;
          const databases = await listDatabasesImpl(connectionId, workspaceId);
          return {
            success: true,
            databases: databases.map(db => ({
              id: db.id, // UUID for D1
              name: db.name,
              dialect: db.sqlDialect,
            })),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list databases",
          };
        }
      },
    },

    /**
     * List tables in a database
     * For Cloudflare D1: use the UUID from list_databases 'id' field
     */
    list_tables: {
      description:
        "List tables and views in a database. IMPORTANT for Cloudflare D1: use the UUID from list_databases 'id' field as the database parameter.",
      inputSchema: connectionAndDbSchema,
      execute: async (params: z.infer<typeof connectionAndDbSchema>) => {
        try {
          const { connectionId, database: databaseName } = params;
          const tables = await listTablesImpl(
            connectionId,
            databaseName,
            workspaceId,
          );
          return {
            success: true,
            tables: tables.map(t => ({
              name: t.name,
              type: t.type,
              schema: t.schema,
            })),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : "Failed to list tables",
          };
        }
      },
    },

    /**
     * Inspect a table's schema and sample data
     * For Cloudflare D1: use the UUID from list_databases 'id' field
     */
    inspect_table: {
      description:
        "Get a table's schema (columns, types) and sample rows. IMPORTANT for Cloudflare D1: use the UUID from list_databases 'id' field as the database parameter.",
      inputSchema: inspectTableSchema,
      execute: async (params: z.infer<typeof inspectTableSchema>) => {
        try {
          const {
            connectionId,
            database: databaseName,
            table: tableName,
          } = params;
          const result = await inspectTableImpl(
            connectionId,
            databaseName,
            tableName,
            workspaceId,
          );
          return {
            success: true,
            connectionName: result.connectionName,
            connectionType: result.connectionType,
            tableName,
            columns: result.columns,
            sampleRowCount: result.samples.length,
            samples: result.samples.slice(0, 5),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to inspect table",
          };
        }
      },
    },

    // =========================================================================
    // Sync Configuration Tools
    // =========================================================================

    /**
     * Validate query against source database
     */
    validate_query: {
      description:
        "Test a SQL query against the source database. Returns column types and a sample row. Also checks for dangerous patterns.",
      inputSchema: validateQueryParams,
      execute: async (params: z.infer<typeof validateQueryParams>) => {
        const { connectionId, query, database } = params;
        try {
          if (!Types.ObjectId.isValid(connectionId)) {
            return { success: false, error: "Invalid connection ID" };
          }

          const safetyResult = checkQuerySafety(query);
          if (!safetyResult.safe) {
            return {
              success: false,
              error: safetyResult.errors.join("; "),
              safetyCheck: safetyResult,
            };
          }

          const connection = await DatabaseConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          });

          if (!connection) {
            return { success: false, error: "Connection not found" };
          }

          const result = await validateQueryService(
            connection,
            query,
            database,
          );

          return {
            success: result.success,
            columns: result.columns,
            sampleRow: result.sampleRow,
            connectionName: connection.name,
            connectionType: connection.type,
            safetyCheck: safetyResult,
            error: result.error,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Query validation failed",
          };
        }
      },
    },

    /**
     * Execute any SQL query against a database
     */
    execute_query: {
      description:
        "Execute any SQL query the database supports. Use for introspection queries, NULL checks, data sampling, or any ad-hoc queries. LIMIT 500 is automatically added to SELECT queries if missing.",
      inputSchema: executeQueryParams,
      execute: async (params: z.infer<typeof executeQueryParams>) => {
        const { connectionId, database, query } = params;
        try {
          if (!Types.ObjectId.isValid(connectionId)) {
            return { success: false, error: "Invalid connection ID" };
          }

          const connection = await DatabaseConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          });

          if (!connection) {
            return { success: false, error: "Connection not found" };
          }

          // Add LIMIT if missing from SELECT queries (safety measure)
          let safeQuery = query;
          const upperQuery = query.toUpperCase().trim();
          if (
            upperQuery.startsWith("SELECT") &&
            !upperQuery.includes("LIMIT")
          ) {
            safeQuery = `${query.replace(/;+$/, "")} LIMIT 500`;
          }

          const result = await databaseConnectionService.executeQuery(
            connection.toObject(),
            safeQuery,
            { databaseName: database },
          );

          return {
            success: result.success,
            data: result.data,
            rowCount: Array.isArray(result.data) ? result.data.length : 0,
            connectionName: connection.name,
            connectionType: connection.type,
            error: result.error,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : "Query execution failed",
          };
        }
      },
    },

    /**
     * Explain what template placeholders do
     */
    explain_template: {
      description:
        "Explain what template placeholders ({{limit}}, {{offset}}, etc.) will be replaced with at runtime.",
      inputSchema: explainTemplateParams,
      execute: async (params: z.infer<typeof explainTemplateParams>) => {
        const { placeholder } = params;
        const explanations: Record<
          string,
          { description: string; example: string }
        > = {
          limit: {
            description:
              "Replaced with the batch size (default 2000). Controls how many rows are fetched per iteration.",
            example: "LIMIT {{limit}} → LIMIT 2000",
          },
          offset: {
            description:
              "Replaced with the current pagination offset. Increments by batch size each iteration.",
            example: "OFFSET {{offset}} → OFFSET 0, then OFFSET 2000, etc.",
          },
          last_sync_value: {
            description:
              "Replaced with the last synced value of the tracking column. Used for incremental sync.",
            example:
              "WHERE updated_at > '{{last_sync_value}}' → WHERE updated_at > '2024-01-15T10:30:00Z'",
          },
          keyset_value: {
            description:
              "Replaced with the last value of the keyset column. Used for keyset pagination.",
            example: "WHERE id > {{keyset_value}} → WHERE id > 150000",
          },
        };

        const info = explanations[placeholder];
        return {
          success: true,
          placeholder: `{{${placeholder}}}`,
          description: info.description,
          example: info.example,
        };
      },
    },

    // =========================================================================
    // Client-side tools (no execute function - handled by frontend)
    // Field names are now derived from the unified schema (FIELD_PATHS)
    // =========================================================================

    get_form_state: {
      description:
        "Get the current form configuration values. Use this to understand what the user has already configured.",
      inputSchema: getFormStateSchema,
    },

    set_form_field: {
      description:
        'Update a single form field using nested path. Examples: "databaseSource.query", "schedule.cron", "tableDestination.tableName", "typeCoercions" (for column mappings array).',
      inputSchema: setFormFieldSchema,
    },

    set_multiple_fields: {
      description:
        "Update multiple form fields at once. Use nested paths as keys.",
      inputSchema: setMultipleFieldsSchema,
    },

    // NOTE: set_column_mappings has been removed - use set_form_field with fieldName="typeCoercions" instead

    // =========================================================================
    // Tab Management Tools (client-side - for creating/listing flow tabs)
    // =========================================================================

    create_flow_tab: {
      description:
        "Create a new database sync flow tab in the editor. Use this when the user wants to create a new sync flow from scratch. Returns the new tab ID.",
      inputSchema: createFlowTabSchema,
    },

    list_flow_tabs: {
      description:
        "List all open flow editor tabs. Returns tab ID, title, flow type, and whether it's the active tab. Use this to see existing flow configurations.",
      inputSchema: listFlowTabsSchema,
    },
  };
}

/**
 * Build runtime context string for flow agent
 *
 * Uses CONTEXT_FIELDS from the unified schema to automatically include
 * all fields marked with injectInContext: true. No more manual field lists!
 */
function buildRuntimeContext(
  flowFormState: Record<string, unknown> | undefined,
  databases: AgentContext["databases"],
): string {
  let context = "";

  // Add available connections context
  if (databases && databases.length > 0) {
    context += "\n\n---\n\n## Available Connections (auto-injected)\n\n";
    for (const db of databases) {
      context += `- **${db.name}** (${db.type}) - id: \`${db.id}\`\n`;
    }
  }

  // Add form state context using CONTEXT_FIELDS from unified schema
  if (flowFormState && Object.keys(flowFormState).length > 0) {
    context += "\n\n## Current Form State\n\n";

    // CONTEXT_FIELDS is derived from schema metadata (injectInContext: true)
    // This ensures we never forget to add new fields to the context!
    for (const fieldPath of CONTEXT_FIELDS) {
      const value = getNestedValue(flowFormState, fieldPath);
      if (value !== undefined && value !== "" && value !== null) {
        const meta = getFieldMeta(fieldPath);
        if (meta) {
          context += formatContextValue(fieldPath, value, meta);
        } else {
          // Fallback for fields without metadata
          if (Array.isArray(value)) {
            context += `**${fieldPath}:** ${JSON.stringify(value)}\n`;
          } else {
            context += `**${fieldPath}:** ${value}\n`;
          }
        }
      }
    }

    // Include schemaMappingConfirmed status
    const schemaMappingConfirmed = flowFormState.schemaMappingConfirmed;
    if (schemaMappingConfirmed !== undefined) {
      context += `**schemaMappingConfirmed:** ${schemaMappingConfirmed}\n`;
    }
  }

  if (context) {
    context += "\n---";
  }

  return context;
}

/**
 * Flow agent factory
 */
export const flowAgentFactory: AgentFactory = (
  context: AgentContext,
): AgentConfig => {
  const { workspaceId, flowFormState, databases = [] } = context;

  const runtimeContext = buildRuntimeContext(flowFormState, databases);
  const systemPrompt = FLOW_PROMPT + runtimeContext;

  const tools = createFlowTools(workspaceId);

  return {
    systemPrompt,
    tools,
  };
};
