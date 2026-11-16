/**
 * How a run reads (its steps in order, with the steps each waited for, and
 * the log the agent and the screen get), how a retry asks Hatchet, and that
 * a workflow's runs are its own.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/runs.test.ts
 */
import assert from "node:assert/strict";

import {
  endedStatusOf,
  listWorkflowRuns,
  readWorkflowFlow,
  retryRun,
  shapeRun,
} from "./runs";

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
// What the tenant holds: more workflows than a page of Hatchet's list (those
// of earlier commits come first), one that runs all the time, and `flow`,
// whose only run is older than a list's worth of the busy one's.
const BUSY = "44444444-4444-4444-4444-444444444444";
const GHOST = "55555555-5555-5555-5555-555555555555";
const GHOST_RUN = "66666666-6666-6666-6666-666666666666";
const tenantWorkflows = [
  ...Array.from({ length: 60 }, (_, i) => ({
    name: `gone-${i}`,
    metadata: { id: `99999999-9999-9999-9999-${String(i).padStart(12, "0")}` },
  })),
  { name: "busy", metadata: { id: BUSY } },
  { name: "flow", metadata: { id: WORKFLOW } },
  { name: "ghost", metadata: { id: GHOST } },
];
const tenantRuns: Array<Record<string, unknown> & { workflowId: string }> = [
  {
    metadata: { id: GHOST_RUN },
    workflowId: GHOST,
    workflowName: "ghost",
    status: "RUNNING",
    startedAt: "2026-11-16T16:30:00Z",
  },
  {
    metadata: { id: "77777777-7777-7777-7777-777777777777" },
    workflowId: GHOST,
    workflowName: "ghost",
    status: "COMPLETED",
    startedAt: "2026-11-16T16:00:00Z",
  },
  ...Array.from({ length: 150 }, (_, i) => ({
    metadata: { id: `88888888-8888-8888-8888-${String(i).padStart(12, "0")}` },
    workflowId: BUSY,
    workflowName: "busy",
    status: "COMPLETED",
  })),
  {
    metadata: { id: RUN },
    workflowId: WORKFLOW,
    workflowName: "flow",
    status: "COMPLETED",
  },
];

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

// A run Hatchet left open: its status says RUNNING, every step of it ended.
// Mako reads how it ended from the steps, once they have been still for ten
// minutes; a run between two steps, or with a step under way, stays open.
const NOW = Date.parse("2026-11-16T20:00:00Z");
const ended = (status: string, at = "2026-11-16T16:40:00Z", stepId = "s1") => ({
  status,
  stepId,
  finishedAt: at,
});
const open = (tasks: Array<Record<string, unknown>>, shape = detail.shape) =>
  endedStatusOf({ run: { status: "RUNNING" }, tasks, shape }, NOW);
assert.equal(open([ended("COMPLETED"), ended("FAILED")]), "FAILED");
assert.equal(open([ended("COMPLETED"), ended("CANCELLED")]), "CANCELLED");
// Every step ran and completed: the run did.
assert.equal(
  open([
    ended("COMPLETED", undefined, "s1"),
    ended("COMPLETED", undefined, "s2"),
    ended("COMPLETED", undefined, "s3"),
  ]),
  "COMPLETED",
);
// Steps that never started: the run did not complete.
assert.equal(open([ended("COMPLETED")]), "CANCELLED");
// Still open: a step under way, a step that ended a moment ago (the next
// one is about to be queued), no step yet (waiting its turn), no time known.
assert.equal(open([ended("COMPLETED"), { status: "RUNNING" }]), null);
assert.equal(open([ended("FAILED", "2026-11-16T19:55:00Z")]), null);
assert.equal(open([]), null);
assert.equal(open([{ status: "FAILED", stepId: "s1" }]), null);
// A run Hatchet closed is left as Hatchet says.
assert.equal(
  endedStatusOf(
    { run: { status: "COMPLETED" }, tasks: [ended("FAILED")] },
    NOW,
  ),
  null,
);

void (async () => {
  // Retry: from a step replays that step's task; without, the run itself.
  const sent: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { pathname, searchParams } = new URL(String(url));
    const page = <T>(rows: T[]) => ({
      rows: rows.slice(0, Number(searchParams.get("limit") ?? 50)),
    });
    const body = String(url).includes(`/workflow-runs/${GHOST_RUN}`)
      ? {
          run: { metadata: { id: GHOST_RUN }, status: "RUNNING" },
          tasks: [ended("COMPLETED"), ended("FAILED")],
        }
      : String(url).includes("/workflow-runs/")
        ? detail
        : pathname.endsWith("/workflow-runs")
          ? // As Hatchet lists them: newest first, of the workflows asked for.
            page(
              tenantRuns.filter(run =>
                searchParams.getAll("workflow_ids").includes(run.workflowId),
              ),
            )
          : pathname.endsWith(`/tenants/${tenant.tenantId}/workflows`)
            ? // As Hatchet pages them: 50 unless asked for more.
              page(tenantWorkflows)
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

  // A workflow's runs are its own: one that runs all the time leaves the
  // tenant's last runs without any of this one's, and its list still has it.
  assert.deepEqual(
    (await listWorkflowRuns(tenant, "flow", 100)).map(run => [
      run.runId,
      run.workflowId,
      run.status,
    ]),
    [[RUN, "flow", "COMPLETED"]],
  );
  assert.equal((await listWorkflowRuns(tenant, "busy", 100)).length, 100);
  // A run Hatchet left open is listed as it ended; it is read once.
  const before = sent.length;
  assert.deepEqual(
    (await listWorkflowRuns(tenant, "ghost", 100)).map(run => run.status),
    ["FAILED", "COMPLETED"],
  );
  await listWorkflowRuns(tenant, "ghost", 100);
  assert.equal(
    sent.slice(before).filter(s => s.url.includes(GHOST_RUN)).length,
    1,
  );

  // A workflow Hatchet does not know has none, and is not asked about.
  const asked = sent.length;
  assert.deepEqual(await listWorkflowRuns(tenant, "never-deployed", 100), []);
  assert.equal(sent.length, asked + 1);

  console.info("runs.test.ts: ok");
})();
