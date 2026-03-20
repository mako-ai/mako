import { Hono } from "hono";
import { authMiddleware } from "../auth/auth.middleware";
import {
  requireWorkspace,
  requireWorkspaceRole,
  AuthenticatedContext,
} from "../middleware/workspace.middleware";
import {
  DatabaseConnection,
  IDatabaseConnection,
  Flow,
} from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  queryExecutionService,
  QueryLanguage,
  QuerySource,
  QueryStatus,
} from "../services/query-execution.service";
import { Types } from "mongoose";
import { loggers } from "../logging";
import { checkPreviewQuerySafety } from "../services/query-pagination.service";
import { createStreamingExportResponse } from "../utils/query-export-stream";
import { createArrowIPCStreamResponse } from "../utils/arrow-serializer";

const logger = loggers.db();

function sanitizeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

type QueryDefinitionInput = {
  connectionId?: string;
  language?: "sql" | "javascript" | "mongodb";
  code?: string;
  databaseId?: string;
  databaseName?: string;
  mongoOptions?: {
    collection?: string;
    operation?:
      | "find"
      | "aggregate"
      | "insertMany"
      | "updateMany"
      | "deleteMany"
      | "findOne"
      | "updateOne"
      | "deleteOne";
  };
};

function resolveQueryDefinition(
  body: Record<string, any>,
): QueryDefinitionInput | null {
  if (body.queryDefinition && typeof body.queryDefinition === "object") {
    return body.queryDefinition as QueryDefinitionInput;
  }

  if (typeof body.query === "string") {
    return {
      connectionId:
        typeof body.connectionId === "string" ? body.connectionId : undefined,
      language:
        typeof body.language === "string"
          ? (body.language as QueryDefinitionInput["language"])
          : undefined,
      code: body.query,
      databaseId:
        typeof body.databaseId === "string" ? body.databaseId : undefined,
      databaseName:
        typeof body.databaseName === "string" ? body.databaseName : undefined,
      mongoOptions:
        body.mongoOptions && typeof body.mongoOptions === "object"
          ? body.mongoOptions
          : undefined,
    };
  }

  return null;
}

function buildExecutableQuery(
  queryDefinition: QueryDefinitionInput,
  databaseType: string,
) {
  const code = queryDefinition.code;
  if (typeof code !== "string" || !code.trim()) {
    return null;
  }

  if (
    databaseType === "mongodb" &&
    queryDefinition.language === "mongodb" &&
    queryDefinition.mongoOptions?.collection
  ) {
    return {
      collection: queryDefinition.mongoOptions.collection,
      operation: queryDefinition.mongoOptions.operation || "find",
      query: code,
    };
  }

  return code;
}

async function parseRequestBody(
  c: AuthenticatedContext,
): Promise<Record<string, any>> {
  const contentType = c.req.header("content-type") || "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return (await c.req.parseBody()) as Record<string, any>;
  }

  return await c.req.json();
}

/**
 * Determine query language from database type
 */
function getQueryLanguage(databaseType: string): QueryLanguage {
  if (databaseType === "mongodb") {
    return "mongodb";
  }
  if (databaseType === "cloudflare-kv") {
    return "javascript";
  }
  return "sql";
}

// Demo database configuration - returns config with connection string read at runtime
function getDemoDatabaseConfig() {
  return {
    name: "Chinook Music Store",
    type: "postgresql" as const,
    connection: {
      // Use environment variable for demo database URL (Neon PostgreSQL)
      connectionString: process.env.DEMO_DATABASE_URL || "",
    },
  };
}

export const workspaceDatabaseRoutes = new Hono();

// Helper function to mask passwords in connection strings
function maskPasswordInConnectionString(connectionString: string): string {
  if (!connectionString) return connectionString;

  // Generic pattern for database connection strings:
  // protocol://[username:password@]host[:port][/database][?options]
  // This handles mongodb://, mongodb+srv://, postgresql://, postgres://, mysql://, etc.
  return connectionString.replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^:]+:)([^@]+)(@)/g,
    "$1*****$3",
  );
}

