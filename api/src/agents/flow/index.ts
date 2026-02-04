/**
 * Flow Agent
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

const explainTemplateParams = z.object({
  placeholder: z
    .enum(["limit", "offset", "last_sync_value", "keyset_value"])
    .describe("Template placeholder to explain"),
});

/**
 * Schemas for client-side flow tools
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

/**
 * Schema for column mapping (used in schema analysis)
 */
const columnMappingSchema = z.object({
  name: z.string().describe("Column name"),
  sourceType: z.string().describe("Original type from source database"),
  destType: z
    .string()
    .describe(
      "Destination type (e.g., STRING, INT64, FLOAT64, BOOL, TIMESTAMP, DATE, JSON, BYTES)",
    ),
  nullable: z.boolean().describe("Whether the column can contain NULL values"),
  transformer: z
    .string()
    .optional()
    .describe(
      "Optional transformation: lowercase, uppercase, trim, json_parse, json_stringify",
    ),
});

const setColumnMappingsSchema = z.object({
  mappings: z
    .array(columnMappingSchema)
    .describe("Array of column mappings for the destination table"),
});

const analyzeSchemaParams = z.object({
  connectionId: z.string().describe("Source database connection ID"),
  database: z.string().optional().describe("Database name (for cluster mode)"),
  query: z.string().describe("SQL query to analyze"),
});

/**
 * Analyze column values and suggest appropriate destination types
 */
interface ColumnAnalysis {
  name: string;
  sourceType: string;
  suggestedDestType: string;
  nullable: boolean;
  reasoning: string;
  sampleValues: unknown[];
}

