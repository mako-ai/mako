/**
 * decideBackfillFetchMode — full vs incremental scheduled resync.
 *
 * A scheduled resync of a Close flow fetches only records updated since the
 * entity's last completed backfill (minus an overlap); everything else stays
 * a full fetch, and every entity still gets a full fetch at least weekly.
 *
 * Run: npx tsx src/sync-cdc/backfill-fetch-mode.test.ts
 */
import assert from "node:assert/strict";

import {
  backfillFetchConfigFromEnv,
  decideBackfillFetchMode,
  DEFAULT_FULL_INTERVAL_MS,
  DEFAULT_OVERLAP_MS,
  supportsIncrementalResync,
} from "./backfill-fetch-mode";

const at = (iso: string) => new Date(iso);
const config = {
  enabled: true,
  overlapMs: DEFAULT_OVERLAP_MS,
  fullIntervalMs: DEFAULT_FULL_INTERVAL_MS,
};

// Nightly run at 02:00 UTC on the 20th; last full on the 15th; last
// completed (incremental) run on the 19th.
const base = {
  connectorType: "close",
  entity: "leads",
  trigger: "scheduled" as const,
  writeMode: "append_dedup",
  runStartedAt: at("2026-10-20T02:00:00Z"),
  lastBackfillRunStartedAt: at("2026-10-19T02:00:00Z"),
  lastFullBackfillRunStartedAt: at("2026-10-15T02:00:00Z"),
  config,
};

// ── The happy path: incremental from the last run minus 6 h ──────────
{
  const d = decideBackfillFetchMode(base);
  assert.equal(d.mode, "incremental");
  assert.equal(
    d.mode === "incremental" && d.since.toISOString(),
    "2026-10-18T20:00:00.000Z",
  );
}

// Every Search-API entity is eligible: leads, contacts, opportunities and
// each activity type.
for (const entity of [
  "leads",
  "contacts",
  "opportunities",
  "activities:Call",
  "activities:Email",
  "activities:CustomActivity",
]) {
  assert.equal(supportsIncrementalResync("close", entity), true, entity);
  assert.equal(
    decideBackfillFetchMode({ ...base, entity }).mode,
    "incremental",
  );
}

// Entities without an update-time filter keep a full fetch.
for (const entity of [
  "users",
  "custom_fields",
  "groups",
  "lead_statuses",
  "opportunity_statuses",
  "outcomes",
  "custom_activity_types",
  "custom_object_types",
  "custom_objects",
  "activities",
  "activities:",
]) {
  assert.equal(supportsIncrementalResync("close", entity), false, entity);
  assert.equal(decideBackfillFetchMode({ ...base, entity }).mode, "full");
}

// Other connectors are not covered (their behaviour is left untouched).
assert.equal(supportsIncrementalResync("stripe", "charges"), false);
assert.equal(supportsIncrementalResync(undefined, "leads"), false);
assert.equal(
  decideBackfillFetchMode({ ...base, connectorType: "stripe" }).mode,
  "full",
);

// ── Only scheduled runs go incremental ───────────────────────────────
assert.equal(
  decideBackfillFetchMode({ ...base, trigger: "manual" }).mode,
  "full",
);
// Runs started before the trigger field existed: treated as manual.
assert.equal(
  decideBackfillFetchMode({ ...base, trigger: undefined }).mode,
  "full",
);

// ── Write modes that need every record stay full ─────────────────────
assert.equal(
  decideBackfillFetchMode({ ...base, writeMode: "overwrite" }).mode,
  "full",
);
assert.equal(
  decideBackfillFetchMode({ ...base, writeMode: "append" }).mode,
  "full",
);
// Unset write mode is the default append_dedup.
assert.equal(
  decideBackfillFetchMode({ ...base, writeMode: undefined }).mode,
  "incremental",
);

// ── Safety net: full when there is no full on record ─────────────────
assert.equal(
  decideBackfillFetchMode({
    ...base,
    lastFullBackfillRunStartedAt: null,
    lastBackfillRunStartedAt: null,
  }).mode,
  "full",
);
// An incremental stamp alone never substitutes for a full one.
assert.equal(
  decideBackfillFetchMode({ ...base, lastFullBackfillRunStartedAt: null }).mode,
  "full",
);
assert.equal(
  decideBackfillFetchMode({ ...base, runStartedAt: null }).mode,
  "full",
);

