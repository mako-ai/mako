/**
 * Unified SQL Tools for Agent Library
 * Supports PostgreSQL, MySQL, BigQuery, SQLite, and Cloudflare D1 with a single tool surface.
 */

import { z } from "zod";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import {
  checkQueryAccess,
  canUserSeeDatabase,
} from "../../services/database-access.service";
import type { ConsoleDataV2 } from "../types";
import { clientConsoleTools } from "./console-tools-client";
import {
  truncateSamples,
  truncateQueryResults,
  MAX_SAMPLE_ROWS,
} from "./shared/truncation";
import {
  ALL_SQL_TYPES,
  getDialect,
  ensureValidObjectId,
  escapePostgresLiteral,
  escapePostgresIdentifier,
  escapeBigQueryIdentifier,
  escapeMySqlIdentifier,
  escapeSqliteLiteral,
  escapeSqliteIdentifier,
} from "./shared/sql-dialects";
import { MYSQL_SYSTEM_DATABASES_SET } from "../../databases/drivers/mysql/driver";

// LIMIT enforcement (kept local as it has sql-tools specific logic)
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
      `This tool only supports SQL database connections (PostgreSQL, MySQL, BigQuery, SQLite, D1). Got: ${database.type}`,
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
async function listSqlConnectionsImpl(workspaceId: string, userId?: string) {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(ALL_SQL_TYPES) },
  }).sort({ name: 1 });

  return databases
    .filter(db => {
      if (!userId) return true;
      return canUserSeeDatabase(db, userId);
    })
    .map(db => {
      const connection: Record<string, unknown> =
        (db as unknown as { connection: Record<string, unknown> }).connection ||
        {};
      const dialect = getDialect(db.type);

      let displayInfo: string;
      if (dialect === "postgresql" || dialect === "mysql") {
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

      const accessLevel = db.access || "shared_write";
      const accessLabel = accessLevel === "shared_read" ? " [read-only]" : "";

      return {
        id: db._id.toString(),
        name: db.name,
        type: db.type,
        sqlDialect: dialect,
        displayName: `${db.name} (${dialect}: ${displayInfo})${accessLabel}`,
        active: true,
        access: accessLevel,
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

  if (dialect === "mysql") {
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      "SHOW DATABASES",
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list databases");
    }

    return (result.data || [])
      .map(
        (row: { Database?: string; database?: string }) =>
          row.Database || row.database,
      )
      .filter(
        (name: string | undefined): name is string =>
          !!name && !MYSQL_SYSTEM_DATABASES_SET.has(name),
      )
      .map((name: string) => ({
        name,
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

  if (dialect === "clickhouse") {
    // List ClickHouse databases
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      "SHOW DATABASES",
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list databases");
    }

    const systemDatabases = new Set([
      "system",
      "information_schema",
      "INFORMATION_SCHEMA",
    ]);

    return (result.data || [])
      .filter((row: { name: string }) => !systemDatabases.has(row.name))
      .map((row: { name: string }) => ({
        name: row.name,
        sqlDialect: dialect,
      }));
  }

  // SQLite/D1
  const connection: Record<string, unknown> =
    (database as unknown as { connection: Record<string, unknown> })
      .connection || {};
  const databaseId = connection.database_id as string | undefined;

  // For Cloudflare D1: check if it's cluster mode (no database_id configured)
  if (database.type === "cloudflare-d1") {
    if (databaseId) {
      // Single database mode: return the configured database_id as both id and name
      return [{ id: databaseId, name: databaseId, sqlDialect: dialect }];
    }

    // Cluster mode: fetch all D1 databases from Cloudflare API
    try {
      const d1Databases = await databaseConnectionService.listD1Databases(
        database as Parameters<
          typeof databaseConnectionService.listD1Databases
        >[0],
      );
      return d1Databases.map(db => ({
        id: db.uuid, // UUID for API calls
        name: db.name, // Human-readable name for display
        sqlDialect: dialect,
      }));
    } catch {
      // Fallback to "main" if listing fails (e.g., API error, credentials issue)
      return [{ name: "main", sqlDialect: dialect }];
    }
  }

  // Plain SQLite (not D1)
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

  if (dialect === "mysql") {
    const safeDb = databaseName.replace(/'/g, "''");
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT table_name AS table_name, table_type AS table_type
       FROM information_schema.tables
       WHERE table_schema = '${safeDb}'
       ORDER BY table_name;`,
      { databaseName },
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list tables");
    }

    return (result.data || [])
      .map(
        (row: {
          table_name?: string;
          TABLE_NAME?: string;
          table_type?: string;
          TABLE_TYPE?: string;
        }) => ({
          name: row.table_name ?? row.TABLE_NAME,
          type: row.table_type ?? row.TABLE_TYPE,
        }),
      )
      .filter(
        (row: {
          name?: string;
          type?: string;
        }): row is {
          name: string;
          type?: string;
        } => !!row.name,
      )
      .map((row: { name: string; type?: string }) => ({
        name: row.name,
        type: row.type === "VIEW" ? "view" : "table",
        sqlDialect: dialect,
      }));
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

  if (dialect === "clickhouse") {
    // List ClickHouse tables in the database
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT name, engine 
       FROM system.tables 
       WHERE database = '${databaseName.replace(/'/g, "''")}'
       ORDER BY name`,
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list tables");
    }

    return (result.data || []).map((row: { name: string; engine: string }) => ({
      name: row.name,
      type:
        row.engine === "View" || row.engine === "MaterializedView"
          ? "view"
          : "table",
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
  } else if (dialect === "clickhouse") {
    // ClickHouse table inspection
    const safeDatabase = databaseName.replace(/'/g, "''");
    const safeTable = tableName.replace(/'/g, "''");

    // Get columns from system.columns
    const columnsResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT name, type, default_kind, default_expression
       FROM system.columns
       WHERE database = '${safeDatabase}' AND table = '${safeTable}'
       ORDER BY position`,
    );

    if (!columnsResult.success) {
      throw new Error(columnsResult.error || "Failed to get columns");
    }

    columns = (columnsResult.data || []).map(
      (row: Record<string, unknown>) => ({
        name: row.name as string,
        types: [row.type as string],
        nullable: (row.type as string).startsWith("Nullable"),
        defaultValue: row.default_expression as string | undefined,
      }),
    );

    // Check if it's a view
    const typeResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT engine FROM system.tables 
       WHERE database = '${safeDatabase}' AND name = '${safeTable}'`,
    );
    if (
      typeResult.success &&
      (typeResult.data?.[0]?.engine === "View" ||
        typeResult.data?.[0]?.engine === "MaterializedView")
    ) {
      entityKind = "view";
    }

    // Get samples
    const samplesResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM "${databaseName.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}" LIMIT ${MAX_SAMPLE_ROWS}`,
    );

    if (samplesResult.success && samplesResult.data) {
      samples = samplesResult.data;
    }
  } else if (dialect === "mysql") {
    const safeDb = databaseName.replace(/'/g, "''");
    const safeTable = tableName.replace(/'/g, "''");

    const columnsResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT column_name AS column_name, data_type AS data_type, is_nullable AS is_nullable, column_default AS column_default
       FROM information_schema.columns
       WHERE table_schema = '${safeDb}'
         AND table_name = '${safeTable}'
       ORDER BY ordinal_position;`,
      { databaseName },
    );

    if (!columnsResult.success) {
      throw new Error(columnsResult.error || "Failed to get columns");
    }

    type MySqlColumn = {
      name?: string;
      types: string[];
      nullable?: boolean;
      defaultValue?: string;
    };

    columns = (columnsResult.data || [])
      .map(
        (row: {
          column_name?: string;
          COLUMN_NAME?: string;
          data_type?: string;
          DATA_TYPE?: string;
          is_nullable?: string;
          IS_NULLABLE?: string;
          column_default?: string;
          COLUMN_DEFAULT?: string;
        }): MySqlColumn => ({
          name: row.column_name ?? row.COLUMN_NAME,
          types: [row.data_type ?? row.DATA_TYPE].filter(
            (value): value is string => !!value,
          ),
          nullable:
            (row.is_nullable ?? row.IS_NULLABLE)?.toUpperCase() === "YES",
          defaultValue: row.column_default ?? row.COLUMN_DEFAULT,
        }),
      )
      .filter((row: MySqlColumn): row is Required<MySqlColumn> => !!row.name);

    const typeResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT table_type AS table_type
       FROM information_schema.tables
       WHERE table_schema = '${safeDb}'
         AND table_name = '${safeTable}';`,
      { databaseName },
    );
    const typeValue =
      (typeResult.success && typeResult.data?.[0]?.table_type) ||
      (typeResult.success && typeResult.data?.[0]?.TABLE_TYPE);
    if (typeValue === "VIEW") {
      entityKind = "view";
    }

    const qualifiedName = `${escapeMySqlIdentifier(databaseName)}.${escapeMySqlIdentifier(tableName)}`;
    const samplesResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM ${qualifiedName} LIMIT ${MAX_SAMPLE_ROWS};`,
      { databaseName },
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
  userId?: string,
) {
  if (!databaseName) {
    throw new Error("'database' is required");
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("'query' must be a non-empty string");
  }

  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const dialect = getDialect(database.type);

  // Enforce access controls
  if (userId) {
    const accessResult = checkQueryAccess(database, userId, query);
    if (!accessResult.allowed) {
      throw new Error(accessResult.error);
    }
  }
  const safeQuery = appendLimitIfMissing(query);

  let options: Record<string, string> = {};
  if (dialect === "postgresql" || dialect === "mysql") {
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
  userId?: string,
) => {
  return {
    ...clientConsoleTools,

    sql_list_connections: {
      description:
        "List all SQL database connections (PostgreSQL, MySQL, BigQuery, SQLite, Cloudflare D1) in this workspace. Returns connection ID, name, type, sqlDialect, and access level. Connections marked [read-only] only allow SELECT queries.",
      inputSchema: emptySchema,
      execute: async () => listSqlConnectionsImpl(workspaceId, userId),
    },

    sql_list_databases: {
      description:
        "List databases (PostgreSQL/MySQL), datasets (BigQuery), or database files (SQLite/D1) within a SQL connection. Returns array with 'name' and 'sqlDialect'. IMPORTANT for Cloudflare D1: returns 'id' (UUID) and 'name' (human-readable). Use the 'id' field (not 'name') for subsequent D1 tool calls.",
      inputSchema: connectionIdSchema,
      execute: async (params: { connectionId: string }) =>
        listDatabasesImpl(params.connectionId, workspaceId),
    },

    sql_list_tables: {
      description:
        "List tables and views in a database. For PostgreSQL with multiple schemas, returns schema-prefixed names (e.g., 'analytics.events'). Returns table names with type and sqlDialect. IMPORTANT for Cloudflare D1: use the UUID from sql_list_databases 'id' field as the database parameter.",
      inputSchema: connectionAndDbSchema,
      execute: async (params: { connectionId: string; database: string }) =>
        listTablesImpl(params.connectionId, params.database, workspaceId),
    },

    sql_inspect_table: {
      description:
        "Get table/view schema (columns, types, nullability) plus up to 25 sample rows. Returns sqlDialect to guide query syntax. For PostgreSQL, use 'schema.table' format if not in public schema. IMPORTANT for Cloudflare D1: use the UUID from sql_list_databases 'id' field as the database parameter.",
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
        "Execute a SQL query and return results. LIMIT 500 is automatically added to SELECT queries if missing. Use sqlDialect from previous tool calls to write correct syntax. If a connection has 'access: shared_read', only SELECT/WITH/EXPLAIN queries are allowed. IMPORTANT for Cloudflare D1: use the UUID from sql_list_databases 'id' field as the database parameter.",
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
          userId,
        ),
    },
  };
};