function analyzeColumnValues(
  columnName: string,
  sourceType: string,
  values: unknown[],
  destDbType: string,
): ColumnAnalysis {
  const isBigQuery = destDbType === "bigquery";
  const lowerName = columnName.toLowerCase();
  const upperSourceType = sourceType.toUpperCase();

  // Default suggestions based on source type
  let suggestedDestType: string;
  let reasoning: string;

  // Check for timestamp patterns in column names
  const isTimestampLikeName =
    lowerName.endsWith("_at") ||
    lowerName.endsWith("_time") ||
    lowerName.includes("timestamp") ||
    lowerName.includes("created") ||
    lowerName.includes("updated") ||
    lowerName.includes("deleted");

  // Check for JSON patterns in column names
  const isJsonLikeName =
    lowerName.includes("json") ||
    lowerName.includes("data") ||
    lowerName.includes("metadata") ||
    lowerName.includes("config") ||
    lowerName.includes("settings") ||
    lowerName.includes("payload");

  // Analyze actual values
  const nonNullValues = values.filter(v => v !== null && v !== undefined);
  const hasNulls = values.some(v => v === null || v === undefined);

  // Check if integer values look like Unix timestamps (10+ digits, reasonable range)
  const looksLikeUnixTimestamp =
    upperSourceType.includes("INT") &&
    nonNullValues.length > 0 &&
    nonNullValues.every(v => {
      const num = Number(v);
      // Unix timestamp in seconds (10 digits) or milliseconds (13 digits)
      return num > 1000000000 && num < 10000000000000;
    });

  // Check if text values look like JSON
  const looksLikeJson =
    (upperSourceType.includes("TEXT") || upperSourceType.includes("VARCHAR")) &&
    nonNullValues.length > 0 &&
    nonNullValues.some(v => {
      if (typeof v !== "string") return false;
      const trimmed = v.trim();
      return (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      );
    });

  // Check if text values are actually numeric
  const looksLikeNumericText =
    (upperSourceType.includes("TEXT") || upperSourceType.includes("VARCHAR")) &&
    nonNullValues.length > 0 &&
    nonNullValues.every(v => {
      if (typeof v !== "string") return false;
      return !isNaN(Number(v)) && v.trim() !== "";
    });

  // Determine destination type based on analysis
  if (upperSourceType.includes("INT") || upperSourceType === "INTEGER") {
    if (looksLikeUnixTimestamp && isTimestampLikeName) {
      // Unix timestamp stored as integer
      suggestedDestType = isBigQuery ? "STRING" : "TEXT";
      reasoning = `Column "${columnName}" contains Unix timestamps (e.g., ${nonNullValues[0]}). Using STRING to preserve the numeric value. You could convert to TIMESTAMP if needed.`;
    } else {
      suggestedDestType = isBigQuery ? "INT64" : "BIGINT";
      reasoning = `Standard integer type.`;
    }
  } else if (
    upperSourceType.includes("REAL") ||
    upperSourceType.includes("FLOAT") ||
    upperSourceType.includes("DOUBLE") ||
    upperSourceType.includes("NUMERIC") ||
    upperSourceType.includes("DECIMAL")
  ) {
    suggestedDestType = isBigQuery ? "FLOAT64" : "DOUBLE PRECISION";
    reasoning = `Floating point number.`;
  } else if (upperSourceType.includes("BOOL")) {
    suggestedDestType = isBigQuery ? "BOOL" : "BOOLEAN";
    reasoning = `Boolean value.`;
  } else if (
    upperSourceType.includes("TIMESTAMP") ||
    upperSourceType.includes("DATETIME")
  ) {
    suggestedDestType = isBigQuery ? "TIMESTAMP" : "TIMESTAMPTZ";
    reasoning = `Timestamp/datetime value.`;
  } else if (upperSourceType === "DATE") {
    suggestedDestType = "DATE";
    reasoning = `Date value.`;
  } else if (upperSourceType.includes("JSON")) {
    suggestedDestType = isBigQuery ? "JSON" : "JSONB";
    reasoning = `JSON data.`;
  } else if (
    upperSourceType.includes("BLOB") ||
    upperSourceType.includes("BYTES")
  ) {
    suggestedDestType = isBigQuery ? "BYTES" : "BYTEA";
    reasoning = `Binary data.`;
  } else if (
    upperSourceType.includes("TEXT") ||
    upperSourceType.includes("VARCHAR") ||
    upperSourceType.includes("CHAR") ||
    upperSourceType.includes("STRING")
  ) {
    if (looksLikeJson && isJsonLikeName) {
      suggestedDestType = isBigQuery ? "JSON" : "JSONB";
      reasoning = `Column "${columnName}" contains JSON data. Using JSON type for structured storage.`;
    } else if (looksLikeNumericText) {
      // Still default to STRING, but note it
      suggestedDestType = isBigQuery ? "STRING" : "TEXT";
      reasoning = `Column "${columnName}" contains numeric-looking text values (e.g., "${nonNullValues[0]}"). Keeping as STRING. Consider INT64/FLOAT64 if these should be numbers.`;
    } else {
      suggestedDestType = isBigQuery ? "STRING" : "TEXT";
      reasoning = `Text value.`;
    }
  } else {
    // Unknown type - default to string
    suggestedDestType = isBigQuery ? "STRING" : "TEXT";
    reasoning = `Unknown source type "${sourceType}". Defaulting to STRING for safety.`;
  }

  return {
    name: columnName,
    sourceType,
    suggestedDestType,
    nullable: hasNulls || true, // Default to nullable for safety
    reasoning,
    sampleValues: nonNullValues.slice(0, 3),
  };
}

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
    // Schema Analysis Tools
    // =========================================================================

    /**
     * Analyze query results and suggest optimal destination column types
     */
    analyze_and_suggest_schema: {
      description:
        "Analyze a SQL query's results to suggest optimal destination column types. Runs the query with LIMIT 100, examines actual data values, and provides intelligent type suggestions with reasoning. Use this AFTER validating the query to propose type mappings.",
      inputSchema: analyzeSchemaParams,
      execute: async (params: z.infer<typeof analyzeSchemaParams>) => {
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

          // Run query with LIMIT to get sample data
          const sampleQuery = `SELECT * FROM (${query.replace(/;+$/, "")}) AS __sample_query LIMIT 100`;

          const result = await databaseConnectionService.executeQuery(
            connection.toObject(),
            sampleQuery,
            { databaseName: database },
          );

          const rows = result.data as Record<string, unknown>[] | undefined;

          if (!result.success || !rows || rows.length === 0) {
            // If sample query fails, try to get schema from dry run (BigQuery)
            if (connection.type === "bigquery") {
              const schemaResult =
                await databaseConnectionService.getBigQueryQuerySchema(
                  connection.toObject(),
                  query,
                );
              if (schemaResult.success && schemaResult.columns) {
                return {
                  success: true,
                  columns: schemaResult.columns.map(col => ({
                    name: col.name,
                    sourceType: col.type,
                    suggestedDestType: col.type, // BigQuery to BigQuery is 1:1
                    nullable: col.nullable,
                    reasoning: `Type from BigQuery schema.`,
                  })),
                  message:
                    "Schema inferred from BigQuery dry run (no sample data available).",
                };
              }
            }
            return {
              success: false,
              error:
                result.error ||
                "Query returned no results. Cannot analyze schema.",
            };
          }

          // Get column names from first row
          const columns = Object.keys(rows[0]);

          // Analyze each column
          const columnAnalyses: ColumnAnalysis[] = columns.map(colName => {
            // Get all values for this column
            const values = rows.map(row => row[colName]);

            // Try to determine source type from the values or result metadata
            let sourceType = "TEXT"; // Default
            if (result.fields && Array.isArray(result.fields)) {
              const colInfo = result.fields.find(
                (c: { name?: string; type?: string }) =>
                  c.name?.toLowerCase() === colName.toLowerCase(),
              );
              if (colInfo?.type) {
                sourceType = colInfo.type;
              }
            } else {
              // Infer type from values
              const firstNonNull = values.find(
                (v: unknown) => v !== null && v !== undefined,
              );
              if (typeof firstNonNull === "number") {
                sourceType = Number.isInteger(firstNonNull)
                  ? "INTEGER"
                  : "REAL";
              } else if (typeof firstNonNull === "boolean") {
                sourceType = "BOOLEAN";
              } else if (firstNonNull instanceof Date) {
                sourceType = "TIMESTAMP";
              }
            }

            // Get destination database type for suggestions
            // For now, we'll use BigQuery types as default
            const destDbType = "bigquery";

            return analyzeColumnValues(colName, sourceType, values, destDbType);
          });

          return {
            success: true,
            columns: columnAnalyses.map(col => ({
              name: col.name,
              sourceType: col.sourceType,
              suggestedDestType: col.suggestedDestType,
              nullable: col.nullable,
              reasoning: col.reasoning,
              sampleValues: col.sampleValues,
            })),
            rowCount: rows.length,
            message: `Analyzed ${columns.length} columns from ${rows.length} sample rows.`,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : "Schema analysis failed",
          };
        }
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

    /**
     * Set column type mappings for schema transformation
     */
    set_column_mappings: {
      description:
        "Set the schema mapping for all columns. Each mapping includes column name, source type, destination type, nullable, and optional transformer. Use this after analyzing the schema to configure how data types should be converted.",
      inputSchema: setColumnMappingsSchema,
    },

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
      "destinationSchema",
      "destinationTable",
      "syncMode",
      "paginationMode",
      "trackingColumn",
      "conflictStrategy",
      "keyColumns",
      "batchSize",
      "enabled",
      "columnMappings",
      "schemaMappingConfirmed",
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
