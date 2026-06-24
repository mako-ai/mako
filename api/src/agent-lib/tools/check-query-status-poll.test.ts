import assert from "node:assert/strict";
import {
  pollRunStatus,
  abortableSleep,
  type ReadRunResult,
  type PollRunArtifact,
} from "./check-query-status-poll";

/**
 * Build a virtual clock + sleep pair so the long-poll loop can be driven
 * deterministically without real timers. Every simulated sleep advances the
 * clock by the requested amount.
 */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

const running: PollRunArtifact = {
  at: new Date(0),
  startedAt: new Date(0),
  status: "running",
  executionId: "exec-1",
};
const success: PollRunArtifact = {
  at: new Date(0),
  status: "success",
  rowCount: 42,
  durationMs: 1234,
  sampleRows: [{ a: 1 }, { a: 2 }],
  executionId: "exec-1",
};

/** A terminal status returns immediately without ever sleeping. */
async function testTerminalReturnsImmediately() {
  const clock = virtualClock();
  let reads = 0;
  let sleeps = 0;
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => {
      reads++;
      return { ok: true, lastRun: success };
    },
    waitMs: 30_000,
    intervalMs: 2_000,
    now: clock.now,
    sleep: async ms => {
      sleeps++;
      await clock.sleep(ms);
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.rowCount, 42);
  assert.equal(result.durationMs, 1234);
  assert.deepEqual(result.preview, [{ a: 1 }, { a: 2 }]);
  assert.equal(reads, 1, "should read exactly once");
  assert.equal(sleeps, 0, "should never sleep for a settled run");
}

/** While running, the poll blocks and returns the instant the run settles. */
async function testBlocksThenReturnsOnSettle() {
  const clock = virtualClock();
  let reads = 0;
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => {
      reads++;
      // Running for the first 3 reads, then finishes.
      return { ok: true, lastRun: reads <= 3 ? running : success };
    },
    waitMs: 30_000,
    intervalMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.status, "success");
  assert.equal(reads, 4, "should keep polling until the run settles");
  // 3 sleeps of 2s each before the 4th read saw success.
  assert.equal(clock.now(), 6_000);
}

/**
 * THE THROTTLE GUARANTEE: a run that never settles must NOT return on the first
 * read. It blocks for the whole wait window, returns status:"running", and only
 * polls a bounded number of times — so the agent can't rapid-fire the tool.
 */
async function testStillRunningThrottlesToOnePerWindow() {
  const clock = virtualClock();
  let reads = 0;
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => {
      reads++;
      return { ok: true, lastRun: running };
    },
    executionId: "exec-1",
    waitMs: 30_000,
    intervalMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.status, "running");
  assert.equal(result.executionId, "exec-1");
  assert.ok(
    typeof result.elapsedMs === "number" && result.elapsedMs >= 30_000,
    "elapsedMs should reflect the full wait",
  );
  // Reads happen at t=0,2k,...,30k => 16 reads. The key point: it is bounded
  // and small (NOT one-per-second-forever like the bug).
  assert.equal(reads, 16, "bounded number of reads per blocking poll");
  assert.equal(clock.now(), 30_000, "blocks for the full wait window");
}

/** A newer run on the same console is reported as superseded. */
async function testSuperseded() {
  const clock = virtualClock();
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => ({
      ok: true,
      lastRun: { ...running, executionId: "exec-2" },
    }),
    executionId: "exec-1",
    waitMs: 30_000,
    intervalMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.status, "superseded");
  assert.equal(result.latestExecutionId, "exec-2");
}

/** An aborted turn ends the wait immediately rather than blocking. */
async function testAbortEndsWaitEarly() {
  const clock = virtualClock();
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => {
      reads++;
      return { ok: true, lastRun: running };
    },
    executionId: "exec-1",
    waitMs: 30_000,
    intervalMs: 2_000,
    signal: controller.signal,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.status, "running");
  assert.equal(reads, 1, "aborted poll returns after a single read");
  assert.equal(clock.now(), 0, "aborted poll does not sleep");
}

/** A read/load error surfaces as a failure result. */
async function testReadErrorSurfaces() {
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => ({
      ok: false,
      error: "Console not found",
    }),
    waitMs: 30_000,
    intervalMs: 2_000,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "Console not found");
}

/** No run yet → clear instruction to run the query first. */
async function testNoRunYet() {
  const result = await pollRunStatus({
    readRun: async (): Promise<ReadRunResult> => ({ ok: true, lastRun: null }),
    waitMs: 30_000,
    intervalMs: 2_000,
  });

  assert.equal(result.success, false);
  assert.match(String(result.error), /No run found/);
}

/** The real abortableSleep resolves promptly when the signal aborts. */
async function testAbortableSleepResolvesOnAbort() {
  const controller = new AbortController();
  const started = Date.now();
  const p = abortableSleep(10_000, controller.signal);
  controller.abort();
  await p;
  assert.ok(
    Date.now() - started < 1_000,
    "abortableSleep should resolve right after abort, not after the full delay",
  );
}

async function run() {
  await testTerminalReturnsImmediately();
  await testBlocksThenReturnsOnSettle();
  await testStillRunningThrottlesToOnePerWindow();
  await testSuperseded();
  await testAbortEndsWaitEarly();
  await testReadErrorSurfaces();
  await testNoRunYet();
  await testAbortableSleepResolvesOnAbort();
  process.stdout.write("\ncheck-query-status-poll.test.ts: all tests passed\n");
}

run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
