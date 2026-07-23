/**
 * Server-side console tools (issue #475)
 *
 * Console data operations (read/modify/create/connect/run/open) execute on
 * the API against the authoritative SavedConsole draft instead of in the
 * browser. The agent becomes "just another window": every write is a
 * revision-checked draft update that bumps `draftRevision` and pokes the
 * workspace realtime channel, so attached tabs update live — and detached
 * chats keep working end-to-end because the SSE stream no longer has to
 * split to hand control to a browser.
 *
 * Tool schemas stay in @mako/agent-tools (single source of truth shared
 * with the app's tool cards); the modification engine is the same
 * applyModification used by Monaco.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import {
  modifyConsoleSchema,
  readConsoleSchema,
  createConsoleSchema,
  setConsoleConnectionSchema,
  openConsoleSchema,
  runConsoleSchema,
  checkQueryStatusSchema,
  cancelQueryStatusSchema,
  listConsoleExecutionsSchema,
  applyModification,
  buildModificationDiff,
  type ConsoleModification,
} from "@mako/agent-tools";
import {
  SavedConsole,
  DatabaseConnection,
  type ISavedConsole,
} from "../../database/workspace-schema";
import { ConsoleManager } from "../../utils/console-manager";
import { workspaceService } from "../../services/workspace.service";
import { publishRealtimeEvent } from "../../services/realtime.service";
import {
  startDetachedConsoleRun,
  cancelDetachedConsoleRun,
} from "../../services/console-execution.service";
import { queryExecutionService } from "../../services/query-execution.service";
import { queryExecutionSourceLabel } from "../../services/query-execution-source";
import {
  MONGO_QUERY_WRITE_SCOPE_REQUIRED,
  sqlReadOnlyAccessError,
} from "../../services/read-only-query.service";
import type { QueryAccess } from "../../auth/api-key-scopes";
import type { AgentToolExecutionContext } from "../../agents/types";
import {
  QUERY_SOFT_TIMEOUT_MS,
  QUERY_HARD_MAX_EXECUTION_MS,
  QUERY_STATUS_POLL_WAIT_MS,
  QUERY_STATUS_POLL_INTERVAL_MS,
} from "../../config/long-running-queries";
import { pollRunStatus } from "./check-query-status-poll";
import { loggers } from "../../logging";

const logger = loggers.agent();

const RUN_PREVIEW_MAX_ROWS = 50;

/**
 * A console's `name` is the canonical LEAF display name (folder placement is
 * `folderId`, never the name). Keep agent-set names as leaves so the agent
 * cannot reintroduce slash-delimited "paths" into the name field — the UI
 * shows `name` verbatim as the title/breadcrumb leaf/tree row.
 */
