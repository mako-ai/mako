import assert from "node:assert/strict";
import {
  buildAnthropicThinkingConfig,
  resolveAnthropicThinkingMode,
} from "./anthropic-thinking";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

// --- Explicit allowlist ---------------------------------------------------
// These IDs are catalogued directly from Vercel's docs and must always
// resolve to the documented mode regardless of the version-regex fallback.
// https://vercel.com/docs/ai-gateway/capabilities/reasoning/anthropic

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
