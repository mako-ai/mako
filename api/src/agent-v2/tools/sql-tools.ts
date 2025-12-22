/**
 * Unified SQL Tools for Agent V2
 * Supports PostgreSQL, BigQuery, SQLite, and Cloudflare D1 with a single tool surface.
 */

import { z } from "zod";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import type { ConsoleDataV2 } from "../types";
import { clientConsoleTools } from "./console-tools-client";
import {
  truncateSamples,
  truncateQueryResults,
  MAX_SAMPLE_ROWS,
} from "./shared/truncation";

// SQL dialect types for routing
type SqlDialect = "postgresql" | "bigquery" | "sqlite";

const SQL_TYPES = {
  postgres: new Set(["postgresql", "cloudsql-postgres"]),
  bigquery: new Set(["bigquery"]),
  sqlite: new Set(["sqlite", "cloudflare-d1"]),
};

const ALL_SQL_TYPES = new Set([
  ...SQL_TYPES.postgres,
  ...SQL_TYPES.bigquery,
  ...SQL_TYPES.sqlite,
]);

const getDialect = (type: string): SqlDialect => {
  if (SQL_TYPES.postgres.has(type)) return "postgresql";
  if (SQL_TYPES.bigquery.has(type)) return "bigquery";
  if (SQL_TYPES.sqlite.has(type)) return "sqlite";
  throw new Error(`Unknown SQL type: ${type}`);
};

// Validation helpers
const ensureValidObjectId = (value: string, label: string): Types.ObjectId => {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    throw new Error(`'${label}' must be a valid identifier`);
  }
  return new Types.ObjectId(value);
};

// SQL escaping helpers
const escapePostgresLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const escapePostgresIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

const escapeBigQueryIdentifier = (value: string): string =>
  `\`${value.replace(/`/g, "\\`")}\``;

const escapeSqliteLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const escapeSqliteIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

// LIMIT enforcement
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

// Fetch and validate database connection
const fetchSqlDatabase = async (connectionId: string, workspaceId: string) => {
  const connectionObjectId = ensureValidObjectId(connectionId, "connectionId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await DatabaseConnection.findOne({
    _id: connectionObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database connection not found or access denied");
  }

  if (!ALL_SQL_TYPES.has(database.type)) {
    throw new Error(
      `This tool only supports SQL database connections (PostgreSQL, BigQuery, SQLite, D1). Got: ${database.type}`,
    );
  }

  return database;
};

// Zod schemas
const emptySchema = z.object({});

const connectionIdSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
});

const connectionAndDbSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database/dataset name"),
});

const inspectTableSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database/dataset name"),
  table: z
    .string()
    .describe("The table name (may include schema prefix for Postgres)"),
});

const executeQuerySchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database/dataset name"),
  query: z.string().describe("The SQL query to execute"),
});

// ============================================================================
// sql_list_connections
// ============================================================================
async function listSqlConnectionsImpl(workspaceId: string) {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(ALL_SQL_TYPES) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: Record<string, unknown> =
      (db as unknown as { connection: Record<string, unknown> }).connection ||
      {};
    const dialect = getDialect(db.type);

    let displayInfo: string;
    if (dialect === "postgresql") {
      const host = (connection.host || connection.instanceConnectionName) as
        | string
        | undefined;
      const dbName = (connection.database || connection.db) as
        | string
        | undefined;
      displayInfo = `${host || "unknown-host"}/${dbName || "unknown-db"}`;
    } else if (dialect === "bigquery") {
      displayInfo = (connection.project_id as string) || "unknown-project";
    } else {
      // SQLite/D1
      const dbId = connection.database_id as string | undefined;
      displayInfo = dbId || "main";
    }

    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      sqlDialect: dialect,
      displayName: `${db.name} (${dialect}: ${displayInfo})`,
      active: true,
    };
  });
}

