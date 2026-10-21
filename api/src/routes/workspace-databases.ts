import {
  checkConnectionWrite,
  covers,
  principalsOutsideWorkspace,
} from "../access/connection-writes";
import { ConnectionWriteEvent } from "../access/connection-write-event";
import { createRoute, z } from "@hono/zod-openapi";
import type { Db } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { restQueryAccessFromStoredScopes } from "../auth/api-key-scopes";
import {
  requireWorkspace,
  requireWorkspaceRole,
  AuthenticatedContext,
} from "../middleware/workspace.middleware";
import {
  DatabaseConnection,
  IDatabaseConnection,
  Flow,
  SavedConsole,
} from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";
import { recordConnectionVerification } from "../services/connection-verification.service";
import {
  queryExecutionService,
  QueryLanguage,
  QuerySource,
  QueryStatus,
} from "../services/query-execution.service";
import { Types } from "mongoose";
import { loggers } from "../logging";
import { ConsoleManager } from "../utils/console-manager";
import {
  connectionStringGroupKey,
  redactConnectionSecrets,
  restoreKeptSecrets,
} from "../utils/connection-secrets";
import { checkPreviewQuerySafety } from "../services/query-pagination.service";
import { createStreamingExportResponse } from "../utils/query-export-stream";
import { createArrowIPCStreamResponse } from "../utils/arrow-serializer";
import { writeParquetTempFile } from "../utils/parquet-serializer";
import { workspaceService } from "../services/workspace.service";
import { promises as fsPromises } from "fs";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.db();
const consoleManager = new ConsoleManager();

type WorkspaceDatabaseRouteError = {
  response: { success: false; error: string };
  status: 400 | 403 | 404;
};

type WorkspaceDatabaseResult =
  WorkspaceDatabaseRouteError | { database: IDatabaseConnection };

type WorkspaceMongoDbResult = WorkspaceDatabaseRouteError | { db: Db };

function isWorkspaceDatabaseRouteError(
  result: WorkspaceDatabaseResult,
): result is WorkspaceDatabaseRouteError {
  return "response" in result;
}

function isWorkspaceMongoDbRouteError(
  result: WorkspaceMongoDbResult,
): result is WorkspaceDatabaseRouteError {
  return "response" in result;
}

async function getWorkspaceDatabase(
  workspaceId: Types.ObjectId,
  databaseId: string,
): Promise<WorkspaceDatabaseResult> {
  if (!Types.ObjectId.isValid(databaseId)) {
    return {
      response: { success: false, error: "Invalid database ID" },
      status: 400 as const,
    };
  }

  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(databaseId),
    workspaceId,
  });

  if (!database) {
    return {
      response: { success: false, error: "Database not found" },
      status: 404 as const,
    };
  }

  if (database.type !== "mongodb") {
    return {
      response: {
        success: false,
        error: "This endpoint is only for MongoDB databases",
      },
      status: 400 as const,
    };
  }

  return { database };
}

/**
 * The MongoDB database behind a connection. `write` names the change a
 * route is about to make with the raw client (createCollection,
 * dropCollection): it is checked against the connection's writers list
 * first, as a query would be (access/connection-writes.ts).
 */
async function getWorkspaceMongoDb(
  workspaceId: Types.ObjectId,
  databaseId: string,
  write?: string,
): Promise<WorkspaceMongoDbResult> {
  const result = await getWorkspaceDatabase(workspaceId, databaseId);
  if (isWorkspaceDatabaseRouteError(result)) return result;
  if (write) {
    const check = await checkConnectionWrite(result.database, {
      operation: write,
    });
    if (check.refused) {
      return {
        response: { success: false, error: check.refused },
        status: 403 as const,
      };
    }
  }

  const connection = await databaseConnectionService.getConnection(
    result.database,
  );
  return {
    db: connection.db(result.database.connection.database),
  };
}

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

