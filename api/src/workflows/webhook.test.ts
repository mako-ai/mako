/**
 * Run with: pnpm --filter api exec tsx src/workflows/webhook.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SESSION_SECRET = "test-secret";
process.env.BASE_URL = "https://mako.example/";

const WS = "6846e6a01b05af0948070582";

void test("a webhook URL opens its own workflow and no other", async () => {
  const { isWebhookSecret, webhookUrl } = await import("./webhook");
  const url = webhookUrl(WS, "daily-digest");
  assert.ok(url?.startsWith(`https://mako.example/api/workflows/hooks/${WS}/`));
  const secret = url?.split("/").pop() ?? "";
  assert.equal(isWebhookSecret(WS, "daily-digest", secret), true);
  assert.equal(isWebhookSecret(WS, "other", secret), false);
  assert.equal(isWebhookSecret("0".repeat(24), "daily-digest", secret), false);
  assert.equal(isWebhookSecret(WS, "daily-digest", ""), false);
});

void test("without SESSION_SECRET there is no webhook", async () => {
  const { isWebhookSecret, webhookUrl } = await import("./webhook");
  delete process.env.SESSION_SECRET;
  assert.equal(webhookUrl(WS, "daily-digest"), null);
  assert.equal(isWebhookSecret(WS, "daily-digest", ""), false);
});
