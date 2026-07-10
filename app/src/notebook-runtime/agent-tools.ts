/**
 * Client-side executor for the notebook agent tools.
 *
 * Mirrors `executeAppAgentTool`: the AI SDK routes notebook tool calls to the
 * browser via `onToolCall`, and this dispatcher applies them to the open
 * notebook through `notebookStore` (which autosaves), so the agent's edits show
 * up live in the editor exactly like a human's.
 */
import { useConsoleStore } from "../store/consoleStore";
import {
  useNotebookStore,
  type NotebookBlock,
  type NotebookBlockType,
} from "../store/notebookStore";
import { useUIStore } from "../store/uiStore";
import { focusNotebookTab } from "./shell";

type ToolResult = Record<string, unknown>;

function fail(error: string): ToolResult {
  return { success: false, error };
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

  switch (toolName) {
    case "read_notebook":
      return {
        success: true,
        notebookId,
        name: doc.name,
        cells: doc.blocks.map(b => ({
          cellId: b.id,
          type: b.type,
          source: b.source,
          connectionId: b.connectionId,
        })),
      };

    case "add_notebook_cell": {
      const type = (input.type as NotebookBlockType) || "code";
      const atIndex =
        typeof input.atIndex === "number" ? input.atIndex : undefined;
      const cell = store.addCell(notebookId, type, atIndex);
      if (!cell) return fail("Failed to add cell");
      const patch: Partial<NotebookBlock> = {};
      if (typeof input.source === "string") patch.source = input.source;
      if (typeof input.connectionId === "string") {
        patch.connectionId = input.connectionId;
      }
      if (Object.keys(patch).length > 0) {
        store.updateCell(notebookId, cell.id, patch);
      }
      return { success: true, cellId: cell.id, type };
    }

    case "edit_notebook_cell": {
      const cellId = input.cellId as string;
      if (!doc.blocks.some(b => b.id === cellId)) {
        return fail(`No cell with id "${cellId}"`);
      }
      const patch: Partial<NotebookBlock> = {};
      if (typeof input.source === "string") patch.source = input.source;
      if (typeof input.type === "string") {
        patch.type = input.type as NotebookBlockType;
      }
      if (typeof input.connectionId === "string") {
        patch.connectionId = input.connectionId;
      }
      store.updateCell(notebookId, cellId, patch);
      return { success: true, cellId };
    }

    case "delete_notebook_cell": {
      const cellId = input.cellId as string;
      if (!doc.blocks.some(b => b.id === cellId)) {
        return fail(`No cell with id "${cellId}"`);
      }
      store.deleteCell(notebookId, cellId);
      return { success: true, cellId };
    }

    case "run_notebook_sql_cell": {
      const cellId = input.cellId as string;
      const cell = doc.blocks.find(b => b.id === cellId);
      if (!cell) return fail(`No cell with id "${cellId}"`);
      if (cell.type !== "sql") {
        return fail("Only SQL cells can run yet (Python needs the kernel).");
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

    default:
      return fail(`Unknown notebook tool: ${toolName}`);
  }
}
