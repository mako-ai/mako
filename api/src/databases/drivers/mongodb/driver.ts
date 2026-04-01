import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { loggers } from "../../../logging";

const logger = loggers.db("mongodb");

export class MongoDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "mongodb",
      displayName: "MongoDB",
      consoleLanguage: "mongodb",
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
            metadata: { databaseId: name, databaseName: name },
          }),
        );
    } catch (error) {
      logger.error("Error listing databases in cluster mode", { error });
      return [];
    }
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Expanding a Database Node (Cluster Mode)
    if (parent.kind === "database") {
      const dbName =
        parent.metadata?.databaseName || parent.metadata?.databaseId;
      return [
        {
          // Use unique IDs for groups to prevent tree state confusion in frontend
          id: `collections::${dbName}`,
          label: "Collections",
          kind: "group",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        },
        {
          id: `views::${dbName}`,
          label: "Views",
          kind: "group",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        },
      ];
    }

    // Determine which database to target
    const targetDbName =
      parent.metadata?.databaseName ||
      parent.metadata?.databaseId ||
      database.connection.database;

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
            metadata: { databaseId: targetDbName, databaseName: targetDbName },
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
            metadata: { databaseId: targetDbName, databaseName: targetDbName },
          }),
        );
    }
    return [];
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    const client = await databaseConnectionService.getConnection(database);
    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    // Determine which databases to scan
    let dbNames: string[] = [];
    if (database.connection.database) {
      dbNames = [database.connection.database];
    } else {
      // Cluster mode - list all databases
      const adminDb = client.db("admin");
      const result = await adminDb.admin().listDatabases();
      dbNames = (result.databases || [])
        .map((db: any) => db.name)
        .filter((name: string) => !["admin", "local", "config"].includes(name));
    }

    // Scan each database
    for (const dbName of dbNames) {
      schema[dbName] = {};
      const db = client.db(dbName);

      try {
        const collections = await db
          .listCollections({ type: { $ne: "view" } })
          .toArray();

        // For each collection, sample one document to get fields
        for (const col of collections) {
          const colName = col.name;
          schema[dbName][colName] = [];

          try {
            // Sample one document
            const doc = await db.collection(colName).findOne({});
            if (doc) {
              // Extract top-level keys
              const fields = Object.keys(doc).map(key => {
                let type: string = typeof doc[key];
                if (doc[key] === null) type = "null";
                else if (Array.isArray(doc[key])) type = "array";
                else if (doc[key] instanceof Date) type = "date";
                return { name: key, type };
              });
              schema[dbName][colName] = fields;
            } else {
              // Empty collection, at least add _id
              schema[dbName][colName] = [{ name: "_id", type: "ObjectId" }];
            }
          } catch (err) {
            // Ignore error for single collection
            logger.warn("Failed to sample collection", {
              dbName,
              colName,
              error: err,
            });
          }
        }
      } catch (err) {
        logger.warn("Failed to list collections", { dbName, error: err });
      }
    }

    return schema;
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: any,
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }
}
