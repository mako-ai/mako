/**
 * Shared Database Discovery Tools
 *
 * Implementation functions for database discovery that can be used by multiple agents.
 * These handle listing connections, databases, tables, and table inspection.
 */

import { z } from "zod";
import { DatabaseConnection } from "../../../database/workspace-schema";
import type { AgentToolExecutionContext } from "../../../agents/types";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { MYSQL_SYSTEM_DATABASES_SET } from "../../../databases/drivers/mysql/driver";
import {
  type SqlDialect,
  ALL_SQL_TYPES,
  ALL_SUPPORTED_TYPES,
  getDialect,
  getSqlDialectOrNull,
  ensureValidObjectId,
  escapePostgresIdentifier,
  escapeBigQueryIdentifier,
  escapeMySqlIdentifier,
  escapeSqliteIdentifier,
} from "./sql-dialects";
import {
  MAX_SAMPLE_ROWS,
  isAgentToolAbortError,
  registerAgentExecution,
  throwIfAborted,
  withAgentTimeout,
} from "./truncation";

// =============================================================================
// Zod Schemas (for tool definitions)
// =============================================================================

export const emptySchema = z.object({});

export const connectionIdSchema = z.object({
  connectionId: z.string().describe("The database connection ID"),
});

export const connectionAndDbSchema = z.object({
  connectionId: z.string().describe("The database connection ID"),
  database: z.string().describe("The database/dataset name"),
});

export const inspectTableSchema = z.object({
  connectionId: z.string().describe("The database connection ID"),
  database: z.string().describe("The database/dataset name"),
  table: z
    .string()
    .describe("The table name (may include schema prefix for Postgres)"),
});

// =============================================================================
// Helper: Fetch and validate database connection
// =============================================================================

interface FetchDatabaseOptions {
  /** If true, only allow SQL database types */
  sqlOnly?: boolean;
  /** If true, allow both SQL and MongoDB */
  includeNoSQL?: boolean;
}

async function fetchDatabase(
  connectionId: string,
  workspaceId: string,
  options: FetchDatabaseOptions = {},
) {
  const connectionObjectId = ensureValidObjectId(connectionId, "connectionId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await DatabaseConnection.findOne({
    _id: connectionObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database connection not found or access denied");
  }

  const allowedTypes = options.includeNoSQL
    ? ALL_SUPPORTED_TYPES
    : options.sqlOnly
      ? ALL_SQL_TYPES
      : ALL_SUPPORTED_TYPES;

  if (!allowedTypes.has(database.type)) {
    throw new Error(
      `Unsupported database type: ${database.type}. Expected: ${Array.from(allowedTypes).join(", ")}`,
    );
  }

  return database;
}

// =============================================================================
// List Connections Implementation
// =============================================================================

export interface ConnectionInfo {
  id: string;
  name: string;
  type: string;
  dialect: string | null;
  displayName: string;
}

/**
 * List all database connections in a workspace
 * @param workspaceId - The workspace ID
 * @param options - Filter options (sqlOnly, includeNoSQL)
 */
export async function listConnectionsImpl(
  workspaceId: string,
  options: { sqlOnly?: boolean; includeNoSQL?: boolean } = {},
): Promise<ConnectionInfo[]> {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const allowedTypes = options.includeNoSQL
    ? ALL_SUPPORTED_TYPES
    : options.sqlOnly
      ? ALL_SQL_TYPES
      : ALL_SUPPORTED_TYPES;

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(allowedTypes) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: Record<string, unknown> =
      (db as unknown as { connection: Record<string, unknown> }).connection ||
      {};
    const dialect = getSqlDialectOrNull(db.type);

    let displayInfo: string;
    if (db.type === "mongodb") {
      const databaseName = (connection.database as string) || "Unknown";
      displayInfo = databaseName;
    } else if (dialect === "postgresql" || dialect === "mysql") {
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
      dialect: dialect || db.type,
      displayName: `${db.name} (${dialect || db.type}: ${displayInfo})`,
    };
  });
}

// =============================================================================
// List Databases Implementation
// =============================================================================

export interface DatabaseInfo {
  id?: string; // UUID for D1, otherwise same as name
  name: string;
  sqlDialect: SqlDialect;
}

/**
 * List databases/datasets within a connection
 * For D1 in cluster mode, returns both id (UUID) and name (human-readable)
 */
