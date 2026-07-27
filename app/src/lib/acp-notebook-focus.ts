/**
 * Open/focus notebook tabs when Local ACP MCP notebook tools complete.
 */
import { focusNotebookTab } from "../notebook-runtime/shell";
import { useNotebookStore } from "../store/notebookStore";
import { resolveAcpToolName, type AcpToolUpdate } from "./local-acp-parts";

export const ACP_NOTEBOOK_FOCUS_TOOLS = new Set([
  "create_notebook",
  "add_notebook_cell",
  "edit_notebook_cell",
  "run_notebook_sql_cell",
  "run_notebook_code_cell",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function extractNotebookIdFromAcpTool(update: AcpToolUpdate): {
  notebookId: string;
  title?: string;
} | null {
  const input = asRecord(update.rawInput);
  const output = asRecord(update.rawOutput ?? update.content);
  const nested = asRecord(output?.data);

  const notebookId =
    (typeof output?.notebookId === "string" && output.notebookId) ||
    (typeof nested?.notebookId === "string" && nested.notebookId) ||
    (typeof input?.notebookId === "string" && input.notebookId) ||
    null;
  if (!notebookId) return null;

  const title =
    (typeof output?.name === "string" && output.name.trim() && output.name) ||
    (typeof output?.title === "string" &&
      output.title.trim() &&
      output.title) ||
    (typeof nested?.name === "string" && nested.name.trim() && nested.name) ||
    undefined;
  return { notebookId, title };
}

export function maybeFocusNotebookFromAcpTool(
  workspaceId: string | undefined,
  update: AcpToolUpdate,
): boolean {
  if (!workspaceId || update.status !== "completed") return false;
  const toolName = resolveAcpToolName(update);
  if (!ACP_NOTEBOOK_FOCUS_TOOLS.has(toolName)) return false;

  const extracted = extractNotebookIdFromAcpTool(update);
  if (!extracted) return false;

  const { notebookId, title } = extracted;
  const shouldFocus =
    toolName === "create_notebook" ||
    !useNotebookStore.getState().openNotebooks[notebookId];

  void useNotebookStore
    .getState()
    .loadNotebooks()
    .catch(() => undefined);

  if (shouldFocus) {
    focusNotebookTab(notebookId, title || "Untitled notebook");
  }
  return true;
}
