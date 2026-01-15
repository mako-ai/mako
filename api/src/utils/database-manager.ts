import { CreateCollectionOptions } from "mongodb";
import { mongoConnection } from "./mongodb-connection";
import { loggers } from "../logging";

const logger = loggers.db();

export class DatabaseManager {
  async listCollections(databaseId: string): Promise<any[]> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      const collections = await db
        .listCollections({ type: "collection" })
        .toArray();

      return collections.map((col: any) => ({
        name: col.name,
        type: col.type,
        options: col.options,
        info: col.info,
      }));
    } catch (error) {
      logger.error("Error listing collections", { error });
      throw new Error(
        `Failed to list collections: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async listViews(databaseId: string): Promise<any[]> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      const views = await db.listCollections({ type: "view" }).toArray();

      return views.map((view: any) => ({
        name: view.name,
        type: view.type,
        options: view.options,
        info: view.info,
      }));
    } catch (error) {
      logger.error("Error listing views", { error });
      throw new Error(
        `Failed to list views: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async createCollection(
    databaseId: string,
    name: string,
    options?: CreateCollectionOptions,
  ): Promise<any> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      // Check if collection already exists
      const existingCollections = await db.listCollections({ name }).toArray();
      if (existingCollections.length > 0) {
        throw new Error(`Collection '${name}' already exists`);
      }

      const collection = await db.createCollection(name, options);

      return {
        name: collection.collectionName,
        namespace: collection.namespace,
        created: true,
      };
    } catch (error) {
      logger.error("Error creating collection", { name, error });
      throw new Error(
        `Failed to create collection '${name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async createView(
    databaseId: string,
    name: string,
    viewOn: string,
    pipeline: any[],
    options?: any,
  ): Promise<any> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      // Check if view already exists
      const existingViews = await db.listCollections({ name }).toArray();
      if (existingViews.length > 0) {
        throw new Error(`View '${name}' already exists`);
      }

      // Check if source collection exists
      const sourceCollections = await db
        .listCollections({ name: viewOn })
        .toArray();
      if (sourceCollections.length === 0) {
        throw new Error(`Source collection '${viewOn}' does not exist`);
      }

      await db.createCollection(name, {
        viewOn,
        pipeline,
        ...options,
      });

      return {
        name,
        viewOn,
        pipeline,
        created: true,
      };
    } catch (error) {
      logger.error("Error creating view", { name, viewOn, error });
      throw new Error(
        `Failed to create view '${name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async deleteCollection(databaseId: string, name: string): Promise<any> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      // Check if collection exists
      const existingCollections = await db.listCollections({ name }).toArray();
      if (existingCollections.length === 0) {
        throw new Error(`Collection '${name}' does not exist`);
      }

      const result = await db.dropCollection(name);

      return {
        name,
        deleted: result,
      };
    } catch (error) {
      logger.error("Error deleting collection", { name, error });
      throw new Error(
        `Failed to delete collection '${name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async deleteView(databaseId: string, name: string): Promise<any> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      // Check if view exists
      const existingViews = await db
        .listCollections({ name, type: "view" })
        .toArray();
      if (existingViews.length === 0) {
        throw new Error(`View '${name}' does not exist`);
      }

      const result = await db.dropCollection(name);

      return {
        name,
        deleted: result,
      };
    } catch (error) {
      logger.error("Error deleting view", { name, error });
      throw new Error(
        `Failed to delete view '${name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async getCollectionInfo(databaseId: string, name: string): Promise<any> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      // Check if collection exists
      const collections = await db.listCollections({ name }).toArray();
      if (collections.length === 0) {
        throw new Error(`Collection '${name}' does not exist`);
      }

      const collection = db.collection(name);

      // Get collection stats
      const stats = await db.command({ collStats: name });

      // Get indexes
      const indexes = await collection.indexes();

      // Get sample documents (first 5)
      const sampleDocs = await collection.find({}).limit(5).toArray();

      return {
        name,
        type: collections[0].type,
        options: (collections[0] as any).options,
        stats: {
          count: stats.count,
          size: stats.size,
          avgObjSize: stats.avgObjSize,
          storageSize: stats.storageSize,
          indexes: stats.nindexes,
          totalIndexSize: stats.totalIndexSize,
        },
        indexes,
        sampleDocuments: sampleDocs,
      };
    } catch (error) {
      logger.error("Error getting collection info", { name, error });
      throw new Error(
        `Failed to get collection info for '${name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async getViewInfo(databaseId: string, name: string): Promise<any> {
    try {
      const db = await mongoConnection.getDatabase(databaseId);

      // Check if view exists
      const views = await db.listCollections({ name, type: "view" }).toArray();
      if (views.length === 0) {
        throw new Error(`View '${name}' does not exist`);
      }

      const viewInfo = views[0];
      const collection = db.collection(name);

      // Get view stats
      const stats = await db.command({ collStats: name });

      // Get sample documents (first 5)
      const sampleDocs = await collection.find({}).limit(5).toArray();

      return {
        name,
        type: viewInfo.type,
        options: (viewInfo as any).options,
        viewOn: (viewInfo as any).options?.viewOn,
        pipeline: (viewInfo as any).options?.pipeline,
        stats: {
          count: stats.count,
          size: stats.size,
          avgObjSize: stats.avgObjSize,
        },
        sampleDocuments: sampleDocs,
      };
    } catch (error) {
      logger.error("Error getting view info", { name, error });
      throw new Error(
        `Failed to get view info for '${name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
