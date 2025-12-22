import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";

export class ClickHouseDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "clickhouse",
      displayName: "ClickHouse",
      consoleLanguage: "sql",
    };
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    // List all databases in the ClickHouse server
    const result = await databaseConnectionService.executeQuery(
      database,
      "SHOW DATABASES",
    );

    if (!result.success || !result.data) {
      return [];
    }

    // Filter out system databases
    const systemDatabases = new Set([
      "system",
      "information_schema",
      "INFORMATION_SCHEMA",
    ]);

    return result.data
      .map((row: { name?: string }) => row.name)
      .filter((name: string | undefined): name is string => {
        return !!name && !systemDatabases.has(name);
      })
      .map<DatabaseTreeNode>((dbName: string) => ({
        id: dbName,
        label: dbName,
        kind: "database",
        hasChildren: true,
        metadata: { databaseName: dbName },
      }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind === "database") {
      // List tables in the database
      const dbName = parent.metadata?.databaseName || parent.id;
      const result = await databaseConnectionService.executeQuery(
        database,
        `SELECT name, engine 
         FROM system.tables 
         WHERE database = '${dbName.replace(/'/g, "''")}'
         ORDER BY name`,
      );

      if (!result.success || !result.data) {
        return [];
      }

      return result.data.map(
        (row: { name: string; engine: string }): DatabaseTreeNode => ({
          id: `${dbName}.${row.name}`,
          label: row.name,
          kind:
            row.engine === "View" || row.engine === "MaterializedView"
              ? "view"
              : "table",
          hasChildren: true,
          metadata: { databaseName: dbName, tableName: row.name },
        }),
      );
    }

    if (parent.kind === "table" || parent.kind === "view") {
      // List columns in the table
      const { databaseName, tableName } = parent.metadata || {};
      if (!databaseName || !tableName) return [];

      const result = await databaseConnectionService.executeQuery(
        database,
        `SELECT name, type 
         FROM system.columns 
         WHERE database = '${databaseName.replace(/'/g, "''")}' 
           AND table = '${tableName.replace(/'/g, "''")}'
         ORDER BY position`,
      );

      if (!result.success || !result.data) {
        return [];
      }

      return result.data.map(
        (row: { name: string; type: string }): DatabaseTreeNode => ({
          id: `${databaseName}.${tableName}.${row.name}`,
          label: `${row.name}: ${row.type}`,
          kind: "column",
          hasChildren: false,
          metadata: {
            databaseName,
            tableName,
            columnName: row.name,
            columnType: row.type,
          },
        }),
      );
    }

    return [];
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: any,
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    // Get all columns from all tables across all databases
    const result = await databaseConnectionService.executeQuery(
      database,
      `SELECT database, table, name, type 
       FROM system.columns 
       WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
       ORDER BY database, table, position`,
    );

    if (!result.success || !result.data) {
      return {};
    }

    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    for (const row of result.data) {
      const {
        database: dbName,
        table,
        name,
        type,
      } = row as {
        database: string;
        table: string;
        name: string;
        type: string;
      };

      if (!schema[dbName]) {
        schema[dbName] = {};
      }
      if (!schema[dbName][table]) {
        schema[dbName][table] = [];
      }

      schema[dbName][table].push({ name, type });
    }

    return schema;
  }

  async cancelQuery(
    executionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    return databaseConnectionService.cancelClickHouseQuery(executionId);
  }
}
