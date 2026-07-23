/**
 * Map ACP session/update tool events → AI SDK UIMessage dynamic-tool parts
 * so main Chat renders the same StreamingToolCard UI as the in-app agent.
 */
import type { UIMessage } from "ai";

export type AcpToolUpdate = {
  sessionUpdate?: string;
  toolCallId?: string;
  name?: string | null;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  _meta?: { claudeCode?: { toolName?: string } } | null;
};

export type DynamicToolPart = {
  type: "dynamic-tool";
  toolCallId: string;
  toolName: string;
  title?: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-streaming"
    | "output-available"
    | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

type TextPart = { type: "text"; text: string };
type AssistantPart =
  | TextPart
  | DynamicToolPart
  | { type: string; [k: string]: unknown };

export function resolveAcpToolName(update: AcpToolUpdate): string {
  const raw =
    update._meta?.claudeCode?.toolName || update.name || update.title || "tool";
  const name = String(raw).trim() || "tool";
  // Strip Claude MCP prefix so AGENT_TOOL_MANIFEST icons/labels match.
  if (name.startsWith("mcp__mako__")) {
    return name.slice("mcp__mako__".length) || name;
  }
  return name;
}

export function mapAcpToolStatus(
  status: string | null | undefined,
): DynamicToolPart["state"] {
  switch (status) {
    case "completed":
      return "output-available";
    case "failed":
    case "cancelled":
      return "output-error";
    case "in_progress":
      return "output-streaming";
    case "pending":
    default:
      return "input-available";
  }
}

function stringifyToolError(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw;
  if (raw && typeof raw === "object") {
    const rec = raw as { error?: unknown; message?: unknown };
    if (typeof rec.error === "string") return rec.error;
    if (typeof rec.message === "string") return rec.message;
    try {
      return JSON.stringify(raw);
    } catch {
      return "Tool failed";
    }
  }
  return "Tool failed";
}

export function upsertAcpToolPart(
  parts: AssistantPart[],
  update: AcpToolUpdate,
): AssistantPart[] {
  const toolCallId = String(update.toolCallId || "").trim();
  if (!toolCallId) return parts;

  const idx = parts.findIndex(
    p =>
      (p.type === "dynamic-tool" || String(p.type).startsWith("tool-")) &&
      (p as { toolCallId?: string }).toolCallId === toolCallId,
  );
  const existing = (idx >= 0 ? parts[idx] : null) as DynamicToolPart | null;
  const state = mapAcpToolStatus(update.status);
  const resolvedName = resolveAcpToolName(update);
  // tool_call_update is patch-semantics — omit name/title/input when absent.
  const toolName =
    (resolvedName !== "tool" ? resolvedName : null) ||
    existing?.toolName ||
    "tool";
  const title =
    (typeof update.title === "string" && update.title.trim()
      ? update.title
      : null) ||
    existing?.title ||
    undefined;
  const input =
    update.rawInput !== undefined ? update.rawInput : (existing?.input ?? {});

  const next: DynamicToolPart = {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    title,
    state,
    input,
  };

  if (state === "output-available") {
    next.output =
      update.rawOutput !== undefined
        ? update.rawOutput
        : (update.content ?? existing?.output ?? {});
  } else if (state === "output-error") {
    next.errorText =
      update.status === "cancelled"
        ? "Cancelled"
        : stringifyToolError(update.rawOutput ?? update.content);
  }

  if (idx >= 0) {
    const copy = parts.slice();
    copy[idx] = next;
    return copy;
  }
  return [...parts, next];
}

/** Append or extend the trailing text part (keeps tool cards intact). */
export function appendAssistantText(
  parts: AssistantPart[],
  chunk: string,
): AssistantPart[] {
  if (!chunk) return parts;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    const copy = parts.slice();
    copy[copy.length - 1] = {
      type: "text",
      text: `${(last as TextPart).text}${chunk}`,
    };
    return copy;
  }
  return [...parts, { type: "text", text: chunk }];
}

export function setAssistantErrorText(
  parts: AssistantPart[],
  message: string,
): AssistantPart[] {
  return appendAssistantText(
    parts,
    parts.some(p => p.type === "text" && (p as TextPart).text.trim())
      ? `\n\n${message}`
      : message,
  );
}

export function getAssistantParts(
  message: UIMessage | undefined,
): AssistantPart[] {
  return (message?.parts ?? []) as AssistantPart[];
}