export async function listDatabasesImpl(
  connectionId: string,
  workspaceId: string,
  toolExecutionContext?: AgentToolExecutionContext,
): Promise<DatabaseInfo[]> {
  const { executionId, signal, release } = registerAgentExecution(
    toolExecutionContext,
    "agent-discovery-list-databases",
  );

  try {
    throwIfAborted(signal);
    const database = await fetchDatabase(connectionId, workspaceId, {
      sqlOnly: true,
    });
    const dialect = getDialect(database.type);

    if (dialect === "postgresql") {
      const result = await databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;`,
        { executionId, signal },
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
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        "SHOW DATABASES",
        { executionId, signal },
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
      const datasets = await databaseConnectionService.listBigQueryDatasets(
        database as Parameters<
          typeof databaseConnectionService.listBigQueryDatasets
        >[0],
      );
      throwIfAborted(signal);
      return datasets.map(ds => ({
        name: ds,
        sqlDialect: dialect,
      }));
    }

    if (dialect === "clickhouse") {
      const result = await databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        "SHOW DATABASES",
        { executionId, signal },
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
        throwIfAborted(signal);
        return d1Databases.map(db => ({
          id: db.uuid, // UUID for API calls
          name: db.name, // Human-readable name for display
          sqlDialect: dialect,
        }));
      } catch (error) {
        if (isAgentToolAbortError(error)) {
          throw error;
        }
        // Fallback to "main" if listing fails (e.g., API error, credentials issue)
        return [{ name: "main", sqlDialect: dialect }];
      }
    }

    // Plain SQLite (not D1)
    if (databaseId) {
      return [{ name: databaseId, sqlDialect: dialect }];
    }
    return [{ name: "main", sqlDialect: dialect }];
  } finally {
    release();
  }
}

// =============================================================================
// List Tables Implementation
// =============================================================================

export interface TableInfo {
  name: string;
  type: "table" | "view";
  schema?: string;
  sqlDialect: SqlDialect;
}

/**
 * List tables in a database
 */
export async function listTablesImpl(
  connectionId: string,
  databaseName: string,
  workspaceId: string,
  toolExecutionContext?: AgentToolExecutionContext,
): Promise<TableInfo[]> {
  if (!databaseName) {
    throw new Error("'database' is required");
  }

  const { executionId, signal, release } = registerAgentExecution(
    toolExecutionContext,
    "agent-discovery-list-tables",
  );

  try {
    throwIfAborted(signal);
    const database = await fetchDatabase(connectionId, workspaceId, {
      sqlOnly: true,
    });
    const dialect = getDialect(database.type);

    if (dialect === "postgresql") {
      const result = await databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name;`,
        { databaseName, executionId, signal },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to list tables");
      }

      return (result.data || []).map(
        (row: {
          table_schema: string;
          table_name: string;
          table_type: string;
        }) => ({
          name:
            row.table_schema === "public"
              ? row.table_name
              : `${row.table_schema}.${row.table_name}`,
          type: (row.table_type === "VIEW" ? "view" : "table") as
            | "table"
            | "view",
          schema: row.table_schema,
          sqlDialect: dialect,
        }),
      );
    }

    if (dialect === "mysql") {
      const safeDb = databaseName.replace(/'/g, "''");
      const result = await databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        `SELECT table_name, table_type FROM information_schema.tables 
       WHERE table_schema = '${safeDb}' ORDER BY table_name;`,
        { databaseName, executionId, signal },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to list tables");
      }

      return (result.data || []).map(
        (row: {
          table_name?: string;
          TABLE_NAME?: string;
          table_type?: string;
          TABLE_TYPE?: string;
        }) => ({
          name: (row.table_name || row.TABLE_NAME) as string,
          type: ((row.table_type || row.TABLE_TYPE) === "VIEW"
            ? "view"
            : "table") as "table" | "view",
          sqlDialect: dialect,
        }),
      );
    }

    if (dialect === "bigquery") {
      const tables = await databaseConnectionService.listBigQueryTables(
        database as Parameters<
          typeof databaseConnectionService.listBigQueryTables
        >[0],
        databaseName,
      );
      throwIfAborted(signal);
      return tables.map(t => ({
        name: t.name,
        type: (t.type === "VIEW" ? "view" : "table") as "table" | "view",
        sqlDialect: dialect,
      }));
    }

    if (dialect === "sqlite") {
      // D1/SQLite: use databaseId for cluster mode
      const result = await databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        `SELECT name, type FROM sqlite_master 
       WHERE type IN ('table', 'view') 
       AND name NOT LIKE 'sqlite_%' 
       AND name NOT LIKE '_cf_%'
       ORDER BY type DESC, name ASC;`,
        { databaseId: databaseName, databaseName, executionId, signal },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to list tables");
      }

      return (result.data || []).map((row: { name: string; type: string }) => ({
        name: row.name,
        type: row.type as "table" | "view",
        sqlDialect: dialect,
      }));
    }

    if (dialect === "clickhouse") {
      const safeDb = databaseName.replace(/'/g, "''");
      const result = await databaseConnectionService.executeQuery(
        database as Parameters<
          typeof databaseConnectionService.executeQuery
        >[0],
        `SELECT name, engine FROM system.tables WHERE database = '${safeDb}' ORDER BY name`,
        { executionId, signal },
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to list tables");
      }

      return (result.data || []).map(
        (row: { name: string; engine: string }) => ({
          name: row.name,
          type:
            row.engine === "View" || row.engine === "MaterializedView"
              ? ("view" as const)
              : ("table" as const),
          sqlDialect: dialect,
        }),
      );
    }

    throw new Error(`Unsupported database type: ${database.type}`);
  } finally {
    release();
  }
}