// Create demo database for workspace (onboarding)
workspaceDatabaseRoutes.post(
  "/demo",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin", "member"]),
  async (c: AuthenticatedContext) => {
    try {
      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const workspace = c.get("workspace");

      // Check if workspace already has a demo database
      const existingDemo = await DatabaseConnection.findOne({
        workspaceId: workspace._id,
        isDemo: true,
      });

      if (existingDemo) {
        return c.json({
          success: true,
          data: {
            id: existingDemo._id,
            name: existingDemo.name,
            type: existingDemo.type,
            isDemo: true,
          },
          message: "Demo database already exists",
        });
      }

      // Create demo database connection
      const demoConfig = getDemoDatabaseConfig();
      const database = new DatabaseConnection({
        workspaceId: workspace._id,
        name: demoConfig.name,
        type: demoConfig.type,
        connection: demoConfig.connection,
        isDemo: true,
        createdBy: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await database.save();

      return c.json(
        {
          success: true,
          data: {
            id: database._id,
            name: database.name,
            type: database.type,
            isDemo: true,
            createdAt: database.createdAt,
          },
          message: "Demo database created successfully",
        },
        201,
      );
    } catch (error) {
      console.error("Error creating demo database:", error);
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to create demo database",
        },
        500,
      );
    }
  },
);

// Get all databases for workspace
workspaceDatabaseRoutes.get(
  "/",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");

      const databases = await DatabaseConnection.find({
        workspaceId: workspace._id,
      }).sort({ createdAt: -1 });

      // Transform to API response format without connection details for security
      const transformedDatabases = databases.map((db: IDatabaseConnection) => {
        // Create masked hostKey for grouping per database type
        let hostKey: string;
        let hostName: string;
        const conn: any = db.connection || {};
        if (db.type === "bigquery") {
          const projectId = conn.project_id || "unknown-project";
          hostKey = `bigquery://${projectId}`;
          hostName = `BigQuery (${projectId})`;
        } else if (conn.connectionString) {
          hostKey = maskPasswordInConnectionString(conn.connectionString);
          hostName =
            db.type === "mongodb" ? "MongoDB Atlas" : db.type.toUpperCase();
        } else {
          hostKey = conn.host || "unknown";
          hostName =
            db.type === "mongodb"
              ? `MongoDB (${conn.host || "localhost"})`
              : `${db.type.toUpperCase()} (${conn.host || "localhost"})`;
        }

        // Determine if this is a cluster/server connection without a specific database
        const isClusterMode = !conn.database;

        return {
          id: db._id.toString(),
          connectionId: db._id.toString(), // Explicit connection ID for clarity
          name: db.name,
          description: "",
          database: conn.database,
          databaseName: conn.database, // Alias for clarity
          type: db.type,
          active: true,
          lastConnectedAt: db.lastConnectedAt,
          isClusterMode, // true when connection can access multiple databases
          isDemo: db.isDemo || false, // true if this is a demo database
          // Helper fields for easier access (connection object removed for security)
          displayName: db.name || conn.database || "Unknown Database",
          hostKey,
          hostName,
        };
      });

      return c.json({
        success: true,
        data: transformedDatabases,
      });
    } catch (error) {
      logger.error("Error getting databases", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get databases",
        },
        500,
      );
    }
  },
);

// Get specific database
workspaceDatabaseRoutes.get(
  "/:id",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      const conn: any = database.connection || {};
      const isClusterMode = !conn.database;

      return c.json({
        success: true,
        data: {
          id: database._id,
          connectionId: database._id.toString(),
          name: database.name,
          type: database.type,
          connection: database.connection, // Will be decrypted by getter
          databaseName: conn.database,
          isClusterMode,
          createdAt: database.createdAt,
          updatedAt: database.updatedAt,
          lastConnectedAt: database.lastConnectedAt,
        },
      });
    } catch (error) {
      logger.error("Error getting database", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to get database",
        },
        500,
      );
    }
  },
);

