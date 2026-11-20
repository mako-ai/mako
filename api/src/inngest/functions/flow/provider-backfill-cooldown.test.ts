import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backfillResumeDue,
  infraResumeBackoffMs,
  isInfrastructureFailure,
  providerBackfillRetryAt,
  readProviderThrottle,
} from "./infra-failure";

const minute = 60_000;
const failureAt = new Date("2026-11-20T19:48:12.000Z");
const throttle =
  'read failed for "ad_creatives": meta-ads ad_creatives read failed: HTTP 400: code 80004: subcode 2446079';
const after = (minutes: number) => new Date(+failureAt + minutes * minute);

void test("skip every sweep inside the throttle cooldown, then allow resume", () => {
  const providerRetryAt = providerBackfillRetryAt(
    readProviderThrottle(throttle),
    failureAt,
  );
  assert.deepEqual(providerRetryAt, after(30));
  for (const minutes of [0, 5, 10, 15, 20, 25]) {
    assert.equal(backfillResumeDue({ providerRetryAt }, after(minutes)), false);
  }
  assert.equal(
    backfillResumeDue({ providerRetryAt }, new Date(+after(30) - 1)),
    false,
  );
  assert.equal(backfillResumeDue({ providerRetryAt }, after(30)), true);
  assert.equal(isInfrastructureFailure(throttle), false);
});

void test("ordinary failures and other streams keep their current retry policy", () => {
  for (const message of [
    undefined,
    "HTTP 400: code 80004: subcode 2446079",
    throttle.replace("ad_creatives read failed", "ads read failed"),
    throttle.replace("2446079", "33"),
    throttle.replace("HTTP 400", "HTTP 500"),
  ]) {
    assert.equal(
      providerBackfillRetryAt(readProviderThrottle(message), failureAt),
      undefined,
    );
  }
  assert.equal(backfillResumeDue(undefined, after(0)), true);
  const infraState = { infraFailures: 2, lastInfraFailureAt: failureAt };
  assert.equal(backfillResumeDue(infraState, after(1)), false);
  assert.equal(backfillResumeDue(infraState, after(2)), true);
});

void test("both the provider and infrastructure clocks must be due", () => {
  const state = {
    providerRetryAt: providerBackfillRetryAt(
      readProviderThrottle(throttle),
      failureAt,
    ),
    infraFailures: 6,
    lastInfraFailureAt: after(5),
  };
  assert.equal(infraResumeBackoffMs(state.infraFailures), 30 * minute);
  assert.equal(backfillResumeDue(state, after(30)), false);
  assert.equal(backfillResumeDue(state, after(35)), true);
});

void test("a longer typed provider delay wins over the default", () => {
  assert.deepEqual(
    providerBackfillRetryAt(
      { kind: "provider-throttle", retryAfterMs: 75 * minute },
      failureAt,
    ),
    after(75),
  );
  assert.deepEqual(
    providerBackfillRetryAt(
      { kind: "provider-throttle", retryAfterMs: 2 * minute },
      failureAt,
    ),
    after(30),
  );
});
