import assert from "node:assert/strict";
import {
  infraResumeBackoffMs,
  infraResumeDue,
  isInfrastructureFailure,
} from "./infra-failure";
import { backfillFailureUpdate } from "./failure";

// The 18 Nov 2026 incident's errors are the platform's.
const platform = [
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/lib/mako-connectors/runtime/versions/afaf3869/node_modules/@makoai/connector-sdk/src/run.js' imported from /var/lib/mako-connectors/runtime/versions/afaf3869/node_modules/@makoai/connector-sdk/bin/mako-connector.js",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/scratch/connector-runtime/versions/abc/node_modules/@makoai/connector-sdk/src/run.js'",
  "Could not install the connector runtime: The staged connector runtime failed its check: an SDK file is missing or changed, or the SDK does not import.",
  "Could not install the connector Node runtime: curl: (28) timed out",
  "Timed out while installing the connector runtime.",
  "Sandbox ix4jt4l5niwopbimyvwa4 for connector-sync:v2:6846e6a01b05af0948070582 was replaced or is gone.",
  "The connector's box was replaced during the run; its output is missing.",
  "Connector run cleanup failed: cleanup timed out",
  "Connector run cleanup failed: [unavailable] The sandbox is running but port is not open: The sandbox is running but envd inside it could not be reached (e.g. its network is down).",
  "No connector box for this connection after 120 s. 4 runs are waiting.",
  "A new connector box did not answer its first ping.",
  "Flow execution abandoned due to worker crash or timeout",
  "Process received SIGTERM",
];
for (const message of platform) {
  assert.equal(isInfrastructureFailure(message), true, message);
}

// A connector's own errors still count.
const connector = [
  'read failed for "leads": HTTP 401 Unauthorized',
  'discover failed: The connector "acme" has no entity "deals".',
  // A connector importing a package it does not ship: its code, not ours.
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'lodash' imported from /var/lib/mako-connectors/runs/r1/connectors/acme@abc/connector.ts",
  "The connector timed out.",
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "",
];
for (const message of connector) {
  assert.equal(isInfrastructureFailure(message), false, message);
}
assert.equal(isInfrastructureFailure(undefined), false);
assert.equal(isInfrastructureFailure(null), false);

// Backoff: 1, 2, 4 … min, capped at 30 min.
assert.equal(infraResumeBackoffMs(1), 60_000);
assert.equal(infraResumeBackoffMs(2), 120_000);
assert.equal(infraResumeBackoffMs(3), 240_000);
assert.equal(infraResumeBackoffMs(6), 30 * 60_000);
assert.equal(infraResumeBackoffMs(40), 30 * 60_000);
assert.equal(infraResumeBackoffMs(0), 60_000);

const now = new Date("2026-11-18T11:00:00Z");
assert.equal(infraResumeDue(undefined, now), true);
assert.equal(infraResumeDue({ infraFailures: 0 }, now), true);
assert.equal(
  infraResumeDue(
    { infraFailures: 2, lastInfraFailureAt: new Date("2026-11-18T10:59:00Z") },
    now,
  ),
  false,
);
assert.equal(
  infraResumeDue(
    { infraFailures: 2, lastInfraFailureAt: new Date("2026-11-18T10:58:00Z") },
    now,
  ),
  true,
);

// A platform failure bumps infraFailures, never the resume cap's counter.
const infra = backfillFailureUpdate(
  "Sandbox sbx_1 for connector-sync:v2:ws was replaced or is gone.",
);
assert.deepEqual(infra.$inc, { "backfillState.infraFailures": 1 });
assert.ok(
  (infra.$set as Record<string, unknown>)[
    "backfillState.lastInfraFailureAt"
  ] instanceof Date,
);
// A connector failure counts, and ends the run of platform failures.
assert.deepEqual(backfillFailureUpdate("HTTP 401 Unauthorized"), {
  $inc: { "backfillState.consecutiveFailures": 1 },
  $set: { "backfillState.infraFailures": 0 },
});

console.info("infra-failure tests passed");