// Test database connection (without saving)
// This allows testing a connection before creating the database
workspaceDatabaseRoutes.post(
  "/test-connection",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin", "member"]),
  async (c: AuthenticatedContext) => {
    try {
      const body = await c.req.json();

      // Validate required fields
      if (!body.type) {
        return c.json(
          { success: false, error: "Database type is required" },
          400,
        );
      }

      if (!body.connection) {
        return c.json(
          { success: false, error: "Connection configuration is required" },
          400,
        );
      }

      // Create a temporary database object for testing
      const tempDatabase = {
        _id: new Types.ObjectId(),
        type: body.type,
        connection: body.connection,
      } as IDatabaseConnection;

      const result =
        await databaseConnectionService.testConnection(tempDatabase);

      return c.json(result);
    } catch (error) {
      logger.error("Error testing database connection", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to test connection",
        },
        500,
      );
    }
  },
);

// Create new database
workspaceDatabaseRoutes.post(
  "/",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin", "member"]),
  async (c: AuthenticatedContext) => {
    try {
      const user = c.get("user");
      const workspace = c.get("workspace");
      const body = await c.req.json();

      // Validate required fields
      if (!body.name || !body.type) {
        return c.json(
          { success: false, error: "Name and type are required" },
          400,
        );
      }

      // Check workspace database limit
      const databaseCount = await DatabaseConnection.countDocuments({
        workspaceId: workspace._id,
      });
      if (databaseCount >= workspace.settings.maxDatabases) {
        return c.json(
          {
            success: false,
            error: `Workspace database limit reached (${workspace.settings.maxDatabases})`,
          },
          403,
        );
      }

      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      // Create database connection
      const database = new DatabaseConnection({
        workspaceId: workspace._id,
        name: body.name,
        type: body.type,
        connection: body.connection || {},
        createdBy: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Test connection before saving using RAW (unencrypted) connection from body
      const testResult = await databaseConnectionService.testConnection({
        _id: database._id,
        type: body.type,
        connection: body.connection || {},
      } as any);

      if (!testResult.success) {
        return c.json(
          {
            success: false,
            error: `Connection test failed: ${testResult.error}`,
          },
          400,
        );
      }

      await database.save();

      return c.json(
        {
          success: true,
          data: {
            id: database._id,
            name: database.name,
            type: database.type,
            createdAt: database.createdAt,
          },
          message: "Database created successfully",
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating database", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to create database",
        },
        500,
      );
    }
  },
);

// Update database
workspaceDatabaseRoutes.put(
  "/:id",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin", "member"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const body = await c.req.json();

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      // Update fields
      if (body.name) database.name = body.name;
      if (body.connection) {
        // Build candidate connection using decrypted previous + incoming patch
        const previous =
          (database.toObject({ getters: true }) as any).connection || {};
        const candidate = { ...previous, ...body.connection };

        // Test new connection using RAW candidate (unencrypted)
        const testResult = await databaseConnectionService.testConnection({
          _id: database._id,
          type: database.type,
          connection: candidate,
        } as any);

        if (!testResult.success) {
          return c.json(
            {
              success: false,
              error: `Connection test failed: ${testResult.error}`,
            },
            400,
          );
        }

        // Only assign after successful test (setter will encrypt)
        database.connection = candidate as any;
      }

      database.updatedAt = new Date();
      await database.save();

      return c.json({
        success: true,
        data: {
          id: database._id,
          name: database.name,
          type: database.type,
          updatedAt: database.updatedAt,
        },
        message: "Database updated successfully",
      });
    } catch (error) {
      logger.error("Error updating database", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update database",
        },
        500,
      );
    }
  },
);

// Delete database
workspaceDatabaseRoutes.delete(
  "/:id",
  authMiddleware,
  requireWorkspace,
  requireWorkspaceRole(["owner", "admin"]),
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      // Check for dependent flows
      const dependentFlow = await Flow.findOne({
        destinationDatabaseId: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (dependentFlow) {
        return c.json(
          {
            success: false,
            error:
              "Cannot delete database because it is used by one or more flows",
          },
          409,
        );
      }

      const result = await DatabaseConnection.deleteOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (result.deletedCount === 0) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      // Close any open connections
      await databaseConnectionService.closeConnection(databaseId);

      return c.json({
        success: true,
        message: "Database deleted successfully",
      });
    } catch (error) {
      logger.error("Error deleting database", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to delete database",
        },
        500,
      );
    }
  },
);

