/**
 * Incremental-sync helpers (incremental.ts).
 *
 * Run: npx tsx src/connectors/base/incremental.test.ts
 */
import assert from "node:assert/strict";

import {
  DAY_MS,
  addDaysIso,
  filterRecordsSince,
  isoDay,
  windowEnd,
} from "./incremental";

assert.equal(DAY_MS, 86_400_000);
assert.equal(isoDay(new Date("2024-03-05T23:59:59.000Z")), "2024-03-05");
assert.equal(
  addDaysIso("2024-01-30T12:00:00.000Z", 7),
  "2024-02-06T12:00:00.000Z",
);
assert.equal(
  addDaysIso("2024-01-30T12:00:00.000Z", -1),
  "2024-01-29T12:00:00.000Z",
);

const start = new Date("2024-01-01T00:00:00.000Z");
assert.equal(
  windowEnd(start, 90, new Date("2025-01-01T00:00:00.000Z")).toISOString(),
  "2024-03-31T00:00:00.000Z",
);
assert.equal(
  windowEnd(start, 90, new Date("2024-02-01T00:00:00.000Z")).toISOString(),
  "2024-02-01T00:00:00.000Z",
  "capped",
);

const since = new Date("2024-06-01T00:00:00.000Z");
const kept = filterRecordsSince<Record<string, unknown>>(
  [
    { id: "new", updated_at: "2024-06-02T00:00:00Z" },
    { id: "edge", updated_at: "2024-06-01T00:00:00.000Z" },
    { id: "old", updated_at: "2024-05-31T23:59:59Z" },
    { id: "undated" },
    { id: "garbage", updated_at: "not a date" },
    { id: "number", updated_at: 1717286400000 },
  ],
  since,
  "updated_at",
);
assert.deepEqual(
  kept.map(record => record.id),
  ["new", "edge"],
  "undated and non-string timestamps are dropped, not kept",
);

console.info("incremental tests passed");
