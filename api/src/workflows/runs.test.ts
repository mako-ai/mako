/**
 * How a run reads (its steps in order, with the steps each waited for, and
 * the log the agent and the screen get) and how a retry asks Hatchet.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/runs.test.ts
 */
import assert from "node:assert/strict";

import { readWorkflowFlow, retryRun, shapeRun } from "./runs";

const RUN = "22222222-2222-2222-2222-222222222222";
const WORKFLOW = "33333333-3333-3333-3333-333333333333";
const tenant = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  token: "t",
  apiUrl: "http://hatchet.test",
};

// select → write → report, with write failed and report never run.
const task = (name: string, stepId: string, status: string, at: string) => ({
  actionId: `flow:${name}`,
  stepId,
  status,
  taskInsertedAt: at,
  taskExternalId: `ext-${name}`,
  metadata: { id: `id-${name}` },
  errorMessage:
    status === "FAILED"
      ? JSON.stringify({
          message: "BigQuery refused the write",
          stack:
            "Error: BigQuery refused the write\n    at fn (/tmp/src/abc/workflows/flow/workflow.ts:42:7)",
        })
      : undefined,
});
const detail = {
  run: { metadata: { id: RUN }, status: "FAILED" },
  tasks: [
    task("report", "s3", "CANCELLED", "3"),
    task("select", "s1", "COMPLETED", "1"),
    task("write", "s2", "FAILED", "2"),
  ],
  shape: [
    { stepId: "s1", childrenStepIds: ["s2"] },
    { stepId: "s2", childrenStepIds: ["s3"] },
    { stepId: "s3", childrenStepIds: [] },
  ],
};
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ message: `line ${i + 1}` }));

// Steps come in order, each with the steps it waited for; the error keeps
// the code line from its stack.
const shaped = shapeRun(detail, { "id-select": lines(30) });
assert.deepEqual(
  shaped.steps.map(s => [s.step, s.parents, s.status]),
  [
    ["select", [], "COMPLETED"],
    ["write", ["select"], "FAILED"],
    ["report", ["write"], "CANCELLED"],
  ],
);
assert.match(shaped.steps[1].error ?? "", /workflows\/flow\/workflow\.ts:42/);
// The agent's read keeps the last 20 lines; the screen's (`full`) all of them.
assert.equal(shaped.steps[0].logs.length, 20);
assert.equal(shaped.steps[0].logs[0], "line 11");
assert.equal(
  shapeRun(detail, { "id-select": lines(30) }, { full: true }).steps[0].logs
    .length,
  30,
);
// A run without a graph (an older Hatchet) has no parents, not an error.
assert.deepEqual(
  shapeRun({ ...detail, shape: undefined }, {}).steps.map(s => s.parents),
  [[], [], []],
);

void (async () => {
  // Retry: from a step replays that step's task; without, the run itself.
  const sent: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body = String(url).includes("/workflow-runs/")
      ? detail
      : String(url).endsWith(`/tenants/${tenant.tenantId}/workflows`)
        ? { rows: [{ name: "flow", metadata: { id: WORKFLOW } }] }
        : String(url).endsWith(`/workflows/${WORKFLOW}/versions`)
          ? {
              workflowConfig: {
                Tasks: [
                  { ReadableId: "select", Parents: [], Timeout: "60s" },
                  { ReadableId: "write", Parents: ["select"], Retries: 2 },
                ],
              },
            }
          : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  await retryRun(tenant, RUN, "write");
  assert.deepEqual(sent.at(-1), {
    url: `http://hatchet.test/api/v1/stable/tenants/${tenant.tenantId}/tasks/replay`,
    body: { externalIds: ["ext-write"] },
  });
  await retryRun(tenant, RUN);
  assert.deepEqual(sent.at(-1)?.body, { externalIds: [RUN] });
  await assert.rejects(retryRun(tenant, RUN, "nope"), /No step "nope"/);
  await assert.rejects(retryRun(tenant, "../x"), /Invalid run id/);

  // The flow as the code defines it: from the workflow's latest version.
  assert.deepEqual(await readWorkflowFlow(tenant, "flow"), {
    workflowId: "flow",
    steps: [
      { step: "select", parents: [], retries: 0, timeout: "60s" },
      { step: "write", parents: ["select"], retries: 2, timeout: undefined },
    ],
  });
  await assert.rejects(readWorkflowFlow(tenant, "other"), /not deployed/);

  console.info("runs.test.ts: ok");
})();