// =============================================================================
// Inspect Table Implementation
// =============================================================================

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TableInspectionResult {
  columns: ColumnInfo[];
  samples: Record<string, unknown>[];
  sqlDialect: SqlDialect;
  connectionName: string;
  connectionType: string;
}

/**
 * Inspect a table's schema and sample data
 */
export async function inspectTableImpl(
  connectionId: string,
  databaseName: string,
  tableName: string,
  workspaceId: string,
  toolExecutionContext?: AgentToolExecutionContext,
): Promise<TableInspectionResult> {
  if (!tableName) {
    throw new Error("'table' is required");
  }
  if (!databaseName) {
    throw new Error("'database' is required");
  }

  const database = await fetchDatabase(connectionId, workspaceId, {
    sqlOnly: true,
  });
  const dialect = getDialect(database.type);
  const { executionId, signal, release } = registerAgentExecution(
    toolExecutionContext,
    "agent-discovery-inspect",
  );

  try {
    return await withAgentTimeout(
      executionId,
      async registeredExecutionId => {
        let columns: ColumnInfo[] = [];
        let samples: Record<string, unknown>[] = [];

        if (dialect === "postgresql") {
          let schemaName: string;
          let tblName: string;
          if (tableName.includes(".")) {
            const dotIndex = tableName.indexOf(".");
            schemaName = tableName.slice(0, dotIndex);
            tblName = tableName.slice(dotIndex + 1);
          } else {
            schemaName = "public";
            tblName = tableName;
          }

          const safeSchema = schemaName.replace(/'/g, "''");
          const safeTable = tblName.replace(/'/g, "''");

          const colResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = '${safeSchema}' AND table_name = '${safeTable}'
             ORDER BY ordinal_position;`,
            {
              databaseName,
              executionId: registeredExecutionId,
              signal,
            },
          );

          if (colResult.success && colResult.data) {
            columns = colResult.data.map(
              (row: {
                column_name: string;
                data_type: string;
                is_nullable: string;
              }) => ({
                name: row.column_name,
                type: row.data_type,
                nullable: row.is_nullable === "YES",
              }),
            );
          }

          const quotedSchema = escapePostgresIdentifier(schemaName);
          const quotedTable = escapePostgresIdentifier(tblName);
          const sampleResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT * FROM ${quotedSchema}.${quotedTable} LIMIT ${MAX_SAMPLE_ROWS};`,
            {
              databaseName,
              executionId: registeredExecutionId,
              signal,
            },
          );

          if (sampleResult.success && sampleResult.data) {
            samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
          }
        } else if (dialect === "mysql") {
          const safeDb = databaseName.replace(/'/g, "''");
          const safeTable = tableName.replace(/'/g, "''");

          const colResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = '${safeDb}' AND table_name = '${safeTable}'
             ORDER BY ordinal_position;`,
            {
              databaseName,
              executionId: registeredExecutionId,
              signal,
            },
          );

          if (colResult.success && colResult.data) {
            columns = colResult.data.map(
              (row: {
                column_name?: string;
                COLUMN_NAME?: string;
                data_type?: string;
                DATA_TYPE?: string;
                is_nullable?: string;
                IS_NULLABLE?: string;
              }) => ({
                name: (row.column_name || row.COLUMN_NAME) as string,
                type: (row.data_type || row.DATA_TYPE) as string,
                nullable: (row.is_nullable || row.IS_NULLABLE) === "YES",
              }),
            );
          }

          const quotedTable = escapeMySqlIdentifier(tableName);
          const sampleResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT * FROM ${quotedTable} LIMIT ${MAX_SAMPLE_ROWS};`,
            {
              databaseName,
              executionId: registeredExecutionId,
              signal,
            },
          );

          if (sampleResult.success && sampleResult.data) {
            samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
          }
        } else if (dialect === "bigquery") {
          const safeDataset = databaseName.replace(/'/g, "''");
          const safeTable = tableName.replace(/'/g, "''");

          const colResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT column_name, data_type, is_nullable
             FROM \`${safeDataset}\`.INFORMATION_SCHEMA.COLUMNS
             WHERE table_name = '${safeTable}'
             ORDER BY ordinal_position;`,
            { executionId: registeredExecutionId, signal },
          );

          if (colResult.success && colResult.data) {
            columns = colResult.data.map(
              (row: {
                column_name: string;
                data_type: string;
                is_nullable: string;
              }) => ({
                name: row.column_name,
                type: row.data_type,
                nullable: row.is_nullable === "YES",
              }),
            );
          }

          const quotedDataset = escapeBigQueryIdentifier(databaseName);
          const quotedTable = escapeBigQueryIdentifier(tableName);
          const sampleResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT * FROM ${quotedDataset}.${quotedTable} LIMIT ${MAX_SAMPLE_ROWS};`,
            { executionId: registeredExecutionId, signal },
          );

          if (sampleResult.success && sampleResult.data) {
            samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
          }
        } else if (dialect === "sqlite") {
          const safeTable = tableName.replace(/"/g, '""');

          const colResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `PRAGMA table_info("${safeTable}");`,
            {
              databaseId: databaseName,
              databaseName,
              executionId: registeredExecutionId,
              signal,
            },
          );

          if (colResult.success && colResult.data) {
            columns = colResult.data.map(
              (row: { name: string; type: string; notnull: number }) => ({
                name: row.name,
                type: row.type || "TEXT",
                nullable: row.notnull === 0,
              }),
            );
          }

          const quotedTable = escapeSqliteIdentifier(tableName);
          const sampleResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT * FROM ${quotedTable} LIMIT ${MAX_SAMPLE_ROWS};`,
            {
              databaseId: databaseName,
              databaseName,
              executionId: registeredExecutionId,
              signal,
            },
          );

          if (sampleResult.success && sampleResult.data) {
            samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
          }
        } else if (dialect === "clickhouse") {
          const safeDb = databaseName.replace(/'/g, "''");
          const safeTable = tableName.replace(/'/g, "''");

          const colResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT name, type FROM system.columns WHERE database = '${safeDb}' AND table = '${safeTable}' ORDER BY position`,
            { executionId: registeredExecutionId, signal },
          );

          if (colResult.success && colResult.data) {
            columns = colResult.data.map(
              (row: { name: string; type: string }) => ({
                name: row.name,
                type: row.type,
              }),
            );
          }

          const escapedDbName = databaseName.replace(/"/g, '""');
          const escapedTblName = tableName.replace(/"/g, '""');
          const sampleResult = await databaseConnectionService.executeQuery(
            database as Parameters<
              typeof databaseConnectionService.executeQuery
            >[0],
            `SELECT * FROM "${escapedDbName}"."${escapedTblName}" LIMIT ${MAX_SAMPLE_ROWS}`,
            { executionId: registeredExecutionId, signal },
          );

          if (sampleResult.success && sampleResult.data) {
            samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
          }
        }

        throwIfAborted(signal);
        return {
          columns,
          samples,
          sqlDialect: dialect,
          connectionName: database.name,
          connectionType: database.type,
        };
      },
      { signal },
    );
  } finally {
    release();
  }
}

// =============================================================================
// Re-export types and schemas for convenience
// =============================================================================

export { type SqlDialect } from "./sql-dialects";