async function createAdHocParquetResponse(options: {
  database: IDatabaseConnection;
  executableQuery: any;
  queryDefinition: QueryDefinitionInput;
  filename: string;
}) {
  const queryResult = await databaseConnectionService.executeQuery(
    options.database,
    options.executableQuery,
    {
      databaseId: options.queryDefinition.databaseId,
      databaseName: options.queryDefinition.databaseName,
      readOnly: true,
      labels: { mako_source: "export" },
    },
  );

  if (!queryResult.success || !queryResult.data) {
    throw new Error(queryResult.error || "Query failed");
  }

  const rows = Array.isArray(queryResult.data) ? queryResult.data : [];
  const fields = (queryResult.fields || []).map((field: any) => ({
    name: field.name || field.columnName || String(field),
    type: field.type || field.dataType,
  }));
  const normalizedFields =
    fields.length > 0
      ? fields
      : rows.length > 0
        ? Object.keys(rows[0]).map(name => ({ name, type: undefined }))
        : [];

  const parquetFile = await writeParquetTempFile({
    rows,
    fields: normalizedFields,
    filenameBase: options.filename,
  });

  try {
    const fileBuffer = await fsPromises.readFile(parquetFile.filePath);
    return new Response(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": "application/vnd.apache.parquet",
        "Content-Disposition": `attachment; filename="${options.filename}.parquet"`,
        "Content-Length": String(parquetFile.byteSize),
        "X-Row-Count": String(parquetFile.rowCount),
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await fsPromises
      .rm(parquetFile.filePath, { force: true })
      .catch(() => undefined);
  }
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

export const workspaceDatabaseRoutes = createRouter();

// Create demo database for workspace (onboarding)
workspaceDatabaseRoutes.openapi(
  createRoute({
    method: "post",
    path: "/demo",
    tags: ["Databases"],
    summary: "POST /demo",
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
      logger.error("Error creating demo database", { error });
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
workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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

// Who may write through a connection (access/connection-writes.ts). Anyone
// in the workspace may look; the owner and admins change it, in the app.
const writersParams = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

/** A principal that can be put on a writers list. */
const LISTABLE_PRINCIPAL =
  /^(user:[A-Za-z0-9_-]+|workflow:[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/;

const WriterSchema = z.object({
  principal: z
    .string()
    .regex(LISTABLE_PRINCIPAL)
    .openapi({ example: "workflow:crm-chat-issues" }),
  where: z
    .string()
    .regex(/^[^.\s]+(\.[^.\s]+)?$/)
    .optional()
    .openapi({ example: "mako_out.issue_labels" }),
});

const RECENT_WRITES_DAYS = 30;

workspaceDatabaseRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/writers",
    tags: ["Databases"],
    summary: "Who may write through this connection",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: writersParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }
    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    })
      .select("writers")
      .lean();
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }
    const memberRole = c.get("memberRole");
    // Who wrote or tried to write here lately, from the write log, and what
    // the list does not cover (what it refuses), to allow in one click.
    const since = new Date(Date.now() - RECENT_WRITES_DAYS * 86_400_000);
    const recent = await ConnectionWriteEvent.aggregate<{
      _id: string;
      count: number;
      lastAt: Date;
      targets: (string | null)[];
    }>([
      {
        $match: {
          connectionId: new Types.ObjectId(databaseId),
          at: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$principal",
          count: { $sum: 1 },
          lastAt: { $max: "$at" },
          targets: { $addToSet: "$target" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]);
    return c.json({
      success: true,
      data: {
        writers: (database.writers ?? []).map(w => ({
          principal: w.principal,
          where: w.where ?? null,
          addedBy: w.addedBy ?? null,
          addedAt: w.addedAt ?? null,
        })),
        canEdit: memberRole === "owner" || memberRole === "admin",
        // Only who could be allowed: the worker writing as no workflow
        // cannot be listed.
        recent: recent
          .filter(r => LISTABLE_PRINCIPAL.test(r._id))
          .map(r => {
            const targets = r.targets.filter((t): t is string => !!t);
            return {
              principal: r._id,
              count: r.count,
              lastAt: r.lastAt,
              targets: targets.slice(0, 5),
              // Against the list as it is now, not as it was then.
              uncovered: targets
                .filter(t => !covers(database.writers, r._id, t))
                .slice(0, 5),
            };
          }),
      },
    });
  },
);

workspaceDatabaseRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/writers",
    tags: ["Databases"],
    summary: "Change who may write through this connection",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: {
      params: writersParams,
      body: {
        content: {
          "application/json": {
            schema: z.object({ writers: z.array(WriterSchema).max(200) }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    const user = c.get("user");
    // People decide who writes, in the app: never an API key, MCP client or
    // agent, whatever it is asked.
    if (c.get("authType") !== "session" || !user?.id) {
      return c.json(
        { success: false, error: "Writers can only be changed in the app" },
        403,
      );
    }
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
    const { writers } = c.req.valid("json");
    const strangers = await principalsOutsideWorkspace(
      String(workspace._id),
      writers.map(w => w.principal),
    );
    if (strangers.length > 0) {
      return c.json(
        {
          success: false,
          error: `${strangers.join(", ")} is not a member of this workspace`,
        },
        400,
      );
    }
    // One entry per principal and place; keep who added an entry first.
    const now = new Date();
    const previous = new Map(
      (database.writers ?? []).map(w => [`${w.principal} ${w.where ?? ""}`, w]),
    );
    const next = new Map<string, (typeof writers)[number]>();
    for (const w of writers) next.set(`${w.principal} ${w.where ?? ""}`, w);
    database.writers = [...next].map(([key, w]) => ({
      principal: w.principal,
      ...(w.where ? { where: w.where } : {}),
      addedBy: previous.get(key)?.addedBy ?? user.id,
      addedAt: previous.get(key)?.addedAt ?? now,
    }));
    await database.save();
    logger.info("Connection writers changed", {
      workspaceId: String(workspace._id),
      databaseId,
      userId: user.id,
      writers: database.writers.length,
    });
    return c.json({ success: true });
  },
);

// Delete database
workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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

// Execute query on database
workspaceDatabaseRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/execute",
    tags: ["Databases"],
    summary: "POST /{id}/execute",
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
      const apiKey = c.get("apiKey");
      const databaseId = c.req.param("id");
      const body = await c.req.json();
      const queryAccess = apiKey
        ? restQueryAccessFromStoredScopes(apiKey.scopes)
        : "write";
      if (queryAccess === "none") {
        return c.json(
          { success: false, error: "API key does not have query access" },
          403,
        );
      }

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
        {
          ...body.options,
          readOnly: queryAccess === "read",
          labels: { mako_source: "adhoc" },
        },
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
workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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

workspaceDatabaseRoutes.openapi(
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

workspaceDatabaseRoutes.openapi(
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

workspaceDatabaseRoutes.openapi(
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
workspaceDatabaseRoutes.openapi(
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

workspaceDatabaseRoutes.openapi(
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

workspaceDatabaseRoutes.openapi(
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

workspaceDatabaseRoutes.openapi(
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

// ============================================================================
// Workspace-level execute endpoint (cleaner API)
// Mounted at /api/workspaces/:workspaceId/execute in index.ts
// ============================================================================
export const workspaceExecuteRoutes = createRouter();

// POST /api/workspaces/:workspaceId/execute - Execute query with explicit connection/database params
workspaceExecuteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Query Execution"],
    summary: "POST /",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
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
    const startTime = Date.now();
    let database: IDatabaseConnection | null = null;
    let executionStatus: QueryStatus;
    let rowCount: number | undefined;
    let errorType: string | undefined;

    try {
      const workspace = c.get("workspace");
      const user = c.get("user");
      const apiKey = c.get("apiKey");
      const body = await parseRequestBody(c);
      const queryAccess = apiKey
        ? restQueryAccessFromStoredScopes(apiKey.scopes)
        : "write";
      if (queryAccess === "none") {
        return c.json(
          { success: false, error: "API key does not have query access" },
          403,
        );
      }

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
        confirmUnsafe,
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
        readOnly: queryAccess === "read",
        labels: {
          // A console tab runs through here; its id says which console.
          mako_source: consoleId ? "console" : "adhoc",
          mako_console: typeof consoleId === "string" ? consoleId : undefined,
          mako_trigger: apiKey ? "api" : String(source || "console_ui"),
          mako_user: user?.id ?? apiKey?.createdBy?.toString(),
        },
      };

      const isPreviewMode = mode === "preview";
      const wantsUnsafeOverride = confirmUnsafe === true;

      let useFullExecute = !isPreviewMode;
      let usedAdminPreviewOverride = false;

      if (
        isPreviewMode &&
        typeof executableQuery === "string" &&
        database.type !== "mongodb" &&
        database.type !== "cloudflare-kv"
      ) {
        const safety = checkPreviewQuerySafety(executableQuery);
        if (!safety.safe) {
          if (!wantsUnsafeOverride) {
            return c.json(
              {
                success: false,
                error: safety.errors.join(" "),
                code: "PREVIEW_BLOCKED" as const,
              },
              400,
            );
          }
          if (c.get("authType") !== "session" || !user?.id) {
            return c.json(
              {
                success: false,
                error:
                  "Admin session required to override preview safety (API keys cannot use confirmUnsafe)",
                code: "FORBIDDEN" as const,
              },
              403,
            );
          }
          const isAdmin = await workspaceService.isAdmin(
            workspace._id.toString(),
            user.id,
          );
          if (!isAdmin) {
            return c.json(
              {
                success: false,
                error: "Admin access required to override preview safety",
                code: "FORBIDDEN" as const,
              },
              403,
            );
          }
          useFullExecute = true;
          usedAdminPreviewOverride = true;
        }
      }

      const result = useFullExecute
        ? await databaseConnectionService.executeQuery(
            database,
            executableQuery,
            options,
          )
        : await databaseConnectionService.executePreviewQuery(
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
        let executionSource: QuerySource = apiKey
          ? "api"
          : source || "console_ui";
        if (usedAdminPreviewOverride && !apiKey) {
          executionSource = "console_ui_admin_override";
        }

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

        // When a saved console id is provided, keep console execution stats
        // current (UI runs historically omitted this). API-key runs also bump
        // the durable external-use signal.
        if (validConsoleId) {
          void SavedConsole.updateOne(
            {
              _id: validConsoleId,
              workspaceId: workspace._id,
            },
            {
              $set: { lastExecutedAt: new Date() },
              $inc: { executionCount: 1 },
            },
          ).catch(error => {
            logger.warn("Failed to update console execution stats", {
              error,
              consoleId: validConsoleId.toString(),
            });
          });

          if (apiKey) {
            void consoleManager.recordExternalUse(
              validConsoleId.toString(),
              workspace._id.toString(),
              "api",
              "execute",
            );
          }
        }

        if (
          isPreviewMode &&
          !useFullExecute &&
          "pageInfo" in result &&
          result.pageInfo
        ) {
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

workspaceExecuteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/export",
    tags: ["Query Execution"],
    summary: "POST /export",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
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
        format === "ndjson" ||
        format === "csv" ||
        format === "arrow" ||
        format === "parquet"
          ? format
          : null;
      if (!normalizedFormat) {
        return c.json(
          {
            success: false,
            error:
              "format must be one of 'arrow', 'ndjson', 'parquet', or 'csv'",
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

      const streamingOptions = {
        databaseId:
          queryDefinition.databaseId ||
          (typeof databaseId === "string" ? databaseId : undefined),
        databaseName:
          queryDefinition.databaseName ||
          (typeof databaseName === "string" ? databaseName : undefined),
        batchSize:
          typeof batchSize === "string"
            ? parseInt(batchSize, 10)
            : typeof batchSize === "number"
              ? batchSize
              : 1000,
        executionId: typeof executionId === "string" ? executionId : undefined,
        signal: c.req.raw.signal,
        readOnly: true,
        // On the query itself: the stream runs after this handler returns.
        labels: { mako_source: "export", mako_user: c.get("user")?.id },
      };

      if (normalizedFormat === "parquet") {
        return await createAdHocParquetResponse({
          database,
          executableQuery,
          queryDefinition,
          filename: safeBaseName,
        });
      }

      if (normalizedFormat === "arrow") {
        const fieldsResult =
          await databaseConnectionService.getStreamingQueryFields(
            database,
            executableQuery,
            streamingOptions,
          );
        if (!fieldsResult.success || !fieldsResult.fields?.length) {
          return c.json(
            {
              success: false,
              error:
                fieldsResult.error ||
                "Arrow export requires schema metadata before streaming begins",
            },
            400,
          );
        }

        return createArrowIPCStreamResponse({
          fields: fieldsResult.fields,
          filename: safeBaseName,
          streamRows: emitRows =>
            databaseConnectionService.executeStreamingQuery(
              database,
              executableQuery,
              {
                ...streamingOptions,
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
              ...streamingOptions,
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
workspaceExecuteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/cancel",
    tags: ["Query Execution"],
    summary: "POST /cancel",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
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
