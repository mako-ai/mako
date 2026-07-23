/**
 * Condensed prior-transcript seed for Local ACP when the process session is
 * new (dead binding / adapter reconnect) but Mako History still has turns.
 */
import type { UIMessage } from "ai";

const MAX_SEED_CHARS = 8_000;
const MAX_MESSAGES = 24;

function partText(part: { type?: string; text?: string }): string {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text.trim();
  }
  if (part.type === "reasoning" && typeof part.text === "string") {
    return "";
  }
  return "";
}

function summarizeMessage(message: UIMessage): string | null {
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;
  const chunks: string[] = [];
  for (const part of message.parts ?? []) {
    const p = part as {
      type?: string;
      text?: string;
      toolName?: string;
      state?: string;
    };
    const text = partText(p);
    if (text) {
      chunks.push(text);
      continue;
    }
    if (
      p.type === "dynamic-tool" ||
      (typeof p.type === "string" && p.type.startsWith("tool-"))
    ) {
      const name =
        p.toolName ||
        (typeof p.type === "string" ? p.type.replace(/^tool-/, "") : "tool");
      chunks.push(`[tool:${name}${p.state ? ` ${p.state}` : ""}]`);
    }
  }
  const body = chunks.join(" ").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const clipped = body.length > 1_200 ? `${body.slice(0, 1_200)}…` : body;
  return `${role}: ${clipped}`;
}

export function buildAcpContinuitySeed(messages: UIMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages
    .slice(-MAX_MESSAGES)
    .map(summarizeMessage)
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return "";

  let text = [
    "[Prior Mako chat transcript — the previous local Claude/Codex session ended; continue from this context. Do not re-greet as if this is a brand-new chat.]",
    ...lines,
    "[End prior transcript]",
  ].join("\n");

  if (text.length > MAX_SEED_CHARS) {
    text = `${text.slice(0, MAX_SEED_CHARS)}\n…(truncated)`;
  }
  return text;
}

export function prependAcpPromptLayers(args: {
  userText: string;
  continuitySeed?: string;
  uiContext?: string;
}): string {
  const trimmed = args.userText.trim();
  const layers: string[] = [];
  const continuity = args.continuitySeed?.trim();
  const ui = args.uiContext?.trim();
  if (continuity) layers.push(continuity);
  if (ui) layers.push(ui);
  if (layers.length === 0) return trimmed;
  return `${layers.join("\n\n")}\n\n[User message]\n${trimmed}`;
}
