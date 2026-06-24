/**
 * Provider-agnostic token estimation.
 *
 * We deliberately avoid a real per-provider tokenizer here: the agent routes
 * every model through the Vercel AI Gateway (OpenAI, Anthropic, Google, …),
 * and shipping a tokenizer per family is both heavy and still approximate for
 * tool-call / image parts. A character heuristic with a conservative ratio is
 * accurate enough for *budgeting* (we only need to know when we are nearing a
 * limit, not the exact count) and is the same shape every provider sees.
 *
 * `CHARS_PER_TOKEN` is intentionally low (≈3.5) so we OVER-estimate token
 * counts. Over-estimating is the safe direction: it makes us compact slightly
 * earlier rather than sail past the real ceiling. The reactive overflow
 * backstop (`context-overflow-self-heal.ts`) covers the rare case where the
 * estimate was still too optimistic.
 */

import type { UIMessage } from "ai";

/** Lower = more conservative (higher estimated token count). */
const CHARS_PER_TOKEN = 3.5;

/** Flat per-part overhead (role markers, tool framing, JSON punctuation). */
const PART_OVERHEAD_TOKENS = 8;

/** Per-message overhead the provider adds around every message envelope. */
const MESSAGE_OVERHEAD_TOKENS = 8;

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the token cost of an arbitrary JSON-serialisable value (tool
 * inputs/outputs). Falls back to a small constant if serialisation fails.
 */
export function estimateTokensFromValue(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return estimateTokensFromText(value);
  try {
    return estimateTokensFromText(JSON.stringify(value));
  } catch {
    return PART_OVERHEAD_TOKENS;
  }
}

function estimatePartTokens(part: Record<string, unknown>): number {
  const type = typeof part.type === "string" ? part.type : "";
  let tokens = PART_OVERHEAD_TOKENS;

  if (type === "text") {
    tokens += estimateTokensFromText(String(part.text ?? ""));
  } else if (type === "reasoning") {
    tokens += estimateTokensFromText(String(part.text ?? part.reasoning ?? ""));
  } else if (type === "file") {
    // Inline data URLs are the expensive case; a remote/proxied url is cheap.
    const url = typeof part.url === "string" ? part.url : "";
    const data = typeof part.data === "string" ? part.data : "";
    tokens += estimateTokensFromText(url.startsWith("data:") ? url : "");
    tokens += estimateTokensFromText(data);
  } else if (type.startsWith("tool-") || type === "dynamic-tool") {
    tokens += estimateTokensFromValue(part.input);
    tokens += estimateTokensFromValue(part.output);
    if (typeof part.errorText === "string") {
      tokens += estimateTokensFromText(part.errorText);
    }
  } else {
    // Unknown part — price the whole serialised blob defensively.
    tokens += estimateTokensFromValue(part);
  }

  return tokens;
}

export function estimateUiMessageTokens(message: UIMessage): number {
  const parts = (message.parts ?? []) as Array<Record<string, unknown>>;
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  for (const part of parts) {
    tokens += estimatePartTokens(part);
  }
  return tokens;
}

export function estimateUiMessagesTokens(messages: UIMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateUiMessageTokens(message);
  }
  return tokens;
}
