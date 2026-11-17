import { test } from "node:test";
import assert from "node:assert/strict";
import { isCronDue } from "./cron-due";
import { resyncLastRunAt } from "./resync-schedule";

const NOW = new Date("2026-11-17T15:00:00.000Z");
const LAST = new Date("2026-11-10T04:00:00.000Z");
const DAILY = { enabled: true, cron: "0 4 * * *", timezone: "Europe/Paris" };

/** Due at the moment the schedule is saved? */
const dueOnSave = (lastRunAt: Date | undefined, cron: string, tz: string) =>
  isCronDue({ cron, timezone: tz, lastRunAt: lastRunAt ?? null, now: NOW });

void test("a newly set resync first runs at its next tick, not at once", () => {
  const lastRunAt = resyncLastRunAt(undefined, DAILY, NOW);
  assert.deepEqual(lastRunAt, NOW);
  assert.equal(dueOnSave(lastRunAt, DAILY.cron, DAILY.timezone), false);
  // Without the anchor it was due on save: the bug.
  assert.equal(dueOnSave(undefined, DAILY.cron, DAILY.timezone), true);
});

void test("a changed cron or timezone counts from now", () => {
  const before = { ...DAILY, lastRunAt: LAST };
  const hourly = { ...DAILY, cron: "0 * * * *" };
  assert.deepEqual(resyncLastRunAt(before, hourly, NOW), NOW);
  assert.equal(dueOnSave(LAST, hourly.cron, hourly.timezone), true);
  assert.equal(dueOnSave(NOW, hourly.cron, hourly.timezone), false);
  assert.deepEqual(
    resyncLastRunAt(before, { ...DAILY, timezone: "UTC" }, NOW),
    NOW,
  );
});

void test("a re-enabled resync counts from now", () => {
  const before = { ...DAILY, enabled: false, lastRunAt: LAST };
  assert.deepEqual(resyncLastRunAt(before, DAILY, NOW), NOW);
});

void test("an unchanged resync keeps its last run", () => {
  const before = { ...DAILY, lastRunAt: LAST };
  assert.deepEqual(resyncLastRunAt(before, { ...DAILY }, NOW), LAST);
  // Whitespace and an unset timezone (UTC) are not changes.
  assert.deepEqual(
    resyncLastRunAt(
      { enabled: true, cron: "0 4 * * *", timezone: null, lastRunAt: LAST },
      { enabled: true, cron: " 0 4 * * * ", timezone: "UTC" },
      NOW,
    ),
    LAST,
  );
});

void test("a disabled or cron-less resync keeps its last run", () => {
  const before = { ...DAILY, lastRunAt: LAST };
  assert.deepEqual(
    resyncLastRunAt(before, { ...DAILY, enabled: false }, NOW),
    LAST,
  );
  assert.equal(
    resyncLastRunAt(undefined, { enabled: true, cron: "" }, NOW),
    undefined,
  );
});
