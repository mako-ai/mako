/**
 * Matching old model calls to the step they were made in, by time
 * (cost-backfill.ts).
 *
 * Run with: pnpm --filter api exec tsx src/workflows/cost-backfill.test.ts
 */
import assert from "node:assert/strict";

import { matchCallsToSteps, type StepWindow } from "./cost-backfill";

const at = (s: number) => Date.UTC(2026, 9, 22, 9, 10, s);
const step = (
  runId: string,
  name: string,
  start: number,
  end: number,
): StepWindow => ({
  workflowId: "classifier",
  runId,
  step: name,
  start: at(start),
  end: at(end),
});

// Run A: label 0–40s, report 40–41s. Run B overlaps A's label from 30s.
const steps = [
  step("A", "label", 0, 40),
  step("A", "report", 40, 41),
  step("B", "label", 30, 60),
  // A later run, alone.
  step("C", "label", 3590, 3600),
];

const { matched, ambiguous, unmatched } = matchCallsToSteps(
  [
    // Inside A's label only.
    { id: "a1", endedAt: at(10), durationMs: 2_000 },
    // After A's label ended, while B still ran: exactly inside B's step,
    // so B's (the slack would also reach A's steps).
    { id: "a2", endedAt: at(43), durationMs: 2_000 },
    // Just past the end of the only step: within the slack, still its own.
    { id: "c1", endedAt: at(3602), durationMs: 1_000 },
    // Ends just before the next step of its run: exactly inside one step,
    // so the slack (which reaches the next) does not count.
    { id: "a3", endedAt: at(29), durationMs: 1_000 },
    // While A and B both ran: left alone.
    { id: "ab", endedAt: at(35), durationMs: 1_000 },
    // Inside B only.
    { id: "b1", endedAt: at(55), durationMs: 3_000 },
    // In no run (a person's own test run, two hours later).
    { id: "x", endedAt: at(7200), durationMs: 1_000 },
  ],
  steps,
);

assert.deepEqual(
  matched
    .map(m => [m.call.id, m.step.runId, m.step.step])
    .sort((x, y) => x[0].localeCompare(y[0])),
  [
    ["a1", "A", "label"],
    ["a2", "B", "label"],
    ["a3", "A", "label"],
    ["b1", "B", "label"],
    ["c1", "C", "label"],
  ],
);
assert.deepEqual(
  ambiguous.map(c => c.id),
  ["ab"],
);
assert.deepEqual(
  unmatched.map(c => c.id),
  ["x"],
);

// A call without a duration is placed at its end.
assert.equal(
  matchCallsToSteps([{ id: "c", endedAt: at(20) }], steps).matched[0].step
    .runId,
  "A",
);

console.info("cost backfill tests passed");
