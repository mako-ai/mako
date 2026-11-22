import { DuckDBInstance } from "@duckdb/node-api";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { checkOutcome } from "../../connectors/workspace/webhook-batch";
import { shapeWebhookCdcRecords } from "../../inngest/functions/webhook-flow";
import { getCdcEventStore } from "../event-store";
import type { CdcEventInput } from "../events";
import { cdcIngestService } from "../ingest";
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

function boxedRecord(options: {
  eventType: string;
  eventTime: Date;
  processingTime: Date;
  customer?: string | null;
  connectorType?: string;
  recordEntity?: string;
  suppliedTime?: Date;
  providerClock?: boolean;
  raw?: Record<string, unknown>;
}) {
  const payload = {
    id: recordId,
    object: "payment_method",
    created: sourceCreated.getTime() / 1000,
    customer: options.customer,
  };
  const eventId = "evt_fixture";
  const rawPayload = {
    id: eventId,
    object: "event",
    type: options.eventType,
    created: options.eventTime.getTime() / 1000,
    data: { object: payload },
    ...options.raw,
  };
  const checked = checkOutcome(
    {
      outcome: "records",
      records: [
        {
          entity: options.recordEntity ?? entity,
          recordId,
          operation: "upsert",
          sourceTs: (options.suppliedTime ?? options.eventTime).toISOString(),
          ...(options.providerClock ? { sourceTsKind: "provider_event" } : {}),
          payload,
        },
      ],
    },
    new Set([options.recordEntity ?? entity]),
    1,
  );
  if (checked?.kind !== "records") throw new Error("Missing boxed record");
  vi.useFakeTimers({ toFake: ["Date"], now: options.processingTime });
  try {
    const [record] = shapeWebhookCdcRecords({
      rawRecords: checked.records,
      sourceConnection: {
        id: "fixture",
        name: "Fixture",
        type: options.connectorType ?? "ws:stripe",
      },
      flow: {},
      webhookEvent: {
        eventId,
        eventType: options.eventType,
        rawPayload,
        receivedAt: options.processingTime,
      },
    });
    if (!record) throw new Error("Missing shaped record");
    return record;
  } finally {
    vi.useRealTimers();
  }
}

it("lets the destination guard reject an older attachment delivered after detachment", async () => {
  const flowId = String(new Types.ObjectId());
  for (const delivery of [
    boxedRecord({
      eventType: "payment_method.detached",
      eventTime: detachment,
      processingTime: detachProcessing,
      customer: null,
      providerClock: true,
    }),
    boxedRecord({
      eventType: "payment_method.attached",
      eventTime: attachment,
      processingTime: attachProcessing,
      customer: "cus_fixture",
      providerClock: true,
    }),
  ]) {
    await cdcIngestService.appendNormalizedEvents({
      workspaceId,
      flowId,
      events: [delivery],
    });
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
    expect(queued.map(delivery => delivery.sourceTsKind)).toEqual([
      "provider_event",
      "provider_event",
    ]);
  } finally {
    conn.closeSync();
    duck.closeSync();
  }
});

it.each<{
  label: string;
  options: Partial<Parameters<typeof boxedRecord>[0]>;
}>([
  {
    label:
      "the older boxed Stripe release supplies object time without opting in",
    options: { providerClock: false, suppliedTime: sourceCreated },
  },
  {
    label: "an identical event time still needs an explicit opt-in",
    options: { providerClock: false },
  },
  {
    label: "Stripe invoices keep processing-time ordering",
    options: {
      eventType: "invoice.updated",
      recordEntity: "invoices",
      suppliedTime: sourceCreated,
    },
  },
  {
    label: "another boxed connector cannot opt in even with Stripe-shaped data",
    options: { connectorType: "ws:calendly" },
  },
  {
    label: "a mismatched receipt id cannot authorize the timestamp",
    options: { raw: { id: "evt_another" } },
  },
  {
    label: "a mismatched record id cannot authorize the timestamp",
    options: { raw: { data: { object: { id: "pm_another" } } } },
  },
  {
    label: "the timestamp must match the original receipt",
    options: { suppliedTime: attachment },
  },
  {
    label: "an ISO timestamp in the receipt is outside the v1 rollout",
    options: { raw: { created: detachment.toISOString() } },
  },
])("$label", async ({ options }) => {
  const flowId = String(new Types.ObjectId());
  const record = boxedRecord({
    eventType: "payment_method.detached",
    eventTime: detachment,
    processingTime: detachProcessing,
    providerClock: true,
    ...options,
  });
  expect(record.sourceTsKind).toBeUndefined();
  await cdcIngestService.appendNormalizedEvents({
    workspaceId,
    flowId,
    events: [record],
  });
  const queued = await store.readAfter({
    flowId,
    entity: record.entity,
    afterIngestSeq: 0,
    limit: 1,
  });
  expect(queued).toMatchObject([{ sourceTs: detachProcessing }]);
  expect(queued[0]?.sourceTsKind).toBeUndefined();
});

it("retains legacy webhook and poll or backfill timestamp fallbacks", async () => {
  const flowId = String(new Types.ObjectId());
  const payload = { date_updated: sourceCreated, _syncedAt: attachProcessing };
  const cases: Array<{
    event: Pick<
      CdcEventInput,
      "source" | "sourceTs" | "sourceTsKind" | "payload"
    >;
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
      event: {
        source: "backfill",
        sourceTs: attachment,
        sourceTsKind: "provider_event",
        payload,
      },
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
  expect(queued.every(delivery => delivery.sourceTsKind === undefined)).toBe(
    true,
  );
});
