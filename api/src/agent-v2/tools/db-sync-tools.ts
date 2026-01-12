/**
 * AI Agent Tools for Database-to-Database Sync Configuration
 *
 * These tools enable the AI agent to help users configure sync flows
 * through the chat interface. The agent can:
 * - List available database connections
 * - Explore database schemas
 * - Write and validate SQL queries
 * - Configure pagination, type coercions, and other settings
 * - Validate the complete flow configuration
 * - Run dry-run tests
 */

import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { getDatabaseDriver } from "../../databases/registry";
import {
  validateQuery,
  checkQuerySafety,
  dryRunDbSync,
  extractOrderByColumn,
  extractOrderByDirection,
} from "../../services/destination-writer.service";
import {
  validateDbFlowConfig,
  getDbFlowConfigDescription,
  DbFlowConfigSchema,
} from "../../schemas/db-flow-config.schema";

/**
 * Tool: List available database connections in the workspace
 */
export const listDatabaseConnectionsTool = tool({
  description:
    "List all database connections available in the current workspace. Use this to find source and destination database connection IDs.",
  parameters: z.object({
    workspaceId: z.string().describe("The workspace ID"),
    type: z
      .string()
      .optional()
      .describe("Optional filter by database type (e.g., 'postgresql', 'bigquery')"),
  }),
  execute: async ({ workspaceId, type }) => {
    try {
      const query: Record<string, unknown> = {
        workspaceId: new Types.ObjectId(workspaceId),
      };
      if (type) {
        query.type = type;
      }

      const connections = await DatabaseConnection.find(query)
        .select("_id name type createdAt")
        .sort({ name: 1 })
        .lean();

      return {
        success: true,
        connections: connections.map((conn) => ({
          id: conn._id.toString(),
          name: conn.name,
          type: conn.type,
          createdAt: conn.createdAt,
        })),
        total: connections.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Tool: Get database schema (tables/collections and columns)
 */
export const getDatabaseSchemaTool = tool({
  description:
    "Get the schema of a database connection, including tables/collections and their columns. Use this to understand the structure of source or destination databases.",
  parameters: z.object({
    workspaceId: z.string().describe("The workspace ID"),
    connectionId: z.string().describe("The database connection ID"),
    database: z.string().optional().describe("Specific database name within the connection"),
    schema: z.string().optional().describe("Schema name (for PostgreSQL) or dataset (for BigQuery)"),
    tableName: z.string().optional().describe("Get columns for a specific table only"),
  }),
  execute: async ({ workspaceId, connectionId, database, schema, tableName }) => {
    try {
      const connection = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connection) {
        return { success: false, error: "Database connection not found" };
      }

      const driver = getDatabaseDriver(connection.type);
      if (!driver) {
        return { success: false, error: `No driver found for type: ${connection.type}` };
      }

      // Get tables
      if (!tableName && driver.getTables) {
        const tablesResult = await driver.getTables(connection, {
          databaseName: database,
          schema,
        });

        if (!tablesResult.success) {
          return { success: false, error: tablesResult.error };
        }

        return {
          success: true,
          connectionName: connection.name,
          connectionType: connection.type,
          tables: tablesResult.tables?.map((t) => ({
            name: t.name,
            schema: t.schema,
            type: t.type,
          })),
        };
      }

      // Get columns for a specific table
      if (tableName && driver.getColumns) {
        const columnsResult = await driver.getColumns(connection, tableName, {
          databaseName: database,
          schema,
        });

        if (!columnsResult.success) {
          return { success: false, error: columnsResult.error };
        }

        return {
          success: true,
          connectionName: connection.name,
          connectionType: connection.type,
          tableName,
          columns: columnsResult.columns?.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            primaryKey: c.primaryKey,
          })),
        };
      }

      return { success: false, error: "Schema introspection not supported for this database type" };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Tool: Validate a SQL query for sync operations
 */
export const validateSyncQueryTool = tool({
  description:
    "Validate a SQL query to be used in a database sync flow. Checks for safety (read-only), syntax, and returns column information. Use this before setting the query in a flow configuration.",
  parameters: z.object({
    workspaceId: z.string().describe("The workspace ID"),
    connectionId: z.string().describe("The source database connection ID"),
    query: z.string().describe("The SQL SELECT query to validate"),
    database: z.string().optional().describe("Database name within the connection"),
  }),
  execute: async ({ workspaceId, connectionId, query, database }) => {
    try {
      // First run safety checks
      const safetyCheck = checkQuerySafety(query);

      const connection = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connection) {
        return {
          success: false,
          error: "Database connection not found",
          safetyCheck,
        };
      }

      if (!safetyCheck.safe) {
        return {
          success: false,
          error: safetyCheck.errors.join("; "),
          safetyCheck,
          connectionName: connection.name,
        };
      }

      // Validate against the database
      const result = await validateQuery(connection, query, database);

      // Extract ORDER BY info for pagination suggestions
      const orderByColumn = extractOrderByColumn(query);
      const orderByDirection = extractOrderByDirection(query);

      return {
        success: result.success,
        error: result.error,
        safetyCheck,
        connectionName: connection.name,
        connectionType: connection.type,
        columns: result.columns,
        sampleRow: result.sampleRow,
        pagination: {
          hasOrderBy: !!orderByColumn,
          orderByColumn,
          orderByDirection,
          suggestion: !orderByColumn
            ? "Add ORDER BY clause for consistent pagination (e.g., ORDER BY id ASC)"
            : undefined,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Tool: Suggest tracking columns for incremental sync
 */
export const suggestTrackingColumnsTool = tool({
  description:
    "Analyze a table and suggest columns that could be used for incremental sync tracking. Looks for timestamp columns (updated_at, modified_at) and auto-incrementing IDs.",
  parameters: z.object({
    workspaceId: z.string().describe("The workspace ID"),
    connectionId: z.string().describe("The database connection ID"),
    tableName: z.string().describe("The table to analyze"),
    database: z.string().optional().describe("Database name"),
    schema: z.string().optional().describe("Schema name"),
  }),
  execute: async ({ workspaceId, connectionId, tableName, database, schema }) => {
    try {
      const connection = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connection) {
        return { success: false, error: "Database connection not found" };
      }

      const driver = getDatabaseDriver(connection.type);
      if (!driver || !driver.getColumns) {
        return { success: false, error: "Schema introspection not supported" };
      }

      const columnsResult = await driver.getColumns(connection, tableName, {
        databaseName: database,
        schema,
      });

      if (!columnsResult.success || !columnsResult.columns) {
        return { success: false, error: columnsResult.error || "Could not get columns" };
      }

      const suggestions: Array<{
        column: string;
        type: string;
        trackingType: "timestamp" | "numeric";
        confidence: "high" | "medium" | "low";
        reason: string;
      }> = [];

      for (const col of columnsResult.columns) {
        const colName = col.name.toLowerCase();
        const colType = col.type.toLowerCase();

        // High confidence: updated_at, modified_at columns
        if (
          (colName.includes("updated") || colName.includes("modified")) &&
          (colType.includes("timestamp") || colType.includes("datetime") || colType.includes("date"))
        ) {
          suggestions.push({
            column: col.name,
            type: col.type,
            trackingType: "timestamp",
            confidence: "high",
            reason: "Timestamp column with 'updated' or 'modified' in name - ideal for tracking changes",
          });
        }
        // Medium confidence: created_at (works but misses updates)
        else if (
          colName.includes("created") &&
          (colType.includes("timestamp") || colType.includes("datetime") || colType.includes("date"))
        ) {
          suggestions.push({
            column: col.name,
            type: col.type,
            trackingType: "timestamp",
            confidence: "medium",
            reason: "Creation timestamp - good for append-only data, but won't catch updates",
          });
        }
        // Medium confidence: auto-incrementing ID
        else if (
          col.primaryKey &&
          (colType.includes("int") || colType.includes("serial") || colType.includes("bigint"))
        ) {
          suggestions.push({
            column: col.name,
            type: col.type,
            trackingType: "numeric",
            confidence: "medium",
            reason: "Primary key - good for append-only data, but won't catch updates to existing rows",
          });
        }
        // Low confidence: any timestamp column
        else if (
          colType.includes("timestamp") ||
          colType.includes("datetime")
        ) {
          suggestions.push({
            column: col.name,
            type: col.type,
            trackingType: "timestamp",
            confidence: "low",
            reason: "Timestamp column - verify this represents when rows change",
          });
        }
      }

      // Sort by confidence
      suggestions.sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.confidence] - order[b.confidence];
      });

      return {
        success: true,
        tableName,
        suggestions,
        recommendation:
          suggestions.length > 0
            ? `Recommended: Use '${suggestions[0].column}' (${suggestions[0].trackingType}) - ${suggestions[0].reason}`
            : "No suitable tracking columns found. Consider adding an 'updated_at' timestamp column to the source table.",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Tool: Validate a complete flow configuration
 */
export const validateFlowConfigTool = tool({
  description:
    "Validate a complete database sync flow configuration against the schema. Use this to check if the configuration is valid before creating or updating a flow.",
  parameters: z.object({
    config: z.string().describe("The flow configuration as a JSON string"),
  }),
  execute: async ({ config }) => {
    try {
      const parsed = JSON.parse(config);
      const result = validateDbFlowConfig(parsed);

      if (result.success) {
        return {
          success: true,
          message: "Configuration is valid",
          validatedConfig: result.data,
        };
      }

      return {
        success: false,
        errors: result.errors,
        schemaDescription: getDbFlowConfigDescription(),
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          error: "Invalid JSON: " + error.message,
          schemaDescription: getDbFlowConfigDescription(),
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Tool: Run a dry-run test of a sync configuration
 */
export const dryRunSyncTool = tool({
  description:
    "Run a dry-run test of a database sync configuration. Executes 3 pages of the query and returns sample data without actually writing to the destination. Use this to preview what data will be synced.",
  parameters: z.object({
    workspaceId: z.string().describe("The workspace ID"),
    connectionId: z.string().describe("The source database connection ID"),
    query: z.string().describe("The SQL SELECT query"),
    database: z.string().optional().describe("Database name"),
    paginationMode: z.enum(["offset", "keyset"]).optional().default("offset"),
    keysetColumn: z.string().optional().describe("Column for keyset pagination"),
    keysetDirection: z.enum(["asc", "desc"]).optional().default("asc"),
    pageSize: z.number().optional().default(100).describe("Rows per page (max 1000)"),
  }),
  execute: async ({
    workspaceId,
    connectionId,
    query,
    database,
    paginationMode,
    keysetColumn,
    keysetDirection,
    pageSize,
  }) => {
    try {
      const connection = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!connection) {
        return { success: false, error: "Database connection not found" };
      }

      const result = await dryRunDbSync({
        sourceConnection: connection,
        sourceQuery: query,
        sourceDatabase: database,
        paginationConfig:
          paginationMode === "keyset" && keysetColumn
            ? {
                mode: "keyset",
                keysetColumn,
                keysetDirection,
              }
            : { mode: "offset" },
        pageSize: Math.min(pageSize || 100, 1000),
        pages: 3,
      });

      return {
        success: result.success,
        error: result.error,
        safetyCheck: result.safetyCheck,
        totalRows: result.totalRows,
        estimatedTotal: result.estimatedTotal,
        columns: result.columns,
        sampleData: result.sampleData.slice(0, 10), // Limit sample data in response
        preview: {
          rowsShown: Math.min(result.sampleData.length, 10),
          totalFetched: result.totalRows,
          estimatedInTable: result.estimatedTotal,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Tool: Get the schema description for reference
 */
export const getFlowSchemaDescriptionTool = tool({
  description:
    "Get a detailed description of the database flow configuration schema. Use this to understand what fields are available and their requirements.",
  parameters: z.object({}),
  execute: async () => {
    return {
      success: true,
      schemaDescription: getDbFlowConfigDescription(),
    };
  },
});

/**
 * Tool: Generate cron expression
 */
export const generateCronExpressionTool = tool({
  description:
    "Generate a cron expression from a human-readable schedule description. Supports common patterns like 'every hour', 'daily at 3am', 'every 15 minutes', etc.",
  parameters: z.object({
    description: z.string().describe("Human-readable schedule (e.g., 'every hour', 'daily at 3am')"),
  }),
  execute: async ({ description }) => {
    const desc = description.toLowerCase().trim();

    // Common patterns
    const patterns: Array<{ match: RegExp; cron: string; readable: string }> = [
      { match: /every\s*minute/i, cron: "* * * * *", readable: "Every minute" },
      { match: /every\s*5\s*minutes?/i, cron: "*/5 * * * *", readable: "Every 5 minutes" },
      { match: /every\s*10\s*minutes?/i, cron: "*/10 * * * *", readable: "Every 10 minutes" },
      { match: /every\s*15\s*minutes?/i, cron: "*/15 * * * *", readable: "Every 15 minutes" },
      { match: /every\s*30\s*minutes?/i, cron: "*/30 * * * *", readable: "Every 30 minutes" },
      { match: /every\s*hour/i, cron: "0 * * * *", readable: "Every hour at :00" },
      { match: /every\s*2\s*hours?/i, cron: "0 */2 * * *", readable: "Every 2 hours" },
      { match: /every\s*4\s*hours?/i, cron: "0 */4 * * *", readable: "Every 4 hours" },
      { match: /every\s*6\s*hours?/i, cron: "0 */6 * * *", readable: "Every 6 hours" },
      { match: /every\s*12\s*hours?/i, cron: "0 */12 * * *", readable: "Every 12 hours" },
      { match: /daily|every\s*day/i, cron: "0 0 * * *", readable: "Daily at midnight" },
      { match: /weekly|every\s*week/i, cron: "0 0 * * 0", readable: "Weekly on Sunday at midnight" },
      { match: /monthly|every\s*month/i, cron: "0 0 1 * *", readable: "Monthly on the 1st at midnight" },
    ];

    // Check for time-specific patterns
    const timeMatch = desc.match(/at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3]?.toLowerCase();

      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;

      if (desc.includes("daily") || desc.includes("every day")) {
        return {
          success: true,
          cron: `${minute} ${hour} * * *`,
          readable: `Daily at ${timeMatch[1]}:${String(minute).padStart(2, "0")} ${ampm || ""}`.trim(),
        };
      }
    }

    // Check common patterns
    for (const { match, cron, readable } of patterns) {
      if (match.test(desc)) {
        return { success: true, cron, readable };
      }
    }

    return {
      success: false,
      error: "Could not parse schedule description",
      suggestions: [
        "every 15 minutes",
        "every hour",
        "every 6 hours",
        "daily at 3am",
        "weekly",
        "monthly",
      ],
    };
  },
});

/**
 * Export all tools as a collection
 */
export const dbSyncTools = {
  listDatabaseConnections: listDatabaseConnectionsTool,
  getDatabaseSchema: getDatabaseSchemaTool,
  validateSyncQuery: validateSyncQueryTool,
  suggestTrackingColumns: suggestTrackingColumnsTool,
  validateFlowConfig: validateFlowConfigTool,
  dryRunSync: dryRunSyncTool,
  getFlowSchemaDescription: getFlowSchemaDescriptionTool,
  generateCronExpression: generateCronExpressionTool,
};

/**
 * System prompt addition for the AI agent when helping with sync configuration
 */
export const dbSyncAgentPrompt = `
You are helping the user configure a database-to-database sync flow. You have access to tools that let you:

1. **List database connections** - Find available source and destination databases
2. **Explore database schemas** - See tables and columns to help write queries
3. **Validate SQL queries** - Check if queries are safe and valid for syncing
4. **Suggest tracking columns** - Recommend columns for incremental sync
5. **Validate flow configuration** - Check if the complete configuration is valid
6. **Run dry-run tests** - Preview what data will be synced
7. **Generate cron expressions** - Convert schedule descriptions to cron format

When helping the user:
1. First understand what data they want to sync (source table, destination)
2. Help them write or refine the SQL query
3. Suggest appropriate sync mode (full vs incremental) based on their needs
4. Configure pagination (keyset is more efficient for large tables)
5. Set up type coercions if needed for data format mismatches
6. Validate the complete configuration before creating the flow
7. Run a dry-run to preview the results

The flow configuration is represented as JSON. You can read and modify this configuration, validate it, and help the user understand what each field does.
`.trim();
