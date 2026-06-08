/**
 * Prompt Compaction — Phase 1: clear/mask stale tool results
 *
 * High-confidence, no-extra-LLM-call compaction. We keep the most recent N
 * tool-call/result pairs verbatim and replace the *output* of older tool
 * results with a short placeholder, while leaving the tool-call parts (and the
 * `toolCallId`/`toolName` of the result) intact so the call/result pairing
 * stays valid for every provider and for `convertToModelMessages`.
 *
 * This is the main lever against the in-loop growth where a single agent run
 * accumulates many large query/discovery dumps and approaches (or blows past)
 * the model context window. The full transcript is still persisted to Mongo;
 * this only changes what is *sent* to the model.
 *
 * Caching note: only the system block is cache-prefixed, and messages live
 * after it, so masking message content does NOT invalidate that prefix cache.
 */

import type { ModelMessage } from "ai";
import {
  getCompactionConfig,
  type CompactionBudget,
  type CompactionConfig,
} from "./config";
import {
  estimateModelMessagesTokens,
  modelMessagesCharSize,
  pickUsageSignal,
  serializedCharSize,
} from "./token-estimate";

/** Prefix used for placeholder outputs; also how we detect already-cleared results (idempotency). */
export const CLEAR_MARKER_PREFIX = "[result cleared";

function placeholderText(toolName: string): string {
  const name = toolName && toolName.length > 0 ? toolName : "the tool";
  return `${CLEAR_MARKER_PREFIX} to save context — re-run ${name} to retrieve]`;
}

interface ToolResultPartLike {
  type: "tool-result";
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
  [key: string]: unknown;
}

function isToolResultPart(part: unknown): part is ToolResultPartLike {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-result"
  );
}

function isAlreadyCleared(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { type?: unknown }).type === "text" &&
    typeof (output as { value?: unknown }).value === "string" &&
    ((output as { value: string }).value).startsWith(CLEAR_MARKER_PREFIX)
  );
}

export interface CompactionStats {
  applied: boolean;
  reason: string;
  signalTokens: number;
  signalSource: "usage" | "estimate";
  clearTriggerTokens: number;
  toolResultsTotal: number;
  clearedCount: number;
  charsBefore: number;
  charsAfter: number;
  estTokensBefore: number;
  estTokensAfter: number;
}

export interface CompactOptions {
  budget: CompactionBudget;
  config?: CompactionConfig;
  /**
   * Best available current-size signal in tokens (prefer the provider's
   * reported input tokens from the previous step). When omitted, it is
   * estimated from the messages plus `systemTokens`.
   */
  currentTokens?: number | null;
  /** Estimated system-prompt tokens, added to the message estimate fallback. */
  systemTokens?: number;
  signalSource?: "usage" | "estimate";
}

export interface CompactionResult {
  messages: ModelMessage[];
  stats: CompactionStats;
}

/**
 * Clear/mask stale tool results when the request is large enough to warrant it.
 *
 * The decision to act lives here so callers (cross-turn boundary and the
 * in-loop `prepareStep`) stay one-liners. Returns the original array reference
 * unchanged when no clearing is performed.
 */
