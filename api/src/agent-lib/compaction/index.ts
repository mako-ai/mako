/**
 * Prompt Compaction — provider-agnostic, application-level context shrinking.
 *
 * Public surface for the agent request path. Compaction is a read-time
 * transform: it only changes what is sent to the model, never the persisted
 * transcript.
 */

export {
  getCompactionConfig,
  resolveCompactionBudget,
  DEFAULT_CONTEXT_WINDOW,
  type CompactionConfig,
  type CompactionBudget,
} from "./config";
export {
  estimateModelMessagesTokens,
  estimateTokensFromText,
  pickUsageSignal,
} from "./token-estimate";
export {
  compactModelMessages,
  CLEAR_MARKER_PREFIX,
  type CompactionResult,
  type CompactionStats,
  type CompactOptions,
} from "./compactor";
