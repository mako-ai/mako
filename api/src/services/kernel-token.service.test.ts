/* eslint-disable no-console, no-process-exit */
/**
 * Unit tests for kernel-token.service — mint/verify round-trip, tamper
 * detection, expiry, secret mismatch, and prefix handling.
 *
 * Run with: tsx src/services/kernel-token.service.test.ts
 */
import assert from "node:assert/strict";

import {
  KernelTokenError,
  isKernelToken,
  mintKernelToken,
  verifyKernelToken,
} from "./kernel-token.service";

// resolveSecret() reads the env lazily at mint/verify time, so setting it here
// (module top-level, after the hoisted imports) is sufficient.
process.env.NOTEBOOK_KERNEL_SECRET = "test-secret-please-ignore";

function testRoundTrip() {
  const token = mintKernelToken({
    workspaceId: "ws1",
    userId: "u1",
    notebookId: "nb1",
  });
  assert.equal(isKernelToken(token), true, "minted token has the mnk_ prefix");
  const payload = verifyKernelToken(token);
  assert.equal(payload.wsId, "ws1");
  assert.equal(payload.userId, "u1");
  assert.equal(payload.notebookId, "nb1");
  assert.equal(payload.scope, "read");
}

function testTamperRejected() {
  const token = mintKernelToken({ workspaceId: "ws1", userId: "u1" });
  const [body, sig] = token.slice("mnk_".length).split(".");
  const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
  assert.throws(
    () => verifyKernelToken(`mnk_${flipped}.${sig}`),
    KernelTokenError,
    "a tampered payload must fail signature verification",
  );
}

function testExpiredRejected() {
  const past = 1_000_000_000_000;
  const token = mintKernelToken({
    workspaceId: "ws1",
    userId: "u1",
    ttlSeconds: 60,
    nowMs: past,
  });
  assert.throws(
    () => verifyKernelToken(token, { nowMs: past + 61_000 }),
    /expired/i,
  );
}

function testWithinTtl() {
  const t0 = 1_700_000_000_000;
  const token = mintKernelToken({
    workspaceId: "ws1",
    userId: "u1",
    ttlSeconds: 900,
    nowMs: t0,
  });
  assert.equal(verifyKernelToken(token, { nowMs: t0 + 800_000 }).wsId, "ws1");
}

function testSecretMismatchRejected() {
  const token = mintKernelToken({ workspaceId: "ws1", userId: "u1" });
  process.env.NOTEBOOK_KERNEL_SECRET = "a-different-secret";
  try {
    assert.throws(() => verifyKernelToken(token), /signature/i);
  } finally {
    process.env.NOTEBOOK_KERNEL_SECRET = "test-secret-please-ignore";
  }
}

function testNonKernelBearer() {
  assert.equal(isKernelToken("revops_abc"), false);
  assert.throws(() => verifyKernelToken("revops_abc"), /not a kernel token/i);
}

function main() {
  testRoundTrip();
  testTamperRejected();
  testExpiredRejected();
  testWithinTtl();
  testSecretMismatchRejected();
  testNonKernelBearer();
  console.log("kernel-token.service.test: OK — mint/verify/tamper/expiry");
  process.exit(0);
}

main();
