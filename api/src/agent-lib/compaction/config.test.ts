import assert from "node:assert/strict";
import {
  getCompactionConfig,
  resolveCompactionBudget,
  DEFAULT_CONTEXT_WINDOW,
} from "./config";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

const COMPACTION_ENV_KEYS = [
  "COMPACTION_ENABLED",
  "COMPACTION_CLEAR_TRIGGER_FRACTION",
  "COMPACTION_SUMMARIZE_TRIGGER_FRACTION",
  "COMPACTION_HARD_CEILING_FRACTION",
  "COMPACTION_KEEP_RECENT_TOOL_RESULTS",
  "COMPACTION_MIN_CLEAR_DELTA_CHARS",
  "COMPACTION_MIN_RESULT_CLEAR_CHARS",
];

function clearEnv() {
  for (const k of COMPACTION_ENV_KEYS) delete process.env[k];
}

t("defaults are sensible and enabled", () => {
  clearEnv();
  const cfg = getCompactionConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.clearTriggerFraction, 0.6);
  assert.equal(cfg.summarizeTriggerFraction, 0.8);
  assert.equal(cfg.hardCeilingFraction, 0.92);
  assert.equal(cfg.keepRecentToolResults, 6);
  assert.ok(cfg.minClearDeltaChars > 0);
  assert.ok(cfg.minResultClearChars > 0);
});

t("env overrides are applied and validated", () => {
  clearEnv();
  process.env.COMPACTION_ENABLED = "false";
  process.env.COMPACTION_CLEAR_TRIGGER_FRACTION = "0.5";
  process.env.COMPACTION_KEEP_RECENT_TOOL_RESULTS = "3";
  const cfg = getCompactionConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.clearTriggerFraction, 0.5);
  assert.equal(cfg.keepRecentToolResults, 3);
  clearEnv();
});

t("invalid env values fall back to defaults", () => {
  clearEnv();
  process.env.COMPACTION_CLEAR_TRIGGER_FRACTION = "9"; // out of (0,1]
  process.env.COMPACTION_KEEP_RECENT_TOOL_RESULTS = "-2"; // negative
  const cfg = getCompactionConfig();
  assert.equal(cfg.clearTriggerFraction, 0.6);
  assert.equal(cfg.keepRecentToolResults, 6);
  clearEnv();
});

t("resolveCompactionBudget derives absolute token budgets", () => {
  clearEnv();
  const b = resolveCompactionBudget(1000);
  assert.equal(b.contextWindow, 1000);
  assert.equal(b.clearTriggerTokens, 600);
  assert.equal(b.summarizeTriggerTokens, 800);
  assert.equal(b.hardCeilingTokens, 920);
});

t("resolveCompactionBudget falls back when window missing", () => {
  clearEnv();
  assert.equal(resolveCompactionBudget(null).contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveCompactionBudget(0).contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(
    resolveCompactionBudget(undefined).contextWindow,
    DEFAULT_CONTEXT_WINDOW,
  );
});
