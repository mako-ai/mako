// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { createConsoleTools, ConsoleData } from "../shared/console-tools";

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
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed
    .replace(/(--.*?$)/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  if (!normalized) {
    return false;
  }

  const firstTokenMatch = normalized.match(/^[\s(]*([a-z]+)/i);
  if (!firstTokenMatch) {
    return false;
  }

  const firstToken = firstTokenMatch[1].toLowerCase();
  return firstToken === "select" || firstToken === "with";
};

const appendLimitIfMissing = (sql: string): string => {
  if (!needsDefaultLimit(sql)) {
    return sql;
  }

  if (/\blimit\s+\d+/i.test(sql)) {
    return sql;
  }

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
    throw new Error(
      "This tool only supports PostgreSQL database connections.",
    );
  }

  return database;
};

const listPostgresConnections = async (workspaceId: string) => {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(POSTGRES_TYPES) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: any = (db as any).connection || {};
    const host = connection.host || connection.instanceConnectionName;
    const databaseName = connection.database || connection.db;
    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      host: host || "unknown-host",
      databaseName: databaseName || "unknown-database", // Default DB
      displayName: `${db.name} (${databaseName || "db"})`,
      active: true,
    };
  });
};

const listPostgresDatabases = async (
  connectionId: string,
  workspaceId: string,
) => {
  const database = await fetchPostgresDatabase(connectionId, workspaceId);

  const result = await databaseConnectionService.executeQuery(
    database as any,
    `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;`,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list databases");
  }

  return (result.data || []).map((row: any) => ({
    name: row.datname,
  }));
};

const listSchemas = async (
  connectionId: string,
  databaseName: string,
  workspaceId: string,
) => {
  const database = await fetchPostgresDatabase(connectionId, workspaceId);

  // Pass databaseName to connect to specific DB
  const options = databaseName ? { databaseName } : undefined;

  const result = await databaseConnectionService.executeQuery(
    database as any,
    `SELECT schema_name
     FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
     ORDER BY schema_name;`,
    options,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list schemas");
  }

  return (result.data || []).map((row: any) => ({
    schema: row.schema_name,
  }));
};

const listTables = async (
  connectionId: string,
  databaseName: string,
  schema: string,
  workspaceId: string,
) => {
  if (!schema || typeof schema !== "string") {
    throw new Error("'schema' is required");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);
  const schemaLiteral = escapeLiteral(schema);
  const options = databaseName ? { databaseName } : undefined;

  const result = await databaseConnectionService.executeQuery(
    database as any,
    `SELECT table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = ${schemaLiteral}
     ORDER BY table_name;`,
    options,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list tables");
  }

  return (result.data || []).map((row: any) => ({
    table: row.table_name,
    schema,
    type: row.table_type,
  }));
};

const describeTable = async (
  connectionId: string,
  databaseName: string,
  schema: string,
  table: string,
  workspaceId: string,
) => {
  if (!schema || typeof schema !== "string") {
    throw new Error("'schema' is required");
  }
  if (!table || typeof table !== "string") {
    throw new Error("'table' is required");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);
  const schemaLiteral = escapeLiteral(schema);
  const tableLiteral = escapeLiteral(table);
  const options = databaseName ? { databaseName } : undefined;

  const result = await databaseConnectionService.executeQuery(
    database as any,
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
    options,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to describe table");
  }

  return {
    schema,
    table,
    columns: (result.data || []).map((row: any) => ({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === "YES",
      defaultValue: row.column_default ?? null,
      maxLength: row.character_maximum_length ?? null,
      numericPrecision: row.numeric_precision ?? null,
      numericScale: row.numeric_scale ?? null,
    })),
  };
};

const executePostgresQuery = async (
  connectionId: string,
  query: string,
  workspaceId: string,
  databaseName?: string,
) => {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("'query' must be a non-empty string");
  }

  const database = await fetchPostgresDatabase(connectionId, workspaceId);
  const safeQuery = appendLimitIfMissing(query);
  const options = databaseName ? { databaseName } : undefined;

  return databaseConnectionService.executeQuery(
    database as any,
    safeQuery,
    options,
  );
};

