/**
 * Prompt Compaction — configuration
 *
 * Provider-agnostic, application-level compaction config. All thresholds are
 * env-overridable so they can be tuned from Langfuse data without a redeploy.
 *
 * Compaction is a read-time transform: we shrink what we send to the model on a
 * given turn/step but always persist the FULL transcript to Mongo. Nothing in
 * here mutates the saved chat history.
 */

/** Fallback context window (tokens) when the model catalog reports none. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface CompactionConfig {
  /** Master switch — when false, compaction is a no-op. */
  enabled: boolean;
  /**
   * Fraction of the context window at which stale tool results start getting
   * cleared/masked (Phase 1). Leaves headroom for the system prompt + tool
   * schemas which are not counted in the message estimate.
   */
  clearTriggerFraction: number;
  /**
   * Fraction of the context window at which middle-of-session summarization
   * should kick in (Phase 2). Surfaced here so the budget math lives in one
   * place even though the summarizer ships later.
   */
  summarizeTriggerFraction: number;
  /**
   * Hard ceiling fraction. We never want the request to approach the model
   * maximum; used as a guard/escalation point for aggressive clearing.
   */
  hardCeilingFraction: number;
  /**
   * Number of most-recent tool-result payloads to always keep verbatim. Older
   * results are eligible for masking.
   */
  keepRecentToolResults: number;
  /**
   * Minimum characters that clearing must reclaim for it to be worth doing.
   * Prevents churn (and cache thrash) when only a tiny amount would be saved.
   */
  minClearDeltaChars: number;
  /**
   * Tool-result payloads smaller than this (serialized chars) are left alone
   * even when stale — they are cheap to keep and clearing them hurts quality.
   */
  minResultClearChars: number;
}

const DEFAULTS: CompactionConfig = {
  enabled: true,
  clearTriggerFraction: 0.6,
  summarizeTriggerFraction: 0.8,
  hardCeilingFraction: 0.92,
  keepRecentToolResults: 6,
  minClearDeltaChars: 4_000,
  minResultClearChars: 1_000,
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function envFraction(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the active compaction config from env (falling back to defaults).
 * Read fresh each call so tests / Langfuse-driven tuning can flip env without a
 * process restart; the work here is trivial.
 */
export function getCompactionConfig(): CompactionConfig {
  return {
    enabled: envBool("COMPACTION_ENABLED", DEFAULTS.enabled),
    clearTriggerFraction: envFraction(
      "COMPACTION_CLEAR_TRIGGER_FRACTION",
      DEFAULTS.clearTriggerFraction,
    ),
    summarizeTriggerFraction: envFraction(
      "COMPACTION_SUMMARIZE_TRIGGER_FRACTION",
      DEFAULTS.summarizeTriggerFraction,
    ),
    hardCeilingFraction: envFraction(
      "COMPACTION_HARD_CEILING_FRACTION",
      DEFAULTS.hardCeilingFraction,
    ),
    keepRecentToolResults: envInt(
      "COMPACTION_KEEP_RECENT_TOOL_RESULTS",
      DEFAULTS.keepRecentToolResults,
    ),
    minClearDeltaChars: envInt(
      "COMPACTION_MIN_CLEAR_DELTA_CHARS",
      DEFAULTS.minClearDeltaChars,
    ),
    minResultClearChars: envInt(
      "COMPACTION_MIN_RESULT_CLEAR_CHARS",
      DEFAULTS.minResultClearChars,
    ),
  };
}

export interface CompactionBudget {
  /** Effective context window in tokens used for all fraction math. */
  contextWindow: number;
  /** Token count at/above which Phase 1 clearing should run. */
  clearTriggerTokens: number;
  /** Token count at/above which Phase 2 summarization should run. */
  summarizeTriggerTokens: number;
  /** Token count we never want to exceed; escalation point. */
  hardCeilingTokens: number;
}

/**
 * Derive absolute token budgets from a model context window and config.
 * A null/0/negative window falls back to {@link DEFAULT_CONTEXT_WINDOW}.
 */
export function resolveCompactionBudget(
  contextWindow: number | null | undefined,
  config: CompactionConfig = getCompactionConfig(),
): CompactionBudget {
  const window =
    typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW;

  return {
    contextWindow: window,
    clearTriggerTokens: Math.floor(window * config.clearTriggerFraction),
    summarizeTriggerTokens: Math.floor(window * config.summarizeTriggerFraction),
    hardCeilingTokens: Math.floor(window * config.hardCeilingFraction),
  };
}
