/* eslint-disable no-console */
/**
 * One-off verification: every tool registered on the unified agent must be
 * reachable through at least one expertise mode (or the always-on core set),
 * and every name referenced by a mode must actually exist in the tool union.
 * Run: pnpm exec tsx scripts/verify-mode-coverage.ts
 */
import { buildUnifiedModeRuntime } from "../src/agents/modes/runtime";
import {
  modeRegistry,
  CORE_ALWAYS_TOOL_NAMES,
  EXPERTISE_MODE_IDS,
  toolNamesForModes,
} from "../src/agents/modes/registry";
import { computeActiveTools } from "../src/agents/modes/runtime";
import { READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";

const runtime = buildUnifiedModeRuntime({
  context: { workspaceId: "000000000000000000000000" },
  messages: [],
});

const allToolNames = new Set(Object.keys(runtime.tools));
const coveredNames = toolNamesForModes(EXPERTISE_MODE_IDS);

const unreachable = [...allToolNames].filter(n => !coveredNames.has(n));
const dangling = [...coveredNames].filter(n => !allToolNames.has(n));

console.log("Registered unified tools:", allToolNames.size);
console.log("Unreachable (in union, no mode/core):", unreachable);
console.log("Dangling (referenced, not registered):", dangling);

// Plan-gate sanity: gated set must contain no mutating tool.
const gated = computeActiveTools(
  {
    enabledModes: new Set(EXPERTISE_MODE_IDS),
    planSubmitted: true,
    planApproved: false,
  },
  allToolNames,
);
const lifecycleAllowed = new Set([
  "enable_mode",
  "todo_write",
  "ask_clarifying_questions",
  "submit_plan",
]);
const leaks = gated.filter(
  n => !READ_ONLY_TOOL_NAMES.has(n) && !lifecycleAllowed.has(n),
);
console.log("Plan-gate active tools:", gated.length);
console.log("Plan-gate mutation leaks:", leaks);

// Default state (no plan submitted): mutating sql tools AND submit_plan are
// both active — the model decides per request whether to plan first.
const defaultActive = new Set(
  computeActiveTools(
    {
      enabledModes: new Set(["sql"]),
      planSubmitted: false,
      planApproved: false,
    },
    allToolNames,
  ),
);
console.log(
  "Default/sql has sql_execute_query + modify_console + submit_plan?",
  defaultActive.has("sql_execute_query"),
  defaultActive.has("modify_console"),
  defaultActive.has("submit_plan"),
);

// Approved plan: full tools again.
const approvedActive = new Set(
  computeActiveTools(
    { enabledModes: new Set(["sql"]), planSubmitted: true, planApproved: true },
    allToolNames,
  ),
);
console.log(
  "Approved/sql has sql_execute_query?",
  approvedActive.has("sql_execute_query"),
);

const exitCode = unreachable.length || dangling.length || leaks.length ? 1 : 0;
process.exit(exitCode);
