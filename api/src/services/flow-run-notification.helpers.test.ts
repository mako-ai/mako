import assert from "node:assert/strict";
import {
  buildIdempotencyKey,
  signWebhookBody,
  terminalTriggerFromRunEvent,
} from "./flow-run-notification.helpers";

function testTerminalTriggerMapsSuccessAndFailure() {
  assert.equal(
    terminalTriggerFromRunEvent({
      workspaceId: "w",
      resourceType: "flow",
      resourceId: "f",
      runId: "r",
      status: "completed",
      success: true,
      completedAt: "",
    }),
    "success",
  );
  assert.equal(
    terminalTriggerFromRunEvent({
      workspaceId: "w",
      resourceType: "flow",
      resourceId: "f",
      runId: "r",
      status: "failed",
      success: false,
      completedAt: "",
    }),
    "failure",
  );
}

function testBuildIdempotencyKeyJoinsParts() {
  assert.equal(
    buildIdempotencyKey({
      resourceType: "scheduled_query",
      resourceId: "abc",
      runId: "run1",
      trigger: "success",
      channelType: "email",
      ruleId: "rule1",
    }),
    "scheduled_query:abc:run1:success:email:rule1",
  );
}

function testSignWebhookBodyIsStableHex() {
  const sig = signWebhookBody("secret", '{"a":1}');
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(signWebhookBody("secret", '{"a":1}'), sig);
}

function main() {
  testTerminalTriggerMapsSuccessAndFailure();
  testBuildIdempotencyKeyJoinsParts();
  testSignWebhookBodyIsStableHex();
}

main();
