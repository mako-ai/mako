/**
 * Stored webhook headers never keep a secret: the fixed list, Claap's
 * echoed secret, and a connector's declared secret header.
 *
 * Run: node --import tsx src/utils/webhook-token.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactWebhookSecretHeaders } from "./webhook-token";

void test("secret headers are redacted, any case, the rest kept", () => {
  const out = redactWebhookSecretHeaders(
    {
      Authorization: "Bearer s",
      "X-Mako-Webhook-Token": "s",
      "X-Claap-Webhook-Secret": "s",
      "X-Vendor-Secret": "s",
      "content-type": "application/json",
    },
    ["x-vendor-secret"],
  );
  assert.deepEqual(out, {
    Authorization: "[redacted]",
    "X-Mako-Webhook-Token": "[redacted]",
    "X-Claap-Webhook-Secret": "[redacted]",
    "X-Vendor-Secret": "[redacted]",
    "content-type": "application/json",
  });
});
