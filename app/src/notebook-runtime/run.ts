/**
 * Centralized cell execution. Both the per-cell Run button and the notebook
 * toolbar (Run all) call `runCell`, so agent, human, and batch runs all take
 * the same path: execute → persist outputs to the block (→ autosave/GCS) →
 * return a result. SQL runs in the control plane; Python runs on the kernel.
 */
import { useConsoleStore } from "../store/consoleStore";
import { useNotebookStore, type NotebookBlock } from "../store/notebookStore";
import { executeCode, startKernelSession, type KernelOutput } from "./kernel";
import { capKernelOutputs, capSqlRows } from "./outputs";

export interface RunCellResult {
  ok: boolean;
  error?: string;
}

const nowIso = () => new Date().toISOString();

/**
 * Execute one cell, persisting its outputs. Markdown cells are a no-op. For
 * Python, `onOutput` streams each chunk as it arrives (used for live display).
 */
export async function runCell(
  workspaceId: string,
  notebookId: string,
  cell: NotebookBlock,
  opts: { onOutput?: (o: KernelOutput) => void; signal?: AbortSignal } = {},
): Promise<RunCellResult> {
  const store = useNotebookStore.getState();
  if (cell.type === "markdown") return { ok: true };

  if (cell.type === "sql") {
    if (!cell.connectionId) {
      return { ok: false, error: "Set a data source on the cell first." };
    }
    const start = Date.now();
    const res = await useConsoleStore
      .getState()
      .executeQuery(workspaceId, cell.connectionId, cell.source, {
        pageSize: 500,
        signal: opts.signal,
      });
    if (!res.success) {
      const message =
        typeof res.error === "string" ? res.error : "Query failed";
      store.updateCell(notebookId, cell.id, {
        outputs: [
          { type: "error", ename: "SQLError", evalue: message, traceback: [] },
        ],
        executedAt: nowIso(),
      });
      return { ok: false, error: message };
    }
    const rows = (res as { rows?: unknown[] }).rows ?? [];
    const fields = (
      res as {
        fields?: Array<{ name?: string; originalName?: string } | string>;
      }
    ).fields;
    const { rows: persistRows, truncated } = capSqlRows(rows);
    store.updateCell(notebookId, cell.id, {
      outputs: [
        {
          type: "sql",
          rows: persistRows,
          fields,
          rowCount: rows.length,
          executionTime: Date.now() - start,
          truncated,
        },
      ],
      executedAt: nowIso(),
    });
    return { ok: true };
  }

  // Python
  const collected: KernelOutput[] = [];
  try {
    await startKernelSession(workspaceId, notebookId);
    const res = await executeCode(
      workspaceId,
      notebookId,
      cell.source,
      o => {
        collected.push(o);
        opts.onOutput?.(o);
      },
      opts.signal,
    );
    store.updateCell(notebookId, cell.id, {
      outputs: capKernelOutputs(collected),
      executionCount: res.executionCount ?? undefined,
      executedAt: nowIso(),
    });
    return res.status === "error"
      ? { ok: false, error: "Cell raised an error" }
      : { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Execution failed";
    store.updateCell(notebookId, cell.id, {
      outputs: [
        {
          type: "error",
          ename: "ExecutionError",
          evalue: message,
          traceback: [],
        },
      ],
      executedAt: nowIso(),
    });
    return { ok: false, error: message };
  }
}
