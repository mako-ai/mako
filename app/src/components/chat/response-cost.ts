/**
 * Per-turn cost metadata carried on the chat stream's finish part.
 *
 * The server prices the turn and emits this as `messageMetadata`, which the AI
 * SDK lands on `message.metadata`. It is consumed as a DELTA that advances the
 * session total (see `session-usage.ts`), not rendered per message: a
 * multi-segment turn produces several of these, so a per-message reading of
 * them shows only the last segment.
 */

export interface ResponseCostMetadata {
  costUsd?: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Subset of `inputTokens`. */
  cacheReadTokens?: number;
  /** Subset of `inputTokens`. */
  cacheWriteTokens?: number;
  /** Subset of `outputTokens`. */
  reasoningTokens?: number;
}

/**
 * Extract turn metadata from a UIMessage, tolerating unknown shapes.
 *
 * A turn with tokens but no `costUsd` is still returned: server-side pricing
 * lookup can fail while the token counts remain good, and the session total
 * should still advance by the volume it saw.
 */
export function getResponseCostMetadata(message: {
  metadata?: unknown;
}): ResponseCostMetadata | null {
  const meta = message.metadata as ResponseCostMetadata | undefined;
  if (!meta || typeof meta !== "object") return null;
  const isNum = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (
    !isNum(meta.costUsd) &&
    !isNum(meta.inputTokens) &&
    !isNum(meta.outputTokens)
  ) {
    return null;
  }
  return meta;
}

/** "$0.0132" under a cent, "$0.04" above — always parseable at a glance. */
export function formatCostUsd(costUsd: number): string {
  if (costUsd >= 0.01 || costUsd === 0) return `$${costUsd.toFixed(2)}`;
  return `$${costUsd.toFixed(4)}`;
}

/** "12.4k" style token counts for the tooltip. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
