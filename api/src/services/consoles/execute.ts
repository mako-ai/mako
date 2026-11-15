/**
 * Running a saved console over REST (POST /{id}/execute) and exporting its
 * results (GET /{id}/export). The agent's run_console and the scheduler use
 * console-execution.service.ts; this is the request-shaped path: preview
 * paging, the execute row cap, API-key query scopes and the viewer write
 * gate.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SavedConsole,
  type IDatabaseConnection,
  type ISavedConsole,
  type IWorkspaceApiKey,
} from "../../database/workspace-schema";
import { restQueryAccessFromStoredScopes } from "../../auth/api-key-scopes";
import { viewerWriteRefusal } from "../../access/viewer-writes";
import { liveConsoleCode } from "../../apps/workspace-consoles.service";
import { RepoRequiredError } from "../../apps/config";
import { createStreamingExportResponse } from "../../utils/query-export-stream";
import { databaseConnectionService } from "../database-connection.service";
import { queryExecutionService } from "../query-execution.service";
import {
  applySqlRowLimit,
  checkPreviewQuerySafety,
} from "../query-pagination.service";
import {
  executeQueryWithRowCap,
  resolveExecuteMaxRows,
} from "../query-row-cap";
import {
  classifyError,
  mapConsoleLanguageToQueryLanguage,
} from "../console-execution.service";
import { canReadConsoleWithInheritance } from "./access";
import { recordConsoleExternalUse } from "./crud";

export type ExecuteApiKey = Pick<
  IWorkspaceApiKey,
  "_id" | "createdBy" | "scopes"
>;

export type ConsoleRunOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404; error: string };

function refuse(status: 400 | 403 | 404, error: string): ConsoleRunOutcome {
  return { ok: false, status, error };
}

/** `{ collection, operation, query }` for a structured MongoDB console. */
function structuredMongoQuery(savedConsole: ISavedConsole) {
  const opts = savedConsole.mongoOptions;
  return savedConsole.language === "mongodb" &&
    opts?.collection &&
    opts.operation
    ? {
        collection: opts.collection,
        operation: opts.operation,
        query: savedConsole.code,
      }
    : null;
}

function consoleStamp(savedConsole: ISavedConsole) {
  return {
    id: savedConsole._id,
    name: savedConsole.name,
    language: savedConsole.language,
    executedAt: new Date().toISOString(),
  };
}

/**
 * POST /{id}/execute. A failed query is `success: false` (status 200, with
 * the console stamp) — never `success: true` with no rows, which an API
 * caller reads as an empty result. Unexpected errors are tracked as failed
 * executions and rethrown for the route's 500.
 */
