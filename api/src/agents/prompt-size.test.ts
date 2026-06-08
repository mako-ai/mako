/**
 * Prompt-size budget guard.
 *
 * The base agent prompts must stay lean — heavy vendor/database/app/domain
 * reference material belongs in Agent Skills (`api/src/agent-skills/**`), loaded
 * on demand, not in the always-on base prompt. These budgets fail CI if a
 * change re-inflates the base prompt (e.g. by inlining a dialect reference or a
 * full dashboard/flow guide again). See `.cursor/rules/35-agent-prompts.mdc`.
 *
 * If you intentionally grow the base prompt, justify it and bump the budget —
 * but first check whether the content should be a skill instead.
 */

import assert from "node:assert/strict";
import { UNIVERSAL_PROMPT_V2 } from "../agent-lib/prompts/universal";
import { UNIFIED_SYSTEM_PROMPT } from "./unified/prompt";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

// Current sizes (chars) after the system-prompt-to-skills migration:
//   UNIVERSAL_PROMPT_V2   ~12.9k
//   UNIFIED_SYSTEM_PROMPT ~18.1k
// Budgets include headroom for small edits but block another full guide.
const UNIVERSAL_BUDGET = 16000;
const UNIFIED_BUDGET = 22000;

t(`UNIVERSAL_PROMPT_V2 under ${UNIVERSAL_BUDGET} chars`, () => {
  assert.ok(
    UNIVERSAL_PROMPT_V2.length < UNIVERSAL_BUDGET,
    `UNIVERSAL_PROMPT_V2 is ${UNIVERSAL_PROMPT_V2.length} chars (budget ${UNIVERSAL_BUDGET}). ` +
      "Move new dialect/vendor guidance into an api/src/agent-skills/<name>/SKILL.md package.",
  );
});

t(`UNIFIED_SYSTEM_PROMPT under ${UNIFIED_BUDGET} chars`, () => {
  assert.ok(
    UNIFIED_SYSTEM_PROMPT.length < UNIFIED_BUDGET,
    `UNIFIED_SYSTEM_PROMPT is ${UNIFIED_SYSTEM_PROMPT.length} chars (budget ${UNIFIED_BUDGET}). ` +
      "Do not inline the dashboard/flow guides — they load on demand via the dashboards/flows skills.",
  );
});

// Guard against the specific regression we just fixed: the unified prompt must
// not inline the full dashboard/flow guides (they should be skill-loaded).
t("UNIFIED_SYSTEM_PROMPT does not inline the dashboard widget examples", () => {
  assert.ok(
    !UNIFIED_SYSTEM_PROMPT.includes("Donut chart"),
    "UNIFIED_SYSTEM_PROMPT appears to inline the dashboard guide; it should point to the `dashboards` skill instead.",
  );
});

process.stdout.write("\nprompt-size budget: all checks passed\n");
