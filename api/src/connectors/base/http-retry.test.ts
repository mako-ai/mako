/**
 * The shared connector retry policy (http-retry.ts).
 *
 * Run: npx tsx src/connectors/base/http-retry.test.ts
 */
import assert from "node:assert/strict";
import axios, { AxiosError, AxiosHeaders } from "axios";

import {
  computeRetryDelay,
  isRetryableHttpError,
  parseRetryAfter,
  withHttpRetry,
} from "./http-retry";

function httpError(status: number, headers: Record<string, string> = {}) {
  const error = new AxiosError(`HTTP ${status}`, "ERR_BAD_RESPONSE");
  error.response = {
    status,
    statusText: "",
    headers,
    data: {},
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

const NOW = Date.parse("2026-11-14T12:00:00Z");

function testParseRetryAfter() {
  assert.equal(parseRetryAfter("120", NOW), 120_000);
  assert.equal(parseRetryAfter(" 1.5 ", NOW), 1_500);
  assert.equal(parseRetryAfter("0", NOW), 0);
  // HTTP-date, both in the future and in the past.
  assert.equal(parseRetryAfter("Sat, 14 Nov 2026 12:00:30 GMT", NOW), 30_000);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", NOW), 0);
  // Never NaN.
  assert.equal(parseRetryAfter("soon", NOW), null);
  assert.equal(parseRetryAfter("-5", NOW), null);
  assert.equal(parseRetryAfter("", NOW), null);
  assert.equal(parseRetryAfter(undefined, NOW), null);
  assert.equal(parseRetryAfter(["7"], NOW), 7_000);
}

function testIsRetryable() {
  assert.equal(isRetryableHttpError(httpError(429)), true);
  assert.equal(isRetryableHttpError(httpError(500)), true);
  assert.equal(isRetryableHttpError(httpError(503)), true);
  assert.equal(isRetryableHttpError(httpError(400)), false);
  assert.equal(isRetryableHttpError(httpError(404)), false);

  // Network errors: an axios request that got no response, Node codes.
  const network = new AxiosError("socket hang up", "ECONNRESET");
  network.request = {};
  assert.equal(isRetryableHttpError(network), true);
  const noResponse = new AxiosError("Network Error", "ERR_NETWORK");
  noResponse.request = {};
  assert.equal(isRetryableHttpError(noResponse), true);
  assert.equal(
    isRetryableHttpError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })),
    true,
  );
  assert.equal(
    isRetryableHttpError(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      }),
    ),
    true,
  );

  // Not retryable: cancellation, programming errors.
  assert.equal(isRetryableHttpError(new axios.CanceledError()), false);
  assert.equal(isRetryableHttpError(new Error("boom")), false);
  assert.equal(isRetryableHttpError(undefined), false);
}

function testComputeRetryDelay() {
  // Retry-After wins (any header case), capped by maxRetryAfterMs.
  assert.deepEqual(
    computeRetryDelay(0, httpError(429, { "Retry-After": "3" }), {
      now: () => NOW,
    }),
    { delayMs: 3_000, fromRetryAfter: true },
  );
  assert.deepEqual(
    computeRetryDelay(0, httpError(429, { "retry-after": "86400" }), {
      now: () => NOW,
      maxRetryAfterMs: 10_000,
    }),
    { delayMs: 10_000, fromRetryAfter: true },
  );

  // No Retry-After (a typical 5xx): full jitter over base * 2^attempt,
  // capped at maxDelayMs — not a flat 1 s and not a flat 60 s.
  const top = {
    random: () => 0.999999,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
  };
  assert.equal(computeRetryDelay(0, httpError(503), top).delayMs, 999);
  assert.equal(computeRetryDelay(3, httpError(503), top).delayMs, 7_999);
  assert.equal(computeRetryDelay(10, httpError(503), top).delayMs, 59_999);
  assert.equal(
    computeRetryDelay(3, httpError(503), { ...top, random: () => 0 }).delayMs,
    0,
  );
}

async function testWithHttpRetry() {
  // Recovers after transient failures, waiting what the policy says.
  const delays: number[] = [];
  let calls = 0;
  const value = await withHttpRetry(
    async () => {
      calls++;
      if (calls === 1) throw httpError(429, { "retry-after": "2" });
      if (calls === 2) throw httpError(502);
      return "ok";
    },
    {
      sleep: async ms => void delays.push(ms),
      random: () => 0.5,
      baseDelayMs: 100,
    },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2_000, 100]); // 0.5 * 100 * 2^1

  // A non-retryable error is thrown at once.
  calls = 0;
  await assert.rejects(
    withHttpRetry(
      async () => {
        calls++;
        throw httpError(401);
      },
      { sleep: async () => {} },
    ),
    (error: unknown) => (error as AxiosError).response?.status === 401,
  );
  assert.equal(calls, 1);

  // A sustained 429 with an HTTP-date Retry-After stops at the cap and
  // surfaces the last error (previously: NaN → 0 ms, forever).
  calls = 0;
  const waits: number[] = [];
  const retries: number[] = [];
  await assert.rejects(
    withHttpRetry(
      async () => {
        calls++;
        throw httpError(429, {
          "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
        });
      },
      {
        maxRetries: 4,
        sleep: async ms => void waits.push(ms),
        onRetry: info => retries.push(info.attempt),
      },
    ),
  );
  assert.equal(calls, 5);
  assert.deepEqual(retries, [1, 2, 3, 4]);
  assert.ok(waits.every(ms => Number.isFinite(ms) && ms >= 0));

  // Custom predicate (e.g. "writes only on 429").
  calls = 0;
  await assert.rejects(
    withHttpRetry(
      async () => {
        calls++;
        throw httpError(503);
      },
      {
        sleep: async () => {},
        isRetryable: error => (error as AxiosError).response?.status === 429,
      },
    ),
  );
  assert.equal(calls, 1);
}

async function main() {
  testParseRetryAfter();
  testIsRetryable();
  testComputeRetryDelay();
  await testWithHttpRetry();
  console.info("http-retry tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
