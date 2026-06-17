/**
 * Server-side console execution
 *
 * Shared by:
 *   - POST /api/workspaces/:id/consoles/:id/execute (routes/consoles.ts)
 *   - the agent's server-side run_console tool (agent-lib/tools/server-console-tools.ts)
 *
 * Runs the console's saved code against its attached connection, tracks the
 * execution, persists a `lastRun` artifact on the SavedConsole (so results
 * survive detached agent sessions) and publishes console.run.completed on
 * the workspace realtime channel.
 */
import { Types } from "mongoose";
import {
  SavedConsole,
  type ISavedConsole,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import { databaseConnectionService } from "./database-connection.service";
import { getConnectionStore } from "../db/connection-store";
import {
  queryExecutionService,
  type QueryLanguage,
  type QueryStatus,
  type QuerySource,
} from "./query-execution.service";
import { publishRealtimeEvent } from "./realtime.service";
import { loggers } from "../logging";

const logger = loggers.query();

/** Caps applied to the persisted run artifact. */
const ARTIFACT_MAX_ROWS = 50;
const ARTIFACT_MAX_BYTES = 256 * 1024;

export interface ExecuteSavedConsoleInput {
  workspaceId: string;
  consoleId: string;
  userId: string;
  apiKeyId?: Types.ObjectId | string;
  source: QuerySource;
  /** Cancellation: pre-registered execution id + abort signal. */
  executionId?: string;
  signal?: AbortSignal;
}

export interface ExecuteSavedConsoleResult {
  success: boolean;
  /** Full result rows on success (NOT capped — caller decides what to keep). */
  rows: unknown[];
  rowCount: number;
  fields: unknown;
  error?: string;
  durationMs: number;
  console: { id: string; name: string; language: string };
}

function mapConsoleLanguageToQueryLanguage(
  language: "sql" | "javascript" | "mongodb",
): QueryLanguage {
  if (language === "mongodb") return "mongodb";
  if (language === "javascript") return "javascript";
  return "sql";
}

function classifyError(errorMessage: string | undefined): {
  status: QueryStatus;
  errorType: string;
} {
  const errorMsg = errorMessage?.toLowerCase() || "";
  if (errorMsg.includes("syntax")) {
    return { status: "error", errorType: "syntax" };
  }
  if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
    return { status: "timeout", errorType: "timeout" };
  }
  if (errorMsg.includes("cancel") || errorMsg.includes("abort")) {
    return { status: "cancelled", errorType: "cancelled" };
  }
  if (errorMsg.includes("connection") || errorMsg.includes("connect")) {
    return { status: "error", errorType: "connection" };
  }
  if (errorMsg.includes("permission") || errorMsg.includes("access denied")) {
    return { status: "error", errorType: "permission" };
  }
  return { status: "error", errorType: "unknown" };
}

/** Cap sample rows for the persisted artifact: row count first, bytes second. */
function capSampleRows(rows: unknown[]): unknown[] | undefined {
  let sample = rows.slice(0, ARTIFACT_MAX_ROWS);
  try {
    while (
      sample.length > 0 &&
      JSON.stringify(sample).length > ARTIFACT_MAX_BYTES
    ) {
      sample = sample.slice(0, Math.max(1, Math.floor(sample.length / 2)));
      if (sample.length === 1) {
        // A single row larger than the cap: drop samples entirely.
        if (JSON.stringify(sample).length > ARTIFACT_MAX_BYTES) {
          return undefined;
        }
        break;
      }
    }
  } catch {
    // Rows not serializable (circular/BSON edge) — skip the sample.
    return undefined;
  }
  return sample;
}

/**
 * Execute a saved console server-side and persist the run artifact.
 *
 * Access note: callers are responsible for read-access checks (route does
 * canReadWithInheritance; the agent tool does the same) — this service only
 * verifies workspace scoping.
 */
