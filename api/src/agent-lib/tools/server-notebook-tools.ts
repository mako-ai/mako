/**
 * Server-executed notebook agent tools.
 *
 * Unlike the client notebook tools (which need the browser to run via
 * onToolCall), these have an `execute` and mutate the durable notebook directly
 * — via the notebook store (GCS) + kernel session — then poke the workspace so
 * open tabs pull the change. Mirrors server-app-tools / dbt server tools, and
 * is what lets an agent run keep building a notebook after the tab closes.
 *
 * Spread AFTER `clientNotebookTools` in the unified factory so these win.
 */
import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Types } from "mongoose";
import {
  applyStrReplace,
  editNotebookCellSchema,
  notebookCellResourceVersion,
  readNotebookCellRange,
  readNotebookCellSchema,
  readNotebookSchema,
  searchNotebookCells,
  searchNotebookSchema,
  summarizeNotebookCell,
} from "@mako/agent-tools";

import { getNotebookStore } from "../../notebooks/store";
import { NotebookVersionConflictError } from "../../notebooks/store/types";
import { offloadOutputs } from "../../notebooks/offload";
import {
  createNotebookIndex,
  getNotebookIndex,
  updateNotebookIndex,
} from "../../services/notebook-index.service";
import { NotebookManager } from "../../utils/notebook-manager";
import type {
  NotebookBlock,
  NotebookBlockType,
  NotebookCellOutput,
  NotebookDoc,
} from "../../notebooks/types";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import {
  KernelUnavailableError,
  kernelSessionService,
} from "../../services/kernel-session.service";
import type { KernelOutput } from "../../services/kernel-provider";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { loggers } from "../../logging";

const logger = loggers.api("notebook-server-tools");

const MAX_SQL_ROWS = 200; // persisted with the cell + returned to the model
const MAX_STREAM_CHARS = 50_000;
const SAVE_CONFLICT = "conflict" as const;

interface ServerNotebookToolsOptions {
  workspaceId: string;
  userId?: string;
  chatId?: string;
  /** The notebook the user is currently in; cell tools default to it. */
  defaultNotebookId?: string;
}

const notebookIdField = z
  .string()
  .optional()
  .describe("Notebook id. Defaults to the notebook the user is viewing.");

const cellTypeField = z
  .enum(["code", "sql", "markdown"])
  .describe(
    "Cell type: 'sql' runs against a data source, 'code' is Python (managed " +
      "kernel), 'markdown' renders as prose.",
  );

/** Truncate outputs so the persisted notebook doc stays small. */
function capOutputs(outputs: KernelOutput[]): KernelOutput[] {
  return outputs.map(o =>
    o.type === "stream" && o.text.length > MAX_STREAM_CHARS
      ? { ...o, text: o.text.slice(0, MAX_STREAM_CHARS) + "\n… (truncated)" }
      : o,
  );
}

