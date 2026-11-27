import assert from "node:assert/strict";
import { getEffectiveBillingPlan, startOfUtcMonth } from "./config";

function testPastDueFallsBackToFree() {
  assert.equal(
    getEffectiveBillingPlan({
      plan: "pro",
      subscriptionStatus: "past_due",
    }),
    "free",
  );
}

function testCanceledFallsBackToFree() {
  assert.equal(
    getEffectiveBillingPlan({
      plan: "enterprise",
      subscriptionStatus: "canceled",
    }),
    "free",
  );
}

function testUnpaidPausedIncompleteExpiredFallBackToFree() {
  for (const status of ["unpaid", "paused", "incomplete_expired"] as const) {
    assert.equal(
      getEffectiveBillingPlan({
        plan: "pro",
        subscriptionStatus: status,
      }),
      "free",
      `expected ${status} to degrade to free`,
    );
  }
}

function testActivePlanIsPreserved() {
  assert.equal(
    getEffectiveBillingPlan({
      plan: "pro",
      subscriptionStatus: "active",
    }),
    "pro",
  );
}

function testMissingPlanDefaultsToFree() {
  assert.equal(getEffectiveBillingPlan(), "free");
}

function testStartOfUtcMonthIgnoresServerTimezone() {
  // Just after midnight UTC on the 1st is still that month in UTC, even
  // where local time is the previous day (and vice versa).
  assert.equal(
    startOfUtcMonth(new Date("2026-03-01T00:30:00Z")).toISOString(),
    "2026-03-01T00:00:00.000Z",
  );
  assert.equal(
    startOfUtcMonth(new Date("2026-02-28T23:30:00-05:00")).toISOString(),
    "2026-03-01T00:00:00.000Z",
  );
  assert.equal(
    startOfUtcMonth(new Date("2026-12-31T23:59:59Z")).toISOString(),
    "2026-12-01T00:00:00.000Z",
  );
}

function main() {
  testStartOfUtcMonthIgnoresServerTimezone();
  testPastDueFallsBackToFree();
  testCanceledFallsBackToFree();
  testUnpaidPausedIncompleteExpiredFallBackToFree();
  testActivePlanIsPreserved();
  testMissingPlanDefaultsToFree();
}

main();
