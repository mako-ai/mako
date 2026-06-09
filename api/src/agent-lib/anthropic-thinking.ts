/**
 * Anthropic extended-thinking capability map.
 *
 * The Vercel AI Gateway does not expose which thinking mode (adaptive vs
 * manual `budget_tokens`) each Claude model supports — the `/v1/models` and
 * `/v1/models/{id}/endpoints` responses only carry a generic `"reasoning"`
 * tag. The adaptive/manual split is documented only here:
 *
 *   https://vercel.com/docs/ai-gateway/capabilities/reasoning/anthropic
 *   https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 *
 * Consequences of picking the wrong mode:
 *   - adaptive payload against a pre-4.6 model → 400
 *   - manual  payload against Opus 4.7+       → 400
 *     ("thinking.type.enabled is not supported for this model")
 *   - manual  payload against 4.6             → accepted today but deprecated
 *
 * This static map is the FIRST layer of a three-layer resolution:
 *   1. probed capabilities persisted in the model catalog (authoritative,
 *      written by the catalog-refresh probe and the runtime self-heal —
 *      see model-catalog.service.ts and thinking-self-heal.ts)
 *   2. this explicit map (documented model IDs)
 *   3. the version-regex fallback below, defaulting to adaptive for any
 *      uncatalogued Claude model
 */

export type AnthropicThinkingMode = "adaptive" | "manual" | "none";

// Models for which we've verified the required/recommended mode against
// Vercel's docs. This is the authoritative source; the regex below is only
// a fallback for models we haven't catalogued yet.
const EXPLICIT_MODES: Record<string, AnthropicThinkingMode> = {
  // Adaptive — Claude 4.6+ (manual deprecated on 4.6, rejected on 4.7+)
  "anthropic/claude-fable-5": "adaptive",
  "anthropic/claude-opus-4.8": "adaptive",
  "anthropic/claude-opus-4.7": "adaptive",
  "anthropic/claude-opus-4.6": "adaptive",
  "anthropic/claude-sonnet-4.6": "adaptive",
  // Manual — Claude 4.x and earlier
  "anthropic/claude-opus-4.5": "manual",
  "anthropic/claude-opus-4.1": "manual",
  "anthropic/claude-opus-4": "manual",
  "anthropic/claude-sonnet-4.5": "manual",
  "anthropic/claude-sonnet-4": "manual",
  "anthropic/claude-haiku-4.5": "manual",
};

/** Whether the mode for this model ID is pinned in the explicit map. */
export function hasExplicitThinkingMode(modelId: string): boolean {
  return modelId in EXPLICIT_MODES;
}

/**
 * Resolve the thinking mode for a given model + capability tags.
 *
 *   modelId:          the gateway ID, e.g. "anthropic/claude-opus-4.7"
 *   supportsThinking: whether the gateway tagged the model with "reasoning"
 */
export function resolveAnthropicThinkingMode(
  modelId: string,
  supportsThinking: boolean,
): AnthropicThinkingMode {
  if (!supportsThinking) return "none";
  const explicit = EXPLICIT_MODES[modelId];
  if (explicit) return explicit;

  const lower = modelId.toLowerCase();
  if (lower.includes("mythos")) return "adaptive";
  if (!lower.includes("claude")) return "manual";

  // Fallback for uncatalogued Claude models. Vercel AI Gateway uses dot
  // notation ("claude-opus-4.7"); our seed migrations use dashes
  // ("claude-opus-4-7"); some third-party rails flip the order. Match all.
  const patterns = [
    /claude-(?:opus|sonnet|haiku)-(\d+)[.-](\d+)/,
    /claude-(\d+)[.-](\d+)-(?:opus|sonnet|haiku)/,
  ];
  for (const re of patterns) {
    const m = lower.match(re);
    if (!m) continue;
    const major = Number.parseInt(m[1], 10);
    const minor = Number.parseInt(m[2], 10);
    if (Number.isNaN(major) || Number.isNaN(minor)) continue;
    if (major > 4 || (major === 4 && minor >= 6)) return "adaptive";
    return "manual";
  }
  // Unknown Claude model with a reasoning tag: default to ADAPTIVE.
  //
  // This used to default to "manual" as the conservative choice, which
  // became backwards once Anthropic deprecated `thinking.type.enabled`:
  // every Claude model released since 4.6 is adaptive, and new models have
  // dropped the family-major.minor naming entirely (e.g. claude-fable-5),
  // so they never match the regex above. All pre-4.6 manual models are
  // pinned in EXPLICIT_MODES. If this default is ever wrong, the catalog
  // probe and the runtime self-heal correct and persist the real mode.
  return "adaptive";
}

/**
 * Build the Anthropic `thinking` provider-option payload for the AI SDK.
 * Returns `null` when thinking isn't supported.
 */
export function buildAnthropicThinkingConfig(
  mode: AnthropicThinkingMode,
  budgetTokens: number,
) {
  if (mode === "adaptive") {
    // `display: "summarized"` restores visible reasoning on Opus 4.7, which
    // defaults to `"omitted"` (streams arrive empty → long pause before text).
    return { type: "adaptive", display: "summarized" };
  }
  if (mode === "manual") {
    return { type: "enabled", budgetTokens };
  }
  return null;
}

/**
 * Whether an error (possibly nested in `cause` / AggregateError `errors`)
 * is the Anthropic 400 telling us the model only accepts adaptive thinking:
 *   '"thinking.type.enabled" is not supported for this model. Use
 *    "thinking.type.adaptive" and "output_config.effort" ...'
 */
export function thinkingErrorRequiresAdaptive(error: unknown): boolean {
  return errorIncludes(error, '"thinking.type.enabled" is not supported');
}

function errorIncludes(error: unknown, needle: string): boolean {
  if (error instanceof Error) {
    if (error.message.includes(needle) || String(error).includes(needle)) {
      return true;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause && errorIncludes(cause, needle)) {
      return true;
    }
    const nested = (error as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      return nested.some(item => errorIncludes(item, needle));
    }
    return false;
  }
  return String(error).includes(needle);
}