export function createNotebookServerTools({
  workspaceId,
  userId,
  chatId,
  defaultNotebookId,
}: ServerNotebookToolsOptions) {
  const agentClientId = `agent:${chatId ?? "unknown"}`;
  const store = getNotebookStore();

  const resolveId = (input: { notebookId?: string }): string | null =>
    input.notebookId || defaultNotebookId || null;

  const assertWriteAccess = async (notebookId: string) => {
    const index = await getNotebookIndex(workspaceId, notebookId);
    if (!index) {
      return { ok: false as const, error: `Notebook ${notebookId} not found` };
    }
    const effectiveAccess = await NotebookManager.getEffectiveAccessForNotebook(
      index,
      workspaceId,
    );
    if (
      !NotebookManager.canWrite(
        index,
        userId ?? "agent",
        false,
        undefined,
        effectiveAccess,
      )
    ) {
      return { ok: false as const, error: `Notebook ${notebookId} not found` };
    }
    return { ok: true as const, index };
  };

  const assertReadAccess = async (notebookId: string) => {
    const index = await getNotebookIndex(workspaceId, notebookId);
    if (!index) {
      return { ok: false as const, error: `Notebook ${notebookId} not found` };
    }
    const effectiveAccess = await NotebookManager.getEffectiveAccessForNotebook(
      index,
      workspaceId,
    );
    if (
      !NotebookManager.canRead(
        index,
        userId ?? "agent",
        undefined,
        effectiveAccess,
      )
    ) {
      return { ok: false as const, error: `Notebook ${notebookId} not found` };
    }
    return { ok: true as const, index };
  };

  const publishTreeUpdated = () => {
    publishRealtimeEvent(workspaceId, { type: "notebook.tree.updated" });
  };

  const noNotebook = {
    success: false,
    error:
      "No notebook specified and none is active. Pass notebookId (use " +
      "list_open_notebooks) or open a notebook first.",
  };

  // Persist blocks + poke open tabs to pull. Returns the new version.
  const saveBlocks = async (
    notebookId: string,
    blocks: NotebookBlock[],
    expectedVersion?: number,
  ): Promise<number | null | typeof SAVE_CONFLICT> => {
    const access = await assertWriteAccess(notebookId);
    if (!access.ok) return null;
    let updated: NotebookDoc | null;
    try {
      updated = await store.update(
        workspaceId,
        notebookId,
        { blocks },
        { expectedVersion },
      );
    } catch (error) {
      if (error instanceof NotebookVersionConflictError) return SAVE_CONFLICT;
      throw error;
    }
    if (!updated) return null;
    await updateNotebookIndex(workspaceId, notebookId, {
      updatedAt: new Date(updated.updatedAt),
    });
    publishRealtimeEvent(workspaceId, {
      type: "notebook.updated",
      notebookId,
      version: updated.version,
      updatedBy: userId ?? "agent",
      clientId: agentClientId,
      origin: "agent",
    });
    return updated.version;
  };

  // Ask the window viewing this chat to open the notebook in the editor. The
  // client tool that used to do this on create no longer runs (notebook tools
  // are server-executed now), so the server signals the intent instead.
  const publishOpenIntent = (notebookId: string, title: string) => {
    if (!chatId) return;
    publishRealtimeEvent(workspaceId, {
      type: "chat.ui-intent",
      chatId,
      intent: "open_notebook",
      notebookId,
      title,
    });
  };

  return {
    create_notebook: tool({
      description:
        "Create a new notebook and make it the target for subsequent cell " +
        "tools. Use when no notebook is open or the user asks for a new one.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("Title; defaults to 'Untitled notebook'."),
      }),
      execute: async ({ name }) => {
        const doc = await store.create(workspaceId, { name });
        await createNotebookIndex({
          workspaceId,
          notebookId: doc.id,
          name: doc.name,
          ownerId: userId ?? "agent",
          access: "private",
          updatedAt: new Date(doc.updatedAt),
        });
        publishRealtimeEvent(workspaceId, {
          type: "notebook.updated",
          notebookId: doc.id,
          version: doc.version,
          updatedBy: userId ?? "agent",
          clientId: agentClientId,
          origin: "agent",
        });
        publishTreeUpdated();
        // Surface it: refresh the explorer list + open it in the editor.
        publishOpenIntent(doc.id, doc.name);
        return {
          success: true,
          notebookId: doc.id,
          name: doc.name,
          cellCount: 0,
        };
      },
    }),

    list_open_notebooks: tool({
      description:
        "List the workspace's notebooks (id, title). Use to find the notebook " +
        "to work on before reading or editing it.",
      inputSchema: z.object({}),
      execute: async () => {
        const split = await NotebookManager.listNotebooksSplit(
          workspaceId,
          userId ?? "agent",
        );
        const flatten = (
          nodes: Array<{
            id: string;
            name: string;
            isDirectory: boolean;
            children?: unknown[];
          }>,
        ): Array<{ id: string; title: string }> => {
          const out: Array<{ id: string; title: string }> = [];
          for (const node of nodes) {
            if (node.isDirectory && node.children) {
              out.push(
                ...flatten(
                  node.children as Array<{
                    id: string;
                    name: string;
                    isDirectory: boolean;
                    children?: unknown[];
                  }>,
                ),
              );
            } else if (!node.isDirectory) {
              out.push({ id: node.id, title: node.name });
            }
          }
          return out;
        };
        const notebooks = [
          ...flatten(split.myNotebooks),
          ...flatten(split.workspaceNotebooks),
        ];
        return { success: true, notebooks };
      },
    }),

    read_notebook: tool({
      description:
        "Get a compact, paginated notebook manifest: cell ids/types, source " +
        "lengths and short previews, connection ids, execution metadata, and " +
        "resource versions. Full source is intentionally omitted; use " +
        "search_notebook, then read_notebook_cell for relevant ranges.",
      inputSchema: readNotebookSchema,
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertReadAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        const cellOffset = input.cellOffset ?? 0;
        const cellLimit = input.cellLimit ?? 50;
        const cells = doc.blocks
          .slice(cellOffset, cellOffset + cellLimit)
          .map(cell => summarizeNotebookCell(cell, doc.version));
        const nextCellOffset =
          cellOffset + cells.length < doc.blocks.length
            ? cellOffset + cells.length
            : undefined;
        return {
          success: true,
          notebookId: id,
          name: doc.name,
          version: doc.version,
          cellOffset,
          cellLimit,
          totalCells: doc.blocks.length,
          totalSourceChars: doc.blocks.reduce(
            (total, cell) => total + cell.source.length,
            0,
          ),
          cells,
          ...(nextCellOffset !== undefined ? { nextCellOffset } : {}),
          hint:
            "Search with search_notebook, then fetch only relevant ranges " +
            "with read_notebook_cell.",
        };
      },
    }),

    search_notebook: tool({
      description:
        "Search notebook cell sources without loading the whole notebook into " +
        "context. Returns bounded snippets, line ranges, cell ids, and versions.",
      inputSchema: searchNotebookSchema,
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertReadAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        return {
          success: true,
          notebookId: id,
          query: input.query,
          ...searchNotebookCells(doc.blocks, input.query, {
            cellTypes: input.cellTypes,
            contextLines: input.contextLines,
            maxResults: input.maxResults,
            offset: input.offset,
            notebookVersion: doc.version,
          }),
          hint:
            "Use read_notebook_cell with a returned cellId and line range " +
            "for more context.",
        };
      },
    }),

    read_notebook_cell: tool({
      description:
        "Read a bounded line range from one notebook cell. Returns continuation " +
        "metadata and a resourceVersion for safe targeted edits.",
      inputSchema: readNotebookCellSchema,
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertReadAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        const cell = doc.blocks.find(block => block.id === input.cellId);
        if (!cell) {
          return { success: false, error: `No cell with id "${input.cellId}"` };
        }
        return {
          success: true,
          notebookId: id,
          cellId: cell.id,
          type: cell.type,
          connectionId: cell.connectionId,
          resourceVersion: notebookCellResourceVersion(cell, doc.version),
          ...readNotebookCellRange(
            cell.source,
            input.startLine,
            input.endLine,
            input.startOffset,
          ),
        };
      },
    }),

    add_notebook_cell: tool({
      description:
        "Append (or insert at atIndex) a cell. For a SQL cell set connectionId " +
        "to a data source id (from list_connections) so it can run.",
      inputSchema: z.object({
        notebookId: notebookIdField,
        type: cellTypeField,
        source: z.string().optional().describe("Cell contents"),
        connectionId: z
          .string()
          .optional()
          .describe("Data source id for SQL cells"),
        atIndex: z
          .number()
          .int()
          .optional()
          .describe("Insert position; appends when omitted"),
      }),
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertWriteAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        const cell: NotebookBlock = {
          id: randomUUID(),
          type: input.type as NotebookBlockType,
          source: input.source ?? "",
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        };
        const blocks = [...doc.blocks];
        blocks.splice(input.atIndex ?? blocks.length, 0, cell);
        const version = await saveBlocks(id, blocks, doc.version);
        if (version === SAVE_CONFLICT) {
          return {
            success: false,
            error: "Notebook changed while adding the cell. Re-read and retry.",
          };
        }
        if (version == null) {
          return { success: false, error: "Failed to add cell" };
        }
        return { success: true, cellId: cell.id, type: cell.type };
      },
    }),

    edit_notebook_cell: tool({
      description:
        "Edit a cell's source or metadata. For large cells, use a unique " +
        "oldString/newString plus resourceVersion instead of replacing the full source.",
      inputSchema: editNotebookCellSchema,
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertWriteAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        const current = doc.blocks.find(block => block.id === input.cellId);
        if (!current) {
          return { success: false, error: `No cell with id "${input.cellId}"` };
        }
        const currentResourceVersion = notebookCellResourceVersion(
          current,
          doc.version,
        );
        if (
          input.resourceVersion &&
          input.resourceVersion !== currentResourceVersion
        ) {
          return {
            success: false,
            error:
              "Cell changed since it was read. Re-read it and retry with the " +
              "latest resourceVersion.",
            currentResourceVersion,
          };
        }
        let nextSource = input.source;
        let replacements: number | undefined;
        if (input.oldString !== undefined && input.newString !== undefined) {
          const edit = applyStrReplace(
            current.source,
            input.oldString,
            input.newString,
            input.replaceAll,
          );
          if (!edit.ok) return { success: false, error: edit.error };
          nextSource = edit.contents;
          replacements = edit.replacements;
        }
        const blocks = doc.blocks.map(b =>
          b.id === input.cellId
            ? {
                ...b,
                ...(nextSource !== undefined ? { source: nextSource } : {}),
                ...(input.type
                  ? { type: input.type as NotebookBlockType }
                  : {}),
                ...(input.connectionId !== undefined
                  ? { connectionId: input.connectionId }
                  : {}),
              }
            : b,
        );
        const version = await saveBlocks(id, blocks, doc.version);
        if (version === SAVE_CONFLICT) {
          return {
            success: false,
            error:
              "Notebook changed while editing the cell. Re-read and retry with " +
              "the latest resourceVersion.",
          };
        }
        if (version == null) {
          return { success: false, error: "Failed to edit cell" };
        }
        const updated = blocks.find(block => block.id === input.cellId);
        return {
          success: true,
          cellId: input.cellId,
          version,
          resourceVersion: updated
            ? notebookCellResourceVersion(updated, version)
            : undefined,
          replacements,
        };
      },
    }),

    delete_notebook_cell: tool({
      description: "Delete a cell by id.",
      inputSchema: z.object({
        notebookId: notebookIdField,
        cellId: z.string(),
      }),
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertWriteAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        if (!doc.blocks.some(b => b.id === input.cellId)) {
          return { success: false, error: `No cell with id "${input.cellId}"` };
        }
        const version = await saveBlocks(
          id,
          doc.blocks.filter(b => b.id !== input.cellId),
          doc.version,
        );
        if (version === SAVE_CONFLICT) {
          return {
            success: false,
            error:
              "Notebook changed while deleting the cell. Re-read and retry.",
          };
        }
        if (version == null) {
          return { success: false, error: "Failed to delete cell" };
        }
        return { success: true, cellId: input.cellId };
      },
    }),

    run_notebook_sql_cell: tool({
      description:
        "Run a SQL cell against its data source and return the columns + first " +
        "rows. The cell must be type 'sql' with a connectionId set. Results are " +
        "persisted with the cell.",
      inputSchema: z.object({
        notebookId: notebookIdField,
        cellId: z.string(),
      }),
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertWriteAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        const cell = doc.blocks.find(b => b.id === input.cellId);
        if (!cell) {
          return { success: false, error: `No cell with id "${input.cellId}"` };
        }
        if (cell.type !== "sql") {
          return {
            success: false,
            error:
              "run_notebook_sql_cell only runs SQL cells; use run_notebook_code_cell for Python.",
          };
        }
        if (!cell.connectionId || !Types.ObjectId.isValid(cell.connectionId)) {
          return {
            success: false,
            error: "Set a valid data source (connectionId) on the cell first.",
          };
        }
        const database = await DatabaseConnection.findOne({
          _id: new Types.ObjectId(cell.connectionId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (!database) {
          return {
            success: false,
            error: "Data source not found in this workspace.",
          };
        }

        const started = Date.now();
        const result = await databaseConnectionService.executeQuery(
          database as Parameters<
            typeof databaseConnectionService.executeQuery
          >[0],
          cell.source,
          { readOnly: true },
        );
        if (!result.success) {
          const message = result.error || "Query failed";
          await persistOutputs(
            id,
            doc.blocks,
            input.cellId,
            [
              {
                type: "error",
                ename: "SQLError",
                evalue: message,
                traceback: [],
              },
            ],
            undefined,
            doc.version,
          );
          return { success: false, error: message };
        }
        const rows = (result.data as Record<string, unknown>[]) || [];
        const columns =
          (result as { fields?: Array<{ name?: string } | string> }).fields
            ?.map(f => (typeof f === "string" ? f : (f.name ?? "")))
            .filter(Boolean) ?? (rows[0] ? Object.keys(rows[0]) : []);
        const truncated = rows.length > MAX_SQL_ROWS;
        const persisted = await persistOutputs(
          id,
          doc.blocks,
          input.cellId,
          [
            {
              type: "sql",
              rows: rows.slice(0, MAX_SQL_ROWS),
              fields: columns,
              rowCount: rows.length,
              executionTime: Date.now() - started,
              truncated,
            },
          ],
          undefined,
          doc.version,
        );
        if (persisted === SAVE_CONFLICT) {
          return {
            success: false,
            error:
              "Notebook changed while the SQL cell was running; its result was " +
              "not persisted. Re-read and rerun the cell.",
          };
        }
        return {
          success: true,
          cellId: input.cellId,
          rowCount: rows.length,
          columns,
          sampleRows: rows.slice(0, 20),
        };
      },
    }),

    run_notebook_code_cell: tool({
      description:
        "Run a Python ('code') cell on the notebook's managed kernel and return " +
        "its stdout/stderr, any error + traceback, and the result. Kernel state " +
        "persists across runs. Outputs are persisted with the cell.",
      inputSchema: z.object({
        notebookId: notebookIdField,
        cellId: z.string(),
      }),
      execute: async input => {
        const id = resolveId(input);
        if (!id) return noNotebook;
        const access = await assertWriteAccess(id);
        if (!access.ok) return { success: false, error: access.error };
        const doc = await store.get(workspaceId, id);
        if (!doc) return { success: false, error: `Notebook ${id} not found` };
        const cell = doc.blocks.find(b => b.id === input.cellId);
        if (!cell) {
          return { success: false, error: `No cell with id "${input.cellId}"` };
        }
        if (cell.type !== "code") {
          return {
            success: false,
            error:
              "run_notebook_code_cell only runs Python cells; use run_notebook_sql_cell for SQL.",
          };
        }
        const collected: KernelOutput[] = [];
        try {
          await kernelSessionService.start({
            workspaceId,
            notebookId: id,
            userId: userId ?? "agent",
          });
          const res = await kernelSessionService.execute(
            workspaceId,
            id,
            cell.source,
            o => collected.push(o),
          );
          const persisted = await persistOutputs(
            id,
            doc.blocks,
            input.cellId,
            capOutputs(collected),
            res.executionCount ?? undefined,
            doc.version,
          );
          if (persisted === SAVE_CONFLICT) {
            return {
              success: false,
              error:
                "Notebook changed while the Python cell was running; its result " +
                "was not persisted. Re-read and rerun the cell.",
            };
          }
          return {
            success: true,
            cellId: input.cellId,
            ...summarize(collected, res.status),
          };
        } catch (e) {
          if (e instanceof KernelUnavailableError) {
            return {
              success: false,
              error: `Python kernel unavailable: ${e.message}`,
            };
          }
          logger.warn("run_notebook_code_cell failed", {
            error: e,
            notebookId: id,
          });
          return {
            success: false,
            error: e instanceof Error ? e.message : "Execution failed",
          };
        }
      },
    }),
  };

  // -- helpers scoped to the tool set ---------------------------------------

  async function persistOutputs(
    notebookId: string,
    blocks: NotebookBlock[],
    cellId: string,
    outputs: NotebookCellOutput[],
    executionCount?: number,
    expectedVersion?: number,
  ) {
    // Offload large payloads (plots, HTML tables) to the store, keeping only a
    // small ref inline — same as the human PATCH path.
    const offloaded = await offloadOutputs(
      store,
      workspaceId,
      notebookId,
      outputs,
    );
    const next = blocks.map(b =>
      b.id === cellId
        ? {
            ...b,
            outputs: offloaded,
            executionCount,
            executedAt: new Date().toISOString(),
          }
        : b,
    );
    return saveBlocks(notebookId, next, expectedVersion);
  }
}

/** Condense kernel outputs into a compact tool result the agent can act on. */
function summarize(
  outputs: KernelOutput[],
  status: "ok" | "error" | "abort",
): Record<string, unknown> {
  const trunc = (s: string, n = 4000) =>
    s.length > n ? s.slice(0, n) + "\n… (truncated)" : s;
  const stream = (name: "stdout" | "stderr") =>
    outputs
      .filter(o => o.type === "stream" && o.name === name)
      .map(o => (o.type === "stream" ? o.text : ""))
      .join("");
  const err = outputs.find(o => o.type === "error");
  const resultOut = [...outputs]
    .reverse()
    .find(o => o.type === "result" || o.type === "display");
  const resultText =
    resultOut && (resultOut.type === "result" || resultOut.type === "display")
      ? String(
          resultOut.data["text/plain"] ??
            Object.keys(resultOut.data).join(", "),
        )
      : undefined;
  return {
    status,
    stdout: trunc(stream("stdout")),
    stderr: trunc(stream("stderr")),
    error:
      err && err.type === "error"
        ? {
            ename: err.ename,
            evalue: err.evalue,
            traceback: err.traceback.slice(-20),
          }
        : undefined,
    result: resultText ? trunc(resultText) : undefined,
  };
}
