/**
 * Run with: pnpm --filter api exec tsx src/workflows/webhook.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

void test("only the saved secret opens a webhook", async () => {
  const { encryptString } = await import("../services/crypto.service");
  const { isWebhookSecret } = await import("./webhook");
  const stored = encryptString("s3cret");
  assert.equal(isWebhookSecret(stored, "s3cret"), true);
  assert.equal(isWebhookSecret(stored, "s3creT"), false);
  assert.equal(isWebhookSecret(stored, ""), false);
  // No webhook turned on for the workflow: nothing opens it.
  assert.equal(isWebhookSecret(undefined, "s3cret"), false);
  assert.equal(isWebhookSecret(undefined, ""), false);
});