function leafConsoleName(raw: string | undefined): string {
  const value = raw ?? "";
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

const consoleManager = new ConsoleManager();

export interface ServerConsoleToolsOptions {
  workspaceId: string;
  /** Acting user (session user id, or API-key creator). */
  userId?: string;
  executionContext?: AgentToolExecutionContext;
  /** Chat driving this turn — used as the realtime echo-suppression id. */
  chatId?: string;
  /** Database capability granted by the calling API key. */
  queryAccess?: QueryAccess;
  /**
   * Where these tools are hosted. MCP is an external surface and updates
   * lastExternalUsedAt; in-product agent stays internal (`agent`).
   */
  surface?: "agent" | "mcp";
}

interface LoadedConsole {
  doc: ISavedConsole;
}

type LoadResult = LoadedConsole | { error: string };

function isLoadError(r: LoadResult): r is { error: string } {
  return (r as { error?: string }).error !== undefined;
}

/** Format content with right-aligned line-number prefixes ("  1| code"). */
function withLineNumbers(rawContent: string): {
  content: string;
  totalLines: number;
} {
  const lines = (rawContent || "").split("\n");
  const totalLines = lines.length;
  const width = String(totalLines).length;
  return {
    content: lines
      .map((line, index) => `${String(index + 1).padStart(width)}| ${line}`)
      .join("\n"),
    totalLines,
  };
}

export function createServerConsoleTools({
  workspaceId,
  userId,
  executionContext,
  chatId,
  queryAccess = "write",
  surface = "agent",
}: ServerConsoleToolsOptions) {
  const agentClientId = `agent:${chatId ?? "unknown"}`;
  const runSource = surface === "mcp" ? ("mcp" as const) : ("agent" as const);

  const loadConsole = async (consoleId: string): Promise<LoadResult> => {
    if (!consoleId) {
      return {
        error:
          "consoleId is required. Use list_open_consoles or search_consoles to find console IDs, or create_console to create a new one.",
      };
    }
    if (!Types.ObjectId.isValid(consoleId)) {
      return { error: `Invalid console ID: ${consoleId}` };
    }
    const doc = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    });
    if (!doc) {
      return {
        error: `Console with ID ${consoleId} not found. Use list_open_consoles or search_consoles to see available consoles.`,
      };
    }
    if (userId && !(await consoleManager.canReadWithInheritance(doc, userId))) {
      return {
        error: `Console with ID ${consoleId} not found. Use list_open_consoles or search_consoles to see available consoles.`,
      };
    }
    return { doc };
  };

  const canWrite = async (doc: ISavedConsole): Promise<boolean> => {
    if (!userId) return true; // workspace-scoped API-key automation
    let isAdmin = false;
    try {
      const member = await workspaceService.getMember(workspaceId, userId);
      isAdmin = member?.role === "owner" || member?.role === "admin";
    } catch {
      isAdmin = false;
    }
    return ConsoleManager.canWrite(doc, userId, isAdmin);
  };

  const publishUpdated = (doc: ISavedConsole) => {
    publishRealtimeEvent(workspaceId, {
      type: "console.updated",
      consoleId: doc._id.toString(),
      draftRevision: doc.draftRevision ?? 1,
      name: doc.name,
      updatedBy: userId ?? "agent",
      clientId: agentClientId,
      origin: "agent",
    });
  };

  const publishOpenIntent = (consoleId: string) => {
    if (!chatId) return;
    publishRealtimeEvent(workspaceId, {
      type: "chat.ui-intent",
      chatId,
      intent: "open_console",
      consoleId,
    });
  };

  return {
    read_console: tool({
      description:
        "Read the contents of a console by ID (server-authoritative copy). Returns content with line numbers prefixed (e.g., '  1| code here'), totalLines, and database connection info. Line numbers are for REFERENCE ONLY to help identify patch ranges. Reading is allowed for any access level (private or workspace) as long as the console is visible to you.",
      inputSchema: readConsoleSchema,
      execute: async ({ consoleId }) => {
        try {
          const loaded = await loadConsole(consoleId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (surface === "mcp") {
            void consoleManager.recordExternalUse(
              doc._id.toString(),
              workspaceId,
              "mcp",
              "access",
            );
          }
          const { content, totalLines } = withLineNumbers(doc.code);
          return {
            success: true,
            consoleId: doc._id.toString(),
            title: doc.name,
            content,
            totalLines,
            connectionId: doc.connectionId?.toString(),
            databaseId: doc.databaseId,
            databaseName: doc.databaseName,
            language: doc.language,
            draftRevision: doc.draftRevision ?? 1,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : "Failed to read console",
          };
        }
      },
    }),

    modify_console: tool({
      description:
        "Modify a console's content by ID (applied server-side to the authoritative draft; open windows update live). Actions: 'replace' (full content), 'patch' (specific lines - preferred for small edits, requires startLine/endLine), 'insert' (at position), 'append' (to end). IMPORTANT for 'patch': (1) Line numbers are 1-indexed and inclusive. (2) Your patch content must NOT include line number prefixes - only the actual code. (3) Include ALL lines being replaced in your content, including braces and structural elements. ACCESS NOTE: If the console is read-only (workspace console you don't own and you're not an admin), modification will be rejected — create a copy with create_console instead.",
      inputSchema: modifyConsoleSchema,
      execute: async input => {
        try {
          const { action, content, consoleId, title } = input;

          // Some tool-calling models serialize numeric/nullable fields as
          // strings; coerce so those calls aren't rejected.
          const coerceOptionalNumber = (raw: unknown): number | undefined => {
            if (raw === undefined || raw === null) return undefined;
            if (typeof raw === "number") {
              return Number.isFinite(raw) ? raw : undefined;
            }
            if (typeof raw === "string") {
              const trimmed = raw.trim();
              if (trimmed === "" || trimmed.toLowerCase() === "null") {
                return undefined;
              }
              const parsed = Number(trimmed);
              return Number.isFinite(parsed) ? parsed : undefined;
            }
            return undefined;
          };
          const position = coerceOptionalNumber(input.position);
          const startLine = coerceOptionalNumber(input.startLine);
          const endLine = coerceOptionalNumber(input.endLine);

          if (action === "insert" && position === undefined) {
            return {
              success: false,
              error: "Position is required for insert action",
            };
          }
          if (action === "patch" && (!startLine || !endLine)) {
            return {
              success: false,
              error:
                "startLine and endLine are required for patch action. Use read_console first to see line numbers.",
            };
          }

          const modification: ConsoleModification = {
            action,
            content,
            position:
              position !== undefined
                ? { line: position, column: 1 }
                : undefined,
            startLine,
            endLine,
          };

          // Revision-checked write with one retry: the agent is normally a
          // sequential writer, so a miss means a user typed concurrently —
          // re-read once and re-apply; a second miss surfaces to the model.
          for (let attempt = 0; attempt < 2; attempt++) {
            const loaded = await loadConsole(consoleId);
            if (isLoadError(loaded)) return { success: false, ...loaded };
            const { doc } = loaded;

            if (!(await canWrite(doc))) {
              return {
                success: false,
                error:
                  "This console is shared as read-only. Use create_console to create a copy with the desired changes instead.",
              };
            }

            const currentContent = doc.code || "";
            const newContent = applyModification(currentContent, modification);
            const diff = buildModificationDiff(currentContent, modification);
            const currentRevision = doc.draftRevision ?? 1;

            const setFields: Record<string, unknown> = {
              code: newContent,
              updatedAt: new Date(),
              // Mark agent origin so a reconnecting client surfaces this as a
              // reviewable diff even if it missed the realtime poke.
              lastDraftOrigin: "agent",
              // Set the next revision explicitly (instead of $inc) so the bump
              // is null-safe. Legacy consoles have no draftRevision field; the
              // Mongoose schema default reports it as 1, but `$inc` on the
              // absent DB field also yields 1 — colliding with the value the
              // client already holds, so revisions-sync saw "no change" and the
              // first agent edit/rename never reached the open tab. currentRevision
              // is the schema-defaulted value (1 for legacy), so +1 always
              // exceeds what the client has.
              draftRevision: currentRevision + 1,
            };
            if (title) setFields.name = leafConsoleName(title) || title;

            const updated = await SavedConsole.findOneAndUpdate(
              {
                _id: doc._id,
                workspaceId: new Types.ObjectId(workspaceId),
                draftRevision:
                  currentRevision === 1 ? { $in: [1, null] } : currentRevision,
              },
              { $set: setFields },
              { new: true },
            );

            if (!updated) {
              logger.debug("modify_console revision race, retrying", {
                consoleId,
                attempt,
              });
              continue;
            }

            publishUpdated(updated);
            return {
              success: true,
              consoleId,
              title: title ?? updated.name,
              diff,
              draftRevision: updated.draftRevision ?? 1,
              message: `Console ${action}${action === "patch" ? "ed" : "d"} successfully`,
            };
          }

          return {
            success: false,
            error:
              "Console changed concurrently while applying the modification (someone is editing it). Use read_console to get the latest content and retry.",
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to modify console",
          };
        }
      },
    }),

    create_console: tool({
      description:
        "Create a new console with the specified content (created server-side as a draft; open windows of this chat get a tab for it). Returns a consoleId that you MUST pass to modify_console when writing to this new console. The new console will be owned by the current user with private access by default.",
      inputSchema: createConsoleSchema,
      execute: async input => {
        try {
          const { title, content } = input;
          const connectionId = input.connectionId ?? undefined;
          const databaseId = input.databaseId ?? undefined;
          const databaseName = input.databaseName ?? undefined;

          let language: "sql" | "javascript" | "mongodb" = "sql";
          if (connectionId) {
            if (!Types.ObjectId.isValid(connectionId)) {
              return {
                success: false,
                error: `Invalid connectionId: ${connectionId}`,
              };
            }
            const connection = await DatabaseConnection.findOne({
              _id: new Types.ObjectId(connectionId),
              workspaceId: new Types.ObjectId(workspaceId),
            }).select("type");
            if (!connection) {
              return {
                success: false,
                error: `Connection ${connectionId} not found in this workspace. Use list_connections to see available connections.`,
              };
            }
            if (connection.type === "mongodb") language = "javascript";
          }

          const doc = await SavedConsole.create({
            workspaceId: new Types.ObjectId(workspaceId),
            name: leafConsoleName(title) || "Untitled",
            code: content || "",
            language,
            connectionId: connectionId
              ? new Types.ObjectId(connectionId)
              : undefined,
            databaseId,
            databaseName,
            createdBy: userId ?? "agent",
            owner_id: userId ?? "agent",
            isPrivate: true,
            access: "private",
            isSaved: false,
            draftRevision: 1,
            lastDraftOrigin: "agent",
            executionCount: 0,
          });

          publishUpdated(doc);
          publishOpenIntent(doc._id.toString());

          return {
            success: true,
            _eventType: "console_creation",
            consoleId: doc._id.toString(),
            title: doc.name,
            content: doc.code,
            connectionId: connectionId,
            databaseId,
            databaseName,
            message: `✓ New console "${doc.name}" created successfully`,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to create console",
          };
        }
      },
    }),

    set_console_connection: tool({
      description:
        "Attach a console to a database connection, or change its current attachment (applied server-side; open windows update live). Use this when you need to run queries against a different database than what the console is currently attached to. After setting the connection, you can use run_console to execute queries against that database.",
      inputSchema: setConsoleConnectionSchema,
      execute: async ({
        consoleId,
        connectionId,
        databaseId,
        databaseName,
      }) => {
        try {
          const loaded = await loadConsole(consoleId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;

          if (!(await canWrite(doc))) {
            return {
              success: false,
              error:
                "This console is shared as read-only. Use create_console to create a copy instead.",
            };
          }

          if (!Types.ObjectId.isValid(connectionId)) {
            return {
              success: false,
              error: `Invalid connectionId: ${connectionId}`,
            };
          }
          const connection = await DatabaseConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          }).select("type name");
          if (!connection) {
            return {
              success: false,
              error: `Connection ${connectionId} not found in this workspace. Use list_connections to see available connections.`,
            };
          }

          const updated = await SavedConsole.findOneAndUpdate(
            { _id: doc._id, workspaceId: new Types.ObjectId(workspaceId) },
            {
              $set: {
                connectionId: new Types.ObjectId(connectionId),
                databaseId,
                databaseName,
                updatedAt: new Date(),
                // Null-safe bump (see modify_console): the schema default
                // reports a legacy console's revision as 1 while `$inc` on the
                // absent field also yields 1, so set the next value explicitly.
                draftRevision: (doc.draftRevision ?? 1) + 1,
              },
            },
            { new: true },
          );
          if (!updated) {
            return { success: false, error: "Console not found" };
          }

          publishUpdated(updated);
          return {
            success: true,
            consoleId,
            connectionId,
            databaseId,
            databaseName,
            message: `Console "${updated.name}" attached to connection ${connection.name}${databaseName ? ` (database: ${databaseName})` : ""}`,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to set console connection",
          };
        }
      },
    }),

    open_console: tool({
      description:
        "Open a saved or draft console by its ID. Use after search_consoles to let the user see and interact with a found console. Attached windows of this chat open it as a tab immediately; when nobody is attached the console reopens with the chat. Also returns the console's current content so you can keep working with it.",
      inputSchema: openConsoleSchema,
      execute: async ({ consoleId }) => {
        try {
          const loaded = await loadConsole(consoleId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;

          publishOpenIntent(doc._id.toString());

          const raw = doc.code || "";
          const preview =
            raw.length > 2000 ? `${raw.slice(0, 2000)}\n... (truncated)` : raw;
          return {
            success: true,
            consoleId: doc._id.toString(),
            title: doc.name,
            contentPreview: preview,
            connectionId: doc.connectionId?.toString(),
            databaseName: doc.databaseName,
            message: `Console "${doc.name}" opened successfully.`,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : "Failed to open console",
          };
        }
      },
    }),

    run_console: tool({
      description:
        "Execute the query currently in a console (runs server-side against the console's attached connection; results appear in open windows and are saved on the console). Use this AFTER modify_console to get results. The console must be connected to a database. " +
        'The query runs as a detached server-side task: if it finishes quickly you get the rows back immediately; if it is still running after a short soft timeout you get { status: "running", executionId } and the query KEEPS RUNNING — poll check_query_status to fetch the result, and cancel_query to stop it.',
      inputSchema: runConsoleSchema,
      execute: async ({ consoleId }) => {
        const loaded = await loadConsole(consoleId);
        if (isLoadError(loaded)) return { success: false, ...loaded };
        const { doc } = loaded;

        if (!doc.code?.trim()) {
          return {
            success: false,
            error:
              "Console is empty. Write a query first using modify_console.",
          };
        }
        if (!doc.connectionId) {
          return {
            success: false,
            error:
              "Console has no database connection. Use set_console_connection to attach one first.",
          };
        }
        if (queryAccess === "none") {
          return {
            success: false,
            error: "This API key does not have query access.",
          };
        }
        if (queryAccess === "read") {
          const connection = await DatabaseConnection.findOne({
            _id: doc.connectionId,
            workspaceId: new Types.ObjectId(workspaceId),
          }).select("type");
          if (!connection) {
            return {
              success: false,
              error: "Console database connection was not found.",
            };
          }
          if (connection.type === "mongodb" || doc.language !== "sql") {
            return {
              success: false,
              error: MONGO_QUERY_WRITE_SCOPE_REQUIRED,
            };
          }
          const accessError = sqlReadOnlyAccessError(doc.code);
          if (accessError) {
            return { success: false, error: accessError };
          }
        }

        // Register with the turn's execution registry so an explicit Stop (or
        // turn abort) during THIS turn cancels the query. We deliberately do
        // NOT release it on the soft-timeout path: the detached task outlives
        // the tool call, and across later turns it is cancelled by executionId
        // via cancel_query.
        const executionId =
          executionContext?.createExecutionId("run_console") ??
          `run_console_${Date.now()}`;
        executionContext?.registerExecution(executionId);

        let started: Awaited<ReturnType<typeof startDetachedConsoleRun>>;
        try {
          started = await startDetachedConsoleRun({
            workspaceId,
            consoleId,
            userId: userId ?? "agent",
            source: runSource,
            executionId,
            signal: executionContext?.signal,
            readOnly: queryAccess === "read",
          });
        } catch (error) {
          executionContext?.releaseExecution(executionId);
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Query execution failed unexpectedly.",
          };
        }

        if (!started.started) {
          executionContext?.releaseExecution(executionId);
          return { success: false, error: started.error };
        }

        // Await up to the soft timeout. If the query finishes, return rows as
        // before; otherwise leave it running and tell the agent to poll.
        const TIMED_OUT = Symbol("soft-timeout");
        let softTimer: ReturnType<typeof setTimeout> | undefined;
        const softTimeout = new Promise<typeof TIMED_OUT>(resolve => {
          softTimer = setTimeout(
            () => resolve(TIMED_OUT),
            QUERY_SOFT_TIMEOUT_MS,
          );
        });

        try {
          const outcome = await Promise.race([started.completion, softTimeout]);

          if (outcome === TIMED_OUT) {
            return {
              success: true,
              status: "running" as const,
              executionId,
              consoleId,
              elapsedMs: QUERY_SOFT_TIMEOUT_MS,
              message:
                `Query is still running after ${Math.round(QUERY_SOFT_TIMEOUT_MS / 1000)}s and keeps running server-side. ` +
                `Call check_query_status (consoleId="${consoleId}", executionId="${executionId}") to get the result — it blocks server-side until the query finishes (no need to wait or poll rapidly yourself). Do not re-run the query.`,
            };
          }

          // Completed within the soft timeout — release the turn registration.
          executionContext?.releaseExecution(executionId);

          if (outcome.status === "cancelled") {
            return {
              success: false,
              status: "cancelled" as const,
              error: outcome.error || "Query was cancelled.",
            };
          }
          if (!outcome.success) {
            return {
              success: false,
              error: outcome.error || "Query execution failed.",
            };
          }
          return {
            success: true,
            status: "success" as const,
            rowCount: outcome.rowCount,
            preview: outcome.rows.slice(0, RUN_PREVIEW_MAX_ROWS),
            durationMs: outcome.durationMs,
            message: `Query executed successfully. ${outcome.rowCount} row(s) returned.`,
          };
        } finally {
          if (softTimer) clearTimeout(softTimer);
        }
      },
    }),

    check_query_status: tool({
      description:
        'Poll the status of a console query started with run_console (DB-backed, works across server instances). Returns { status: "running", elapsedMs } while it runs, { status: "success", rowCount, preview } when it finishes, { status: "error", error }, or { status: "cancelled" }. ' +
        `This call BLOCKS server-side for up to ~${Math.round(QUERY_STATUS_POLL_WAIT_MS / 1000)}s, returning the instant the query settles — so you do NOT need to (and must NOT) add your own delay or spam rapid calls. After run_console returns status="running", just call this again; if it returns status="running" again, call it once more to keep waiting. ` +
        `The query is automatically aborted server-side at a hard cap (~${Math.round(QUERY_HARD_MAX_EXECUTION_MS / 60_000)} min); if that happens, rewrite it into smaller/narrower queries rather than retrying as-is. Never silently re-run the query while it is still running.`,
      inputSchema: checkQueryStatusSchema,
      execute: async ({ consoleId, executionId }) =>
        // Long-poll: an LLM cannot sleep between tool calls, so if this returned
        // instantly while the query is "running" the model re-invokes it every
        // ~1s — flooding the chat UI (see the rapid-poll incident this fixes).
        // pollRunStatus blocks (re-reading the DB-backed run artifact) until the
        // run settles or the wait window elapses. The query keeps running
        // server-side either way (hard cap still applies); we only throttle how
        // often the agent gets a turn back.
        pollRunStatus({
          readRun: async () => {
            const loaded = await loadConsole(consoleId);
            if (isLoadError(loaded)) return { ok: false, error: loaded.error };
            return { ok: true, lastRun: loaded.doc.lastRun };
          },
          executionId,
          waitMs: QUERY_STATUS_POLL_WAIT_MS,
          intervalMs: QUERY_STATUS_POLL_INTERVAL_MS,
          signal: executionContext?.signal,
          previewMaxRows: RUN_PREVIEW_MAX_ROWS,
        }),
    }),

    cancel_query: tool({
      description:
        'Cancel a console query that is still running (started with run_console and currently status="running"). Aborts the detached server-side task and issues the engine-native cancel (Postgres pid, Mongo session, ClickHouse query_id, MSSQL request, BigQuery job). Use this when the user chooses to stop waiting.',
      inputSchema: cancelQueryStatusSchema,
      execute: async ({ consoleId, executionId }) => {
        const loaded = await loadConsole(consoleId);
        if (isLoadError(loaded)) return { success: false, ...loaded };

        try {
          const result = await cancelDetachedConsoleRun(executionId);
          if (!result.success) {
            return {
              success: false,
              error:
                result.error ||
                "Query not found or already completed (it may have just finished — check_query_status to confirm).",
            };
          }
          return {
            success: true,
            message:
              "Cancellation requested. The query is being stopped; check_query_status will report it as cancelled or completed.",
          };
        } catch (error) {
          logger.warn("cancel_query failed", { error, consoleId, executionId });
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to cancel query.",
          };
        }
      },
    }),

    list_console_executions: tool({
      description:
        "List recent query executions for a console. Each row includes source (raw) and sourceLabel (App UI / API key / MCP / AI agent / Schedule / Flow). Use sourceLabel when explaining to the user; source api|mcp means external. History is retained for ~90 days.",
      inputSchema: listConsoleExecutionsSchema,
      execute: async ({ consoleId, limit }) => {
        try {
          const loaded = await loadConsole(consoleId);
          if (isLoadError(loaded)) return { success: false, ...loaded };

          const executions = await queryExecutionService.getConsoleExecutions(
            workspaceId,
            consoleId,
            { limit: limit ?? 10 },
          );

          return {
            success: true,
            consoleId,
            executions: executions.map(execution => ({
              id: execution._id.toString(),
              executedAt: execution.executedAt,
              source: execution.source,
              sourceLabel: queryExecutionSourceLabel(execution.source),
              status: execution.status,
              executionTimeMs: execution.executionTimeMs,
              rowCount: execution.rowCount ?? null,
              errorType: execution.errorType ?? null,
              apiKeyId: execution.apiKeyId
                ? execution.apiKeyId.toString()
                : null,
              databaseType: execution.databaseType,
              queryLanguage: execution.queryLanguage,
            })),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to list console executions",
          };
        }
      },
    }),
  };
}
