import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { checkOutcome } from "../../connectors/workspace/webhook-batch";
import { shapeWebhookCdcRecords } from "../../inngest/functions/webhook-flow";
import { getCdcEventStore } from "../event-store";
import type { CdcEventInput } from "../events";
import { cdcIngestService } from "../ingest";
import { BigQueryDestinationAdapter } from "./bigquery";
import { buildMergeStatement } from "./bigquery-sql";

const workspaceId = String(new Types.ObjectId());
const entity = "payment_methods";
const recordId = "pm_fixture";
const sourceCreated = new Date("2026-11-20T08:00:00Z");
const attachment = "2026-11-20T08:09:59Z";
const detachment = "2026-11-20T08:10:00Z";
const detachProcessing = new Date("2026-11-20T08:11:00Z");
const attachProcessing = new Date("2026-11-20T08:12:00Z");
const store = getCdcEventStore();
let mongo: MongoMemoryServer;
let duck: DuckDBInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  duck = await DuckDBInstance.create(":memory:");
});

afterAll(async () => {
  duck?.closeSync();
  try {
    await mongoose.disconnect();
  } finally {
    await mongo?.stop();
  }
});

function boxedRecord(options: {
  eventId?: string;
  suppliedTime?: string;
  processingTime?: Date;
  customer?: string | null;
  connectorType?: string;
  destinationType?: string;
  recordEntity?: string;
  operation?: "upsert" | "delete";
  providerClock?: boolean;
}) {
  const recordEntity = options.recordEntity ?? entity;
  const checked = checkOutcome(
    {
      outcome: "records",
      records: [
        {
          entity: recordEntity,
          recordId,
          operation: options.operation ?? "upsert",
          sourceTs: options.suppliedTime ?? detachment,
          ...(options.providerClock ? { sourceTsKind: "provider_event" } : {}),
          payload: {
            created: sourceCreated.getTime() / 1000,
            customer: options.customer,
          },
        },
      ],
    },
    new Set([recordEntity]),
    1,
  );
  if (checked?.kind !== "records") throw new Error("Missing boxed record");
  const processingTime = options.processingTime ?? detachProcessing;
  vi.useFakeTimers({ toFake: ["Date"], now: processingTime });
  try {
    const [record] = shapeWebhookCdcRecords({
      rawRecords: checked.records,
      sourceConnection: {
        id: "fixture",
        name: "Fixture",
        type: options.connectorType ?? "ws:stripe",
      },
      destinationType: options.destinationType ?? "bigquery",
      flow: {},
      webhookEvent: {
        eventId: options.eventId ?? "evt_fixture",
        receivedAt: processingTime,
      },
    });
    if (!record) throw new Error("Missing shaped record");
    return record;
  } finally {
    vi.useRealTimers();
  }
}

/** Inspect the file at the SDK load boundary. The adapter builds it and
 * issues the normal load path with no credentials or network access. */
function bigQueryLoadFixture(
  conn: DuckDBConnection,
  merge: () => Promise<void> = async () => undefined,
) {
  const clocks: string[] = [];
  const load = vi.fn(async (filePath: string) => {
    await conn.run(
      "CREATE OR REPLACE TEMP TABLE staged_methods AS SELECT * FROM read_parquet(?)",
      [filePath],
    );
    const rows = (
      await conn.runAndReadAll(
        "SELECT CAST(epoch_ms(_mako_source_ts) AS VARCHAR) AS clock FROM staged_methods",
      )
    ).getRowObjects();
    clocks.push(...rows.map(row => String(row.clock)));
    return [{ statistics: { load: { outputRows: rows.length } } }];
  });
  const adapter = new BigQueryDestinationAdapter({
    workspaceId,
    destinationDatabaseId: "fixture",
    tableDestination: {
      connectionId: "fixture",
      schema: "fixture",
      tableName: entity,
    },
  });
  Object.assign(adapter, {
    _resolvedClient: {
      bq: {
        dataset: () => ({
          get: async () => [{}],
          table: () => ({ load, setMetadata: async () => [{}] }),
        }),
      },
      dataset: "fixture",
      destination: { workspaceId },
    },
  });
  vi.spyOn(adapter, "mergeFromStaging").mockImplementation(async () => {
    await merge();
    return { written: 1 };
  });
  vi.spyOn(adapter, "cleanupStaging").mockResolvedValue(undefined);
  return { adapter, clocks, load };
}

const layout = { entity, tableName: entity, keyColumns: ["id"] };

