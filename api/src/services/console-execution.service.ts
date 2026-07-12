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
  DatabaseConnection,
  type ISavedConsole,
  type IDatabaseConnection,
} from "../database/workspace-schema";
import { databaseConnectionService } from "./database-connection.service";
import {
  queryExecutionService,
  type QueryLanguage,
  type QueryStatus,
  type QuerySource,
} from "./query-execution.service";
import { publishRealtimeEvent } from "./realtime.service";
import { loggers } from "../logging";
import { QUERY_HARD_MAX_EXECUTION_MS } from "../config/long-running-queries";

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
  /** Enforce read-only execution at the database connection layer. */
  readOnly?: boolean;
}

export interface ExecuteSavedConsoleResult {
  success: boolean;
  /** Full result rows on success (NOT capped — caller decides what to keep). */
  rows: unknown[];
  rowCount: number;
  fields: unknown;
  error?: string;
  durationMs: number;
  /** Final run status (mirrors the persisted lastRun.status). */
  status: "success" | "error" | "cancelled";
  console: { id: string; name: string; language: string };
}

export interface StartDetachedConsoleRunInput extends ExecuteSavedConsoleInput {
  /** Required for a detached run: used to poll/cancel via lastRun. */
  executionId: string;
}

export type StartDetachedConsoleRunResult =
  | { started: false; error: string; console: { id: string; name: string } }
  | {
      started: true;
      executionId: string;
      console: { id: string; name: string; language: string };
      /**
       * Resolves when the detached task settles. The task persists its own
       * final artifact + realtime event regardless of whether anyone awaits
       * this — awaiting is only used to return rows inline within the soft
       * timeout. Never rejects.
       */
      completion: Promise<ExecuteSavedConsoleResult>;
    };

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

type ResolvedConsoleRun =
  | { ok: true; savedConsole: ISavedConsole; database: IDatabaseConnection }
  | { ok: false; error: string; savedConsole?: ISavedConsole | null };

/**
 * Load + validate the console and its connection. Shared by the inline and
 * detached run paths. Access note: callers are responsible for read-access
 * checks (route does canReadWithInheritance; the agent tool does the same) —
 * this service only verifies workspace scoping.
 */
async function resolveConsoleForRun(
  input: ExecuteSavedConsoleInput,
): Promise<ResolvedConsoleRun> {
  const { workspaceId, consoleId } = input;

  const savedConsole = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!savedConsole) {
    return { ok: false, error: "Console not found" };
  }
  if (!savedConsole.code?.trim()) {
    return {
      ok: false,
      error: "Console is empty. Write a query first.",
      savedConsole,
    };
  }
  if (!savedConsole.connectionId) {
    return {
      ok: false,
      error: "Console has no associated database connection",
      savedConsole,
    };
  }

  const database: IDatabaseConnection | null = await DatabaseConnection.findOne(
    {
      _id: savedConsole.connectionId,
      workspaceId: new Types.ObjectId(workspaceId),
    },
  );
  if (!database) {
    return {
      ok: false,
      error: "Associated database not found or access denied",
      savedConsole,
    };
  }

  return { ok: true, savedConsole, database };
}

/**
 * Execute the (already-resolved) console query, persist the final run
 * artifact, track it, and publish the realtime event. This is the body that
 * runs to completion in BOTH the inline and detached paths — it never depends
 * on whether a tool call is still awaiting it.
 */
