/**
 * withHeartbeat (flow-execution-tracking.ts) with fake timers: it touches the
 * heartbeat up front and on every interval while the work runs, stops on
 * success and on throw, never fails the work when a touch fails, does not
 * stack touches while one is still in flight, and does nothing without an
 * execution id. The heartbeat write is stubbed; no Mongo is involved.
 *
 * Run: npx tsx src/services/flow-execution-heartbeat.test.ts
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { Types } from "mongoose";

import { FlowExecution } from "../database/workspace-schema";
import {
  EXECUTION_HEARTBEAT_INTERVAL_MS,
  EXECUTION_HEARTBEAT_STALE_MS,
  resetExecutionTrackingWarnThrottle,
  withHeartbeat,
} from "./flow-execution-tracking";

type UpdateOne = typeof FlowExecution.collection.updateOne;

const executionId = new Types.ObjectId().toString();
const INTERVAL = 1_000;

let touches = 0;
let behaviour: "ok" | "throw" | "hang" = "ok";
const collection = FlowExecution.collection as unknown as {
  updateOne: UpdateOne;
};
collection.updateOne = (async () => {
  touches++;
  if (behaviour === "throw") throw new Error("mongo blip");
  if (behaviour === "hang") return new Promise(() => {});
  return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
}) as unknown as UpdateOne;

/** Let settled promises run their continuations. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reset(next: typeof behaviour = "ok"): void {
  touches = 0;
  behaviour = next;
  resetExecutionTrackingWarnThrottle();
}

async function touchesPeriodicallyAndClearsOnSuccess(): Promise<void> {
  reset();
  const work = deferred<string>();
  const run = withHeartbeat(executionId, () => work.promise, INTERVAL);
  await flush();
  assert.equal(touches, 1, "touches up front");

  for (let i = 0; i < 3; i++) {
    mock.timers.tick(INTERVAL);
    await flush();
  }
  assert.equal(touches, 4, "touches on every interval");

  work.resolve("done");
  assert.equal(await run, "done", "returns the work's result");

  mock.timers.tick(INTERVAL * 5);
  await flush();
  assert.equal(touches, 4, "no touch after the work settled");
}

async function clearsOnThrow(): Promise<void> {
  reset();
  const work = deferred<never>();
  const run = withHeartbeat(executionId, () => work.promise, INTERVAL);
  await flush();
  mock.timers.tick(INTERVAL);
  await flush();
  assert.equal(touches, 2);

  const boom = new Error("chunk failed");
  work.reject(boom);
  await assert.rejects(run, error => error === boom, "rethrows the error");

  mock.timers.tick(INTERVAL * 5);
  await flush();
  assert.equal(touches, 2, "no touch after the work threw");
}

async function touchFailureNeverFailsTheWork(): Promise<void> {
  reset("throw");
  const work = deferred<number>();
  const run = withHeartbeat(executionId, () => work.promise, INTERVAL);
  await flush();
  for (let i = 0; i < 3; i++) {
    mock.timers.tick(INTERVAL);
    await flush();
  }
  assert.equal(touches, 4, "keeps trying after failures");
  work.resolve(42);
  assert.equal(await run, 42, "a failing heartbeat does not fail the work");
}

async function doesNotStackTouchesInFlight(): Promise<void> {
  reset("hang");
  const work = deferred<void>();
  const run = withHeartbeat(executionId, () => work.promise, INTERVAL);
  await flush();
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(INTERVAL);
    await flush();
  }
  assert.equal(touches, 1, "a hung touch is not doubled up");
  work.resolve();
  await run;
}

async function noExecutionIdNoTouches(): Promise<void> {
  reset();
  const result = await withHeartbeat(undefined, async () => "x", INTERVAL);
  mock.timers.tick(INTERVAL * 3);
  await flush();
  assert.equal(result, "x");
  assert.equal(touches, 0);
}

function intervalIsWellBelowThreshold(): void {
  assert.ok(
    EXECUTION_HEARTBEAT_INTERVAL_MS * 4 <= EXECUTION_HEARTBEAT_STALE_MS,
  );
  assert.equal(EXECUTION_HEARTBEAT_STALE_MS, 10 * 60_000);
}

async function main(): Promise<void> {
  intervalIsWellBelowThreshold();
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await touchesPeriodicallyAndClearsOnSuccess();
    await clearsOnThrow();
    await touchFailureNeverFailsTheWork();
    await doesNotStackTouchesInFlight();
    await noExecutionIdNoTouches();
  } finally {
    mock.timers.reset();
  }
  console.info("flow-execution heartbeat tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
