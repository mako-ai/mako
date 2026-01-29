import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { loggers } from "../../../logging";

const logger = loggers.db("mysql");

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

      const systemDatabases = new Set([
        "information_schema",
        "mysql",
        "performance_schema",
        "sys",
      ]);

      return (result.data as Array<Record<string, string>>)
        .map(row => row.Database || row.database || row.name)
        .filter((name): name is string => !!name && !systemDatabases.has(name))
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

      return result.data
        .map(
          (row: {
            table_name?: string;
            TABLE_NAME?: string;
            table_type?: string;
            TABLE_TYPE?: string;
          }) => ({
            tableName: row.table_name ?? row.TABLE_NAME,
            tableType: row.table_type ?? row.TABLE_TYPE,
          }),
        )
        .filter(
          (row): row is { tableName: string; tableType?: string } =>
            !!row.tableName,
        )
        .map<DatabaseTreeNode>(({ tableName, tableType }) => ({
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

      return result.data
        .map(
          (row: {
            column_name?: string;
            COLUMN_NAME?: string;
            data_type?: string;
            DATA_TYPE?: string;
          }) => ({
            columnName: row.column_name ?? row.COLUMN_NAME,
            dataType: row.data_type ?? row.DATA_TYPE,
          }),
        )
        .filter(
          (row): row is { columnName: string; dataType?: string } =>
            !!row.columnName,
        )
        .map<DatabaseTreeNode>(({ columnName, dataType }) => ({
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
    const result = await this.executeQuery(
      database,
      `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
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

      if (!schema[table_schema]) {
        schema[table_schema] = {};
      }
      if (!schema[table_schema][table_name]) {
        schema[table_schema][table_name] = [];
      }

      schema[table_schema][table_name].push({
        name: column_name,
        type: data_type,
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
