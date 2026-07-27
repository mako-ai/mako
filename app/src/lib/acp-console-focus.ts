/**
 * Open/focus console tabs when Local ACP MCP console tools complete —
 * mirrors acp-app-focus for apps (realtime chat.ui-intent often misses ACP).
 */
import { useConsoleStore } from "../store/consoleStore";
import { resolveAcpToolName, type AcpToolUpdate } from "./local-acp-parts";

export const ACP_CONSOLE_FOCUS_TOOLS = new Set([
  "create_console",
  "open_console",
  "run_console",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function extractConsoleIdFromAcpTool(update: AcpToolUpdate): {
  consoleId: string;
  title?: string;
} | null {
  const input = asRecord(update.rawInput);
  const output = asRecord(update.rawOutput ?? update.content);
  const nested = asRecord(output?.data);

  const consoleId =
    (typeof output?.consoleId === "string" && output.consoleId) ||
    (typeof nested?.consoleId === "string" && nested.consoleId) ||
    (typeof input?.consoleId === "string" && input.consoleId) ||
    null;
  if (!consoleId) return null;

  const title =
    (typeof output?.title === "string" &&
      output.title.trim() &&
      output.title) ||
    (typeof nested?.title === "string" &&
      nested.title.trim() &&
      nested.title) ||
    undefined;
  return { consoleId, title };
}

export function maybeFocusConsoleFromAcpTool(
  workspaceId: string | undefined,
  update: AcpToolUpdate,
): boolean {
  if (!workspaceId || update.status !== "completed") return false;
  const toolName = resolveAcpToolName(update);
  if (!ACP_CONSOLE_FOCUS_TOOLS.has(toolName)) return false;

  const extracted = extractConsoleIdFromAcpTool(update);
  if (!extracted) return false;

  const { consoleId } = extracted;
  const store = useConsoleStore.getState();
  if (store.tabs[consoleId]) {
    store.setActiveTab(consoleId);
    return true;
  }

  void store.openConsoleFromServer(workspaceId, consoleId).catch(() => {
    /* tab may already be gone */
  });
  return true;
}
