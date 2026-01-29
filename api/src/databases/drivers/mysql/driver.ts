import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { loggers } from "../../../logging";

const logger = loggers.db("mysql");

/**
 * MySQL system databases that should be excluded from user-facing lists.
 * Exported for reuse in sql-tools and other MySQL-related code.
 */
export const MYSQL_SYSTEM_DATABASES = [
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
] as const;

export const MYSQL_SYSTEM_DATABASES_SET = new Set<string>(
  MYSQL_SYSTEM_DATABASES,
);

export class MySQLDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "mysql",
      displayName: "MySQL",
      consoleLanguage: "sql",
    };
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    // Single Database Mode
    if (database.connection.database) {
      const dbName = database.connection.database;
      return [
        {
          id: dbName,
          label: dbName,
          kind: "database",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        },
      ];
    }

    // Cluster Mode: list databases
    try {
      const result = await this.executeQuery(database, "SHOW DATABASES");
      if (!result.success || !result.data) return [];

      return (result.data as Array<Record<string, string>>)
        .map(row => row.Database || row.database || row.name)
        .filter(
          (name): name is string =>
            !!name && !MYSQL_SYSTEM_DATABASES_SET.has(name),
        )
        .map<DatabaseTreeNode>(dbName => ({
          id: dbName,
          label: dbName,
          kind: "database",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        }));
    } catch (error) {
      logger.error("Error listing databases in cluster mode", { error });
      return [];
    }
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind === "database") {
      const dbName =
        parent.metadata?.databaseName ||
        parent.metadata?.databaseId ||
        parent.id;
      const safeDbName = String(dbName).replace(/'/g, "''");

      const result = await this.executeQuery(
        database,
        `SELECT table_name AS table_name, table_type AS table_type
         FROM information_schema.tables
         WHERE table_schema = '${safeDbName}'
         ORDER BY table_name;`,
        { databaseName: dbName },
      );

      if (!result.success || !result.data) return [];

      type TableRow = {
        table_name?: string;
        TABLE_NAME?: string;
        table_type?: string;
        TABLE_TYPE?: string;
      };

      type MappedTable = {
        tableName: string | undefined;
        tableType: string | undefined;
      };

      const tables = (result.data as TableRow[])
        .map(
          (row): MappedTable => ({
            tableName: row.table_name ?? row.TABLE_NAME,
            tableType: row.table_type ?? row.TABLE_TYPE,
          }),
        )
        .filter(
          (row): row is MappedTable & { tableName: string } => !!row.tableName,
        );

      return tables.map<DatabaseTreeNode>(({ tableName, tableType }) => ({
        id: `${dbName}.${tableName}`,
        label: tableName,
        kind: tableType === "VIEW" ? "view" : "table",
        hasChildren: true,
        metadata: { databaseName: dbName, tableName },
      }));
    }

    if (parent.kind === "table" || parent.kind === "view") {
      const { databaseName, tableName } = parent.metadata || {};
      if (!databaseName || !tableName) return [];

      const safeDbName = String(databaseName).replace(/'/g, "''");
      const safeTableName = String(tableName).replace(/'/g, "''");

      const result = await this.executeQuery(
        database,
        `SELECT column_name AS column_name, data_type AS data_type
         FROM information_schema.columns
         WHERE table_schema = '${safeDbName}'
           AND table_name = '${safeTableName}'
         ORDER BY ordinal_position;`,
        { databaseName },
      );

      if (!result.success || !result.data) return [];

      type ColumnRow = {
        column_name?: string;
        COLUMN_NAME?: string;
        data_type?: string;
        DATA_TYPE?: string;
      };

      type MappedColumn = {
        columnName: string | undefined;
        dataType: string | undefined;
      };

      const columns = (result.data as ColumnRow[])
        .map(
          (row): MappedColumn => ({
            columnName: row.column_name ?? row.COLUMN_NAME,
            dataType: row.data_type ?? row.DATA_TYPE,
          }),
        )
        .filter(
          (row): row is MappedColumn & { columnName: string } =>
            !!row.columnName,
        );

      return columns.map<DatabaseTreeNode>(({ columnName, dataType }) => ({
        id: `${databaseName}.${tableName}.${columnName}`,
        label: `${columnName}: ${dataType ?? ""}`.trim(),
        kind: "column",
        hasChildren: false,
        metadata: {
          databaseName,
          tableName,
          columnName,
          columnType: dataType,
        },
      }));
    }

    return [];
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    const excludedSchemas = MYSQL_SYSTEM_DATABASES.map(db => `'${db}'`).join(
      ", ",
    );
    const result = await this.executeQuery(
      database,
      `SELECT table_schema AS table_schema, table_name AS table_name, column_name AS column_name, data_type AS data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN (${excludedSchemas})
       ORDER BY table_schema, table_name, ordinal_position;`,
    );

    if (!result.success || !result.data) {
      return {};
    }

    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    for (const row of result.data as Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
    }>) {
      const { table_schema, table_name, column_name, data_type } = row;

      if (!table_schema || !table_name || !column_name) {
        continue;
      }

      if (!schema[table_schema]) {
        schema[table_schema] = {};
      }
      if (!schema[table_schema][table_name]) {
        schema[table_schema][table_name] = [];
      }

      schema[table_schema][table_name].push({
        name: column_name,
        type: data_type || "unknown",
      });
    }

    return schema;
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string; databaseId?: string },
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }
}
