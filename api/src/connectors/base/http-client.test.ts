/**
 * Shared connector HTTP helpers (http-client.ts).
 *
 * Run: npx tsx src/connectors/base/http-client.test.ts
 */
import assert from "node:assert/strict";
import { AxiosError, AxiosHeaders } from "axios";
import type { Logger } from "@logtape/logtape";

import {
  clampPageSize,
  createRetryExecutor,
  formatHttpApiError,
  headerValue,
  resolveConfiguredBaseUrl,
} from "./http-client";

function httpError(status: number, data: unknown) {
  const error = new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
  );
  error.response = {
    status,
    statusText: "",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  };
  return error;
}

function testHeaderValue() {
  const headers = { "X-Signature": "abc", "set-cookie": ["a", "b"] };
  assert.equal(headerValue(headers, "x-signature"), "abc");
  assert.equal(headerValue(headers, "SET-COOKIE"), "a");
  assert.equal(headerValue(headers, "missing"), undefined);
  assert.equal(headerValue(undefined, "x"), undefined);
}

function testResolveConfiguredBaseUrl() {
  const fallback = "https://api.example.com";
  assert.equal(resolveConfiguredBaseUrl(undefined, fallback), fallback);
  assert.equal(resolveConfiguredBaseUrl("   ", fallback), fallback);
  assert.equal(resolveConfiguredBaseUrl(42, fallback), fallback);
  assert.equal(
    resolveConfiguredBaseUrl(" https://eu.example.com/// ", fallback),
    "https://eu.example.com",
  );
}

function testClampPageSize() {
  assert.equal(clampPageSize(undefined, 100, 50), 50);
  assert.equal(clampPageSize(0, 20, 50), 20, "0 falls back, not through");
  assert.equal(clampPageSize(-3, 20, 50), 20);
  assert.equal(clampPageSize(10, 20, 50), 10);
  assert.equal(clampPageSize(500, 20, 50), 50);
}

function testFormatHttpApiError() {
  const describe = (data: unknown) =>
    (data as { message?: string } | undefined)?.message;
  assert.equal(
    formatHttpApiError(httpError(400, { message: "bad field" }), describe),
    "HTTP 400: bad field",
  );
  assert.equal(
    formatHttpApiError(httpError(500, {}), describe),
    "HTTP 500: Request failed with status code 500",
  );
  const noResponse = new AxiosError("socket hang up", "ECONNRESET");
  assert.equal(formatHttpApiError(noResponse, describe), "socket hang up");
  assert.equal(formatHttpApiError(new Error("boom"), describe), "boom");
  assert.equal(formatHttpApiError("plain", describe), "plain");
}

async function testCreateRetryExecutor() {
  const warnings: Array<{ message: string; props: unknown }> = [];
  const logger = {
    warn: (message: string, props: unknown) =>
      warnings.push({ message, props }),
  } as unknown as Logger;
  const sleeps: number[] = [];
  const execute = createRetryExecutor({
    label: "Acme",
    logger,
    sleep: async ms => {
      sleeps.push(ms);
    },
    formatError: () => "HTTP 400: formatted",
  });

  let calls = 0;
  const value = await execute(async () => {
    calls++;
    if (calls < 3) throw httpError(503, {});
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(warnings.length, 2);
  assert.equal(
    warnings[0].message,
    "Acme API rate limited or server error, retrying",
  );

  // A 4xx is not retried and its message is replaced, still an axios error.
  calls = 0;
  await assert.rejects(
    execute(async () => {
      calls++;
      throw httpError(400, {});
    }),
    (error: unknown) =>
      error instanceof AxiosError &&
      error.message === "HTTP 400: formatted" &&
      error.response?.status === 400,
  );
  assert.equal(calls, 1);

  // maxRetries caps the attempts.
  calls = 0;
  await assert.rejects(
    execute(async () => {
      calls++;
      throw httpError(429, {});
    }, 1),
  );
  assert.equal(calls, 2);

  // Without formatError the message is left alone.
  const plain = createRetryExecutor({
    label: "Acme",
    logger,
    sleep: async () => {},
  });
  await assert.rejects(
    plain(async () => {
      throw httpError(404, {});
    }),
    /Request failed with status code 404/,
  );
}

async function main() {
  testHeaderValue();
  testResolveConfiguredBaseUrl();
  testClampPageSize();
  testFormatHttpApiError();
  await testCreateRetryExecutor();
  console.info("http-client tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