async function runResolvedConsole(args: {
  savedConsole: ISavedConsole;
  database: IDatabaseConnection;
  input: ExecuteSavedConsoleInput;
  startTime: number;
  /** Detached correlation: persisted on lastRun so it can be polled/cancelled. */
  startedAt?: Date;
  bigQueryJobMaxWaitMs?: number;
}): Promise<ExecuteSavedConsoleResult> {
  const { savedConsole, database, input, startTime, startedAt } = args;
  const { workspaceId, consoleId, userId, source } = input;

  const executionOptions = {
    databaseId: savedConsole.databaseId,
    databaseName: savedConsole.databaseName,
    executionId: input.executionId,
    signal: input.signal,
    bigQueryJobMaxWaitMs: args.bigQueryJobMaxWaitMs,
    readOnly: input.readOnly,
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

  // A cancelled/aborted run (explicit Stop, user cancel, or the hard cap)
  // gets its own status so the UI/agent don't treat it as a failure.
  const wasCancelled =
    !result.success &&
    (input.signal?.aborted === true || status === "cancelled");
  const finalStatus: "success" | "error" | "cancelled" = result.success
    ? "success"
    : wasCancelled
      ? "cancelled"
      : "error";

  // Update execution stats + persist the run artifact (capped).
  const lastRun: ISavedConsole["lastRun"] = {
    at: new Date(),
    status: finalStatus,
    rowCount: result.success ? rowCount : undefined,
    durationMs,
    error: result.success ? undefined : result.error || "Execution failed",
    sampleRows: result.success ? capSampleRows(rows) : undefined,
    fields: result.success ? (result.fields ?? undefined) : undefined,
    runBy: userId,
    source: String(source),
    startedAt,
    executionId: input.executionId,
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
  // The realtime event contract is success|error; the precise cancelled
  // status lives on the persisted lastRun for the agent's check_query_status.
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
    status: finalStatus,
    console: {
      id: savedConsole._id.toString(),
      name: savedConsole.name,
      language: savedConsole.language,
    },
  };
}

/**
 * Execute a saved console server-side and persist the run artifact, awaiting
 * the full result. Kept for callers that want the simple inline behavior.
 */
export async function executeSavedConsole(
  input: ExecuteSavedConsoleInput,
): Promise<ExecuteSavedConsoleResult> {
  const startTime = Date.now();
  const resolved = await resolveConsoleForRun(input);
  if (!resolved.ok) {
    return {
      success: false,
      rows: [],
      rowCount: 0,
      fields: null,
      error: resolved.error,
      durationMs: Date.now() - startTime,
      status: "error",
      console: {
        id: input.consoleId,
        name: resolved.savedConsole?.name ?? "",
        language: resolved.savedConsole?.language ?? "sql",
      },
    };
  }

  return runResolvedConsole({
    savedConsole: resolved.savedConsole,
    database: resolved.database,
    input,
    startTime,
  });
}

/**
 * Start a console run as a detached in-process task that OUTLIVES the agent
 * tool call. Persists `lastRun.status = "running"` up front, registers an
 * abort handle (cancellable by executionId from any turn or by the hard cap),
 * and launches the execution. The returned `completion` promise lets the
 * caller return rows inline if the query finishes within its soft timeout;
 * otherwise the task keeps running and persists its own final artifact +
 * realtime event. Works for every engine (no re-attach, no Inngest).
 */
export async function startDetachedConsoleRun(
  input: StartDetachedConsoleRunInput,
): Promise<StartDetachedConsoleRunResult> {
  const startTime = Date.now();
  const startedAt = new Date(startTime);
  const { workspaceId, consoleId, userId, source, executionId } = input;

  const resolved = await resolveConsoleForRun(input);
  if (!resolved.ok) {
    return {
      started: false,
      error: resolved.error,
      console: { id: consoleId, name: resolved.savedConsole?.name ?? "" },
    };
  }
  const { savedConsole, database } = resolved;

  // Dedicated controller for the detached task: cancellable by executionId
  // (cancelQuery aborts it + the engine-native cancel) and by the hard cap.
  // Link the caller's signal (the turn signal) so an explicit Stop during the
  // starting turn cancels too.
  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort();
    } else {
      input.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  databaseConnectionService.registerDetachedExecution(executionId, {
    abortController: controller,
    consoleId,
    workspaceId,
  });

  // Persist the running marker so check_query_status (DB-backed,
  // cross-instance) can report progress before the task completes.
  const runningMarker: ISavedConsole["lastRun"] = {
    at: startedAt,
    status: "running",
    durationMs: 0,
    runBy: userId,
    source: String(source),
    startedAt,
    executionId,
  };
  try {
    await SavedConsole.updateOne(
      { _id: savedConsole._id },
      {
        $set: { lastExecutedAt: startedAt, lastRun: runningMarker },
        $inc: { draftRevision: 1 },
      },
    );
  } catch (error) {
    logger.warn("Failed to persist console running marker", {
      error,
      consoleId,
      workspaceId,
    });
  }

  // Server-side hard cap: abort a runaway query (task + engine-native cancel).
  const hardCapTimer = setTimeout(() => {
    logger.warn("Console run exceeded hard max execution; cancelling", {
      consoleId,
      workspaceId,
      executionId,
      hardMaxMs: QUERY_HARD_MAX_EXECUTION_MS,
    });
    void databaseConnectionService.cancelQuery(executionId);
  }, QUERY_HARD_MAX_EXECUTION_MS);
  hardCapTimer.unref?.();

  const completion = runResolvedConsole({
    savedConsole,
    database,
    input: { ...input, signal: controller.signal },
    startTime,
    startedAt,
    // Poll BigQuery up to the hard cap so a detached BQ job runs long instead
    // of capping at the interactive 5-minute default.
    bigQueryJobMaxWaitMs: QUERY_HARD_MAX_EXECUTION_MS,
  })
    .catch(
      (error): ExecuteSavedConsoleResult => ({
        success: false,
        rows: [],
        rowCount: 0,
        fields: null,
        error:
          error instanceof Error
            ? error.message
            : "Detached console run failed",
        durationMs: Date.now() - startTime,
        status: "error",
        console: {
          id: savedConsole._id.toString(),
          name: savedConsole.name,
          language: savedConsole.language,
        },
      }),
    )
    .finally(() => {
      clearTimeout(hardCapTimer);
      databaseConnectionService.releaseDetachedExecution(executionId);
    });

  return {
    started: true,
    executionId,
    console: {
      id: savedConsole._id.toString(),
      name: savedConsole.name,
      language: savedConsole.language,
    },
    completion,
  };
}

/**
 * Cancel a detached console run by executionId: aborts the in-process task and
 * triggers the engine-native cancel. The task's own finalizer then persists
 * the cancelled artifact + realtime event.
 */
export async function cancelDetachedConsoleRun(
  executionId: string,
): Promise<{ success: boolean; error?: string }> {
  return databaseConnectionService.cancelQuery(executionId);
}
