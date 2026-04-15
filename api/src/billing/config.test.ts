import assert from "node:assert/strict";
import { getEffectiveBillingPlan } from "./config";

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

function main() {
  testPastDueFallsBackToFree();
  testCanceledFallsBackToFree();
  testActivePlanIsPreserved();
  testMissingPlanDefaultsToFree();
}

main();
