/**
 * Prompt-size budget guard.
 *
 * Base agent prompts must stay lean: heavy vendor/database/app/domain reference
 * material belongs in Agent Skills (`api/src/agent-skills/**`), loaded on
 * demand, not in the always-on base prompt. These budgets catch regressions
 * where a full dialect, dashboard, or flow guide gets inlined again.
 */

import assert from "node:assert/strict";
import { UNIVERSAL_PROMPT_V2 } from "../agent-lib/prompts/universal";
import { UNIFIED_SYSTEM_PROMPT } from "./unified/prompt";

function test(label: string, fn: () => void): void {
  fn();
  process.stdout.write(`ok ${label}\n`);
}

const UNIVERSAL_BUDGET = 16000;
const UNIFIED_BUDGET = 22000;

test(`UNIVERSAL_PROMPT_V2 under ${UNIVERSAL_BUDGET} chars`, () => {
  assert.ok(
    UNIVERSAL_PROMPT_V2.length < UNIVERSAL_BUDGET,
    `UNIVERSAL_PROMPT_V2 is ${UNIVERSAL_PROMPT_V2.length} chars (budget ${UNIVERSAL_BUDGET}). ` +
      "Move new dialect/vendor guidance into an api/src/agent-skills/<name>/SKILL.md package.",
  );
});

test(`UNIFIED_SYSTEM_PROMPT under ${UNIFIED_BUDGET} chars`, () => {
  assert.ok(
    UNIFIED_SYSTEM_PROMPT.length < UNIFIED_BUDGET,
    `UNIFIED_SYSTEM_PROMPT is ${UNIFIED_SYSTEM_PROMPT.length} chars (budget ${UNIFIED_BUDGET}). ` +
      "Do not inline dashboard/flow guides; point to the dashboards/flows skills instead.",
  );
});

test("UNIFIED_SYSTEM_PROMPT does not inline dashboard widget examples", () => {
  assert.ok(
    !UNIFIED_SYSTEM_PROMPT.includes("Donut chart"),
    "UNIFIED_SYSTEM_PROMPT appears to inline the dashboard guide; it should point to the `dashboards` skill instead.",
  );
});

process.stdout.write("\nprompt-size budget: all checks passed\n");