export async function executeConsoleRequest(input: {
  workspaceId: string;
  consoleId: string;
  userId: string | undefined;
  apiKey: ExecuteApiKey | undefined;
  memberRole: string | undefined;
  mode: string | undefined;
  pageSize: string | undefined;
  cursor: string | undefined;
}): Promise<ConsoleRunOutcome> {
  const startTime = Date.now();
  const { workspaceId, consoleId, userId, apiKey, memberRole } = input;
  let database: IDatabaseConnection | null = null;
  let consoleIdParsed: Types.ObjectId | undefined;

  try {
    const queryAccess = apiKey
      ? restQueryAccessFromStoredScopes(apiKey.scopes)
      : "write";
    if (queryAccess === "none") {
      return refuse(403, "API key does not have query access");
    }

    if (!Types.ObjectId.isValid(consoleId)) {
      return refuse(400, "Invalid console ID");
    }
    consoleIdParsed = new Types.ObjectId(consoleId);

    const savedConsole = await SavedConsole.findOne({
      _id: consoleIdParsed,
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!savedConsole) return refuse(404, "Console not found");
    if (
      userId &&
      !(await canReadConsoleWithInheritance(savedConsole, userId))
    ) {
      return refuse(404, "Console not found");
    }

    // Git is the definition: run the file at main, not the row's last
    // pushed copy (a query edited in git ran stale until the webhook).
    const liveCode = await liveConsoleCode(
      workspaceId,
      consoleIdParsed.toString(),
    );
    if (liveCode) savedConsole.code = liveCode.code;

    // If console has a connection ID, verify it exists and belongs to workspace
    if (savedConsole.connectionId) {
      database = await DatabaseConnection.findOne({
        _id: savedConsole.connectionId,
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!database) {
        return refuse(404, "Associated database not found or access denied");
      }
    }
    if (!database) {
      return refuse(400, "Console has no associated database connection");
    }

    // A viewer only reads: refuse a write before running anything, and
    // run their reads read-only where the engine can enforce it.
    const structured = structuredMongoQuery(savedConsole);
    const viewerRefusal = viewerWriteRefusal(
      memberRole,
      database.type,
      structured ?? savedConsole.code,
    );
    if (viewerRefusal) return refuse(403, viewerRefusal);
    const maxRows = resolveExecuteMaxRows();

    // Pass explicit databaseId and databaseName for cluster mode (D1, etc.)
    const executionOptions = {
      databaseId: savedConsole.databaseId,
      databaseName: savedConsole.databaseName,
      readOnly: queryAccess === "read",
      ...(memberRole === "viewer" ? { readOnlyTransaction: true } : {}),
      labels: {
        mako_source: "console",
        mako_console: consoleId,
        mako_trigger: apiKey ? "api" : "console_ui",
        mako_user: userId ?? apiKey?.createdBy?.toString(),
      },
    };
    const isPreviewMode = input.mode === "preview";

    // Structured MongoDB operations (find, aggregate, …) carry their
    // collection options; JavaScript-style MongoDB and SQL run the code.
    const query = structured ?? savedConsole.code;
    const options = structured
      ? { ...savedConsole.mongoOptions, ...executionOptions }
      : executionOptions;
    const result = isPreviewMode
      ? await databaseConnectionService.executePreviewQuery(database, query, {
          ...options,
          pageSize: input.pageSize ? parseInt(input.pageSize, 10) : undefined,
          cursor: input.cursor || null,
        })
      : await executeQueryWithRowCap(
          databaseConnectionService,
          database,
          query,
          options,
          maxRows,
        );

    // Update execution stats
    await SavedConsole.updateOne(
      { _id: savedConsole._id },
      {
        $set: { lastExecutedAt: new Date() },
        $inc: { executionCount: 1 },
      },
    );

    // API-key executes count as external use (monitor integrations separately
    // from in-app runs).
    if (apiKey) {
      void recordConsoleExternalUse(
        savedConsole._id.toString(),
        workspaceId,
        "api",
        "execute",
      );
    }

    const previewRows =
      "rows" in result && Array.isArray(result.rows) ? result.rows : undefined;
    const data = "data" in result ? result.data || [] : [];
    const rowCount =
      result.rowCount ||
      (Array.isArray(previewRows)
        ? previewRows.length
        : Array.isArray(data)
          ? data.length
          : 0);

    const { status: executionStatus, errorType } = result.success
      ? { status: "success" as const, errorType: undefined }
      : classifyError(result.error);

    // Track query execution (fire-and-forget)
    const trackUserId = userId || apiKey?.createdBy;
    if (trackUserId) {
      queryExecutionService.track({
        userId: trackUserId,
        apiKeyId: apiKey?._id,
        workspaceId: new Types.ObjectId(workspaceId),
        connectionId: database._id,
        databaseName: savedConsole.databaseName || database.connection.database,
        consoleId: savedConsole._id,
        source: apiKey ? "api" : "console_ui",
        databaseType: database.type,
        queryLanguage: mapConsoleLanguageToQueryLanguage(savedConsole.language),
        status: executionStatus,
        executionTimeMs: Date.now() - startTime,
        rowCount,
        errorType,
      });
    }

    if (!result.success) {
      return {
        ok: true,
        body: {
          success: false,
          error: result.error || "Query failed",
          console: consoleStamp(savedConsole),
        },
      };
    }

    const cap =
      "truncated" in result && result.truncated
        ? { truncated: true, rowLimit: result.rowLimit }
        : {};

    return {
      ok: true,
      body: isPreviewMode
        ? {
            success: true,
            rows: previewRows || [],
            rowCount,
            fields: result.fields || null,
            pageInfo: "pageInfo" in result ? result.pageInfo || null : null,
            console: consoleStamp(savedConsole),
          }
        : {
            success: true,
            data: data,
            rowCount: rowCount,
            fields: result.fields || null,
            ...cap,
            console: consoleStamp(savedConsole),
          },
    };
  } catch (error) {
    // Track the failed execution, then let the route answer it (a missing
    // repo binding is the route's 412, not a failed run).
    const trackUserId = userId || apiKey?.createdBy;
    if (trackUserId && database && !(error instanceof RepoRequiredError)) {
      queryExecutionService.track({
        userId: trackUserId,
        apiKeyId: apiKey?._id,
        workspaceId: new Types.ObjectId(workspaceId),
        connectionId: database._id,
        databaseName: database.connection.database,
        consoleId: consoleIdParsed,
        source: apiKey ? "api" : "console_ui",
        databaseType: database.type,
        queryLanguage: mapConsoleLanguageToQueryLanguage(
          database.type === "mongodb" ? "mongodb" : "sql",
        ),
        status: "error",
        executionTimeMs: Date.now() - startTime,
        errorType: "unknown",
      });
    }
    throw error;
  }
}

export type ExportFormat = "arrow" | "json" | "ndjson" | "csv";

function sanitizeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/**
 * GET /{id}/export: the console's results as Arrow IPC (default), JSON, or a
 * streamed NDJSON / CSV download. Read-only, row-limited. Answers a
 * Response, a JSON body, or a refusal.
 */
export async function exportConsoleResults(input: {
  workspaceId: string;
  consoleId: string;
  userId: string | undefined;
  format: ExportFormat;
  limit: number;
  signal: AbortSignal;
}): Promise<
  | { ok: true; response: Response }
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; status: 400 | 404 | 500; error: string }
> {
  const { workspaceId, consoleId, format, limit } = input;
  if (!Types.ObjectId.isValid(consoleId)) {
    return { ok: false, status: 400, error: "Invalid console ID" };
  }

  const savedConsole = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!savedConsole) {
    return { ok: false, status: 404, error: "Console not found" };
  }
  if (!savedConsole.connectionId) {
    return {
      ok: false,
      status: 400,
      error: "Console has no database connection",
    };
  }

  const database = await DatabaseConnection.findOne({
    _id: savedConsole.connectionId,
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) {
    return { ok: false, status: 404, error: "Database connection not found" };
  }

  const startTime = Date.now();
  // Set on the query itself: the streaming export runs after this
  // handler returns, outside any context it could enter.
  const labels = {
    mako_source: "export",
    mako_console: consoleId,
    mako_user: input.userId,
  };

  const mongo = savedConsole.mongoOptions;
  const query: string | Record<string, unknown> =
    savedConsole.language === "mongodb" && mongo?.collection
      ? {
          collection: mongo.collection,
          operation: mongo.operation || "find",
          query: savedConsole.code,
        }
      : savedConsole.code;

  if (format === "ndjson" || format === "csv") {
    if (typeof query === "string" && database.type !== "cloudflare-kv") {
      const safety = checkPreviewQuerySafety(query);
      if (!safety.safe) {
        return { ok: false, status: 400, error: safety.errors.join(" ") };
      }
    }
    const safeFileBase = sanitizeDownloadFilename(
      savedConsole.name || `console-${savedConsole._id.toString()}`,
    );
    const streamQuery =
      typeof query === "string" &&
      database.type !== "cloudflare-kv" &&
      database.type !== "mongodb"
        ? applySqlRowLimit({ query, databaseType: database.type, limit })
        : query;

    return {
      ok: true,
      response: createStreamingExportResponse({
        format,
        filename: `${safeFileBase}.${format === "csv" ? "csv" : "ndjson"}`,
        streamRows: emitRows =>
          databaseConnectionService.executeStreamingQuery(
            database,
            streamQuery,
            {
              databaseId: savedConsole.databaseId,
              databaseName: savedConsole.databaseName,
              batchSize: Math.max(1, Math.min(10000, limit)),
              signal: input.signal,
              onBatch: emitRows,
              readOnly: true,
              labels,
            },
          ),
      }),
    };
  }

  const result = await databaseConnectionService.executeQuery(database, query, {
    databaseId: savedConsole.databaseId,
    databaseName: savedConsole.databaseName,
    readOnly: true,
    labels,
  });
  if (!result.success || !result.data) {
    return {
      ok: false,
      status: 500,
      error: result.error || "Query execution failed",
    };
  }

  const rows = Array.isArray(result.data) ? result.data : [];
  const limitedRows = rows.slice(0, limit);
  const fields = ((result.fields || []) as unknown[]).map(raw => {
    const f = raw as {
      name?: string;
      columnName?: string;
      type?: string;
      dataType?: string;
    };
    return {
      name: f.name || f.columnName || String(raw),
      type: f.type || f.dataType,
    };
  });
  if (fields.length === 0 && limitedRows.length > 0) {
    for (const key of Object.keys(limitedRows[0])) {
      fields.push({ name: key, type: undefined });
    }
  }

  const duration = Date.now() - startTime;
  if (format === "json") {
    return {
      ok: true,
      json: {
        success: true,
        data: limitedRows,
        fields,
        rowCount: limitedRows.length,
        durationMs: duration,
      },
    };
  }

  const { serializeToArrowIPC } = await import("../../utils/arrow-serializer");
  const arrowBuffer = serializeToArrowIPC(limitedRows, fields, { limit });
  return {
    ok: true,
    response: new Response(arrowBuffer, {
      headers: {
        "Content-Type": "application/vnd.apache.arrow.stream",
        "X-Row-Count": String(limitedRows.length),
        "X-Export-Duration-Ms": String(duration),
      },
    }),
  };
}
