/**
 * Run with: pnpm --filter api exec tsx src/workflows/webhook.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

void test("only the saved secret opens a webhook", async () => {
  const { encryptString } = await import("../services/crypto.service");
  const { isWebhookSecret } = await import("./webhook");
  const webhooks = { "daily-digest": encryptString("s3cret") };
  assert.equal(isWebhookSecret(webhooks, "daily-digest", "s3cret"), true);
  assert.equal(isWebhookSecret(webhooks, "daily-digest", "s3creT"), false);
  assert.equal(isWebhookSecret(webhooks, "daily-digest", ""), false);
  // No webhook turned on for that workflow: nothing opens it, and a name
  // every object has is not a workflow.
  assert.equal(isWebhookSecret(webhooks, "other", "s3cret"), false);
  assert.equal(isWebhookSecret(webhooks, "constructor", "s3cret"), false);
  assert.equal(isWebhookSecret(undefined, "daily-digest", ""), false);
});
