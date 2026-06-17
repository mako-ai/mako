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
import { executeSavedConsole } from "../../services/console-execution.service";
import type { AgentToolExecutionContext } from "../../agents/types";
import { databaseConnectionService } from "../../services/database-connection.service";
import { loggers } from "../../logging";

const logger = loggers.agent();

const RUN_CONSOLE_TIMEOUT_MS = 120_000;
const RUN_PREVIEW_MAX_ROWS = 50;

const consoleManager = new ConsoleManager();

export interface ServerConsoleToolsOptions {
  workspaceId: string;
  /** Acting user (session user id, or API-key creator). */
  userId?: string;
  executionContext?: AgentToolExecutionContext;
  /** Chat driving this turn — used as the realtime echo-suppression id. */
  chatId?: string;
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
}: ServerConsoleToolsOptions) {
  const agentClientId = `agent:${chatId ?? "unknown"}`;

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
            };
            if (title) setFields.name = title;

            const updated = await SavedConsole.findOneAndUpdate(
              {
                _id: doc._id,
                workspaceId: new Types.ObjectId(workspaceId),
                draftRevision:
                  currentRevision === 1 ? { $in: [1, null] } : currentRevision,
              },
              { $set: setFields, $inc: { draftRevision: 1 } },
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
            name: title || "Untitled",
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
              },
              $inc: { draftRevision: 1 },
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
        "Execute the query currently in a console (runs server-side against the console's attached connection; results appear in open windows and are saved on the console). Use this AFTER modify_console to get results. The console must be connected to a database.",
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

        // Cancellation: register with the turn's execution registry so an
        // explicit Stop (or turn abort) cancels the database query, plus a
        // hard timeout.
        const executionId =
          executionContext?.createExecutionId("run_console") ??
          `run_console_${Date.now()}`;
        executionContext?.registerExecution(executionId);
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => {
          timeoutController.abort("query-timeout");
          void databaseConnectionService.cancelQuery(executionId);
        }, RUN_CONSOLE_TIMEOUT_MS);

        try {
          const result = await executeSavedConsole({
            workspaceId,
            consoleId,
            userId: userId ?? "agent",
            source: "agent",
            executionId,
            signal: executionContext?.signal ?? timeoutController.signal,
          });

          if (!result.success) {
            const timedOut = timeoutController.signal.aborted;
            return {
              success: false,
              error: timedOut
                ? `Query timed out after ${RUN_CONSOLE_TIMEOUT_MS / 1000}s. The query may be too complex or the database is under heavy load.`
                : result.error || "Query execution failed.",
            };
          }

          return {
            success: true,
            rowCount: result.rowCount,
            preview: result.rows.slice(0, RUN_PREVIEW_MAX_ROWS),
            durationMs: result.durationMs,
            message: `Query executed successfully. ${result.rowCount} row(s) returned.`,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Query execution failed unexpectedly.",
          };
        } finally {
          clearTimeout(timeoutId);
          executionContext?.releaseExecution(executionId);
        }
      },
    }),
  };
}
