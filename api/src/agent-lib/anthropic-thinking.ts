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
 * We keep the mapping in one place, keyed off documented model IDs, with a
 * version-range fallback so future Claude releases that follow the pattern
 * (4.8, 5.x, …) work without a code change.
 */

export type AnthropicThinkingMode = "adaptive" | "manual" | "none";

// Models for which we've verified the required/recommended mode against
// Vercel's docs. This is the authoritative source; the regex below is only
// a fallback for models we haven't catalogued yet.
const EXPLICIT_MODES: Record<string, AnthropicThinkingMode> = {
  // Adaptive — Claude 4.6+ (manual deprecated on 4.6, rejected on 4.7+)
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

/**
 * Resolve the thinking mode for a given model + capability tags.
 *
 *   modelId:       the gateway ID, e.g. "anthropic/claude-opus-4.7"
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
  // Unknown Claude model with reasoning tag: conservative default.
  return "manual";
}

/**
 * Build the Anthropic `thinking` provider-option payload for the AI SDK.
 * Returns `null` when thinking isn't supported.
 */
export function buildAnthropicThinkingConfig(
  mode: AnthropicThinkingMode,
  budgetTokens: number,
): Record<string, unknown> | null {
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
