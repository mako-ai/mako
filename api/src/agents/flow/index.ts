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

import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import { clientFlowTools } from "@mako/agent-tools";
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
import {
  AGENT_QUERY_TIMEOUT_MS,
  isAgentToolAbortError,
  registerAgentExecution,
  withAgentTimeout,
} from "../../agent-lib/tools/shared/truncation";

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

// Import unified schema for context injection
import {
  CONTEXT_FIELDS,
  getNestedValue,
  getFieldMeta,
  formatContextValue,
} from "@mako/schemas";

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
 * Create tools for flow agent
 * Uses shared database discovery tools from agent-lib and the shared
 * client-side flow tools from @mako/agent-tools.
 */
export function createFlowTools(
  workspaceId: string,
  toolExecutionContext?: AgentContext["toolExecutionContext"],
) {
  return {
    // =========================================================================
    // Database Discovery Tools (from shared agent-lib module)
    // =========================================================================

    /**
     * List all database connections in the workspace
     */
    list_connections: tool({
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
    }),

    /**
     * List databases/datasets in a connection
     * For Cloudflare D1: returns both 'id' (UUID) and 'name' (human-readable)
     * Use 'id' for subsequent D1 operations
     */
    list_databases: tool({
      description:
        "List databases (PostgreSQL/MySQL), datasets (BigQuery), or database files (D1/SQLite) within a connection. IMPORTANT for Cloudflare D1: returns 'id' (UUID) and 'name'. Use the 'id' field for subsequent D1 tool calls.",
      inputSchema: connectionIdSchema,
      execute: async ({ connectionId }) => {
        try {
          const databases = await listDatabasesImpl(
            connectionId,
            workspaceId,
            toolExecutionContext,
          );
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
            error: isAgentToolAbortError(error)
              ? "Database listing cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Failed to list databases",
          };
        }
      },
    }),

    /**
     * List tables in a database
     * For Cloudflare D1: use the UUID from list_databases 'id' field
     */
    list_tables: tool({
      description:
        "List tables and views in a database. IMPORTANT for Cloudflare D1: use the UUID from list_databases 'id' field as the database parameter.",
      inputSchema: connectionAndDbSchema,
      execute: async ({ connectionId, database: databaseName }) => {
        try {
          const tables = await listTablesImpl(
            connectionId,
            databaseName,
            workspaceId,
            toolExecutionContext,
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
            error: isAgentToolAbortError(error)
              ? "Table listing cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Failed to list tables",
          };
        }
      },
    }),

    /**
     * Inspect a table's schema and sample data
     * For Cloudflare D1: use the UUID from list_databases 'id' field
     */
    inspect_table: tool({
      description:
        "Get a table's schema (columns, types) and sample rows. IMPORTANT for Cloudflare D1: use the UUID from list_databases 'id' field as the database parameter.",
      inputSchema: inspectTableSchema,
      execute: async ({
        connectionId,
        database: databaseName,
        table: tableName,
      }) => {
        try {
          const result = await inspectTableImpl(
            connectionId,
            databaseName,
            tableName,
            workspaceId,
            toolExecutionContext,
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
            error: isAgentToolAbortError(error)
              ? "Table inspection cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Failed to inspect table",
          };
        }
      },
    }),

    // =========================================================================
    // Sync Configuration Tools
    // =========================================================================

    /**
     * Validate query against source database
     */
    validate_query: tool({
      description:
        "Test a SQL query against the source database. Returns column types and a sample row. Also checks for dangerous patterns.",
      inputSchema: validateQueryParams,
      execute: async ({ connectionId, query, database }) => {
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

          const { executionId, signal, release } = registerAgentExecution(
            toolExecutionContext,
            "agent-flow-validate-query",
          );

          try {
            const result = await withAgentTimeout(
              executionId,
              registeredExecutionId =>
                validateQueryService(connection, query, database, {
                  executionId: registeredExecutionId,
                  signal,
                }),
              { signal },
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
          } finally {
            release();
          }
        } catch (error) {
          return {
            success: false,
            error: isAgentToolAbortError(error)
              ? "Query validation cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Query validation failed",
          };
        }
      },
    }),

    /**
     * Execute any SQL query against a database
     */
    execute_query: tool({
      description:
        "Execute any SQL query the database supports. Use for introspection queries, NULL checks, data sampling, or any ad-hoc queries. LIMIT 500 is automatically added to SELECT queries if missing.",
      inputSchema: executeQueryParams,
      execute: async ({ connectionId, database, query }) => {
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

          let safeQuery = query;
          const upperQuery = query.toUpperCase().trim();
          if (
            upperQuery.startsWith("SELECT") &&
            !upperQuery.includes("LIMIT")
          ) {
            safeQuery = `${query.replace(/;+$/, "")} LIMIT 500`;
          }

          const { executionId, signal, release } = registerAgentExecution(
            toolExecutionContext,
            "agent-flow-execute-query",
          );

          try {
            const result = await withAgentTimeout(
              executionId,
              registeredExecutionId =>
                databaseConnectionService.executeQuery(
                  connection.toObject(),
                  safeQuery,
                  {
                    databaseName: database,
                    executionId: registeredExecutionId,
                    signal,
                  },
                ),
              { signal },
            );

            return {
              success: result.success,
              data: result.data,
              rowCount: Array.isArray(result.data) ? result.data.length : 0,
              connectionName: connection.name,
              connectionType: connection.type,
              error: result.error,
            };
          } finally {
            release();
          }
        } catch (error) {
          const isTimeout =
            error instanceof Error && error.message === "AGENT_QUERY_TIMEOUT";
          return {
            success: false,
            error: isAgentToolAbortError(error)
              ? "Query execution cancelled because the chat stopped."
              : isTimeout
                ? `Query timed out after ${AGENT_QUERY_TIMEOUT_MS / 1000}s.`
                : error instanceof Error
                  ? error.message
                  : "Query execution failed",
          };
        }
      },
    }),

    /**
     * Explain what template placeholders do
     */
    explain_template: tool({
      description:
        "Explain what template placeholders ({{limit}}, {{offset}}, etc.) will be replaced with at runtime.",
      inputSchema: explainTemplateParams,
      execute: async ({ placeholder }) => {
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
    }),

    // =========================================================================
    // Client-side tools (no execute function - handled by frontend)
    // Shared with the frontend via @mako/agent-tools so the tool surface and
    // its types can never drift. Field names derive from the unified schema.
    // =========================================================================

    ...clientFlowTools,
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

  const tools = createFlowTools(workspaceId, context.toolExecutionContext);

  return {
    systemPrompt: [
      {
        role: "system" as const,
        content: FLOW_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
      {
        role: "system" as const,
        content: runtimeContext,
      },
    ],
    tools,
  };
};
