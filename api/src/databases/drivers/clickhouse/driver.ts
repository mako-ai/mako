import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { executeCheckedQuery } from "../../checked-query";
import { CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS } from "./config";

/**
 * Schema-tree and autocomplete reads hold the browser's request open: wait at
 * most 60 s for a sleeping ClickHouse Cloud service, not the 10-min default.
 */
const INTERACTIVE = {
  maxWakeTimeoutMs: CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS,
};
import type { QueryExecuteOptions, QueryResult } from "../../query-types";
import { clickHouseEngine } from "./engine";

export class ClickHouseDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "clickhouse",
      displayName: "ClickHouse",
      consoleLanguage: "sql",
    };
  }

  /**
   * Cheap metadata-based row counts from `system.tables.total_rows`
   * (approximate for MergeTree, null for views — coalesced to 0).
   */
  buildRowCountBatchQuery(schema: string, tableNames: string[]): string | null {
    if (tableNames.length === 0) return null;
    const escape = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const inList = tableNames.map(escape).join(",");
    return `SELECT name AS table_id, coalesce(total_rows, 0) AS row_count FROM system.tables WHERE database = ${escape(schema)} AND name IN (${inList})`;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    // List all databases in the ClickHouse server
    const result = await executeCheckedQuery(
      database,
      "SHOW DATABASES",
      INTERACTIVE,
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

    const databases: DatabaseTreeNode[] = result.data
      .map((row: { name?: string }) => row.name)
      .filter((name: string | undefined): name is string => {
        return !!name && !systemDatabases.has(name);
      })
      .map((dbName: string) => ({
        id: dbName,
        label: dbName,
        kind: "database" as const,
        hasChildren: true,
        metadata: { databaseName: dbName },
      }));

    return databases;
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind === "database") {
      // List tables in the database
      const dbName = parent.metadata?.databaseName || parent.id;
      const result = await executeCheckedQuery(
        database,
        `SELECT name, engine 
         FROM system.tables 
         WHERE database = '${dbName.replace(/'/g, "''")}'
         ORDER BY name`,
        INTERACTIVE,
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

      const result = await executeCheckedQuery(
        database,
        `SELECT name, type 
         FROM system.columns 
         WHERE database = '${databaseName.replace(/'/g, "''")}' 
           AND table = '${tableName.replace(/'/g, "''")}'
         ORDER BY position`,
        INTERACTIVE,
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
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    return executeCheckedQuery(database, query, options);
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    // Get all columns from all tables across all databases
    const result = await executeCheckedQuery(
      database,
      `SELECT database, table, name, type 
       FROM system.columns 
       WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
       ORDER BY database, table, position`,
      INTERACTIVE,
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
    return clickHouseEngine.cancelQuery(executionId);
  }
}