// ── Safety net: periodic full at least every 7 days ──────────────────
{
  const sixDays23h = decideBackfillFetchMode({
    ...base,
    runStartedAt: at("2026-10-22T01:59:59Z"),
  });
  assert.equal(sixDays23h.mode, "incremental");

  const sevenDays = decideBackfillFetchMode({
    ...base,
    runStartedAt: at("2026-10-22T02:00:00Z"),
  });
  assert.equal(sevenDays.mode, "full");
}

// After the weekly full, the last completed run IS the full one.
{
  const d = decideBackfillFetchMode({
    ...base,
    runStartedAt: at("2026-10-23T02:00:00Z"),
    lastBackfillRunStartedAt: at("2026-10-22T02:00:00Z"),
    lastFullBackfillRunStartedAt: at("2026-10-22T02:00:00Z"),
  });
  assert.equal(
    d.mode === "incremental" && d.since.toISOString(),
    "2026-10-21T20:00:00.000Z",
  );
}

// A failed night leaves the older anchor: the next run reaches back further.
{
  const d = decideBackfillFetchMode({
    ...base,
    runStartedAt: at("2026-10-21T02:00:00Z"),
    lastBackfillRunStartedAt: at("2026-10-19T02:00:00Z"),
  });
  assert.equal(
    d.mode === "incremental" && d.since.toISOString(),
    "2026-10-18T20:00:00.000Z",
  );
}

// A stamp in the future of this run (clock skew) never moves the anchor
// forward: fall back to the last full run's start.
{
  const d = decideBackfillFetchMode({
    ...base,
    lastBackfillRunStartedAt: at("2026-10-21T00:00:00Z"),
  });
  assert.equal(
    d.mode === "incremental" && d.since.toISOString(),
    "2026-10-14T20:00:00.000Z",
  );
}

// ISO strings (Inngest step output) work like Dates.
assert.equal(
  decideBackfillFetchMode({
    ...base,
    runStartedAt: "2026-10-20T02:00:00.000Z",
    lastBackfillRunStartedAt: "2026-10-19T02:00:00.000Z",
    lastFullBackfillRunStartedAt: "2026-10-15T02:00:00.000Z",
  }).mode,
  "incremental",
);

// ── Kill switch and env overrides ────────────────────────────────────
assert.equal(
  decideBackfillFetchMode({ ...base, config: { ...config, enabled: false } })
    .mode,
  "full",
);
assert.equal(backfillFetchConfigFromEnv({}).enabled, true);
assert.equal(backfillFetchConfigFromEnv({}).overlapMs, DEFAULT_OVERLAP_MS);
assert.equal(
  backfillFetchConfigFromEnv({}).fullIntervalMs,
  DEFAULT_FULL_INTERVAL_MS,
);
for (const off of ["off", "false", "0", "no", " OFF "]) {
  assert.equal(
    backfillFetchConfigFromEnv({ CDC_INCREMENTAL_RESYNC: off }).enabled,
    false,
    off,
  );
}
assert.equal(
  backfillFetchConfigFromEnv({ CDC_INCREMENTAL_RESYNC_OVERLAP_HOURS: "12" })
    .overlapMs,
  12 * 60 * 60 * 1000,
);
assert.equal(
  backfillFetchConfigFromEnv({ CDC_FULL_RESYNC_INTERVAL_DAYS: "3" })
    .fullIntervalMs,
  3 * 24 * 60 * 60 * 1000,
);
// Garbage falls back to the defaults rather than disabling the safety net.
assert.equal(
  backfillFetchConfigFromEnv({ CDC_FULL_RESYNC_INTERVAL_DAYS: "-1" })
    .fullIntervalMs,
  DEFAULT_FULL_INTERVAL_MS,
);
assert.equal(
  backfillFetchConfigFromEnv({ CDC_INCREMENTAL_RESYNC_OVERLAP_HOURS: "abc" })
    .overlapMs,
  DEFAULT_OVERLAP_MS,
);

console.log("backfill-fetch-mode tests passed");
