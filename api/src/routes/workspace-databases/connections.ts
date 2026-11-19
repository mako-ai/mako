/**
 * Connection CRUD and connection tests: list, get, create, update, delete,
 * test a saved connection or an unsaved candidate.
 */
import { serviceAccountConfigRefusal } from "../../connections/google-service-account";
import { createRoute, z } from "@hono/zod-openapi";
import { recordAccessChange } from "../../access/connection-access-event";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import {
  DatabaseConnection,
  IDatabaseConnection,
  Flow,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { recordConnectionVerification } from "../../services/connection-verification.service";
import { Types } from "mongoose";
import {
  connectionStringGroupKey,
  redactConnectionSecrets,
  restoreKeptSecrets,
} from "../../utils/connection-secrets";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";

import { logger } from "./shared";

export const connectionRoutes = createRouter();

connectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Databases"],
    summary: "GET /",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");

      const databases = await DatabaseConnection.find({
        workspaceId: workspace._id,
      }).sort({ createdAt: -1 });

      // Transform to API response format without connection details for security
      const transformedDatabases = databases.map((db: IDatabaseConnection) => {
        // Create a credential-free hostKey for grouping per database type.
        // This response goes to EVERY member of the workspace, so the key is
        // derived host-only (see connectionStringGroupKey) rather than masked:
        // masking is fail-open on formats we cannot parse.
        let hostKey: string;
        let hostName: string;
        const conn: any = db.connection || {};
        if (db.type === "bigquery") {
          const projectId = conn.project_id || "unknown-project";
          hostKey = `bigquery://${projectId}`;
          hostName = `BigQuery (${projectId})`;
        } else if (conn.connectionString) {
          hostKey = connectionStringGroupKey(conn.connectionString);
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
connectionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Databases"],
    summary: "GET /{id}",
    security: AUTH_SECURITY,
    // Connection internals (host, username, options) are for the people who
    // may edit connections — the same list that gates create/update below.
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
          // Decrypted by the getter, then stripped of every credential: the
          // edit dialog needs the shape, never the secrets.
          connection: redactConnectionSecrets(conn),
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
connectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/test-connection",
    tags: ["Databases"],
    summary: "POST /test-connection",
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

      // Testing an edit of a SAVED connection: the form holds sentinels where
      // its secrets used to be, so resolve them from the stored row. Without
      // this, "Test" on an existing connection would dial with a placeholder
      // password and always fail.
      let connection = body.connection as Record<string, unknown>;
      if (body.connectionId && Types.ObjectId.isValid(body.connectionId)) {
        const saved = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(body.connectionId),
          workspaceId: c.get("workspace")._id,
        });
        if (saved) {
          const previous =
            (saved.toObject({ getters: true }) as any).connection || {};
          connection = restoreKeptSecrets(connection, previous);
        }
      }

      const keyRefusal = serviceAccountConfigRefusal(connection);
      if (keyRefusal) {
        return c.json({ success: false, error: keyRefusal }, 400);
      }

      // Create a temporary database object for testing
      const tempDatabase = {
        _id: new Types.ObjectId(),
        type: body.type,
        connection,
      } as IDatabaseConnection;

      const startedAt = Date.now();
      const result =
        await databaseConnectionService.testConnection(tempDatabase);
      recordConnectionVerification({
        userId: c.get("user")?.id,
        workspaceId: c.get("workspace")?._id,
        databaseType: body.type,
        trigger: "standalone_test",
        success: result.success,
        durationMs: Date.now() - startedAt,
        error: result.error,
      });

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
connectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Databases"],
    summary: "POST /",
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

      const keyRefusal = serviceAccountConfigRefusal(body.connection);
      if (keyRefusal) {
        return c.json({ success: false, error: keyRefusal }, 400);
      }

      // Optionally verify the connection before persisting. When requested and
      // the test fails, do NOT create the record — return a structured result
      // so the client can offer "edit" vs "save anyways". Absent flag keeps the
      // legacy behavior (save without testing) for programmatic callers.
      const verifyBeforeSave = body.verifyBeforeSave === true;
      if (verifyBeforeSave) {
        const tempDatabase = {
          _id: new Types.ObjectId(),
          type: body.type,
          connection: body.connection || {},
        } as IDatabaseConnection;
        const startedAt = Date.now();
        const test =
          await databaseConnectionService.testConnection(tempDatabase);
        recordConnectionVerification({
          userId: user.id,
          workspaceId: workspace._id,
          databaseType: body.type,
          trigger: "create_verify",
          success: test.success,
          durationMs: Date.now() - startedAt,
          error: test.error,
        });
        if (!test.success) {
          return c.json({
            success: false,
            code: "connection_test_failed",
            error: test.error || "Connection test failed",
          });
        }
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

      // A successful pre-save test is the authoritative "reachable" signal.
      if (verifyBeforeSave) {
        database.lastConnectedAt = new Date();
      }

      await database.save();

      return c.json(
        {
          success: true,
          verified: verifyBeforeSave,
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
connectionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Databases"],
    summary: "PUT /{id}",
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

      const verifyBeforeSave = body.verifyBeforeSave === true;

      // As it was, for the record of an access change.
      const agentWritesBefore = database.allowAgentWrites === true;

      // Update fields
      if (body.name) database.name = body.name;
      if (typeof body.allowAgentWrites === "boolean") {
        // Security-sensitive opt-in (scoped agent credentials may write to
        // this connection) — owners/admins only, unlike general edits.
        const memberRole = c.get("memberRole");
        if (memberRole !== "owner" && memberRole !== "admin") {
          return c.json(
            {
              success: false,
              error:
                "Only workspace owners or admins can change allowAgentWrites",
            },
            403,
          );
        }
        database.allowAgentWrites = body.allowAgentWrites;
      }
      if (body.connection) {
        // Build candidate connection using decrypted previous + incoming patch
        const previous =
          (database.toObject({ getters: true }) as any).connection || {};
        // The client never received the real secrets, so put them back
        // wherever it echoed the sentinel or a masked connection string.
        const candidate = {
          ...previous,
          ...restoreKeptSecrets(body.connection, previous),
        };

        const keyRefusal = serviceAccountConfigRefusal(candidate);
        if (keyRefusal) {
          return c.json({ success: false, error: keyRefusal }, 400);
        }

        // Optionally verify the candidate before persisting the change.
        if (verifyBeforeSave) {
          const tempDatabase = {
            _id: new Types.ObjectId(),
            type: database.type,
            connection: candidate,
          } as IDatabaseConnection;
          const startedAt = Date.now();
          const test =
            await databaseConnectionService.testConnection(tempDatabase);
          recordConnectionVerification({
            userId: c.get("user")?.id,
            workspaceId: database.workspaceId,
            connectionId: database._id,
            databaseType: database.type,
            trigger: "update_verify",
            success: test.success,
            durationMs: Date.now() - startedAt,
            error: test.error,
          });
          if (!test.success) {
            return c.json({
              success: false,
              code: "connection_test_failed",
              error: test.error || "Connection test failed",
            });
          }
        }

        database.connection = candidate as any;
      }

      database.updatedAt = new Date();
      if (verifyBeforeSave) {
        database.lastConnectedAt = new Date();
      }
      await database.save();
      if ((database.allowAgentWrites === true) !== agentWritesBefore) {
        await recordAccessChange({
          workspaceId: workspace._id,
          connectionId: database._id,
          kind: "database",
          actor: String(c.get("user")?.id ?? "unknown"),
          via: c.get("authType") === "session" ? "app" : "api",
          changes: { agentWrites: database.allowAgentWrites === true },
        });
      }

      // Every pool/client/connector is cached by connection id alone, so
      // without this an edited host or rotated password keeps being served
      // by the pool built from the old configuration until a restart.
      if (body.connection) {
        await databaseConnectionService.invalidateConnection(databaseId);
      }

      return c.json({
        success: true,
        verified: verifyBeforeSave,
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
connectionRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Databases"],
    summary: "DELETE /{id}",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
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
connectionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Databases"],
    summary: "POST /{id}/test",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
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

      const startedAt = Date.now();
      const result = await databaseConnectionService.testConnection(database);
      recordConnectionVerification({
        userId: c.get("user")?.id,
        workspaceId: database.workspaceId,
        connectionId: database._id,
        databaseType: database.type,
        trigger: "saved_test",
        success: result.success,
        durationMs: Date.now() - startedAt,
        error: result.error,
      });

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
