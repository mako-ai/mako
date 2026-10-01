/**
 * Cumulative token + cost accounting for a whole chat session.
 *
 * WHY this exists rather than summing the per-assistant-message cost metadata:
 * a multi-segment turn (a client-tool round trip, or a server-side stranded
 * continuation) writes SEVERAL `usage.history` entries that all carry the same
 * `messageIndex`. Anything keyed by assistant ordinal therefore keeps only the
 * last segment. Measured on a real session: the per-message tag read $0.16
 * against persisted totals of $0.92 across 2.07M tokens.
 *
 * So the session total is sourced from the server's running totals
 * (`chat.usage`, maintained by `saveChat`'s `$inc`) and only ADVANCED locally,
 * by one delta per finished turn. A load REPLACES; a turn ADDS. That ordering
 * is what makes reload, chat switching and mid-turn refresh all converge
 * instead of double counting.
 */

import type { ResponseCostMetadata } from "./response-cost";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` — never add these on top of it. */
  cacheReadTokens: number;
  /** Subset of `inputTokens` — never add these on top of it. */
  cacheWriteTokens: number;
  /** Subset of `outputTokens`. */
  reasoningTokens: number;
  costUsd: number;
  /** False when every contributing turn lacked server-side pricing. */
  hasCost: boolean;
}

export const EMPTY_SESSION_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  hasCost: false,
};

/**
 * The number we show. Cache reads are part of the prompt and reasoning tokens
 * are part of the completion, so the billable-volume figure is input + output
 * and nothing else. This also matches the server's own `usage.totalTokens`.
 */
export function displayedTokenTotal(usage: SessionUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Read the running totals off a `GET /chats/{id}` payload. That route returns
 * the whole chat document, so `usage` is already in hand — it is simply never
 * read today. Tolerant of every shape, because the route has no typed response
 * schema (it declares only a generic JSON envelope).
 */
export function readPersistedUsageTotals(usage: unknown): SessionUsage {
  if (!usage || typeof usage !== "object") return EMPTY_SESSION_USAGE;
  const u = usage as Record<string, unknown>;
  const costUsd = num(u.costUsd);
  const inputTokens = num(u.promptTokens);
  const outputTokens = num(u.completionTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    reasoningTokens: num(u.reasoningTokens),
    costUsd,
    hasCost: costUsd > 0,
  };
}

/**
 * Fold one finished turn's stream metadata into a delta. Returns null when the
 * turn reported no tokens at all — a Local ACP (Claude Code / Codex) turn, or
 * an aborted one — so the caller can skip it rather than record a zero.
 */
export function usageDeltaFromMetadata(
  metadata: ResponseCostMetadata | null | undefined,
): SessionUsage | null {
  if (!metadata) return null;
  const inputTokens = num(metadata.inputTokens);
  const outputTokens = num(metadata.outputTokens);
  if (inputTokens === 0 && outputTokens === 0) return null;
  const costUsd = num(metadata.costUsd);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: num(metadata.cacheReadTokens),
    cacheWriteTokens: num(metadata.cacheWriteTokens),
    reasoningTokens: num(metadata.reasoningTokens),
    costUsd,
    hasCost: costUsd > 0,
  };
}

export function addUsage(
  base: SessionUsage,
  delta: SessionUsage,
): SessionUsage {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    reasoningTokens: base.reasoningTokens + delta.reasoningTokens,
    costUsd: base.costUsd + delta.costUsd,
    hasCost: base.hasCost || delta.hasCost,
  };
}

/**
 * Identity for a counted turn. A resumed or replayed stream can re-deliver the
 * same `finish` part, which would otherwise be added twice; keying on the
 * message id plus the exact token counts makes re-delivery idempotent while
 * still letting a genuinely different turn through.
 */
export function turnUsageKey(
  messageId: string | undefined,
  delta: SessionUsage,
): string {
  return [
    messageId ?? "unknown",
    delta.inputTokens,
    delta.outputTokens,
    delta.costUsd,
  ].join(":");
}
