/**
 * Running queries: POST /{id}/execute on a connection, and the
 * workspace-level /execute and /execute/export (mounted at
 * /api/workspaces/:workspaceId/execute).
 */
import { viewerWriteRefusal } from "../../access/viewer-writes";
import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import { restQueryAccessFromStoredScopes } from "../../auth/api-key-scopes";
import { requireWorkspace } from "../../middleware/workspace.middleware";
import {
  DatabaseConnection,
  IDatabaseConnection,
  SavedConsole,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import {
  executeQueryWithRowCap,
  resolveExecuteMaxRows,
} from "../../services/query-row-cap";
import {
  queryExecutionService,
  QuerySource,
  QueryStatus,
} from "../../services/query-execution.service";
import { Types } from "mongoose";
import { checkPreviewQuerySafety } from "../../services/query-pagination.service";
import { createStreamingExportResponse } from "../../utils/query-export-stream";
import { createArrowIPCStreamResponse } from "../../utils/arrow-serializer";
import { workspaceService } from "../../services/workspace.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";

import {
  logger,
  consoleManager,
  sanitizeDownloadFilename,
  resolveQueryDefinition,
  buildExecutableQuery,
  parseRequestBody,
  createAdHocParquetResponse,
  requestExecutionOptions,
  getQueryLanguage,
} from "./shared";

export const connectionExecuteRoutes = createRouter();

// Execute query on database
connectionExecuteRoutes.openapi(
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

      const memberRole = c.get("memberRole");
      const viewerRefusal = viewerWriteRefusal(
        memberRole,
        database.type,
        body.query,
      );
      if (viewerRefusal) {
        return c.json({ success: false, error: viewerRefusal }, 403);
      }

      const result = await executeQueryWithRowCap(
        databaseConnectionService,
        database,
        body.query,
        {
          ...requestExecutionOptions(body.options),
          readOnly: queryAccess === "read",
          // A viewer's read runs read-only where the engine can enforce it.
          ...(memberRole === "viewer" ? { readOnlyTransaction: true } : {}),
          labels: { mako_source: "adhoc" },
        },
        resolveExecuteMaxRows(),
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

      const memberRole = c.get("memberRole");
      const viewerRefusal = viewerWriteRefusal(
        memberRole,
        database.type,
        executableQuery,
      );
      if (viewerRefusal) {
        return c.json(
          { success: false, error: viewerRefusal, code: "FORBIDDEN" as const },
          403,
        );
      }

      const maxRows = resolveExecuteMaxRows();
      // Build options for query execution
      const options = {
        databaseId: effectiveQueryDefinition.databaseId || databaseId,
        databaseName: effectiveQueryDefinition.databaseName || databaseName,
        executionId,
        readOnly: queryAccess === "read",
        // A viewer's read runs read-only where the engine can enforce it.
        ...(memberRole === "viewer" ? { readOnlyTransaction: true } : {}),
        // Bounds what a preview reads where it cannot page in the engine
        // (MongoDB); a full execute is capped by executeQueryWithRowCap.
        maxRows,
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
        ? await executeQueryWithRowCap(
            databaseConnectionService,
            database,
            executableQuery,
            options,
            maxRows,
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
