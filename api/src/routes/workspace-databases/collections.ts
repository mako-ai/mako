/**
 * MongoDB collections and views of a connection: list, create, info, drop.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import type { IDatabaseConnection } from "../../database/workspace-schema";
import { connectionsRepo } from "../../repositories/connections";
import { databaseConnectionService } from "../../services/database-connection.service";
import { Types } from "mongoose";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";

import {
  logger,
  isWorkspaceMongoDbRouteError,
  getWorkspaceMongoDb,
} from "./shared";

export const mongoCollectionRoutes = createRouter();

// Get collections for MongoDB database
mongoCollectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/collections",
    tags: ["Databases"],
    summary: "GET /{id}/collections",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await connectionsRepo.findDatabaseConnectionById(
        databaseId,
        workspace._id.toString(),
      );

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      if (database.type === "mongodb") {
        const connection = await databaseConnectionService.getConnection(
          database as unknown as IDatabaseConnection,
        );
        const db = connection.db(database.connection.database);
        const collections = await db
          .listCollections({ type: "collection" })
          .toArray();

        return c.json({
          success: true,
          data: collections.map((col: any) => ({
            name: col.name,
            type: col.type,
            options: col.options,
          })),
        });
      }

      if (database.type === "bigquery") {
        try {
          const datasets = await databaseConnectionService.listBigQueryDatasets(
            database as unknown as IDatabaseConnection,
          );
          // Return dataset root nodes to match tree driver expectations
          const data = datasets.map(ds => ({
            name: `${ds}.__root__`,
            type: "DATASET",
            options: { datasetId: ds },
          }));
          return c.json({ success: true, data });
        } catch (e: any) {
          return c.json(
            {
              success: false,
              error: e?.message || "Failed to list BigQuery datasets",
            },
            500,
          );
        }
      }

      return c.json(
        { success: false, error: "Unsupported database type for collections" },
        400,
      );
    } catch (error) {
      logger.error("Error getting collections", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get collections",
        },
        500,
      );
    }
  },
);

// Get collection info for MongoDB
mongoCollectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/collections",
    tags: ["Databases"],
    summary: "POST /{id}/collections",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin", "member"]),
    ] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const body = await c.req.json();

      if (!body.name) {
        return c.json(
          { success: false, error: "Collection name is required" },
          400,
        );
      }

      const result = await getWorkspaceMongoDb(
        workspace._id,
        databaseId,
        "createCollection",
      );
      if (isWorkspaceMongoDbRouteError(result)) {
        return c.json(result.response, result.status);
      }

      const existingCollections = await result.db
        .listCollections({ name: body.name })
        .toArray();
      if (existingCollections.length > 0) {
        return c.json(
          {
            success: false,
            error: `Collection '${body.name}' already exists`,
          },
          409,
        );
      }

      const collection = await result.db.createCollection(
        body.name,
        body.options,
      );

      return c.json(
        {
          success: true,
          message: "Collection created successfully",
          data: {
            name: collection.collectionName,
            namespace: collection.namespace,
            created: true,
          },
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating collection", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to create collection",
        },
        500,
      );
    }
  },
);

mongoCollectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/collections/{name}",
    tags: ["Databases"],
    summary: "GET /{id}/collections/{name}",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const collectionName = c.req.param("name");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await connectionsRepo.findDatabaseConnectionById(
        databaseId,
        workspace._id.toString(),
      );

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      if (database.type !== "mongodb") {
        return c.json(
          {
            success: false,
            error: "This endpoint is only for MongoDB databases",
          },
          400,
        );
      }

      const connection = await databaseConnectionService.getConnection(
        database as unknown as IDatabaseConnection,
      );
      const db = connection.db(database.connection.database);

      // Check if collection exists
      const collections = await db
        .listCollections({ name: collectionName })
        .toArray();
      if (collections.length === 0) {
        return c.json(
          { success: false, error: `Collection '${collectionName}' not found` },
          404,
        );
      }

      const collection = db.collection(collectionName);

      // Get collection stats
      const stats = await db.command({ collStats: collectionName });

      // Get indexes
      const indexes = await collection.indexes();

      return c.json({
        success: true,
        data: {
          name: collectionName,
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
        },
      });
    } catch (error) {
      logger.error("Error getting collection info", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get collection info",
        },
        500,
      );
    }
  },
);

mongoCollectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/collections/{name}/info",
    tags: ["Databases"],
    summary: "GET /{id}/collections/{name}/info",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const collectionName = c.req.param("name");

      const result = await getWorkspaceMongoDb(workspace._id, databaseId);
      if (isWorkspaceMongoDbRouteError(result)) {
        return c.json(result.response, result.status);
      }

      const collections = await result.db
        .listCollections({ name: collectionName })
        .toArray();
      if (collections.length === 0) {
        return c.json(
          { success: false, error: `Collection '${collectionName}' not found` },
          404,
        );
      }

      const collection = result.db.collection(collectionName);
      const stats = await result.db.command({ collStats: collectionName });
      const indexes = await collection.indexes();
      const sampleDocuments = await collection.find({}).limit(5).toArray();

      return c.json({
        success: true,
        data: {
          name: collectionName,
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
          sampleDocuments,
        },
      });
    } catch (error) {
      logger.error("Error getting collection info", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get collection info",
        },
        500,
      );
    }
  },
);

mongoCollectionRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/collections/{name}",
    tags: ["Databases"],
    summary: "DELETE /{id}/collections/{name}",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin", "member"]),
    ] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const collectionName = c.req.param("name");

      const result = await getWorkspaceMongoDb(
        workspace._id,
        databaseId,
        "dropCollection",
      );
      if (isWorkspaceMongoDbRouteError(result)) {
        return c.json(result.response, result.status);
      }

      const existingCollections = await result.db
        .listCollections({ name: collectionName })
        .toArray();
      if (existingCollections.length === 0) {
        return c.json(
          { success: false, error: `Collection '${collectionName}' not found` },
          404,
        );
      }

      const deleted = await result.db.dropCollection(collectionName);

      return c.json({
        success: true,
        message: "Collection deleted successfully",
        data: {
          name: collectionName,
          deleted,
        },
      });
    } catch (error) {
      logger.error("Error deleting collection", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to delete collection",
        },
        500,
      );
    }
  },
);

// Get views for MongoDB database
mongoCollectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/views",
    tags: ["Databases"],
    summary: "GET /{id}/views",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await connectionsRepo.findDatabaseConnectionById(
        databaseId,
        workspace._id.toString(),
      );

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      if (database.type === "mongodb") {
        const connection = await databaseConnectionService.getConnection(
          database as unknown as IDatabaseConnection,
        );
        const db = connection.db(database.connection.database);
        const views = await db.listCollections({ type: "view" }).toArray();

        return c.json({
          success: true,
          data: views.map((view: any) => ({
            name: view.name,
            type: view.type,
            options: view.options,
          })),
        });
      }

      if (database.type === "bigquery") {
        // BigQuery does not have Mongo-style 'views' endpoint here; return empty for now
        return c.json({ success: true, data: [] });
      }

      return c.json(
        { success: false, error: "Unsupported database type for views" },
        400,
      );
    } catch (error) {
      logger.error("Error getting views", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get views",
        },
        500,
      );
    }
  },
);

mongoCollectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/views",
    tags: ["Databases"],
    summary: "POST /{id}/views",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin", "member"]),
    ] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const body = await c.req.json();

      if (!body.name || !body.viewOn || !body.pipeline) {
        return c.json(
          {
            success: false,
            error:
              "View name, viewOn (source collection), and pipeline are required",
          },
          400,
        );
      }

      if (!Array.isArray(body.pipeline)) {
        return c.json(
          { success: false, error: "View pipeline must be an array" },
          400,
        );
      }

      const result = await getWorkspaceMongoDb(
        workspace._id,
        databaseId,
        "createView",
      );
      if (isWorkspaceMongoDbRouteError(result)) {
        return c.json(result.response, result.status);
      }

      const existingViews = await result.db
        .listCollections({ name: body.name })
        .toArray();
      if (existingViews.length > 0) {
        return c.json(
          { success: false, error: `View '${body.name}' already exists` },
          409,
        );
      }

      const sourceCollections = await result.db
        .listCollections({ name: body.viewOn })
        .toArray();
      if (sourceCollections.length === 0) {
        return c.json(
          {
            success: false,
            error: `Source collection '${body.viewOn}' does not exist`,
          },
          404,
        );
      }

      await result.db.createCollection(body.name, {
        viewOn: body.viewOn,
        pipeline: body.pipeline,
        ...body.options,
      });

      return c.json(
        {
          success: true,
          message: "View created successfully",
          data: {
            name: body.name,
            viewOn: body.viewOn,
            pipeline: body.pipeline,
            created: true,
          },
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating view", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to create view",
        },
        500,
      );
    }
  },
);

mongoCollectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/views/{name}/info",
    tags: ["Databases"],
    summary: "GET /{id}/views/{name}/info",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const viewName = c.req.param("name");

      const result = await getWorkspaceMongoDb(workspace._id, databaseId);
      if (isWorkspaceMongoDbRouteError(result)) {
        return c.json(result.response, result.status);
      }

      const views = await result.db
        .listCollections({ name: viewName, type: "view" })
        .toArray();
      if (views.length === 0) {
        return c.json(
          { success: false, error: `View '${viewName}' not found` },
          404,
        );
      }

      const viewInfo = views[0];
      const collection = result.db.collection(viewName);
      const stats = await result.db.command({ collStats: viewName });
      const sampleDocuments = await collection.find({}).limit(5).toArray();

      return c.json({
        success: true,
        data: {
          name: viewName,
          type: viewInfo.type,
          options: (viewInfo as any).options,
          viewOn: (viewInfo as any).options?.viewOn,
          pipeline: (viewInfo as any).options?.pipeline,
          stats: {
            count: stats.count,
            size: stats.size,
            avgObjSize: stats.avgObjSize,
          },
          sampleDocuments,
        },
      });
    } catch (error) {
      logger.error("Error getting view info", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get view info",
        },
        500,
      );
    }
  },
);

mongoCollectionRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/views/{name}",
    tags: ["Databases"],
    summary: "DELETE /{id}/views/{name}",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin", "member"]),
    ] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        name: z.string().openapi({ param: { name: "name", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const viewName = c.req.param("name");

      const result = await getWorkspaceMongoDb(
        workspace._id,
        databaseId,
        "dropView",
      );
      if (isWorkspaceMongoDbRouteError(result)) {
        return c.json(result.response, result.status);
      }

      const existingViews = await result.db
        .listCollections({ name: viewName, type: "view" })
        .toArray();
      if (existingViews.length === 0) {
        return c.json(
          { success: false, error: `View '${viewName}' not found` },
          404,
        );
      }

      const deleted = await result.db.dropCollection(viewName);

      return c.json({
        success: true,
        message: "View deleted successfully",
        data: {
          name: viewName,
          deleted,
        },
      });
    } catch (error) {
      logger.error("Error deleting view", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to delete view",
        },
        500,
      );
    }
  },
);
