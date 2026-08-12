/**
 * Client-side executor for the notebook agent tools.
 *
 * Mirrors `executeAppAgentTool`: the AI SDK routes notebook tool calls to the
 * browser via `onToolCall`, and this dispatcher applies them to the open
 * notebook through `notebookStore` (which autosaves), so the agent's edits show
 * up live in the editor exactly like a human's.
 */
import {
  applyStrReplace,
  notebookCellResourceVersion,
  readNotebookCellRange,
  searchNotebookCells,
  summarizeNotebookCell,
} from "@mako/agent-tools";
import { useConsoleStore } from "../store/consoleStore";
import {
  useNotebookStore,
  type NotebookBlock,
  type NotebookBlockType,
} from "../store/notebookStore";
import { useUIStore } from "../store/uiStore";
import {
  executeCode,
  startKernelSession,
  type ExecuteResult,
  type KernelOutput,
} from "./kernel";
import { capKernelOutputs } from "./outputs";
import { focusNotebookTab } from "./shell";

type ToolResult = Record<string, unknown>;

function fail(error: string): ToolResult {
  return { success: false, error };
}

/** Condense kernel outputs into a compact result the agent can act on. */
function summarizeKernelOutputs(
  outputs: KernelOutput[],
  result: ExecuteResult,
): ToolResult {
  const trunc = (s: string, n = 4000) =>
    s.length > n ? s.slice(0, n) + "\n… (truncated)" : s;
  const streamText = (name: "stdout" | "stderr") =>
    outputs
      .filter(o => o.type === "stream" && o.name === name)
      .map(o => (o.type === "stream" ? o.text : ""))
      .join("");
  const errorOut = outputs.find(o => o.type === "error");
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
    status: result.status,
    executionCount: result.executionCount ?? null,
    stdout: trunc(streamText("stdout")),
    stderr: trunc(streamText("stderr")),
    error:
      errorOut && errorOut.type === "error"
        ? {
            ename: errorOut.ename,
            evalue: errorOut.evalue,
            traceback: errorOut.traceback.slice(-20),
          }
        : undefined,
    result: resultText ? trunc(resultText) : undefined,
  };
}

/** The notebook id from input, else the notebook in the active (or any) tab. */
function resolveNotebookId(input: Record<string, unknown>): string | null {
  if (typeof input.notebookId === "string" && input.notebookId) {
    return input.notebookId;
  }
  const { tabs, activeTabId } = useConsoleStore.getState();
  const idOf = (t?: {
    kind?: string;
    metadata?: { notebookId?: string };
  }): string | null =>
    t?.kind === "notebook" ? (t.metadata?.notebookId ?? null) : null;

  const active = activeTabId ? tabs[activeTabId] : undefined;
  if (idOf(active)) return idOf(active);
  for (const t of Object.values(tabs)) {
    const id = idOf(t);
    if (id) return id;
  }
  return null;
}

async function ensureOpen(id: string) {
  const store = useNotebookStore.getState();
  if (!store.openNotebooks[id]) await store.openNotebook(id);
  return useNotebookStore.getState().openNotebooks[id];
}

