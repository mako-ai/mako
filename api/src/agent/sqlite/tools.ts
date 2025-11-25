// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
import { Types } from "mongoose";
import { Database } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { createConsoleTools, ConsoleData } from "../shared/console-tools";

const SQLITE_TYPES = new Set(["cloudflare-d1", "sqlite"]);

const ensureValidObjectId = (value: string, label: string): Types.ObjectId => {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    throw new Error(`'${label}' must be a valid identifier`);
  }
  return new Types.ObjectId(value);
};

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

const fetchSqliteDatabase = async (
  databaseId: string,
  workspaceId: string,
) => {
  const databaseObjectId = ensureValidObjectId(databaseId, "databaseId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await Database.findOne({
    _id: databaseObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database not found or access denied");
  }

  if (!SQLITE_TYPES.has(database.type)) {
    throw new Error(
      "This tool only supports SQLite/Cloudflare D1 database connections.",
    );
  }

  return database;
};

const listSqliteDatabases = async (workspaceId: string) => {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const databases = await Database.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(SQLITE_TYPES) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: any = (db as any).connection || {};
    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      accountId: connection.account_id || "unknown",
      databaseId: connection.database_id || "all-databases",
      displayName: `${db.name} (${db.type})`,
      active: true,
    };
  });
};

const listTables = async (databaseId: string, workspaceId: string) => {
  const database = await fetchSqliteDatabase(databaseId, workspaceId);

  const result = await databaseConnectionService.executeQuery(
    database as any,
    `SELECT name, type 
     FROM sqlite_master 
     WHERE type IN ('table', 'view') 
       AND name NOT LIKE 'sqlite_%' 
       AND name NOT LIKE '_cf_%'
     ORDER BY type DESC, name ASC;`,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list tables");
  }

  return (result.data || []).map((row: any) => ({
    table: row.name,
    type: row.type === "view" ? "VIEW" : "TABLE",
  }));
};

const describeTable = async (
  databaseId: string,
  table: string,
  workspaceId: string,
) => {
  if (!table || typeof table !== "string") {
    throw new Error("'table' is required");
  }

  const database = await fetchSqliteDatabase(databaseId, workspaceId);

  // Use PRAGMA table_info for column details
  const result = await databaseConnectionService.executeQuery(
    database as any,
    `PRAGMA table_info('${table.replace(/'/g, "''")}');`,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to describe table");
  }

  return {
    table,
    columns: (result.data || []).map((row: any) => ({
      name: row.name,
      dataType: row.type || "ANY",
      isNullable: row.notnull === 0,
      defaultValue: row.dflt_value ?? null,
      isPrimaryKey: row.pk === 1,
      columnId: row.cid,
    })),
  };
};

const executeSqliteQuery = async (
  databaseId: string,
  query: string,
  workspaceId: string,
) => {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("'query' must be a non-empty string");
  }

  const database = await fetchSqliteDatabase(databaseId, workspaceId);
  const safeQuery = appendLimitIfMissing(query);

  return databaseConnectionService.executeQuery(database as any, safeQuery);
};

export const createSqliteTools = (
  workspaceId: string,
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  const listDatabasesTool = tool({
    name: "sqlite_list_databases",
    description:
      "Return a list of SQLite/Cloudflare D1 database connections available in this workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listSqliteDatabases(workspaceId),
  });

  const listDatabasesAlias = tool({
    name: "list_databases",
    description:
      "Alias for listing SQLite/D1 database connections for the workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listSqliteDatabases(workspaceId),
  });

  const listTablesTool = tool({
    name: "sqlite_list_tables",
    description:
      "List tables and views in the selected SQLite/D1 database.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
      },
      required: ["databaseId"],
      additionalProperties: false,
    },
    execute: async (input: any) => listTables(input.databaseId, workspaceId),
  });

  const listTablesAlias = tool({
    name: "list_tables",
    description:
      "Alias: List tables and views in the selected SQLite/D1 database.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
      },
      required: ["databaseId"],
      additionalProperties: false,
    },
    execute: async (input: any) => listTables(input.databaseId, workspaceId),
  });

  const describeTableTool = tool({
    name: "sqlite_describe_table",
    description:
      "Describe a SQLite table, including columns, data types, nullability, defaults, and primary key status.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
        table: { type: "string" },
      },
      required: ["databaseId", "table"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      describeTable(input.databaseId, input.table, workspaceId),
  });

  const describeTableAlias = tool({
    name: "describe_table",
    description:
      "Alias: Describe a SQLite table, including columns, data types, nullability, defaults, and primary key status.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
        table: { type: "string" },
      },
      required: ["databaseId", "table"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      describeTable(input.databaseId, input.table, workspaceId),
  });

  const executeQueryTool = tool({
    name: "sqlite_execute_query",
    description:
      "Execute a SQLite SQL query and return the results (adds LIMIT 500 when missing).",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
        query: { type: "string" },
      },
      required: ["databaseId", "query"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeSqliteQuery(input.databaseId, input.query, workspaceId),
  });

  const executeQueryAlias = tool({
    name: "execute_query",
    description:
      "Alias: Execute a SQLite SQL query and return the results (adds LIMIT 500 when missing).",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
        query: { type: "string" },
      },
      required: ["databaseId", "query"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeSqliteQuery(input.databaseId, input.query, workspaceId),
  });

  const consoleTools = createConsoleTools(consoles, preferredConsoleId);

  return [
    listDatabasesTool,
    listDatabasesAlias,
    listTablesTool,
    listTablesAlias,
    describeTableTool,
    describeTableAlias,
    executeQueryTool,
    executeQueryAlias,
    ...consoleTools,
  ];
};

