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

void test("only the exact ads error starts its cooldown", () => {
  const ads = throttle.replaceAll("ad_creatives", "ads");
  const providerRetryAt = providerBackfillRetryAt(
    readProviderThrottle(ads),
    failureAt,
  );
  assert.deepEqual(providerRetryAt, after(30));
  assert.equal(
    backfillResumeDue({ providerRetryAt }, new Date(+after(30) - 1)),
    false,
  );
  assert.equal(backfillResumeDue({ providerRetryAt }, after(30)), true);
  assert.equal(isInfrastructureFailure(ads), false);
});

const adSetThrottle =
  "meta-ads ad_sets read failed: HTTP 400: code 17: subcode 2446079: provider rate limit";

void test("the verified ad-set throttle uses the provider cooldown in both error forms", () => {
  for (const message of [
    adSetThrottle,
    `read failed for "ad_sets": ${adSetThrottle}`,
  ]) {
    const providerRetryAt = providerBackfillRetryAt(
      readProviderThrottle(message),
      failureAt,
    );
    assert.deepEqual(providerRetryAt, after(30));
    assert.equal(
      backfillResumeDue({ providerRetryAt }, new Date(+after(30) - 1)),
      false,
    );
    assert.equal(backfillResumeDue({ providerRetryAt }, after(30)), true);
    assert.equal(isInfrastructureFailure(message), false);
  }
});

void test("an unverified ad-set failure does not start a provider cooldown", () => {
  for (const message of [
    adSetThrottle.replace(": provider rate limit", ""),
    adSetThrottle.replace("provider rate limit", "User request limit reached"),
    adSetThrottle.replace("HTTP 400", "HTTP 500"),
    adSetThrottle.replace("code 17:", "code 80004:"),
    adSetThrottle.replace("2446079", "2446078"),
    adSetThrottle.replace("ad_sets", "campaigns"),
    `read failed for "ads": ${adSetThrottle}`,
    `unrelated text: ${adSetThrottle}`,
    `${adSetThrottle}: extra text`,
  ]) {
    assert.equal(readProviderThrottle(message), undefined, message);
  }
});

void test("ordinary failures and other streams keep their current retry policy", () => {
  for (const message of [
    undefined,
    "HTTP 400: code 80004: subcode 2446079",
    "HTTP 500: code 80004: subcode 2446079",
    `unrelated text: ${throttle}`,
    `${throttle}: extra text`,
    throttle.replace("ad_creatives read failed", "ads read failed"),
    throttle.replaceAll("ad_creatives", "campaigns"),
    throttle.replace("80004", "17"),
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
