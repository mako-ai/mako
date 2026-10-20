/**
 * Sandbox runs (sandbox.ts) without a box: what a run's result looks like to
 * an agent (summary and full), which ids are sandbox runs, that the box gets
 * `mako workflow run` itself (runtime-files.ts), and the server-side wait.
 * A real run in a real box is verified end to end (see the PR).
 *
 * Run with: pnpm --filter api exec tsx src/workflows/sandbox.test.ts
 */
import assert from "node:assert/strict";

import { installRuntimeCommand } from "./runtime-files";
import { type RunResult, isSandboxRunId, shapeSandboxRun } from "./sandbox";
import { MAX_WAIT_SECONDS, waitFor, waitSeconds } from "./wait";

const RUN = "sandbox-0d15f705-25a0-4520-8053-eceebe02dc43";

// What `mako workflow run` writes.
const result: RunResult = {
  workflow: "eval",
  input: { limit: 3 },
  status: "FAILED",
  startedAt: "2026-10-20T10:00:00.000Z",
  durationMs: 1500,
  tasks: [
    {
      name: "label",
      status: "COMPLETED",
      attempts: 1,
      durationMs: 1000,
      output: { text: "x".repeat(5000) },
      logs: Array.from({ length: 30 }, (_, i) => ({
        at: "2026-10-20T10:00:01.000Z",
        level: "info",
        message: `line ${i}`,
      })),
    },
    {
      name: "write",
      status: "FAILED",
      attempts: 2,
      error: "Error: refused\n    at write (workflow.ts:9:3)",
      logs: [],
    },
  ],
};

async function main() {
  assert.equal(isSandboxRunId(RUN), true);
  assert.equal(isSandboxRunId("22222222-2222-2222-2222-222222222222"), false);
  assert.equal(isSandboxRunId("sandbox-../../etc"), false);

  const summary = shapeSandboxRun(RUN, result);
  assert.deepEqual(
    [summary.runId, summary.sandbox, summary.workflowId, summary.status],
    [RUN, true, "eval", "FAILED"],
  );
  assert.equal(summary.input, '{"limit":3}');
  const [label, write] = summary.steps;
  assert.match(label.output ?? "", /… \(5011 chars\)$/);
  assert.equal(label.logs.length, 20);
  assert.equal(label.logs.at(-1), "info: line 29");
  assert.equal(label.logLinesOmitted, 10);
  assert.deepEqual(
    [write.status, write.attempt, write.error],
    ["FAILED", 2, "Error: refused\n    at write (workflow.ts:9:3)"],
  );
  const full = shapeSandboxRun(RUN, result, true);
  assert.equal(full.steps[0].output?.length, 5011);
  assert.equal(full.steps[0].logs.length, 30);
  assert.equal("logLinesOmitted" in full.steps[0], false);
  // Too large for one answer (an MCP reply is cut at 200 000 characters):
  // each text cut, a step's last lines kept.
  const cut = shapeSandboxRun(RUN, result, true, { chars: 100, lines: 5 });
  assert.match(cut.steps[0].output ?? "", /^\{"text":"x{91}… \(5011 chars\)$/);
  assert.deepEqual(cut.steps[0].logs.at(-1), "info: line 29");
  assert.equal(cut.steps[0].logs.length, 5);
  assert.equal(cut.steps[0].logLinesOmitted, 25);

  // The box gets the runtime and `mako workflow run` itself.
  const install = installRuntimeCommand();
  for (const file of [
    "run.mjs",
    "defaults/lib/mako.ts",
    "cli/workflow.js",
    "cli/workflow-runner.js",
    "cli/workflow-loader.js",
    "cli/workflow-hatchet.js",
  ]) {
    assert.ok(install.includes(`/${file}"`), file);
  }
  assert.ok(!install.includes("worker.mjs"), "no engine or worker in a box");

  // The server-side wait: capped below the MCP exchange's two minutes.
  assert.equal(waitSeconds(undefined), 0);
  assert.equal(waitSeconds(600), MAX_WAIT_SECONDS);
  assert.ok(MAX_WAIT_SECONDS * 1000 < 120_000);
  let clock = 0;
  let reads = 0;
  const fake = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  assert.deepEqual(
    await waitFor(
      async () => ++reads,
      n => n >= 3,
      { seconds: 10, intervalMs: 2000, ...fake },
    ),
    { value: 3, done: true },
  );
  clock = 0;
  const still = await waitFor(
    async () => "RUNNING",
    () => false,
    {
      seconds: 5,
      intervalMs: 2000,
      ...fake,
    },
  );
  assert.equal(still.done, false);
  assert.equal(clock, 5000, "never past the deadline");

  console.log("sandbox runs tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
