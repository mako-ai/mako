/**
 * Unit tests for `deriveModeState` — the stateless plan-gate / expertise-mode
 * scan over the chat history. Focus: the conversational plan-iteration rule
 * (a user message following a `request_changes` decision keeps the gate
 * engaged, Cursor-style, because that message IS the plan feedback).
 *
 * Run: tsx src/agents/modes/derive-mode-state.test.ts
 */
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { deriveModeState } from "./runtime";

type Part = Record<string, unknown>;

let idCounter = 0;
const msg = (role: "user" | "assistant", parts: Part[]): UIMessage =>
  ({ id: `m${idCounter++}`, role, parts }) as unknown as UIMessage;

const user = (text: string) => msg("user", [{ type: "text", text }]);

const submitPlan = (
  decision?: "approve" | "request_changes" | "cancel",
  requiredCapabilities?: string[],
) =>
  msg("assistant", [
    {
      type: "tool-submit_plan",
      toolCallId: `c${idCounter}`,
      state: decision ? "output-available" : "input-available",
      input: {
        title: "Plan",
        planMarkdown: "…",
        todos: [],
        requiredCapabilities,
      },
      ...(decision ? { output: { success: true, decision } } : {}),
    },
  ]);

// --- pending submission stays gated -----------------------------------------
{
  const state = deriveModeState([user("do it"), submitPlan()], "query");
  assert.equal(state.planSubmitted, true);
  assert.equal(state.planApproved, false);
}

// --- approval unlocks writes -------------------------------------------------
{
  const state = deriveModeState(
    [user("do it"), submitPlan("approve")],
    "query",
  );
  assert.equal(state.planSubmitted, true);
  assert.equal(state.planApproved, true);
}

// --- approval carries only the requested task capabilities ------------------
{
  const state = deriveModeState(
    [user("build it"), submitPlan("approve", ["warehouse-write"])],
    "query",
  );
  assert.deepEqual([...state.approvedCapabilityGrants], ["warehouse-write"]);
}

// --- feedback user message after request_changes KEEPS the gate engaged ------
{
  const state = deriveModeState(
    [user("do it"), submitPlan("request_changes"), user("also add a chart")],
    "query",
  );
  assert.equal(
    state.planSubmitted,
    true,
    "plan iteration feedback must not lift the gate",
  );
  assert.equal(state.planApproved, false);
}

// --- iteration loop: revised plan approved after feedback --------------------
{
  const state = deriveModeState(
    [
      user("do it"),
      submitPlan("request_changes"),
      user("also add a chart"),
      submitPlan("approve"),
    ],
    "query",
  );
  assert.equal(state.planSubmitted, true);
  assert.equal(state.planApproved, true);
}

// --- a user message after APPROVAL starts a fresh cycle ----------------------
{
  const state = deriveModeState(
    [user("do it"), submitPlan("approve"), user("now something else")],
    "query",
  );
  assert.equal(state.planSubmitted, false);
  assert.equal(state.planApproved, false);
}

// --- a user message after CANCEL starts a fresh cycle ------------------------
{
  const state = deriveModeState(
    [user("do it"), submitPlan("cancel"), user("never mind, just query X")],
    "query",
  );
  assert.equal(state.planSubmitted, false);
  assert.equal(state.planApproved, false);
}

// --- multi-round iteration keeps the gate through every feedback message -----
{
  const state = deriveModeState(
    [
      user("do it"),
      submitPlan("request_changes"),
      user("feedback 1"),
      submitPlan("request_changes"),
      user("feedback 2"),
    ],
    "query",
  );
  assert.equal(state.planSubmitted, true);
  assert.equal(state.planApproved, false);
}

// --- no plan at all ----------------------------------------------------------
{
  const state = deriveModeState([user("hello")], "query");
  assert.equal(state.planSubmitted, false);
  assert.equal(state.planApproved, false);
}

// eslint-disable-next-line no-console
console.log("derive-mode-state.test.ts: all assertions passed");

// runtime.ts transitively imports the full agent stack (loggers, mongoose
// schemas), which keeps the event loop alive — exit explicitly like
// openapi/core.test.ts does.
// eslint-disable-next-line no-process-exit
process.exit(0);
