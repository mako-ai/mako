/**
 * Prompt Compaction — cheap token estimator
 *
 * There is no tokenizer dependency in this package, and pulling one in per
 * provider would be both heavy and provider-specific. Compaction only needs a
 * rough, monotonic signal of "how big is this request", so we use the standard
 * ~4-chars-per-token heuristic over the JSON-serialized message content.
 *
 * For accuracy where it matters, callers should prefer the AI SDK's reported
 * `usage` from the previous step/turn (see {@link pickUsageSignal}); the
 * estimate is the first-call fallback only.
 */

import type { ModelMessage } from "ai";

/** Average characters per token for the char/4 heuristic. */
export const CHARS_PER_TOKEN = 4;

/** Estimate tokens for a raw string. */
export function estimateTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/** Estimate tokens for a string of text. */
export function estimateTokensFromText(text: string): number {
  return estimateTokensFromChars(text.length);
}

/**
 * Serialized character size of an arbitrary value. Strings are measured
 * directly; everything else is JSON-stringified. Circular/oversized values
 * fall back to a coarse `String()` length so estimation never throws.
 */
export function serializedCharSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/** Serialized character size of a single model message. */
export function modelMessageCharSize(message: ModelMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  return serializedCharSize(content);
}

/** Serialized character size across all model messages. */
export function modelMessagesCharSize(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += modelMessageCharSize(message);
  }
  return total;
}

/** Estimate tokens for a list of model messages (char/4 heuristic). */
export function estimateModelMessagesTokens(messages: ModelMessage[]): number {
  return estimateTokensFromChars(modelMessagesCharSize(messages));
}

/**
 * Choose the best available "current size" signal in tokens.
 *
 * Prefers the actual input-token count the provider reported for the previous
 * step/turn (which includes system prompt + tool schemas, so it is the truest
 * measure of how close we are to the window). Falls back to the char/4 estimate
 * over the messages plus an optional system-prompt token estimate.
 */
export function pickUsageSignal(opts: {
  priorInputTokens?: number | null;
  messages: ModelMessage[];
  systemTokens?: number;
}): { tokens: number; source: "usage" | "estimate" } {
  const { priorInputTokens, messages, systemTokens = 0 } = opts;
  if (
    typeof priorInputTokens === "number" &&
    Number.isFinite(priorInputTokens) &&
    priorInputTokens > 0
  ) {
    return { tokens: priorInputTokens, source: "usage" };
  }
  return {
    tokens: systemTokens + estimateModelMessagesTokens(messages),
    source: "estimate",
  };
}
