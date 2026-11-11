/**
 * When a workflow worker sleeps and wakes (idle.ts): the decision, and what
 * counts as work in Hatchet. Hatchet is a fake fetch that answers by path.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/idle.test.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { decide, readHatchetDemand, IDLE_AFTER_MS, PREWAKE_MS } =
    await import("./idle");
  const now = new Date("2026-11-11T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const inMs = (ms: number) => new Date(now.getTime() + ms);
  const quiet = { busy: false };

  // --- decide ---------------------------------------------------------------

  // Idle long enough: sleep. Not yet: keep.
  assert.deepEqual(
    decide(
      {
        replicas: 1,
        lastNeededAt: ago(IDLE_AFTER_MS + 1),
        deployPending: false,
        demand: quiet,
      },
      now,
    ),
    { action: "sleep", needed: false },
  );
  assert.equal(
    decide(
      {
        replicas: 1,
        lastNeededAt: ago(IDLE_AFTER_MS - 1000),
        deployPending: false,
        demand: quiet,
      },
      now,
    ).action,
    "keep",
  );
  // Never needed since this field existed: idle, sleeps.
  assert.equal(
    decide({ replicas: 1, deployPending: false, demand: quiet }, now).action,
    "sleep",
  );

  // Work wakes a sleeping worker and keeps an awake one, however old.
  for (const state of [
    { deployPending: true, demand: quiet },
    { deployPending: false, demand: { busy: true } },
    {
      deployPending: false,
      demand: { busy: false, nextTriggerAt: inMs(PREWAKE_MS - 1000) },
    },
  ]) {
    const old = ago(IDLE_AFTER_MS * 10);
    assert.deepEqual(
      decide({ replicas: 0, lastNeededAt: old, ...state }, now),
      { action: "wake", needed: true },
    );
    assert.deepEqual(
      decide({ replicas: 1, lastNeededAt: old, ...state }, now),
      { action: "keep", needed: true },
    );
  }

  // A schedule further off than PREWAKE_MS does not keep it awake.
  assert.equal(
    decide(
      {
        replicas: 1,
        lastNeededAt: ago(IDLE_AFTER_MS * 2),
        deployPending: false,
        demand: { busy: false, nextTriggerAt: inMs(PREWAKE_MS * 3) },
      },
      now,
    ).action,
    "sleep",
  );

  // Hatchet unreadable: leave it as it is, either way.
  for (const replicas of [0, 1]) {
    assert.equal(
      decide({ replicas, deployPending: false, demand: null }, now).action,
      "keep",
    );
  }

  // A sleeping, idle worker stays asleep.
  assert.equal(
    decide({ replicas: 0, deployPending: false, demand: quiet }, now).action,
    "keep",
  );

  // --- readHatchetDemand ----------------------------------------------------

  const tenant = { tenantId: "t1", token: "x", apiUrl: "https://hatchet.test" };
  const asked: URL[] = [];
  let answers: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input);
    asked.push(url);
    const key = Object.keys(answers).find(path => url.pathname.endsWith(path));
    return new Response(JSON.stringify(key ? answers[key] : { rows: [] }), {
      status: 200,
    });
  }) as typeof fetch;

  // Only queued and running runs are asked for.
  answers = {};
  assert.deepEqual(await readHatchetDemand(tenant, ["a"], ["a"], now), {
    busy: false,
    nextTriggerAt: undefined,
  });
  const runsUrl = asked.find(u => u.pathname.endsWith("/workflow-runs"))!;
  assert.deepEqual(runsUrl.searchParams.getAll("statuses"), [
    "QUEUED",
    "RUNNING",
  ]);

  // A run of a deployed workflow is work; one of a workflow gone from main
  // is not.
  answers = { "/workflow-runs": { rows: [{ workflowName: "gone" }] } };
  assert.equal((await readHatchetDemand(tenant, ["a"], [], now)).busy, false);
  answers = { "/workflow-runs": { rows: [{ workflowName: "a" }] } };
  assert.equal((await readHatchetDemand(tenant, ["a"], [], now)).busy, true);

  // Schedules count for active, deployed, enabled workflows only; the
  // earliest one wins, a one-off scheduled run included.
  answers = {
    "/workflows/crons": {
      rows: [
        { workflowName: "a", cron: "30 12 * * *", enabled: true },
        { workflowName: "a", cron: "10 12 * * *", enabled: false },
        { workflowName: "off", cron: "1 12 * * *", enabled: true },
        { workflowName: "a", cron: "not a cron", enabled: true },
      ],
    },
    "/workflows/scheduled": {
      rows: [{ workflowName: "a", triggerAt: "2026-11-11T12:20:00Z" }],
    },
  };
  const demand = await readHatchetDemand(tenant, ["a", "off"], ["a"], now);
  assert.equal(demand.nextTriggerAt?.toISOString(), "2026-11-11T12:20:00.000Z");
  answers["/workflows/scheduled"] = { rows: [] };
  assert.equal(
    (
      await readHatchetDemand(tenant, ["a", "off"], ["a"], now)
    ).nextTriggerAt?.toISOString(),
    "2026-11-11T12:30:00.000Z",
  );

  // A Hatchet error is thrown: the sweep then leaves the worker alone.
  globalThis.fetch = (async () =>
    new Response("down", { status: 503 })) as typeof fetch;
  await assert.rejects(readHatchetDemand(tenant, ["a"], ["a"], now));

  console.log("workflow idle tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