export function compactModelMessages(
  messages: ModelMessage[],
  opts: CompactOptions,
): CompactionResult {
  const config = opts.config ?? getCompactionConfig();
  const { budget } = opts;

  const signal = pickUsageSignal({
    priorInputTokens: opts.currentTokens,
    messages,
    systemTokens: opts.systemTokens,
  });
  const signalTokens = opts.currentTokens ?? signal.tokens;
  const signalSource = opts.signalSource ?? signal.source;

  const charsBefore = modelMessagesCharSize(messages);
  const baseStats: CompactionStats = {
    applied: false,
    reason: "below-trigger",
    signalTokens,
    signalSource,
    clearTriggerTokens: budget.clearTriggerTokens,
    toolResultsTotal: 0,
    clearedCount: 0,
    charsBefore,
    charsAfter: charsBefore,
    estTokensBefore: estimateModelMessagesTokens(messages),
    estTokensAfter: estimateModelMessagesTokens(messages),
  };

  if (!config.enabled) {
    return { messages, stats: { ...baseStats, reason: "disabled" } };
  }

  if (signalTokens < budget.clearTriggerTokens) {
    return { messages, stats: baseStats };
  }

  // When we are past the hard ceiling, clear more aggressively: keep fewer
  // recent results and ignore the "cheap to keep" / "worth it" guards.
  const aggressive = signalTokens >= budget.hardCeilingTokens;
  const keepRecent = aggressive
    ? Math.min(config.keepRecentToolResults, 2)
    : config.keepRecentToolResults;
  const minResultClearChars = aggressive ? 0 : config.minResultClearChars;
  const minClearDeltaChars = aggressive ? 0 : config.minClearDeltaChars;

  // Locate every tool-result part in document order.
  const located: Array<{ msgIndex: number; partIndex: number }> = [];
  messages.forEach((message, msgIndex) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    content.forEach((part, partIndex) => {
      if (isToolResultPart(part)) {
        located.push({ msgIndex, partIndex });
      }
    });
  });

  const toolResultsTotal = located.length;
  // Protect the most recent N; older ones are candidates for masking.
  const candidates = located.slice(0, Math.max(0, located.length - keepRecent));

  const toClear = new Map<number, Set<number>>();
  let savedChars = 0;
  for (const { msgIndex, partIndex } of candidates) {
    const content = (messages[msgIndex] as { content: unknown[] }).content;
    const part = content[partIndex] as ToolResultPartLike;
    if (isAlreadyCleared(part.output)) continue;

    const currentSize = serializedCharSize(part.output);
    if (currentSize < minResultClearChars) continue;

    const newOutput = { type: "text" as const, value: placeholderText(part.toolName ?? "") };
    const newSize = serializedCharSize(newOutput);
    if (newSize >= currentSize) continue;

    savedChars += currentSize - newSize;
    let set = toClear.get(msgIndex);
    if (!set) {
      set = new Set<number>();
      toClear.set(msgIndex, set);
    }
    set.add(partIndex);
  }

  const clearedCount = Array.from(toClear.values()).reduce(
    (sum, set) => sum + set.size,
    0,
  );

  if (clearedCount === 0) {
    return {
      messages,
      stats: { ...baseStats, applied: false, reason: "nothing-to-clear", toolResultsTotal },
    };
  }

  if (savedChars < minClearDeltaChars) {
    return {
      messages,
      stats: {
        ...baseStats,
        applied: false,
        reason: "below-min-delta",
        toolResultsTotal,
      },
    };
  }

  // Build a new messages array, replacing only the targeted result outputs.
  const nextMessages: ModelMessage[] = messages.map((message, msgIndex) => {
    const set = toClear.get(msgIndex);
    if (!set) return message;
    const content = (message as { content: unknown[] }).content;
    const nextContent = content.map((part, partIndex) => {
      if (!set.has(partIndex)) return part;
      const p = part as ToolResultPartLike;
      return {
        ...p,
        output: { type: "text" as const, value: placeholderText(p.toolName ?? "") },
      };
    });
    return { ...message, content: nextContent } as ModelMessage;
  });

  const charsAfter = modelMessagesCharSize(nextMessages);
  return {
    messages: nextMessages,
    stats: {
      applied: true,
      reason: aggressive ? "cleared-aggressive" : "cleared",
      signalTokens,
      signalSource,
      clearTriggerTokens: budget.clearTriggerTokens,
      toolResultsTotal,
      clearedCount,
      charsBefore,
      charsAfter,
      estTokensBefore: baseStats.estTokensBefore,
      estTokensAfter: estimateModelMessagesTokens(nextMessages),
    },
  };
}