export async function executeNotebookAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  options?: { executionId?: string; signal?: AbortSignal },
): Promise<ToolResult> {
  if (toolName === "create_notebook") {
    const name =
      typeof input.name === "string" && input.name ? input.name : undefined;
    const doc = await useNotebookStore.getState().createNotebook(name);
    if (!doc) return fail("Failed to create notebook");
    // Open + focus it so it becomes the active notebook the cell tools default
    // to (resolveNotebookId reads the active tab).
    focusNotebookTab(doc.id, doc.name);
    return {
      success: true,
      notebookId: doc.id,
      name: doc.name,
      cellCount: doc.blocks.length,
    };
  }

  if (toolName === "list_open_notebooks") {
    const { tabs } = useConsoleStore.getState();
    const open = useNotebookStore.getState().openNotebooks;
    const notebooks = Object.values(tabs)
      .filter(t => t.kind === "notebook" && t.metadata?.notebookId)
      .map(t => {
        const id = t.metadata?.notebookId as string;
        return {
          id,
          title: t.title,
          cellCount: open[id]?.blocks.length ?? null,
        };
      });
    return { success: true, notebooks };
  }

  const notebookId = resolveNotebookId(input);
  if (!notebookId) {
    return fail("No notebook is open. Open a notebook tab first.");
  }
  const doc = await ensureOpen(notebookId);
  if (!doc) return fail("Notebook not found");
  const store = useNotebookStore.getState();

  // Shared cell CRUD: edit_notebook_cell dispatches on mode, and the
  // deprecated add/delete alias tools reuse the same legs.
  const insertCell = (inp: Record<string, unknown>): ToolResult => {
    const type = (inp.type as NotebookBlockType) || "code";
    const atIndex = typeof inp.atIndex === "number" ? inp.atIndex : undefined;
    const cell = store.addCell(notebookId, type, atIndex);
    if (!cell) return fail("Failed to add cell");
    const patch: Partial<NotebookBlock> = {};
    if (typeof inp.source === "string") patch.source = inp.source;
    if (typeof inp.connectionId === "string") {
      patch.connectionId = inp.connectionId;
    }
    if (Object.keys(patch).length > 0) {
      store.updateCell(notebookId, cell.id, patch);
    }
    return { success: true, cellId: cell.id, type };
  };

  const replaceCell = (inp: Record<string, unknown>): ToolResult => {
    const cellId = inp.cellId as string;
    const current = doc.blocks.find(block => block.id === cellId);
    if (!current) {
      return fail(`No cell with id "${cellId}"`);
    }
    const currentResourceVersion = notebookCellResourceVersion(
      current,
      doc.version,
    );
    if (
      typeof inp.resourceVersion === "string" &&
      inp.resourceVersion !== currentResourceVersion
    ) {
      return {
        success: false,
        error:
          "Cell changed since it was read. Re-read it and retry with the " +
          "latest resourceVersion.",
        currentResourceVersion,
      };
    }
    const patch: Partial<NotebookBlock> = {};
    if (
      typeof inp.oldString === "string" &&
      typeof inp.newString === "string"
    ) {
      const edit = applyStrReplace(
        current.source,
        inp.oldString,
        inp.newString,
        inp.replaceAll === true,
      );
      if (!edit.ok) return fail(edit.error);
      patch.source = edit.contents;
    } else if (typeof inp.source === "string") {
      patch.source = inp.source;
    }
    if (typeof inp.type === "string") {
      patch.type = inp.type as NotebookBlockType;
    }
    if (typeof inp.connectionId === "string") {
      patch.connectionId = inp.connectionId;
    }
    store.updateCell(notebookId, cellId, patch);
    return {
      success: true,
      cellId,
    };
  };

  const deleteCell = (inp: Record<string, unknown>): ToolResult => {
    const cellId = inp.cellId as string;
    if (!doc.blocks.some(b => b.id === cellId)) {
      return fail(`No cell with id "${cellId}"`);
    }
    store.deleteCell(notebookId, cellId);
    return { success: true, cellId, deleted: true };
  };

  switch (toolName) {
    case "read_notebook": {
      const cellOffset =
        typeof input.cellOffset === "number" ? input.cellOffset : 0;
      const cellLimit =
        typeof input.cellLimit === "number" ? input.cellLimit : 50;
      const cells = doc.blocks
        .slice(cellOffset, cellOffset + cellLimit)
        .map(cell => summarizeNotebookCell(cell, doc.version));
      const nextCellOffset =
        cellOffset + cells.length < doc.blocks.length
          ? cellOffset + cells.length
          : undefined;
      return {
        success: true,
        notebookId,
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
    }

    case "search_notebook":
      return {
        success: true,
        notebookId,
        query: String(input.query ?? ""),
        ...searchNotebookCells(doc.blocks, String(input.query ?? ""), {
          cellTypes: Array.isArray(input.cellTypes)
            ? (input.cellTypes as Array<"code" | "sql" | "markdown">)
            : undefined,
          contextLines:
            typeof input.contextLines === "number"
              ? input.contextLines
              : undefined,
          maxResults:
            typeof input.maxResults === "number" ? input.maxResults : undefined,
          offset: typeof input.offset === "number" ? input.offset : undefined,
          notebookVersion: doc.version,
        }),
      };

    case "read_notebook_cell": {
      const cellId = input.cellId as string;
      const cell = doc.blocks.find(block => block.id === cellId);
      if (!cell) return fail(`No cell with id "${cellId}"`);
      return {
        success: true,
        notebookId,
        cellId,
        type: cell.type,
        connectionId: cell.connectionId,
        resourceVersion: notebookCellResourceVersion(cell, doc.version),
        ...readNotebookCellRange(
          cell.source,
          typeof input.startLine === "number" ? input.startLine : undefined,
          typeof input.endLine === "number" ? input.endLine : undefined,
          typeof input.startOffset === "number" ? input.startOffset : undefined,
        ),
      };
    }

    case "edit_notebook_cell": {
      if (input.mode === "insert") return insertCell(input);
      if (input.mode === "delete") return deleteCell(input);
      return replaceCell(input);
    }

    case "add_notebook_cell":
      return insertCell(input);

    case "delete_notebook_cell":
      return deleteCell(input);

    case "run_notebook_sql_cell": {
      const cellId = input.cellId as string;
      const cell = doc.blocks.find(b => b.id === cellId);
      if (!cell) return fail(`No cell with id "${cellId}"`);
      if (cell.type !== "sql") {
        return fail(
          "run_notebook_sql_cell only runs SQL cells; use " +
            "run_notebook_code_cell for Python.",
        );
      }
      if (!cell.connectionId) {
        return fail("Set a data source (connectionId) on the cell first.");
      }
      const workspaceId = useUIStore.getState().currentWorkspaceId ?? null;
      if (!workspaceId) return fail("No active workspace");
      const res = await useConsoleStore
        .getState()
        .executeQuery(workspaceId, cell.connectionId, cell.source, {
          pageSize: 500,
          signal: options?.signal,
        });
      if (!res.success) {
        return fail(typeof res.error === "string" ? res.error : "Query failed");
      }
      const rows = (res as { rows?: Record<string, unknown>[] }).rows ?? [];
      const fields =
        (res as { fields?: Array<{ name?: string } | string> }).fields ?? [];
      const columns = fields
        .map(f => (typeof f === "string" ? f : (f.name ?? "")))
        .filter(Boolean);
      return {
        success: true,
        cellId,
        rowCount: rows.length,
        columns,
        sampleRows: rows.slice(0, 20),
      };
    }

    case "run_notebook_code_cell": {
      const cellId = input.cellId as string;
      const cell = doc.blocks.find(b => b.id === cellId);
      if (!cell) return fail(`No cell with id "${cellId}"`);
      if (cell.type !== "code") {
        return fail(
          "run_notebook_code_cell only runs 'code' (Python) cells; use " +
            "run_notebook_sql_cell for SQL.",
        );
      }
      const workspaceId = useUIStore.getState().currentWorkspaceId ?? null;
      if (!workspaceId) return fail("No active workspace");
      const collected: KernelOutput[] = [];
      try {
        await startKernelSession(workspaceId, notebookId);
        const res = await executeCode(
          workspaceId,
          notebookId,
          cell.source,
          o => collected.push(o),
          options?.signal,
        );
        // Persist to the cell so outputs show in the editor + survive reload,
        // exactly like a human clicking Run.
        store.updateCell(notebookId, cellId, {
          outputs: capKernelOutputs(collected),
          executionCount: res.executionCount ?? undefined,
          executedAt: new Date().toISOString(),
        });
        return {
          success: true,
          cellId,
          ...summarizeKernelOutputs(collected, res),
        };
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Execution failed");
      }
    }

    default:
      return fail(`Unknown notebook tool: ${toolName}`);
  }
}