it.each([
  { name: "snapshot", detachTime: detachment, attachTime: attachment },
  {
    name: "ISO thin notification",
    detachTime: "2026-11-20T09:10:00.123+01:00",
    attachTime: "2026-11-20T08:10:00.122Z",
  },
])(
  "stages the $name clock and protects the detachment from a delayed attachment",
  async ({ detachTime, attachTime }) => {
    const flowId = String(new Types.ObjectId());
    for (const delivery of [
      boxedRecord({
        eventId: "evt_detached",
        suppliedTime: detachTime,
        processingTime: detachProcessing,
        customer: null,
        providerClock: true,
      }),
      boxedRecord({
        eventId: "evt_attached",
        suppliedTime: attachTime,
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
    const providerClocks = [new Date(detachTime), new Date(attachTime)];
    expect(queued.map(delivery => delivery.sourceTs)).toEqual(providerClocks);
    expect(queued.map(delivery => delivery.sourceTsKind)).toEqual([
      "provider_event",
      "provider_event",
    ]);

    const columns = ["id", "customer", "_mako_source_ts"];
    // Execute the generated MERGE in DuckDB against the staged Parquet data.
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
    const conn = await duck.connect();
    try {
      await conn.run(
        "CREATE TEMP TABLE payment_methods (id VARCHAR, customer VARCHAR, _mako_source_ts TIMESTAMPTZ)",
      );
      await conn.run("INSERT INTO payment_methods VALUES (?, ?, ?)", [
        recordId,
        "cus_fixture",
        attachTime,
      ]);
      const { adapter, clocks, load } = bigQueryLoadFixture(conn, async () => {
        await conn.run(merge);
        expect(
          (
            await conn.runAndReadAll("SELECT customer FROM payment_methods")
          ).getRowObjects(),
        ).toEqual([{ customer: null }]);
      });
      for (const delivery of queued) {
        await adapter.applyEvents({
          events: [delivery],
          layout,
          flow: { _id: new Types.ObjectId(flowId) },
        });
      }
      expect(load).toHaveBeenCalledTimes(2);
      expect(clocks).toEqual(
        providerClocks.map(clock => String(clock.getTime())),
      );
    } finally {
      conn.closeSync();
    }
  },
);

it.each<{
  label: string;
  options: Parameters<typeof boxedRecord>[0];
}>([
  {
    label: "older boxed Stripe object timestamps",
    options: {
      providerClock: false,
      suppliedTime: sourceCreated.toISOString(),
    },
  },
  {
    label: "an unmarked event timestamp",
    options: { providerClock: false },
  },
  {
    label: "Stripe invoices",
    options: {
      recordEntity: "invoices",
      suppliedTime: sourceCreated.toISOString(),
    },
  },
  {
    label: "another boxed connector",
    options: { connectorType: "ws:calendly" },
  },
  {
    label: "another destination",
    options: { destinationType: "postgresql" },
  },
  {
    label: "a delete",
    options: { operation: "delete" },
  },
  {
    label: "an invalid clock",
    options: { suppliedTime: "invalid" },
  },
  {
    label: "a clock outside the BigQuery range",
    options: { suppliedTime: "+010000-01-01T00:00:00Z" },
  },
])(
  "keeps processing time at append and staging for $label",
  async ({ options }) => {
    const flowId = String(new Types.ObjectId());
    const record = boxedRecord({ providerClock: true, ...options });
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

    const conn = await duck.connect();
    try {
      const { adapter, clocks } = bigQueryLoadFixture(conn);
      await adapter.applyEvents({
        events: queued,
        layout: { ...layout, entity: record.entity, tableName: record.entity },
        flow: { _id: new Types.ObjectId(flowId), deleteMode: "soft" },
      });
      expect(clocks).toEqual([String(detachProcessing.getTime())]);
    } finally {
      conn.closeSync();
    }
  },
);

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
        sourceTs: new Date(attachment),
        sourceTsKind: "provider_event",
        payload,
      },
      expected: sourceCreated,
    },
    {
      event: { source: "backfill", sourceTs: new Date(attachment) },
      expected: new Date(attachment),
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

  const conn = await duck.connect();
  try {
    const { adapter, clocks } = bigQueryLoadFixture(conn);
    await adapter.applyBatch({
      records: [{ id: recordId, ...payload }],
      layout,
      flow: { _id: new Types.ObjectId(flowId) },
    });
    expect(clocks).toEqual([String(sourceCreated.getTime())]);
  } finally {
    conn.closeSync();
  }
});