export async function executeSavedConsole(
  input: ExecuteSavedConsoleInput,
): Promise<ExecuteSavedConsoleResult> {
  const startTime = Date.now();
  const { workspaceId, consoleId, userId, source } = input;

  const fail = (
    error: string,
    savedConsole?: ISavedConsole | null,
  ): ExecuteSavedConsoleResult => ({
    success: false,
    rows: [],
    rowCount: 0,
    fields: null,
    error,
    durationMs: Date.now() - startTime,
    console: {
      id: consoleId,
      name: savedConsole?.name ?? "",
      language: savedConsole?.language ?? "sql",
    },
  });

  const savedConsole = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!savedConsole) {
    return fail("Console not found");
  }

  if (!savedConsole.code?.trim()) {
    return fail("Console is empty. Write a query first.", savedConsole);
  }

  if (!savedConsole.connectionId) {
    return fail("Console has no associated database connection", savedConsole);
  }

  const database: IDatabaseConnection | null =
    await getConnectionStore().findInWorkspace(
      String(savedConsole.connectionId),
      workspaceId,
    );
  if (!database) {
    return fail("Associated database not found or access denied", savedConsole);
  }

  const executionOptions = {
    databaseId: savedConsole.databaseId,
    databaseName: savedConsole.databaseName,
    executionId: input.executionId,
    signal: input.signal,
  };

  let result: {
    success: boolean;
    data?: unknown[];
    rowCount?: number;
    fields?: unknown;
    error?: string;
  };
  try {
    if (
      savedConsole.language === "mongodb" &&
      savedConsole.mongoOptions?.collection &&
      savedConsole.mongoOptions?.operation
    ) {
      const mongoQuery = {
        collection: savedConsole.mongoOptions.collection,
        operation: savedConsole.mongoOptions.operation,
        query: savedConsole.code,
      };
      result = (await databaseConnectionService.executeQuery(
        database,
        mongoQuery,
        { ...savedConsole.mongoOptions, ...executionOptions },
      )) as typeof result;
    } else {
      result = (await databaseConnectionService.executeQuery(
        database,
        savedConsole.code,
        executionOptions,
      )) as typeof result;
    }
  } catch (error) {
    result = {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to execute console",
    };
  }

  const durationMs = Date.now() - startTime;
  const rows = Array.isArray(result.data) ? result.data : [];
  const rowCount =
    result.rowCount ?? (Array.isArray(result.data) ? result.data.length : 0);

  const { status, errorType } = result.success
    ? { status: "success" as QueryStatus, errorType: undefined }
    : classifyError(result.error);

  // Update execution stats + persist the run artifact (capped).
  const lastRun: ISavedConsole["lastRun"] = {
    at: new Date(),
    status: result.success ? "success" : "error",
    rowCount: result.success ? rowCount : undefined,
    durationMs,
    error: result.success ? undefined : result.error || "Execution failed",
    sampleRows: result.success ? capSampleRows(rows) : undefined,
    fields: result.success ? (result.fields ?? undefined) : undefined,
    runBy: userId,
    source: String(source),
  };
  try {
    await SavedConsole.updateOne(
      { _id: savedConsole._id },
      {
        $set: { lastExecutedAt: new Date(), lastRun },
        // The run artifact is part of the replicated draft state: bumping
        // the revision lets revisions-sync deliver it to windows that
        // missed the console.run.completed event (reconnect, tab focus).
        $inc: { executionCount: 1, draftRevision: 1 },
      },
    );
  } catch (error) {
    logger.warn("Failed to persist console run artifact", {
      error,
      consoleId,
      workspaceId,
    });
  }

  // Track query execution (fire-and-forget)
  queryExecutionService.track({
    userId,
    apiKeyId: input.apiKeyId,
    workspaceId: new Types.ObjectId(workspaceId),
    connectionId: database._id,
    databaseName: savedConsole.databaseName || database.connection.database,
    consoleId: savedConsole._id,
    source,
    databaseType: database.type,
    queryLanguage: mapConsoleLanguageToQueryLanguage(savedConsole.language),
    status,
    executionTimeMs: durationMs,
    rowCount: result.success ? rowCount : undefined,
    errorType,
  });

  // Poke attached windows: open tabs render the run artifact immediately.
  publishRealtimeEvent(workspaceId, {
    type: "console.run.completed",
    consoleId,
    status: result.success ? "success" : "error",
    rowCount: result.success ? rowCount : undefined,
    durationMs,
    error: result.success ? undefined : result.error,
  });

  return {
    success: result.success,
    rows,
    rowCount,
    fields: result.fields ?? null,
    error: result.success ? undefined : result.error || "Execution failed",
    durationMs,
    console: {
      id: savedConsole._id.toString(),
      name: savedConsole.name,
      language: savedConsole.language,
    },
  };
}
