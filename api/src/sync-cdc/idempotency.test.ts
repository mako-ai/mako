import assert from "node:assert/strict";
import { Types } from "mongoose";
import { buildIdempotencyKey } from "./event-store";
import type { CdcEventInput } from "./events";

const FLOW_ID = new Types.ObjectId("6a0ac428a46d0800bdb51886");

function webhookInput(overrides: Partial<CdcEventInput> = {}): CdcEventInput {
  return {
    entity: "leads",
    recordId: "lead_abc",
    operation: "upsert",
    source: "webhook",
    ...overrides,
  };
}

// Regression for the CDC update-loss bug: a connector that supplies a STABLE
// per-record changeId (e.g. Close's `lead.updated:<recordId>`) must NOT collapse
// distinct updates onto one idempotency key. The webhook branch now derives the
// key from content (sourceTs + payload hash), so two genuinely different updates
// of the same record produce two different keys -> two events get ingested.
function testStableChangeIdDoesNotCollapseDistinctUpdates() {
  const stableChangeId = "lead.updated:lead_abc";
  const ts1 = new Date("2026-06-20T21:29:18.000Z");
  const ts2 = new Date("2026-06-21T17:19:39.000Z");

  const key1 = buildIdempotencyKey(
    webhookInput({
      idempotencyKey: stableChangeId,
      payload: { id: "lead_abc", name: "A" },
    }),
    { id: "lead_abc", name: "A" },
    ts1,
    FLOW_ID,
  );
  const key2 = buildIdempotencyKey(
    webhookInput({
      idempotencyKey: stableChangeId,
      payload: { id: "lead_abc", name: "B" },
    }),
    { id: "lead_abc", name: "B" },
    ts2,
    FLOW_ID,
  );

  assert.notEqual(
    key1,
    key2,
    "distinct updates of the same record must yield distinct idempotency keys",
  );
}

// True re-delivery (identical payload + sourceTs) must still dedupe -> same key.
function testIdenticalReDeliveryDedupes() {
  const ts = new Date("2026-06-21T17:19:39.000Z");
  const payload = { id: "lead_abc", name: "A", status: "open" };

  const key1 = buildIdempotencyKey(
    webhookInput({ idempotencyKey: "lead.updated:lead_abc", payload }),
    payload,
    ts,
    FLOW_ID,
  );
  const key2 = buildIdempotencyKey(
    webhookInput({
      idempotencyKey: "lead.updated:lead_abc",
      payload: { ...payload },
    }),
    { ...payload },
    ts,
    FLOW_ID,
  );

  assert.equal(key1, key2, "identical re-delivery must produce the same key");
}

// The webhook key must be scoped to the flow so the same event in two flows does
// not collide.
function testKeyIsFlowScoped() {
  const ts = new Date("2026-06-21T17:19:39.000Z");
  const payload = { id: "lead_abc" };
  const other = new Types.ObjectId("6a0ac428a46d0800bdb51887");

  const key1 = buildIdempotencyKey(
    webhookInput({ payload }),
    payload,
    ts,
    FLOW_ID,
  );
  const key2 = buildIdempotencyKey(
    webhookInput({ payload }),
    payload,
    ts,
    other,
  );

  assert.notEqual(key1, key2);
  assert.ok(key1.startsWith(`flow:${String(FLOW_ID)}:`));
}

// Non-webhook sources may still short-circuit on an explicit idempotency key.
function testBackfillStillHonorsExplicitKey() {
  const ts = new Date("2026-06-21T00:00:00.000Z");
  const key = buildIdempotencyKey(
    {
      entity: "leads",
      recordId: "lead_abc",
      operation: "upsert",
      source: "backfill",
      idempotencyKey: "explicit-key",
      payload: { id: "lead_abc" },
    },
    { id: "lead_abc" },
    ts,
    FLOW_ID,
  );
  assert.equal(key, `flow:${String(FLOW_ID)}:explicit-key`);
}

// Missing-sourceTs guard: an invalid Date must not throw and must still dedupe
// identical payloads via the payload hash.
function testMissingSourceTsGuard() {
  const invalid = new Date("not-a-date");
  const payload = { id: "lead_abc", name: "A" };

  const key1 = buildIdempotencyKey(
    webhookInput({ payload }),
    payload,
    invalid,
    FLOW_ID,
  );
  const key2 = buildIdempotencyKey(
    webhookInput({ payload: { ...payload } }),
    { ...payload },
    invalid,
    FLOW_ID,
  );

  assert.ok(key1.includes("no-source-ts"));
  assert.equal(key1, key2);
}

function main() {
  testStableChangeIdDoesNotCollapseDistinctUpdates();
  testIdenticalReDeliveryDedupes();
  testKeyIsFlowScoped();
  testBackfillStillHonorsExplicitKey();
  testMissingSourceTsGuard();
  // eslint-disable-next-line no-console
  console.log("idempotency.test.ts: all assertions passed");
}

main();
