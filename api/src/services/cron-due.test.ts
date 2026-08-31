/**
 * isCronDue — the one scheduler-due predicate.
 *
 * Also encodes the equivalence that let the flow scheduler's three
 * hand-rolled heuristics collapse into it: "the next occurrence after the
 * last run has passed" covers both its "alternative" check and its
 * "missed run" check, and a never-run schedule is due immediately.
 *
 * Run: npx tsx src/services/cron-due.test.ts
 */
import assert from "node:assert/strict";

import { isCronDue, nextCronRunAt } from "./cron-due";

const at = (iso: string) => new Date(iso);

// No cron → never due, even never-run.
assert.equal(isCronDue({ cron: null, lastRunAt: null }), false);
assert.equal(isCronDue({ cron: "", lastRunAt: null }), false);
assert.equal(isCronDue({ cron: "   ", lastRunAt: null }), false);

// Never ran → due now (the first occurrence is owed).
assert.equal(isCronDue({ cron: "0 0 * * *", lastRunAt: null }), true);

// Hourly schedule, last ran 06:30: next occurrence is 07:00.
const hourly = { cron: "0 * * * *", lastRunAt: at("2026-08-31T06:30:00Z") };
assert.equal(isCronDue({ ...hourly, now: at("2026-08-31T06:59:00Z") }), false);
assert.equal(isCronDue({ ...hourly, now: at("2026-08-31T07:00:00Z") }), true);
// Long-overdue (many missed occurrences) is still just "due".
assert.equal(isCronDue({ ...hourly, now: at("2026-09-02T00:00:00Z") }), true);

// Ran ON an occurrence: the run at 07:00 satisfies 07:00; due again at 08:00.
assert.equal(
  isCronDue({
    cron: "0 * * * *",
    lastRunAt: at("2026-08-31T07:00:00Z"),
    now: at("2026-08-31T07:59:59Z"),
  }),
  false,
);

// Timezone honored: daily-at-9 in New York (EDT, UTC-4) fires at 13:00 UTC.
const nyDaily = {
  cron: "0 9 * * *",
  timezone: "America/New_York",
  lastRunAt: at("2026-08-30T13:00:00Z"),
};
assert.equal(isCronDue({ ...nyDaily, now: at("2026-08-31T12:59:00Z") }), false);
assert.equal(isCronDue({ ...nyDaily, now: at("2026-08-31T13:00:00Z") }), true);
// Blank timezone falls back to UTC.
assert.equal(
  isCronDue({
    cron: "0 9 * * *",
    timezone: "  ",
    lastRunAt: at("2026-08-30T09:00:00Z"),
    now: at("2026-08-31T09:00:00Z"),
  }),
  true,
);

// Invalid cron / timezone THROW — scanners catch and skip the item.
assert.throws(() =>
  isCronDue({ cron: "not a cron", lastRunAt: at("2026-08-31T00:00:00Z") }),
);
assert.throws(() =>
  isCronDue({
    cron: "0 0 * * *",
    timezone: "Not/AZone",
    lastRunAt: at("2026-08-31T00:00:00Z"),
  }),
);

// nextCronRunAt is strictly after `from`.
assert.equal(
  nextCronRunAt("0 * * * *", {
    from: at("2026-08-31T07:00:00Z"),
  }).toISOString(),
  "2026-08-31T08:00:00.000Z",
);

console.log("cron-due tests passed");
