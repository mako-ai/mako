import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";

export class PostgreSQLDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "postgresql",
      displayName: "PostgreSQL",
      consoleLanguage: "sql",
    } as any;
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

    // Cluster Mode: List all databases
    try {
      const result = await this.executeQuery(
        database,
        `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;`,
      );
      if (!result.success) return [];

      const rows: Array<{ datname: string }> = result.data || [];
      return rows.map<DatabaseTreeNode>(r => ({
        id: r.datname,
        label: r.datname,
        kind: "database",
        hasChildren: true,
        metadata: { databaseId: r.datname, databaseName: r.datname },
      }));
    } catch (error) {
      console.error("Error listing databases in cluster mode:", error);
      return [];
    }
  }

  private async listSchemas(
    database: IDatabaseConnection,
    dbName?: string,
  ): Promise<DatabaseTreeNode[]> {
    const result = await this.executeQuery(
      database,
      `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name;`,
      { databaseName: dbName },
    );
    if (!result.success) return [];

    const systemSchemas: Record<string, true> = {
      information_schema: true,
      pg_catalog: true,
      pg_toast: true,
      pg_temp_1: true,
      pg_toast_temp_1: true,
    };

    const rows: Array<{ schema_name: string }> = result.data || [];
    return rows
      .map(r => r.schema_name)
      .filter(s => !systemSchemas[s])
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(schema => ({
        id: dbName ? `${dbName}.${schema}` : schema,
        label: schema,
        kind: "schema",
        hasChildren: true,
        metadata: { schema, databaseId: dbName, databaseName: dbName },
      }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Expanding a Database Node (Cluster Mode)
    if (parent.kind === "database") {
      const dbName =
        parent.metadata?.databaseName || parent.metadata?.databaseId;
      return this.listSchemas(database, dbName);
    }

    if (parent.kind !== "schema") return [];

    const schema = parent.metadata?.schema || parent.id;
    const dbName = parent.metadata?.databaseName || parent.metadata?.databaseId;
    const safeSchema = String(schema).replace(/'/g, "''");

    const result = await this.executeQuery(
      database,
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '${safeSchema}' ORDER BY table_name;`,
      { databaseName: dbName },
    );

    if (!result.success) return [];
    const rows: Array<{ table_name: string; table_type: string }> =
      result.data || [];
    return rows.map<DatabaseTreeNode>(r => ({
      id: `${dbName ? dbName + "." : ""}${schema}.${r.table_name}`,
      label: r.table_name,
      kind: r.table_type === "VIEW" ? "view" : "table",
      hasChildren: false,
      metadata: {
        schema,
        table: r.table_name,
        databaseId: dbName,
        databaseName: dbName,
      },
    }));
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string; databaseId?: string },
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }
}
