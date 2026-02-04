/**
 * DB Flow Agent
 *
 * Database sync configuration assistant for db-to-db flows.
 * Helps users write queries with template placeholders and configure sync settings.
 * Uses shared database discovery tools from agent-lib.
 */

import { z } from "zod";
import { Types } from "mongoose";
import type {
  AgentFactory,
  AgentMeta,
  AgentContext,
  AgentConfig,
} from "../types";
import { DB_FLOW_PROMPT } from "./prompt";
import { DatabaseConnection } from "../../database/workspace-schema";
import {
  validateQuery as validateQueryService,
  checkQuerySafety,
} from "../../services/destination-writer.service";

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

/**
 * DB Flow agent metadata for UI and routing
 */
export const dbFlowAgentMeta: AgentMeta = {
  id: "db-flow",
  name: "Sync Config Assistant",
  description: "Helps configure database-to-database sync flows",
  tabKinds: ["flow-editor"],
  flowTypes: ["db-scheduled"],
  enabled: true,
};

/**
 * Parameter schemas for db-flow specific tools
 */
const validateQueryParams = z.object({
  connectionId: z.string().describe("Source database connection ID"),
  query: z
    .string()
    .describe("SQL query to validate (without template placeholders)"),
  database: z.string().optional().describe("Database name (for cluster mode)"),
});

const explainTemplateParams = z.object({
  placeholder: z
    .enum(["limit", "offset", "last_sync_value", "keyset_value"])
    .describe("Template placeholder to explain"),
});

/**
 * Schemas for client-side db-flow tools
 */
const getFormStateSchema = z.object({});

const setFormFieldSchema = z.object({
  fieldName: z
    .string()
    .describe(
      'Field to update (e.g., "query", "syncMode", "tableName", "trackingColumn")',
    ),
  value: z.any().describe("New value for the field"),
});

const setMultipleFieldsSchema = z.object({
  fields: z
    .record(z.string(), z.any())
    .describe("Object with field names as keys and new values"),
});

const triggerValidationSchema = z.object({});

/**
 * Create tools for db-flow agent
 * Uses shared database discovery tools from agent-lib
 */
function createDbFlowTools(workspaceId: string) {
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
    // =========================================================================

    get_form_state: {
      description:
        "Get the current form configuration values. Use this to understand what the user has already configured.",
      inputSchema: getFormStateSchema,
    },

    set_form_field: {
      description:
        "Update a single form field. Use for targeted changes to specific settings.",
      inputSchema: setFormFieldSchema,
    },

    set_multiple_fields: {
      description:
        "Update multiple form fields at once. Use when configuring related settings together.",
      inputSchema: setMultipleFieldsSchema,
    },

    trigger_validation: {
      description:
        "Trigger the query validation button in the UI. This will validate the current query and show results to the user.",
      inputSchema: triggerValidationSchema,
    },
  };
}

/**
 * Build runtime context string for db-flow agent
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

  // Add form state context
  if (flowFormState && Object.keys(flowFormState).length > 0) {
    context += "\n\n## Current Form State\n\n";

    const importantFields = [
      "sourceConnectionId",
      "sourceDatabase",
      "query",
      "destinationConnectionId",
      "destinationDatabase",
      "tableName",
      "syncMode",
      "paginationMode",
      "trackingColumn",
      "conflictStrategy",
      "keyColumns",
      "batchSize",
      "enabled",
    ];

    for (const field of importantFields) {
      if (flowFormState[field] !== undefined && flowFormState[field] !== "") {
        const value = flowFormState[field];
        if (
          field === "query" &&
          typeof value === "string" &&
          value.length > 0
        ) {
          context += `**${field}:**\n\`\`\`sql\n${value}\n\`\`\`\n`;
        } else if (Array.isArray(value)) {
          context += `**${field}:** ${JSON.stringify(value)}\n`;
        } else {
          context += `**${field}:** ${value}\n`;
        }
      }
    }
  }

  if (context) {
    context += "\n---";
  }

  return context;
}

/**
 * DB Flow agent factory
 */
export const dbFlowAgentFactory: AgentFactory = (
  context: AgentContext,
): AgentConfig => {
  const { workspaceId, flowFormState, databases = [] } = context;

  const runtimeContext = buildRuntimeContext(flowFormState, databases);
  const systemPrompt = DB_FLOW_PROMPT + runtimeContext;

  const tools = createDbFlowTools(workspaceId);

  return {
    systemPrompt,
    tools,
  };
};