export const createPostgresTools = (
  workspaceId: string,
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  const listConnectionsTool = tool({
    name: "pg_list_connections",
    description:
      "Return a list of Postgres database connections available in this workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listPostgresConnections(workspaceId),
  });

  const listConnectionsAlias = tool({
    name: "list_connections",
    description:
      "Alias for listing Postgres database connections for the workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listPostgresConnections(workspaceId),
  });

  const listDatabasesTool = tool({
    name: "pg_list_databases",
    description:
      "List logical databases available in the specified Postgres connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listPostgresDatabases(input.connectionId, workspaceId),
  });

  const listDatabasesAlias = tool({
    name: "list_databases",
    description:
      "Alias for listing logical databases available in the specified Postgres connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listPostgresDatabases(input.connectionId, workspaceId),
  });

  const listSchemasTool = tool({
    name: "pg_list_schemas",
    description:
      "List schemas available in the specified Postgres database connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
      },
      required: ["connectionId", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listSchemas(input.connectionId, input.databaseName || undefined, workspaceId),
  });

  const listSchemasAlias = tool({
    name: "list_schemas",
    description:
      "Alias: List schemas available in the specified Postgres database connection.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
      },
      required: ["connectionId", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listSchemas(input.connectionId, input.databaseName || undefined, workspaceId),
  });

  const listTablesTool = tool({
    name: "pg_list_tables",
    description:
      "List tables for a specific schema within the selected Postgres database.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
        schema: { type: "string" },
      },
      required: ["connectionId", "schema", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listTables(
        input.connectionId,
        input.databaseName || undefined,
        input.schema,
        workspaceId,
      ),
  });

  const listTablesAlias = tool({
    name: "list_tables",
    description:
      "Alias: List tables for a specific schema within the selected Postgres database.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
        schema: { type: "string" },
      },
      required: ["connectionId", "schema", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listTables(
        input.connectionId,
        input.databaseName || undefined,
        input.schema,
        workspaceId,
      ),
  });

  const describeTableTool = tool({
    name: "pg_describe_table",
    description:
      "Describe a Postgres table, including columns, data types, nullability, and default values.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
        schema: { type: "string" },
        table: { type: "string" },
      },
      required: ["connectionId", "schema", "table", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      describeTable(
        input.connectionId,
        input.databaseName || undefined,
        input.schema,
        input.table,
        workspaceId,
      ),
  });

  const describeTableAlias = tool({
    name: "describe_table",
    description:
      "Alias: Describe a Postgres table, including columns, data types, nullability, and default values.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
        schema: { type: "string" },
        table: { type: "string" },
      },
      required: ["connectionId", "schema", "table", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      describeTable(
        input.connectionId,
        input.databaseName || undefined,
        input.schema,
        input.table,
        workspaceId,
      ),
  });

  const executeQueryTool = tool({
    name: "pg_execute_query",
    description:
      "Execute a Postgres SQL query and return the results (adds LIMIT 500 when missing).",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
        query: { type: "string" },
      },
      required: ["connectionId", "query", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executePostgresQuery(
        input.connectionId,
        input.query,
        workspaceId,
        input.databaseName || undefined,
      ),
  });

  const executeQueryAlias = tool({
    name: "execute_query",
    description:
      "Alias: Execute a Postgres SQL query and return the results (adds LIMIT 500 when missing).",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        databaseName: { type: ["string", "null"] },
        query: { type: "string" },
      },
      required: ["connectionId", "query", "databaseName"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executePostgresQuery(
        input.connectionId,
        input.query,
        workspaceId,
        input.databaseName || undefined,
      ),
  });

  const consoleTools = createConsoleTools(consoles, preferredConsoleId);

  return [
    listConnectionsTool,
    listConnectionsAlias,
    listDatabasesTool,
    listDatabasesAlias,
    listSchemasTool,
    listSchemasAlias,
    listTablesTool,
    listTablesAlias,
    describeTableTool,
    describeTableAlias,
    executeQueryTool,
    executeQueryAlias,
    ...consoleTools,
  ];
};
