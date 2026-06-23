import assert from "node:assert/strict";
import {
  BaseConnector,
  ConnectionTestResult,
  EntityMetadata,
  HttpRetryOptions,
} from "./BaseConnector";
import { getValueByPath } from "./object-path";

/**
 * Minimal concrete connector that exposes the protected retry wrapper and
 * records sleep durations (instead of actually waiting) so backoff behavior
 * can be asserted deterministically.
 */
class TestConnector extends BaseConnector {
  public sleeps: number[] = [];

  testConnection(): Promise<ConnectionTestResult> {
    return Promise.resolve({ success: true, message: "ok" });
  }
  getAvailableEntities(): string[] {
    return [];
  }
  getEntityMetadata(): EntityMetadata[] {
    return [];
  }
  fetchEntity(): Promise<void> {
    return Promise.resolve();
  }
  getMetadata() {
    return {
      name: "test",
      version: "1.0.0",
      description: "test connector",
      supportedEntities: [],
    };
  }

  protected async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }

  run<T>(fn: () => Promise<T>, options?: HttpRetryOptions): Promise<T> {
    return this.executeHttpWithRetry(fn, options);
  }
}

function createConnector(): TestConnector {
  return new TestConnector({
    id: "ds_test",
    name: "Test",
    type: "test",
    config: {},
  } as any);
}

function axiosError(
  status: number,
  headers: Record<string, string> = {},
): any {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, headers },
  };
}

function failTimes<T>(times: number, error: unknown, value: T) {
  let calls = 0;
  const fn = () => {
    calls++;
    if (calls <= times) return Promise.reject(error);
    return Promise.resolve(value);
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}

async function testNoRetryOnSuccess() {
  const c = createConnector();
  let calls = 0;
  const result = await c.run(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(c.sleeps, []);
}

async function testRetriesOn429ThenSucceeds() {
  const c = createConnector();
  const op = failTimes(2, axiosError(429), "done");
  const result = await c.run(op.fn);
  assert.equal(result, "done");
  assert.equal(op.calls, 3); // 1 initial + 2 retries
  assert.equal(c.sleeps.length, 2);
}

async function testHonorsRetryAfterHeader() {
  const c = createConnector();
  const op = failTimes(1, axiosError(429, { "retry-after": "2" }), "done");
  await c.run(op.fn);
  assert.deepEqual(c.sleeps, [2000]);
}

async function testFixedFallbackSeconds() {
  const c = createConnector();
  const op = failTimes(1, axiosError(429), "done");
  await c.run(op.fn, { retryAfterFallbackSeconds: 60 });
  assert.deepEqual(c.sleeps, [60000]);
}

async function testExponentialBackoff() {
  const c = createConnector();
  const op = failTimes(2, axiosError(503), "done");
  await c.run(op.fn);
  // base 1000 * 2^0, then * 2^1
  assert.deepEqual(c.sleeps, [1000, 2000]);
}

async function testNonRetryableThrowsImmediately() {
  const c = createConnector();
  const op = failTimes(5, axiosError(400), "done");
  await assert.rejects(() => c.run(op.fn));
  assert.equal(op.calls, 1);
  assert.deepEqual(c.sleeps, []);
}

async function testExhaustsRetriesAndThrows() {
  const c = createConnector();
  const err = axiosError(429);
  const op = failTimes(99, err, "done");
  await assert.rejects(
    () => c.run(op.fn, { maxRetries: 2 }),
    (thrown: any) => thrown === err,
  );
  assert.equal(op.calls, 3); // 1 initial + 2 retries
  assert.equal(c.sleeps.length, 2);
}

async function testTransformFinalError() {
  const c = createConnector();
  const err = axiosError(400);
  await assert.rejects(
    () =>
      c.run(() => Promise.reject(err), {
        transformFinalError: e => {
          (e as any).message = "friendly message";
          return e;
        },
      }),
    (thrown: any) => thrown.message === "friendly message",
  );
}

async function testCustomIsRetryableRetriesNonAxiosErrors() {
  const c = createConnector();
  const op = failTimes(2, new Error("boom"), "done");
  const result = await c.run(op.fn, { isRetryable: () => true });
  assert.equal(result, "done");
  assert.equal(op.calls, 3);
}

function testGetValueByPath() {
  assert.equal(getValueByPath({ a: { b: { c: 5 } } }, "a.b.c"), 5);
  assert.equal(getValueByPath({ a: { b: {} } }, "a.b.missing"), null);
  assert.equal(getValueByPath({ a: 1 }, "x.y"), null);
  const obj = { a: 1 };
  assert.equal(getValueByPath(obj, ""), obj);
}

async function main() {
  await testNoRetryOnSuccess();
  await testRetriesOn429ThenSucceeds();
  await testHonorsRetryAfterHeader();
  await testFixedFallbackSeconds();
  await testExponentialBackoff();
  await testNonRetryableThrowsImmediately();
  await testExhaustsRetriesAndThrows();
  await testTransformFinalError();
  await testCustomIsRetryableRetriesNonAxiosErrors();
  testGetValueByPath();
}

main().catch((error: unknown) => {
  throw error;
});