// Test database connection
workspaceDatabaseRoutes.post(
  "/:id/test",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      const result = await databaseConnectionService.testConnection(database);

      if (result.success) {
        // Update last connected timestamp
        database.lastConnectedAt = new Date();
        await database.save();
      }

      return c.json(result);
    } catch (error) {
      logger.error("Error testing database connection", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to test connection",
        },
        500,
      );
    }
  },
);

// Execute query on database
workspaceDatabaseRoutes.post(
  "/:id/execute",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const body = await c.req.json();

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      if (!body.query) {
        return c.json({ success: false, error: "Query is required" }, 400);
      }

      const result = await databaseConnectionService.executeQuery(
        database,
        body.query,
        body.options,
      );

      return c.json(result);
    } catch (error) {
      logger.error("Error executing query", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to execute query",
        },
        500,
      );
    }
  },
);

// Get collections for MongoDB database
workspaceDatabaseRoutes.get(
  "/:id/collections",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      if (database.type === "mongodb") {
        const connection =
          await databaseConnectionService.getConnection(database);
        const db = connection.db(database.connection.database);
        const collections = await db.listCollections().toArray();

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
          const datasets =
            await databaseConnectionService.listBigQueryDatasets(database);
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
workspaceDatabaseRoutes.get(
  "/:id/collections/:name",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");
      const collectionName = c.req.param("name");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

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

      const connection =
        await databaseConnectionService.getConnection(database);
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

// Get views for MongoDB database
workspaceDatabaseRoutes.get(
  "/:id/views",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const databaseId = c.req.param("id");

      if (!Types.ObjectId.isValid(databaseId)) {
        return c.json({ success: false, error: "Invalid database ID" }, 400);
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(databaseId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json({ success: false, error: "Database not found" }, 404);
      }

      if (database.type === "mongodb") {
        const connection =
          await databaseConnectionService.getConnection(database);
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

// ============================================================================
// Workspace-level execute endpoint (cleaner API)
// Mounted at /api/workspaces/:workspaceId/execute in index.ts
// ============================================================================
export const workspaceExecuteRoutes = new Hono();

// POST /api/workspaces/:workspaceId/execute - Execute query with explicit connection/database params
workspaceExecuteRoutes.post(
  "/",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    const startTime = Date.now();
    let database: IDatabaseConnection | null = null;
    let executionStatus: QueryStatus = "error";
    let rowCount: number | undefined;
    let errorType: string | undefined;

    try {
      const workspace = c.get("workspace");
      const user = c.get("user");
      const apiKey = c.get("apiKey");
      const body = await parseRequestBody(c);

      const queryDefinition = resolveQueryDefinition(body);
      const {
        connectionId,
        databaseId,
        databaseName,
        executionId,
        consoleId,
        source,
        mode,
        pageSize,
        cursor,
      } = body;
      const effectiveConnectionId =
        queryDefinition?.connectionId || connectionId;

      // Validate required fields
      if (!effectiveConnectionId) {
        return c.json(
          { success: false, error: "connectionId is required" },
          400,
        );
      }

      const effectiveQueryDefinition = queryDefinition || null;
      if (!effectiveQueryDefinition) {
        return c.json(
          { success: false, error: "query or queryDefinition is required" },
          400,
        );
      }

      if (!Types.ObjectId.isValid(effectiveConnectionId)) {
        return c.json(
          { success: false, error: "Invalid connectionId format" },
          400,
        );
      }

      // Find the database connection
      database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(effectiveConnectionId),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json(
          { success: false, error: "Database connection not found" },
          404,
        );
      }

      const executableQuery = buildExecutableQuery(
        effectiveQueryDefinition,
        database.type,
      );
      if (!executableQuery) {
        return c.json(
          { success: false, error: "queryDefinition.code is required" },
          400,
        );
      }

      // Build options for query execution
      const options = {
        databaseId: effectiveQueryDefinition.databaseId || databaseId,
        databaseName: effectiveQueryDefinition.databaseName || databaseName,
        executionId,
      };

      const isPreviewMode = mode === "preview";
      const result = isPreviewMode
        ? await databaseConnectionService.executePreviewQuery(
            database,
            executableQuery,
            {
              ...options,
              pageSize:
                typeof pageSize === "string"
                  ? parseInt(pageSize, 10)
                  : pageSize,
              cursor: typeof cursor === "string" ? cursor : null,
            },
          )
        : await databaseConnectionService.executeQuery(
            database,
            executableQuery,
            options,
          );

      // Determine execution status and extract row count
      if (result.success) {
        executionStatus = "success";
        const resultData = "data" in result ? result.data : undefined;
        rowCount =
          result.rowCount ??
          ("rows" in result && Array.isArray(result.rows)
            ? result.rows.length
            : Array.isArray(resultData)
              ? resultData.length
              : undefined);
      } else {
        executionStatus = "error";
        // Categorize error type
        const errorMsg = result.error?.toLowerCase() || "";
        if (errorMsg.includes("syntax")) {
          errorType = "syntax";
        } else if (
          errorMsg.includes("timeout") ||
          errorMsg.includes("timed out")
        ) {
          errorType = "timeout";
          executionStatus = "timeout";
        } else if (errorMsg.includes("cancel") || errorMsg.includes("abort")) {
          errorType = "cancelled";
          executionStatus = "cancelled";
        } else if (
          errorMsg.includes("connection") ||
          errorMsg.includes("connect")
        ) {
          errorType = "connection";
        } else if (
          errorMsg.includes("permission") ||
          errorMsg.includes("access denied")
        ) {
          errorType = "permission";
        } else {
          errorType = "unknown";
        }
      }

      // Track query execution (fire-and-forget)
      const userId = user?.id || apiKey?.createdBy;
      if (userId && database) {
        // Determine source: API key auth = "api", otherwise check body or default to "console_ui"
        const executionSource: QuerySource = apiKey
          ? "api"
          : source || "console_ui";

        // Validate consoleId before converting to ObjectId
        let validConsoleId: Types.ObjectId | undefined;
        if (consoleId) {
          try {
            if (Types.ObjectId.isValid(consoleId)) {
              validConsoleId = new Types.ObjectId(consoleId);
            }
          } catch (error) {
            // Invalid consoleId, just log and continue without it
            logger.warn("Invalid consoleId format in tracking", {
              consoleId,
              error,
            });
          }
        }

        queryExecutionService.track({
          userId,
          apiKeyId: apiKey?._id,
          workspaceId: workspace._id,
          connectionId: database._id,
          databaseName: databaseName || database.connection.database,
          consoleId: validConsoleId,
          source: executionSource,
          databaseType: database.type,
          queryLanguage: getQueryLanguage(database.type),
          status: executionStatus,
          executionTimeMs: Date.now() - startTime,
          rowCount,
          errorType,
        });

        if (isPreviewMode && "pageInfo" in result && result.pageInfo) {
          logger.debug("Executed preview query page", {
            connectionId: database._id.toString(),
            databaseType: database.type,
            pageSize: result.pageInfo.pageSize,
            returnedRows: result.pageInfo.returnedRows,
            hasMore: result.pageInfo.hasMore,
            capApplied: result.pageInfo.capApplied,
            cursorProvided: Boolean(cursor),
          });
        }
      }

      return c.json(result);
    } catch (error) {
      logger.error("Error executing query", { error });

      // Track failed execution
      const workspace = c.get("workspace");
      const user = c.get("user");
      const apiKey = c.get("apiKey");
      const userId = user?.id || apiKey?.createdBy;

      if (userId && database && workspace) {
        queryExecutionService.track({
          userId,
          apiKeyId: apiKey?._id,
          workspaceId: workspace._id,
          connectionId: database._id,
          databaseName: database.connection.database,
          source: apiKey ? "api" : "console_ui",
          databaseType: database.type,
          queryLanguage: getQueryLanguage(database.type),
          status: "error",
          executionTimeMs: Date.now() - startTime,
          errorType: "unknown",
        });
      }

      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to execute query",
        },
        500,
      );
    }
  },
);

workspaceExecuteRoutes.post(
  "/export",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const workspace = c.get("workspace");
      const body = await parseRequestBody(c);
      const queryDefinition = resolveQueryDefinition(body);
      const {
        connectionId,
        databaseId,
        databaseName,
        format,
        batchSize,
        executionId,
        filename,
      } = body;
      const effectiveConnectionId =
        queryDefinition?.connectionId || connectionId;

      if (!effectiveConnectionId) {
        return c.json(
          { success: false, error: "connectionId is required" },
          400,
        );
      }

      if (!queryDefinition) {
        return c.json(
          { success: false, error: "query or queryDefinition is required" },
          400,
        );
      }

      if (!Types.ObjectId.isValid(String(effectiveConnectionId))) {
        return c.json(
          { success: false, error: "Invalid connectionId format" },
          400,
        );
      }

      const normalizedFormat =
        format === "ndjson" || format === "csv" || format === "arrow"
          ? format
          : null;
      if (!normalizedFormat) {
        return c.json(
          {
            success: false,
            error: "format must be 'ndjson', 'csv', or 'arrow'",
          },
          400,
        );
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(String(effectiveConnectionId)),
        workspaceId: workspace._id,
      });

      if (!database) {
        return c.json(
          { success: false, error: "Database connection not found" },
          404,
        );
      }

      const executableQuery = buildExecutableQuery(
        queryDefinition,
        database.type,
      );
      if (!executableQuery) {
        return c.json(
          { success: false, error: "queryDefinition.code is required" },
          400,
        );
      }

      if (
        typeof executableQuery === "string" &&
        database.type !== "mongodb" &&
        database.type !== "cloudflare-kv"
      ) {
        const safety = checkPreviewQuerySafety(executableQuery);
        if (!safety.safe) {
          return c.json(
            {
              success: false,
              error: safety.errors.join(" "),
            },
            400,
          );
        }
      }

      const safeBaseName = sanitizeDownloadFilename(
        typeof filename === "string" && filename.trim()
          ? filename
          : `query-results-${Date.now()}`,
      );

      const effectiveBatchSize =
        typeof batchSize === "string"
          ? parseInt(batchSize, 10)
          : typeof batchSize === "number"
            ? batchSize
            : 1000;

      const streamingOpts = {
        databaseId:
          queryDefinition.databaseId ||
          (typeof databaseId === "string" ? databaseId : undefined),
        databaseName:
          queryDefinition.databaseName ||
          (typeof databaseName === "string" ? databaseName : undefined),
        batchSize: effectiveBatchSize,
        executionId: typeof executionId === "string" ? executionId : undefined,
        signal: c.req.raw.signal,
      };

      if (normalizedFormat === "arrow") {
        return createArrowIPCStreamResponse({
          filename: safeBaseName,
          streamRows: emitRows =>
            databaseConnectionService.executeStreamingQuery(
              database,
              executableQuery,
              {
                ...streamingOpts,
                onBatch: emitRows,
              },
            ),
        });
      }

      return createStreamingExportResponse({
        format: normalizedFormat,
        filename: `${safeBaseName}.${normalizedFormat === "csv" ? "csv" : "ndjson"}`,
        streamRows: emitRows =>
          databaseConnectionService.executeStreamingQuery(
            database,
            executableQuery,
            {
              ...streamingOpts,
              onBatch: emitRows,
            },
          ),
      });
    } catch (error) {
      logger.error("Error exporting query", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to export query",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/execute/cancel - Cancel a running query
workspaceExecuteRoutes.post(
  "/cancel",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
    try {
      const body = await c.req.json();
      const { executionId } = body;

      if (!executionId) {
        return c.json(
          { success: false, error: "executionId is required" },
          400,
        );
      }

      const result = await databaseConnectionService.cancelQuery(executionId);
      return c.json(result);
    } catch (error) {
      logger.error("Error cancelling query", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to cancel query",
        },
        500,
      );
    }
  },
);
