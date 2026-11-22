import { DuckDBInstance } from "@duckdb/node-api";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getCdcEventStore } from "../event-store";
import type { CdcEventInput } from "../events";
import { buildMergeStatement } from "./bigquery-sql";

const workspaceId = String(new Types.ObjectId());
const entity = "payment_methods";
const recordId = "pm_fixture";
const sourceCreated = new Date("2026-11-20T08:00:00Z");
const attachment = new Date("2026-11-20T08:09:59Z");
const detachment = new Date("2026-11-20T08:10:00Z");
const detachProcessing = new Date("2026-11-20T08:11:00Z");
const attachProcessing = new Date("2026-11-20T08:12:00Z");
const store = getCdcEventStore();
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    await mongo?.stop();
  }
});

it("lets the destination guard reject an older attachment delivered after detachment", async () => {
  const flowId = String(new Types.ObjectId());
  const event = (
    sourceTs: Date,
    processedAt: Date,
    customer: string | null,
  ): CdcEventInput => ({
    entity,
    recordId,
    operation: "upsert",
    source: "webhook",
    sourceTs,
    payload: {
      created: sourceCreated.getTime() / 1000,
      customer,
      _syncedAt: processedAt,
    },
  });
  for (const delivery of [
    event(detachment, detachProcessing, null),
    event(attachment, attachProcessing, "cus_fixture"),
  ]) {
    await store.appendEvents({ workspaceId, flowId, events: [delivery] });
  }
  const queued = await store.readAfter({
    flowId,
    entity,
    afterIngestSeq: 0,
    limit: 10,
  });

  const columns = ["id", "customer", "_mako_source_ts"];
  // Execute the generated guard in DuckDB with equivalent identifiers and
  // casts. Use the queue's clock as the staging input to isolate append.
  const merge = buildMergeStatement({
    fullLive: "payment_methods",
    fullStaging: "staged_methods",
    columns,
    keyColumns: ["id"],
    stagingCols: new Set(columns),
    liveTypes: new Map([
      ["id", "STRING"],
      ["customer", "STRING"],
      ["_mako_source_ts", "TIMESTAMP"],
    ]),
  })
    .replaceAll("`", '"')
    .replaceAll("SAFE_CAST(", "TRY_CAST(")
    .replaceAll(" AS STRING)", " AS VARCHAR)")
    .replaceAll(" AS TIMESTAMP)", " AS TIMESTAMPTZ)")
    .replaceAll(
      "TIMESTAMP('1970-01-01 00:00:00 UTC')",
      "TIMESTAMPTZ '1970-01-01 00:00:00+00'",
    );
  const duck = await DuckDBInstance.create(":memory:");
  const conn = await duck.connect();
  try {
    await conn.run(
      "CREATE TABLE payment_methods (id VARCHAR, customer VARCHAR, _mako_source_ts TIMESTAMPTZ)",
    );
    await conn.run(
      "CREATE TABLE staged_methods AS SELECT * FROM payment_methods",
    );
    await conn.run("INSERT INTO payment_methods VALUES (?, ?, ?)", [
      recordId,
      "cus_fixture",
      attachment.toISOString(),
    ]);
    const customers = [];
    for (const delivery of queued) {
      await conn.run("DELETE FROM staged_methods");
      await conn.run("INSERT INTO staged_methods VALUES (?, ?, ?)", [
        delivery.recordId,
        delivery.payload?.customer as string | null,
        delivery.sourceTs.toISOString(),
      ]);
      await conn.run(merge);
      customers.push(
        (
          await conn.runAndReadAll("SELECT customer FROM payment_methods")
        ).getRowObjects(),
      );
    }
    expect(customers).toEqual([[{ customer: null }], [{ customer: null }]]);
    expect(queued.map(delivery => delivery.sourceTs)).toEqual([
      detachment,
      attachment,
    ]);
  } finally {
    conn.closeSync();
    duck.closeSync();
  }
});

it("retains legacy webhook and poll or backfill timestamp fallbacks", async () => {
  const flowId = String(new Types.ObjectId());
  const payload = { date_updated: sourceCreated, _syncedAt: attachProcessing };
  const cases: Array<{
    event: Pick<CdcEventInput, "source" | "sourceTs" | "payload">;
    expected: Date;
  }> = [
    { event: { source: "webhook", payload }, expected: sourceCreated },
    {
      event: {
        source: "webhook",
        sourceTs: new Date(NaN),
        payload: { _syncedAt: detachProcessing },
      },
      expected: detachProcessing,
    },
    {
      event: { source: "backfill", sourceTs: attachment, payload },
      expected: sourceCreated,
    },
    {
      event: { source: "backfill", sourceTs: attachment },
      expected: attachment,
    },
  ];
  await store.appendEvents({
    workspaceId,
    flowId,
    events: cases.map(({ event }, index) => ({
      ...event,
      entity,
      recordId: `${recordId}_${index}`,
      operation: "upsert",
    })),
  });
  const queued = await store.readAfter({
    flowId,
    entity,
    afterIngestSeq: 0,
    limit: 10,
  });
  expect(queued.map(delivery => delivery.sourceTs)).toEqual(
    cases.map(({ expected }) => expected),
  );
});
