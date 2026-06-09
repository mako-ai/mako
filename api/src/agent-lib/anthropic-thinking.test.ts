import assert from "node:assert/strict";
import {
  buildAnthropicThinkingConfig,
  hasExplicitThinkingMode,
  resolveAnthropicThinkingMode,
  thinkingErrorRequiresAdaptive,
} from "./anthropic-thinking";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

// --- Explicit allowlist ---------------------------------------------------
// These IDs are catalogued directly from Vercel's docs and must always
// resolve to the documented mode regardless of the version-regex fallback.
// https://vercel.com/docs/ai-gateway/capabilities/reasoning/anthropic

t("fable-5 (explicit) → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-fable-5", true),
    "adaptive",
  );
});
t("opus-4.8 (explicit) → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-4.8", true),
    "adaptive",
  );
});
t("opus-4.7 (explicit) → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-4.7", true),
    "adaptive",
  );
});
t("opus-4.6 (explicit) → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-4.6", true),
    "adaptive",
  );
});
t("sonnet-4.6 (explicit) → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-sonnet-4.6", true),
    "adaptive",
  );
});
t("opus-4.5 (explicit) → manual", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-4.5", true),
    "manual",
  );
});
t("sonnet-4.5 (explicit) → manual", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-sonnet-4.5", true),
    "manual",
  );
});
t("haiku-4.5 (explicit) → manual", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-haiku-4.5", true),
    "manual",
  );
});

// --- Fallback: uncatalogued Claude IDs -----------------------------------
// The version regex covers IDs we haven't pinned explicitly yet (e.g. future
// releases or alternate delimiter styles in seed migrations).

t("dash-notation opus-4-7 → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-4-7", true),
    "adaptive",
  );
});
t("reverse-order claude-4.7-opus → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("claude-4.7-opus", true),
    "adaptive",
  );
});
t("future opus-5.0 → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-5.0", true),
    "adaptive",
  );
});
t("mythos preview → adaptive", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-mythos-preview", true),
    "adaptive",
  );
});
t("uncatalogued sonnet-4.0 → manual", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-sonnet-4.0", true),
    "manual",
  );
});
t("uncatalogued opus-3.5 → manual", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-3.5", true),
    "manual",
  );
});

// --- Non-thinking / non-Anthropic ---------------------------------------

t("supportsThinking=false → none", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-opus-4.7", false),
    "none",
  );
});
t("openai/gpt-5.4 → manual (not used, short-circuits upstream)", () => {
  assert.equal(resolveAnthropicThinkingMode("openai/gpt-5.4", true), "manual");
});

// --- Payload shape -------------------------------------------------------

t("buildAnthropicThinkingConfig adaptive payload", () => {
  assert.deepEqual(buildAnthropicThinkingConfig("adaptive", 10000), {
    type: "adaptive",
    display: "summarized",
  });
});
t("buildAnthropicThinkingConfig manual payload carries budgetTokens", () => {
  assert.deepEqual(buildAnthropicThinkingConfig("manual", 12345), {
    type: "enabled",
    budgetTokens: 12345,
  });
});
t("buildAnthropicThinkingConfig none returns null", () => {
  assert.equal(buildAnthropicThinkingConfig("none", 10000), null);
});

// --- Unknown-Claude default flipped to adaptive ---------------------------
// New Anthropic models have dropped the family-major.minor naming pattern
// (claude-fable-5 was the first), so they never match the version regex.
// Since every Claude model released since 4.6 is adaptive and `enabled` is
// the deprecated path, the safe default for unmatched Claude IDs is adaptive.
// All pre-4.6 manual models are pinned in EXPLICIT_MODES.

t("unknown-naming claude model → adaptive (default flipped)", () => {
  assert.equal(
    resolveAnthropicThinkingMode("anthropic/claude-saga-6", true),
    "adaptive",
  );
});
t("fable is pinned explicitly", () => {
  assert.equal(hasExplicitThinkingMode("anthropic/claude-fable-5"), true);
});
t("hypothetical future model is not pinned (probe candidate)", () => {
  assert.equal(hasExplicitThinkingMode("anthropic/claude-saga-6"), false);
});

// --- Adaptive-only error predicate ----------------------------------------

const ADAPTIVE_400 =
  '"thinking.type.enabled" is not supported for this model. ' +
  'Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';

t("detects adaptive-only 400 in message", () => {
  assert.equal(thinkingErrorRequiresAdaptive(new Error(ADAPTIVE_400)), true);
});
t("detects adaptive-only 400 nested in cause", () => {
  const err = new Error("Request failed", {
    cause: new Error(ADAPTIVE_400),
  });
  assert.equal(thinkingErrorRequiresAdaptive(err), true);
});
t("detects adaptive-only 400 in AggregateError-style errors array", () => {
  const err = new Error("fanout failed") as Error & { errors: unknown[] };
  err.errors = [new Error("unrelated"), new Error(ADAPTIVE_400)];
  assert.equal(thinkingErrorRequiresAdaptive(err), true);
});
t("ignores unrelated errors", () => {
  assert.equal(
    thinkingErrorRequiresAdaptive(new Error("rate limit exceeded")),
    false,
  );
});
t("handles non-Error values", () => {
  assert.equal(thinkingErrorRequiresAdaptive(ADAPTIVE_400), true);
  assert.equal(thinkingErrorRequiresAdaptive(null), false);
});