// ============================================================================
// sql_list_databases
// ============================================================================
async function listDatabasesImpl(connectionId: string, workspaceId: string) {
  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const dialect = getDialect(database.type);

  if (dialect === "postgresql") {
    // List Postgres databases
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;`,
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list databases");
    }

    return (result.data || []).map((row: { datname: string }) => ({
      name: row.datname,
      sqlDialect: dialect,
    }));
  }

  if (dialect === "bigquery") {
    // List BigQuery datasets
    const datasets = await databaseConnectionService.listBigQueryDatasets(
      database as Parameters<
        typeof databaseConnectionService.listBigQueryDatasets
      >[0],
    );
    return datasets.map(ds => ({
      name: ds,
      sqlDialect: dialect,
    }));
  }

  // SQLite/D1
  const connection: Record<string, unknown> =
    (database as unknown as { connection: Record<string, unknown> })
      .connection || {};
  const databaseId = connection.database_id as string | undefined;

  if (databaseId) {
    return [{ name: databaseId, sqlDialect: dialect }];
  }
  return [{ name: "main", sqlDialect: dialect }];
}

// ============================================================================
// sql_list_tables
// ============================================================================
async function listTablesImpl(
  connectionId: string,
  databaseName: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'database' is required");
  }

  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const dialect = getDialect(database.type);

  if (dialect === "postgresql") {
    // Query all schemas, prefix table names if not 'public'
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name;`,
      { databaseName },
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list tables");
    }

    return (result.data || []).map(
      (row: {
        table_schema: string;
        table_name: string;
        table_type: string;
      }) => {
        const name =
          row.table_schema === "public"
            ? row.table_name
            : `${row.table_schema}.${row.table_name}`;
        return {
          name,
          type: row.table_type === "VIEW" ? "view" : "table",
          schema: row.table_schema,
          sqlDialect: dialect,
        };
      },
    );
  }

  if (dialect === "bigquery") {
    // Use the existing service method
    const tables = await databaseConnectionService.listBigQueryTables(
      database as Parameters<
        typeof databaseConnectionService.listBigQueryTables
      >[0],
      databaseName,
    );
    return tables.map(t => ({
      name: t.name,
      type: t.type === "VIEW" ? "view" : "table",
      sqlDialect: dialect,
    }));
  }

  // SQLite/D1
  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT name, type 
     FROM sqlite_master 
     WHERE type IN ('table', 'view') 
     AND name NOT LIKE 'sqlite_%' 
     AND name NOT LIKE '_cf_%'
     ORDER BY type DESC, name ASC;`,
    { databaseId: databaseName },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list tables");
  }

  return (result.data || []).map((row: { name: string; type: string }) => ({
    name: row.name,
    type: row.type === "view" ? "view" : "table",
    sqlDialect: dialect,
  }));
}

// ============================================================================
// sql_inspect_table
// ============================================================================
async function inspectTableImpl(
  connectionId: string,
  databaseName: string,
  tableName: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'database' is required");
  }
  if (!tableName) {
    throw new Error("'table' is required");
  }

  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const dialect = getDialect(database.type);

  let columns: Array<{
    name: string;
    types: string[];
    nullable?: boolean;
    defaultValue?: string;
  }> = [];
  let samples: unknown[] = [];
  let entityKind: "table" | "view" = "table";

  if (dialect === "postgresql") {
    // Parse schema.table if present
    let schema = "public";
    let table = tableName;
    if (tableName.includes(".")) {
      const parts = tableName.split(".");
      schema = parts[0];
      table = parts.slice(1).join(".");
    }

    // Get columns
    const columnsResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT
         column_name,
         data_type,
         is_nullable,
         column_default
       FROM information_schema.columns
       WHERE table_schema = ${escapePostgresLiteral(schema)}
         AND table_name = ${escapePostgresLiteral(table)}
       ORDER BY ordinal_position;`,
      { databaseName },
    );

    if (!columnsResult.success) {
      throw new Error(columnsResult.error || "Failed to get columns");
    }

    columns = (columnsResult.data || []).map(
      (row: Record<string, unknown>) => ({
        name: row.column_name as string,
        types: [row.data_type as string],
        nullable: row.is_nullable === "YES",
        defaultValue: row.column_default as string | undefined,
      }),
    );

    // Get entity type
    const typeResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT table_type FROM information_schema.tables
       WHERE table_schema = ${escapePostgresLiteral(schema)}
         AND table_name = ${escapePostgresLiteral(table)};`,
      { databaseName },
    );
    if (typeResult.success && typeResult.data?.[0]?.table_type === "VIEW") {
      entityKind = "view";
    }

    // Get samples
    const qualifiedName = `${escapePostgresIdentifier(schema)}.${escapePostgresIdentifier(table)}`;
    const samplesResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM ${qualifiedName} LIMIT ${MAX_SAMPLE_ROWS};`,
      { databaseName },
    );

    if (samplesResult.success && samplesResult.data) {
      samples = samplesResult.data;
    }
  } else if (dialect === "bigquery") {
    // Get project ID for INFORMATION_SCHEMA queries
    const connection = (
      database as unknown as { connection: { project_id?: string } }
    ).connection;
    const projectId = connection?.project_id;
    if (!projectId) throw new Error("BigQuery connection missing project_id");

    // Parse table name - might be "dataset.table" or just "table"
    // If the table name includes a dataset prefix, extract just the table name
    let dataset = databaseName;
    let table = tableName;
    if (tableName.includes(".")) {
      const parts = tableName.split(".");
      // Could be "dataset.table" or just "table" with dots in name (rare)
      // If first part matches the database/dataset, strip it
      if (parts[0] === databaseName) {
        table = parts.slice(1).join(".");
      } else {
        // Assume format is dataset.table
        dataset = parts[0];
        table = parts.slice(1).join(".");
      }
    }

    // Get columns
    const safeProject = escapeBigQueryIdentifier(projectId);
    const safeDataset = escapeBigQueryIdentifier(dataset);
    const safeTableForQuery = table.replace(/'/g, "\\'");

    const columnsResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT column_name, data_type, is_nullable
       FROM ${safeProject}.${safeDataset}.INFORMATION_SCHEMA.COLUMNS
       WHERE table_name = '${safeTableForQuery}'
       ORDER BY ordinal_position
       LIMIT 1000`,
    );

    if (!columnsResult.success) {
      throw new Error(columnsResult.error || "Failed to get columns");
    }

    columns = (columnsResult.data || []).map(
      (row: Record<string, unknown>) => ({
        name: row.column_name as string,
        types: [row.data_type as string],
        nullable: row.is_nullable === "YES",
      }),
    );

    // Get samples
    const qualifiedName = `${safeProject}.${safeDataset}.${escapeBigQueryIdentifier(table)}`;
    const samplesResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM ${qualifiedName} LIMIT ${MAX_SAMPLE_ROWS}`,
    );

    if (samplesResult.success && samplesResult.data) {
      samples = samplesResult.data;
    }
  } else {
    // SQLite/D1
    // Get columns using PRAGMA
    const columnsResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `PRAGMA table_info(${escapeSqliteLiteral(tableName)});`,
      { databaseId: databaseName },
    );

    if (!columnsResult.success) {
      throw new Error(columnsResult.error || "Failed to get columns");
    }

    columns = (columnsResult.data || []).map(
      (row: Record<string, unknown>) => ({
        name: row.name as string,
        types: [(row.type as string) || "ANY"],
        nullable: row.notnull === 0,
        defaultValue: row.dflt_value as string | undefined,
      }),
    );

    // Check if it's a view
    const typeResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT type FROM sqlite_master WHERE name = ${escapeSqliteLiteral(tableName)};`,
      { databaseId: databaseName },
    );
    if (typeResult.success && typeResult.data?.[0]?.type === "view") {
      entityKind = "view";
    }

    // Get samples
    const samplesResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM ${escapeSqliteIdentifier(tableName)} LIMIT ${MAX_SAMPLE_ROWS};`,
      { databaseId: databaseName },
    );

    if (samplesResult.success && samplesResult.data) {
      samples = samplesResult.data;
    }
  }

  const { samples: truncatedSamples, _note } = truncateSamples(
    samples,
    MAX_SAMPLE_ROWS,
  );

  return {
    sqlDialect: dialect,
    entityKind,
    entityName: tableName,
    database: databaseName,
    fields: columns,
    samples: truncatedSamples,
    _note,
  };
}

