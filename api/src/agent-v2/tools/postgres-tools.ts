/**
 * Postgres Tools for Agent V2
 * Using Vercel AI SDK's tool() function
 */

import { tool, Tool } from "ai";
import { z } from "zod";

// Type helper for creating tools - works around AI SDK type inference issues
type AnyTool = Tool<any, any>;
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import type { ConsoleDataV2 } from "../types";
import { createConsoleToolsV2 } from "./console-tools";

const POSTGRES_TYPES = new Set(["postgresql", "cloudsql-postgres"]);

const ensureValidObjectId = (value: string, label: string): Types.ObjectId => {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    throw new Error(`'${label}' must be a valid identifier`);
  }
  return new Types.ObjectId(value);
};

const escapeLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const needsDefaultLimit = (sql: string): boolean => {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  const normalized = trimmed
    .replace(/(--.*?$)/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  if (!normalized) return false;

  const firstTokenMatch = normalized.match(/^[\s(]*([a-z]+)/i);
  if (!firstTokenMatch) return false;

  const firstToken = firstTokenMatch[1].toLowerCase();
  return firstToken === "select" || firstToken === "with";
};

const appendLimitIfMissing = (sql: string): string => {
  if (!needsDefaultLimit(sql)) return sql;
  if (/\blimit\s+\d+/i.test(sql)) return sql;

  const trimmed = sql.trim().replace(/;\s*$/i, "");
  return `${trimmed}\nLIMIT 500;`;
};

const fetchPostgresDatabase = async (
  connectionId: string,
  workspaceId: string,
) => {
  const connectionObjectId = ensureValidObjectId(connectionId, "connectionId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await DatabaseConnection.findOne({
    _id: connectionObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database connection not found or access denied");
  }

  if (!POSTGRES_TYPES.has(database.type)) {
    throw new Error("This tool only supports PostgreSQL database connections.");
  }

  return database;
};

// Helper function for listing connections
async function listPostgresConnectionsImpl(workspaceId: string) {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(POSTGRES_TYPES) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection = (
      db as unknown as { connection: Record<string, unknown> }
    ).connection || {};
    const host = (connection.host || connection.instanceConnectionName) as
      | string
      | undefined;
    const databaseName = (connection.database || connection.db) as
      | string
      | undefined;
    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      host: host || "unknown-host",
      databaseName: databaseName || "unknown-database",
      displayName: `${db.name} (${databaseName || "db"})`,
      active: true,
    };
  });
}

// Helper function for listing databases
async function listDatabasesImpl(connectionId: string, workspaceId: string) {
  const database = await fetchPostgresDatabase(connectionId, workspaceId);

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;`,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list databases");
  }

  return (result.data || []).map((row: { datname: string }) => ({
    name: row.datname,
  }));
}

// Helper function for listing schemas
async function listSchemasImpl(
  connectionId: string,
  databaseName: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT schema_name
     FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
     ORDER BY schema_name;`,
    { databaseName },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list schemas");
  }

  return (result.data || []).map((row: { schema_name: string }) => ({
    schema: row.schema_name,
  }));
}

// Helper function for listing tables
async function listTablesImpl(
  connectionId: string,
  databaseName: string,
  schema: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }
  if (!schema || typeof schema !== "string") {
    throw new Error("'schema' is required");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);
  const schemaLiteral = escapeLiteral(schema);

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = ${schemaLiteral}
     ORDER BY table_name;`,
    { databaseName },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list tables");
  }

  return (result.data || []).map(
    (row: { table_name: string; table_type: string }) => ({
      table: row.table_name,
      schema,
      type: row.table_type,
    }),
  );
}

// Helper function for describing table
async function describeTableImpl(
  connectionId: string,
  databaseName: string,
  schema: string,
  table: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }
  if (!schema || typeof schema !== "string") {
    throw new Error("'schema' is required");
  }
  if (!table || typeof table !== "string") {
    throw new Error("'table' is required");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);
  const schemaLiteral = escapeLiteral(schema);
  const tableLiteral = escapeLiteral(table);

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT
       column_name,
       data_type,
       is_nullable,
       column_default,
       character_maximum_length,
       numeric_precision,
       numeric_scale
     FROM information_schema.columns
     WHERE table_schema = ${schemaLiteral}
       AND table_name = ${tableLiteral}
     ORDER BY ordinal_position;`,
    { databaseName },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to describe table");
  }

  return {
    schema,
    table,
    columns: (result.data || []).map((row: Record<string, unknown>) => ({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === "YES",
      defaultValue: row.column_default ?? null,
      maxLength: row.character_maximum_length ?? null,
      numericPrecision: row.numeric_precision ?? null,
      numericScale: row.numeric_scale ?? null,
    })),
  };
}

// Helper function for executing query
async function executeQueryImpl(
  connectionId: string,
  databaseName: string,
  query: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'databaseName' is required");
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("'query' must be a non-empty string");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);
  const safeQuery = appendLimitIfMissing(query);

  return databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    safeQuery,
    { databaseName },
  );
}

export const createPostgresToolsV2 = (
  workspaceId: string,
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
): Record<string, AnyTool> => {
  const consoleTools = createConsoleToolsV2(consoles, preferredConsoleId);

  return {
    ...consoleTools,

    pg_list_connections: tool({
      description:
        "Return a list of Postgres database connections available in this workspace.",
      inputSchema: z.object({}),
      execute: async () => listPostgresConnectionsImpl(workspaceId),
    }) as AnyTool,

    pg_list_databases: tool({
      description:
        "List logical databases available in the specified Postgres connection.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
      }),
      execute: async (params: { connectionId: string }) =>
        listDatabasesImpl(params.connectionId, workspaceId),
    }) as AnyTool,

    pg_list_schemas: tool({
      description:
        "List schemas available in the specified Postgres database connection.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        databaseName: z.string().describe("The target database name"),
      }),
      execute: async (params: { connectionId: string; databaseName: string }) =>
        listSchemasImpl(params.connectionId, params.databaseName, workspaceId),
    }) as AnyTool,

    pg_list_tables: tool({
      description:
        "List tables for a specific schema within the selected Postgres database.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        databaseName: z.string().describe("The target database name"),
        schema: z.string().describe("The schema name"),
      }),
      execute: async (params: {
        connectionId: string;
        databaseName: string;
        schema: string;
      }) =>
        listTablesImpl(
          params.connectionId,
          params.databaseName,
          params.schema,
          workspaceId,
        ),
    }) as AnyTool,

    pg_describe_table: tool({
      description:
        "Describe a Postgres table, including columns, data types, nullability, and default values.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        databaseName: z.string().describe("The target database name"),
        schema: z.string().describe("The schema name"),
        table: z.string().describe("The table name"),
      }),
      execute: async (params: {
        connectionId: string;
        databaseName: string;
        schema: string;
        table: string;
      }) =>
        describeTableImpl(
          params.connectionId,
          params.databaseName,
          params.schema,
          params.table,
          workspaceId,
        ),
    }) as AnyTool,

    pg_execute_query: tool({
      description:
        "Execute a Postgres SQL query and return the results (adds LIMIT 500 when missing).",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        databaseName: z.string().describe("The target database name"),
        query: z.string().describe("The SQL query to execute"),
      }),
      execute: async (params: {
        connectionId: string;
        databaseName: string;
        query: string;
      }) =>
        executeQueryImpl(
          params.connectionId,
          params.databaseName,
          params.query,
          workspaceId,
        ),
    }) as AnyTool,
  };
};
