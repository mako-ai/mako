/**
 * Amazon Redshift driver.
 *
 * Redshift is PostgreSQL wire-protocol compatible but uses pg_catalog for
 * schema listing (information_schema.schemata can be empty in Redshift).
 * Tree browsing and query execution otherwise match PostgreSQL.
 *
 * Write methods (insertBatch, upsertBatch, createTable, etc.) are intentionally
 * NOT delegated. Redshift is a read-optimised data warehouse; using it as a
 * sync destination via row-level writes would be extremely slow. If write
 * support is needed in the future, consider Redshift's COPY command instead.
 */

import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { PostgreSQLDatabaseDriver } from "../postgresql/driver";

// Shared instance — PostgreSQLDatabaseDriver is stateless (no instance-level
// config or logging context), so a module-level singleton is safe here.
const postgresDriver = new PostgreSQLDatabaseDriver();

export class RedshiftDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "redshift",
      displayName: "Amazon Redshift",
      consoleLanguage: "sql",
    } as any;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    return postgresDriver.getTreeRoot(database);
  }

  /**
   * List schemas via pg_catalog.pg_namespace (reliable in Redshift).
   * Tables delegate to the PostgreSQL driver (information_schema.tables works).
   */
  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Schema expansion: list tables (same as PostgreSQL)
    if (parent.kind === "schema") {
      return postgresDriver.getChildren(database, parent);
    }
    if (parent.kind !== "database") return [];

    // Resolve database name from node metadata or connection default
    const dbName =
      parent.metadata?.databaseName ??
      parent.metadata?.databaseId ??
      parent.id ??
      database.connection?.database;
    const opts = dbName ? { databaseName: dbName } : undefined;

    // pg_namespace lists all schemas; filter out system ones in SQL
    const result = await databaseConnectionService.executeQuery(
      database,
      `SELECT nspname AS schema_name
       FROM pg_catalog.pg_namespace
       WHERE nspname NOT LIKE 'pg_%'
         AND nspname != 'information_schema'
       ORDER BY nspname;`,
      opts,
    );

    if (!result.success || !Array.isArray(result.data)) return [];

    return result.data
      .map(r => r.schema_name as string)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(schema => ({
        id: dbName ? `${dbName}.${schema}` : schema,
        label: schema,
        kind: "schema",
        hasChildren: true,
        metadata: { schema, databaseId: dbName, databaseName: dbName },
      }));
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    return postgresDriver.getAutocompleteData(database);
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string; databaseId?: string },
  ) {
    return postgresDriver.executeQuery(database, query, options);
  }
}
