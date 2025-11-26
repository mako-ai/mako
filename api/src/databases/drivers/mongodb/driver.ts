import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";

export class MongoDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "mongodb",
      displayName: "MongoDB",
      consoleLanguage: "mongodb",
    } as any;
  }

  async getTreeRoot(database: IDatabaseConnection): Promise<DatabaseTreeNode[]> {
    // Single Database Mode
    if (database.connection.database) {
      const dbName = database.connection.database;
      return [
        {
          id: dbName,
          label: dbName,
          kind: "database",
          hasChildren: true,
          metadata: { databaseName: dbName },
        },
      ];
    }

    // Cluster Mode: List all databases
    try {
      const client = await databaseConnectionService.getConnection(database);
      const adminDb = client.db("admin");
      const result = await adminDb.admin().listDatabases();

      return (result.databases || [])
        .map((db: any) => db.name)
        .sort((a: string, b: string) => a.localeCompare(b))
        .map(
          (name: string): DatabaseTreeNode => ({
            id: name,
            label: name,
            kind: "database",
            hasChildren: true,
            metadata: { databaseName: name },
          }),
        );
    } catch (error) {
      console.error("Error listing databases in cluster mode:", error);
      return [];
    }
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Expanding a Database Node (Cluster Mode)
    if (parent.kind === "database") {
      const dbName = parent.metadata?.databaseName;
      return [
        {
          // Use unique IDs for groups to prevent tree state confusion in frontend
          id: `collections::${dbName}`,
          label: "Collections",
          kind: "group",
          hasChildren: true,
          metadata: { databaseName: dbName },
        },
        {
          id: `views::${dbName}`,
          label: "Views",
          kind: "group",
          hasChildren: true,
          metadata: { databaseName: dbName },
        },
      ];
    }

    // Determine which database to target
    const targetDbName =
      parent.metadata?.databaseName || database.connection.database;

    if (!targetDbName && !database.connection.database) {
      // Should not happen if properly navigated, but safety check
      return [];
    }

    const isCollections =
      parent.id === "collections" || parent.id.startsWith("collections::");
    const isViews = parent.id === "views" || parent.id.startsWith("views::");

    if (isCollections) {
      const client = await databaseConnectionService.getConnection(database);
      const db = client.db(targetDbName);
      const collections = await db
        .listCollections({ type: { $ne: "view" } })
        .toArray();
      return collections
        .map((c: any) => c.name)
        .sort((a: string, b: string) => a.localeCompare(b))
        .map(
          (name: string): DatabaseTreeNode => ({
            id: name,
            label: name,
            kind: "collection",
            hasChildren: false,
            metadata: { databaseName: targetDbName },
          }),
        );
    }

    if (isViews) {
      const client = await databaseConnectionService.getConnection(database);
      const db = client.db(targetDbName);
      const views = await db.listCollections({ type: "view" }).toArray();
      return views
        .map((v: any) => v.name)
        .sort((a: string, b: string) => a.localeCompare(b))
        .map(
          (name: string): DatabaseTreeNode => ({
            id: name,
            label: name,
            kind: "view",
            hasChildren: false,
            metadata: { databaseName: targetDbName },
          }),
        );
    }
    return [];
  }

  async executeQuery(database: IDatabaseConnection, query: string, options?: any) {
    return databaseConnectionService.executeQuery(database, query, options);
  }
}
