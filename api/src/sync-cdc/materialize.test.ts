import assert from "node:assert/strict";
import { materializeCdcEvents } from "./materialize";
import type { CdcStoredEvent } from "./events";

function event(overrides: Partial<CdcStoredEvent>): CdcStoredEvent {
  return {
    id: overrides.id ?? "evt",
    entity: overrides.entity ?? "leads",
    recordId: overrides.recordId ?? "rec_1",
    operation: overrides.operation ?? "upsert",
    payload: overrides.payload,
    sourceTs: overrides.sourceTs ?? new Date("2026-01-01T00:00:00.000Z"),
    ingestTs: overrides.ingestTs ?? new Date("2026-01-01T00:00:01.000Z"),
    ingestSeq: overrides.ingestSeq ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? "k",
    ...overrides,
  } as CdcStoredEvent;
}

function testUpsertRowShape() {
  const result = materializeCdcEvents({
    events: [
      event({
        recordId: "rec_1",
        operation: "upsert",
        ingestSeq: 7,
        sourceTs: new Date("2026-02-02T10:00:00.000Z"),
        payload: { name: "Acme", "nested.key": "v" },
      }),
    ],
    layout: { deleteMode: "hard" },
    flow: { deleteMode: undefined, dataSourceId: "ds_42" as any },
  });

  assert.equal(result.applied, 1);
  assert.equal(result.deleteMode, "hard");
  assert.equal(result.upsertRows.length, 1);
  assert.equal(result.softDeleteRows.length, 0);
  assert.equal(result.hardDeleteEvents.length, 0);

  const row = result.upsertRows[0];
  assert.equal(row.id, "rec_1");
  assert.equal(row.name, "Acme");
  // dotted keys are normalized to underscores
  assert.equal(row["nested_key"], "v");
  assert.equal(row._dataSourceId, "ds_42");
  assert.equal(row._mako_ingest_seq, 7);
  assert.equal(row.is_deleted, false);
  assert.equal(row._mako_deleted_at, null);
  assert.equal(row.deleted_at, null);
  // sourceTs falls back to event.sourceTs when payload has no timestamp field
  assert.ok(row._mako_source_ts instanceof Date);
  assert.equal(
    (row._mako_source_ts as Date).toISOString(),
    "2026-02-02T10:00:00.000Z",
  );
}

function testPayloadDataSourceIdWins() {
  const result = materializeCdcEvents({
    events: [
      event({ operation: "upsert", payload: { _dataSourceId: "payload_ds" } }),
    ],
    layout: {},
    flow: { dataSourceId: "fallback_ds" as any },
  });
  assert.equal(result.upsertRows[0]._dataSourceId, "payload_ds");
}

function testSourceTsFromPayload() {
  const result = materializeCdcEvents({
    events: [
      event({
        operation: "upsert",
        sourceTs: new Date("2026-02-02T10:00:00.000Z"),
        payload: { updated_at: "2026-03-03T12:00:00.000Z" },
      }),
    ],
    layout: {},
    flow: {},
  });
  assert.equal(
    (result.upsertRows[0]._mako_source_ts as Date).toISOString(),
    "2026-03-03T12:00:00.000Z",
  );
}

function testSoftDeleteRowShape() {
  const result = materializeCdcEvents({
    events: [event({ recordId: "rec_9", operation: "delete", ingestSeq: 3 })],
    layout: { deleteMode: "soft" },
    flow: {},
  });

  assert.equal(result.deleteMode, "soft");
  assert.equal(result.softDeleteRows.length, 1);
  assert.equal(result.hardDeleteEvents.length, 0);

  const row = result.softDeleteRows[0];
  assert.equal(row.id, "rec_9");
  assert.equal(row.is_deleted, true);
  assert.ok(row._mako_deleted_at instanceof Date);
  // _mako_deleted_at and deleted_at share the same Date instance
  assert.equal(row._mako_deleted_at, row.deleted_at);
}

function testHardDeleteRoutesEvents() {
  const del = event({ recordId: "rec_x", operation: "delete" });
  const result = materializeCdcEvents({
    events: [del],
    layout: { deleteMode: "hard" },
    flow: {},
  });
  assert.equal(result.deleteMode, "hard");
  assert.equal(result.softDeleteRows.length, 0);
  assert.deepEqual(result.hardDeleteEvents, [del]);
}

function testFlowDeleteModeOverridesLayout() {
  const result = materializeCdcEvents({
    events: [event({ operation: "delete" })],
    layout: { deleteMode: "hard" },
    flow: { deleteMode: "soft" },
  });
  assert.equal(result.deleteMode, "soft");
  assert.equal(result.softDeleteRows.length, 1);
}

function testDeleteModeDefaultsToHard() {
  const result = materializeCdcEvents({
    events: [event({ operation: "delete" })],
    layout: {},
    flow: {},
  });
  assert.equal(result.deleteMode, "hard");
  assert.equal(result.hardDeleteEvents.length, 1);
}

function testLatestChangePerRecordDedup() {
  const result = materializeCdcEvents({
    events: [
      event({
        recordId: "rec_1",
        operation: "upsert",
        sourceTs: new Date("2026-01-01T00:00:00.000Z"),
        payload: { v: "old" },
      }),
      event({
        recordId: "rec_1",
        operation: "upsert",
        sourceTs: new Date("2026-01-02T00:00:00.000Z"),
        payload: { v: "new" },
      }),
    ],
    layout: {},
    flow: {},
  });
  assert.equal(result.applied, 1);
  assert.equal(result.upsertRows.length, 1);
  assert.equal(result.upsertRows[0].v, "new");
}

function testEmptyBatch() {
  const result = materializeCdcEvents({ events: [], layout: {}, flow: {} });
  assert.equal(result.applied, 0);
  assert.equal(result.upsertRows.length, 0);
  assert.equal(result.softDeleteRows.length, 0);
  assert.equal(result.hardDeleteEvents.length, 0);
}

function main() {
  testUpsertRowShape();
  testPayloadDataSourceIdWins();
  testSourceTsFromPayload();
  testSoftDeleteRowShape();
  testHardDeleteRoutesEvents();
  testFlowDeleteModeOverridesLayout();
  testDeleteModeDefaultsToHard();
  testLatestChangePerRecordDedup();
  testEmptyBatch();
  // eslint-disable-next-line no-console
  console.log("materialize.test.ts: all assertions passed");
}

main();
