/**
 * Run notifications must link to routes that exist.
 *
 * Email, Slack and webhook deliveries used to deep-link to
 * `/workspace/<ws>/flows/<id>` and `/workspace/<ws>/console/<id>` — paths the
 * client never routed (it has no workspace segment at all), so every "Open
 * in Mako" button landed on the home screen. The client's real routes are
 * `/f/:flowId` and `/c/:consoleId` (app/src/lib/tab-routing.ts); the client
 * also accepts the legacy shapes, so links already delivered keep working.
 *
 * Run: npx tsx src/services/flow-run-notification.links.test.ts
 */
import assert from "node:assert/strict";

import {
  buildOutboundPayload,
  notificationDeepLinkPath,
} from "./flow-run-notification.service";

assert.equal(notificationDeepLinkPath("flow", "abc"), "/f/abc");
assert.equal(notificationDeepLinkPath("scheduled_query", "abc"), "/c/abc");

process.env.CLIENT_URL = "https://app.example.com/";
const base = {
  workspaceId: "ws1",
  runId: "run1",
  status: "completed" as const,
  success: true,
  completedAt: "2026-10-06T00:00:00.000Z",
};
const flowPayload = buildOutboundPayload({
  event: { ...base, resourceType: "flow", resourceId: "flow1" },
  resourceName: "Close → Warehouse",
  trigger: "success",
});
assert.equal(flowPayload.deepLink, "https://app.example.com/f/flow1");
assert.ok(
  !flowPayload.deepLink?.includes("/workspace/"),
  "the legacy /workspace/<ws>/flows path must not be emitted any more",
);

const consolePayload = buildOutboundPayload({
  event: { ...base, resourceType: "scheduled_query", resourceId: "c1" },
  resourceName: "Daily revenue",
  trigger: "failure",
});
assert.equal(consolePayload.deepLink, "https://app.example.com/c/c1");

// No client URL configured → no link rather than a relative one.
delete process.env.CLIENT_URL;
delete process.env.PUBLIC_URL;
assert.equal(
  buildOutboundPayload({
    event: { ...base, resourceType: "flow", resourceId: "flow1" },
    resourceName: "x",
    trigger: "success",
  }).deepLink,
  undefined,
);

console.log("flow-run-notification links: all assertions passed");
