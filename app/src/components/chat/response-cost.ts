/**
 * Per-response cost metadata for assistant messages.
 *
 * Two producers, one shape:
 *  - Live turns: the chat stream's `messageMetadata` (server-priced on the
 *    finish part) lands on `message.metadata` via the AI SDK.
 *  - History: `GET /chats/{id}` returns `usage.history[]` keyed by assistant
 *    ordinal; the session loader attaches the same shape during conversion.
 */

export interface ResponseCostMetadata {
  costUsd?: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Extract cost metadata from a UIMessage, tolerating unknown shapes. */
export function getResponseCostMetadata(message: {
  metadata?: unknown;
}): ResponseCostMetadata | null {
  const meta = message.metadata as ResponseCostMetadata | undefined;
  if (!meta || typeof meta !== "object") return null;
  if (typeof meta.costUsd !== "number" || !Number.isFinite(meta.costUsd)) {
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

/**
 * Build the assistant-ordinal → cost map from a persisted chat's
 * `usage.history` (the shape saved by the API's saveChat).
 */
export function buildCostByAssistantOrdinal(
  usage: unknown,
): Map<number, ResponseCostMetadata> {
  const map = new Map<number, ResponseCostMetadata>();
  const history = (
    usage as { history?: Array<Record<string, unknown>> } | undefined
  )?.history;
  if (!Array.isArray(history)) return map;
  for (const entry of history) {
    const index = entry.messageIndex;
    const costUsd = entry.costUsd;
    if (typeof index !== "number" || typeof costUsd !== "number") continue;
    map.set(index, {
      costUsd,
      modelId: typeof entry.model === "string" ? entry.model : undefined,
      inputTokens:
        typeof entry.promptTokens === "number" ? entry.promptTokens : undefined,
      outputTokens:
        typeof entry.completionTokens === "number"
          ? entry.completionTokens
          : undefined,
    });
  }
  return map;
}