// ============================================================================
// sql_execute_query
// ============================================================================
async function executeQueryImpl(
  connectionId: string,
  databaseName: string,
  query: string,
  workspaceId: string,
) {
  if (!databaseName) {
    throw new Error("'database' is required");
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("'query' must be a non-empty string");
  }

  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const dialect = getDialect(database.type);
  const safeQuery = appendLimitIfMissing(query);

  let options: Record<string, string> = {};
  if (dialect === "postgresql") {
    options = { databaseName };
  } else if (dialect === "sqlite") {
    options = { databaseId: databaseName };
  }
  // BigQuery doesn't need options - dataset is in the query

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    safeQuery,
    options,
  );

  if (result && result.success && result.data) {
    const truncatedData = truncateQueryResults(result.data);
    return { ...result, data: truncatedData, sqlDialect: dialect };
  }

  return { ...result, sqlDialect: dialect };
}

// ============================================================================
// Export: createSqlToolsV2
// ============================================================================
export const createSqlToolsV2 = (
  workspaceId: string,
  _consoles: ConsoleDataV2[],
  _preferredConsoleId?: string,
) => {
  return {
    ...clientConsoleTools,

    sql_list_connections: {
      description:
        "List all SQL database connections (PostgreSQL, BigQuery, SQLite, Cloudflare D1) in this workspace. Returns connection ID, name, type, and sqlDialect.",
      inputSchema: emptySchema,
      execute: async () => listSqlConnectionsImpl(workspaceId),
    },

    sql_list_databases: {
      description:
        "List databases (PostgreSQL), datasets (BigQuery), or database files (SQLite/D1) within a SQL connection. Returns array of database names with sqlDialect.",
      inputSchema: connectionIdSchema,
      execute: async (params: { connectionId: string }) =>
        listDatabasesImpl(params.connectionId, workspaceId),
    },

    sql_list_tables: {
      description:
        "List tables and views in a database. For PostgreSQL with multiple schemas, returns schema-prefixed names (e.g., 'analytics.events'). Returns table names with type and sqlDialect.",
      inputSchema: connectionAndDbSchema,
      execute: async (params: { connectionId: string; database: string }) =>
        listTablesImpl(params.connectionId, params.database, workspaceId),
    },

    sql_inspect_table: {
      description:
        "Get table/view schema (columns, types, nullability) plus up to 25 sample rows. Returns sqlDialect to guide query syntax. For PostgreSQL, use 'schema.table' format if not in public schema.",
      inputSchema: inspectTableSchema,
      execute: async (params: {
        connectionId: string;
        database: string;
        table: string;
      }) =>
        inspectTableImpl(
          params.connectionId,
          params.database,
          params.table,
          workspaceId,
        ),
    },

    sql_execute_query: {
      description:
        "Execute a SQL query and return results. LIMIT 500 is automatically added to SELECT queries if missing. Use sqlDialect from previous tool calls to write correct syntax.",
      inputSchema: executeQuerySchema,
      execute: async (params: {
        connectionId: string;
        database: string;
        query: string;
      }) =>
        executeQueryImpl(
          params.connectionId,
          params.database,
          params.query,
          workspaceId,
        ),
    },
  };
};
