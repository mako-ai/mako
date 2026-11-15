import { notify } from "../../store/notificationStore";
import { type McpServerInfo, type McpWriteScope } from "../../store/mcpStore";

export const WRITE_SCOPE_LABELS: Record<McpWriteScope, string> = {
  read: "Read only",
  write_safe: "Safe writes",
  write_destructive: "Destructive writes",
};

export const STATUS_COLORS: Record<
  McpServerInfo["status"],
  "default" | "success" | "warning" | "error"
> = {
  created: "default",
  awaiting_auth: "warning",
  connected: "success",
  error: "error",
};

export const STATUS_LABELS: Record<McpServerInfo["status"], string> = {
  created: "Not configured",
  awaiting_auth: "Awaiting credentials",
  connected: "Connected",
  error: "Error",
};

/** Custom header row; the id is a stable React key (not the index). */
export type HeaderRow = { id: number; key: string; value: string };
let headerRowSeq = 0;
export function newHeaderRow(): HeaderRow {
  headerRowSeq += 1;
  return { id: headerRowSeq, key: "", value: "" };
}

/** Favicon for a custom MCP server, derived from its URL's host. */
export function faviconForUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return null;
  }
}

/**
 * MCP settings feedback is a plain snackbar message; the tone records the
 * call site's intent but does not change how it renders.
 */
export function notifyMcp(message: string, _tone: "success" | "error"): void {
  notify.message(message);
}
