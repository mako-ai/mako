/**
 * Safely coerce an unknown value to a number, returning 0 for non-numeric values.
 * Used for extracting token counts from untyped LLM usage objects.
 */
export function toNum(val: unknown): number {
  if (typeof val === "number" && !isNaN(val)) return val;
  return 0;
}

/**
 * Extract input/output token counts from an AI SDK usage object.
 * Handles both naming conventions: promptTokens/completionTokens (OpenAI-style)
 * and inputTokens/outputTokens (Anthropic/Google-style).
 */
export function extractTokenCounts(usage: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
} {
  const inputTokens =
    usage.promptTokens !== undefined
      ? toNum(usage.promptTokens)
      : toNum(usage.inputTokens);
  const outputTokens =
    usage.completionTokens !== undefined
      ? toNum(usage.completionTokens)
      : toNum(usage.outputTokens);
  return { inputTokens, outputTokens };
}
