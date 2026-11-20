/**
 * Which layouts the table check judges, and how it reads the tables:
 * only layouts that changed, names compared without case, table defaults as
 * the fallback, at most 4 cluster fields, entities outside the selection
 * skipped, reads in parallel up to a cap. Plus the metadata cache and the
 * warning's job read timeout.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { DatabaseConnection, Flow } from "../../database/workspace-schema";
import { applyFlowUpdate } from "../../services/flow-mutation.service";
import { BigQueryDestinationAdapter } from "./bigquery";
import { getLiveTableMeta } from "./bigquery-schema";
import { bqLog } from "./bigquery-target";
import type { LiveTableDescription } from "./registry";
import {
  compareLayoutToTable,
  findLayoutTableMismatches,
  snapshotLayouts,
} from "../layout-table-check";

const REAL: LiveTableDescription = {
  exists: true,
  timePartitioning: { field: "date_created", type: "DAY" },
  clusterFields: ["a", "b", "c", "d"],
};

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const DEST = new Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await DatabaseConnection.collection.deleteMany({});
  await DatabaseConnection.collection.insertMany([
    { _id: DEST, workspaceId: WS, name: "bq", type: "bigquery" },
  ] as never[]);
});

function describeAs(
  fn: (table: string) => LiveTableDescription | undefined | Promise<unknown>,
) {
  return vi
    .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
    .mockImplementation(async (t: string) => fn(t) as never);
}

const flow = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  destinationDatabaseId: DEST,
  tableDestination: { connectionId: DEST, schema: "close", tableName: "" },
  entityLayouts: [{ entity: "leads", partitionField: "_syncedAt" }],
  entityFilter: ["leads"],
  ...over,
});

describe("column names compare without case", () => {
  it("passes a partition field and cluster fields that differ only in case", () => {
    expect(
      compareLayoutToTable({
        entity: "e",
        table: "t",
        layout: {
          entity: "e",
          partitionField: "Date_Created",
          clusterFields: ["A", "B", "C", "D"],
        },
        real: REAL,
      }),
    ).toEqual([]);
  });
});

describe("what the layout resolves to", () => {
  it("falls back to the table partitioning when the layout names no field", async () => {
    describeAs(() => REAL);
    const out = await findLayoutTableMismatches(
      flow({
        entityLayouts: [{ entity: "leads" }],
        tableDestination: {
          connectionId: DEST,
          schema: "close",
          tableName: "",
          partitioning: { enabled: true, type: "time", field: "_syncedAt" },
        },
      }),
    );
    expect(out.map(m => [m.kind, m.layoutValue, m.realValue])).toEqual([
      ["partition_field", "_syncedAt", "date_created"],
    ]);
  });

  it("judges only the first 4 cluster fields, which the table is created with", async () => {
    describeAs(() => REAL);
    const out = await findLayoutTableMismatches(
      flow({
        entityLayouts: [
          {
            entity: "leads",
            partitionField: "date_created",
            clusterFields: ["a", "b", "c", "d", "e"],
          },
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it("skips a layout whose entity is not in the selection", async () => {
    const spy = describeAs(() => REAL);
    const out = await findLayoutTableMismatches(
      flow({
        entityLayouts: [
          { entity: "leads", partitionField: "_syncedAt" },
          { entity: "deals", partitionField: "_syncedAt" },
        ],
        entityFilter: ["deals"],
      }),
    );
    expect(spy.mock.calls.map(c => c[0])).toEqual(["deals"]);
    expect(out).toHaveLength(1);
  });
});

describe("only changed layouts are judged", () => {
  const stored = flow();

  it("passes a save that sends the stored layout again", async () => {
    const spy = describeAs(() => REAL);
    const out = await findLayoutTableMismatches(flow(), {
      previous: snapshotLayouts(stored),
    });
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("judges a layout the save edits and one it adds", async () => {
    describeAs(() => REAL);
    const out = await findLayoutTableMismatches(
      flow({
        entityLayouts: [
          {
            entity: "leads",
            partitionField: "_syncedAt",
            clusterFields: ["x"],
          },
          { entity: "deals", partitionField: "_syncedAt" },
        ],
        entityFilter: ["leads", "deals"],
      }),
      { previous: snapshotLayouts(stored) },
    );
    expect([...new Set(out.map(m => m.entity))].sort()).toEqual([
      "deals",
      "leads",
    ]);
  });

  it("judges every layout when the destination moved", async () => {
    describeAs(() => REAL);
    const out = await findLayoutTableMismatches(
      flow({
        tableDestination: {
          connectionId: DEST,
          schema: "other_dataset",
          tableName: "",
        },
      }),
      { previous: snapshotLayouts(stored) },
    );
    expect(out).toHaveLength(1);
  });

  function storedFlow() {
    return new Flow({
      workspaceId: WS,
      slug: "close",
      name: "close",
      createdBy: "u",
      sourceType: "connector",
      dataSourceId: new Types.ObjectId(),
      syncEngine: "cdc",
      syncMode: "full",
      destinationDatabaseId: DEST,
      tableDestination: { connectionId: DEST, schema: "close", tableName: "" },
      entityFilter: ["leads"],
      entityLayouts: [{ entity: "leads", partitionField: "_syncedAt" }],
    }) as never;
  }

  it("a UI save of a flow with an old mismatch goes through", async () => {
    describeAs(() => REAL);
    await expect(
      applyFlowUpdate({
        workspaceId: String(WS),
        flow: storedFlow(),
        body: {
          entityLayouts: [{ entity: "leads", partitionField: "_syncedAt" }],
        },
      }),
    ).resolves.toBeDefined();
  });

  it("a UI save that edits the mismatching layout is refused", async () => {
    describeAs(() => REAL);
    await expect(
      applyFlowUpdate({
        workspaceId: String(WS),
        flow: storedFlow(),
        body: {
          entityLayouts: [
            {
              entity: "leads",
              partitionField: "_syncedAt",
              partitionGranularity: "hour",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("table reads", () => {
  it("run in parallel, 8 at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    describeAs(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return REAL;
    });
    const entities = Array.from({ length: 30 }, (_, i) => `e${i}`);
    const out = await findLayoutTableMismatches(
      flow({
        entityLayouts: entities.map(entity => ({
          entity,
          partitionField: "date_created",
        })),
        entityFilter: entities,
      }),
    );
    expect(out).toEqual([]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe("live table metadata cache", () => {
  function target(getMetadata: () => Promise<unknown[]>, dataset: string) {
    return {
      bq: { dataset: () => ({ table: () => ({ getMetadata }) }) },
      projectId: "p",
      dataset,
      destination: {},
      datasetLocation: "EU",
    } as never;
  }

  it("reads partitioning and clustering once and serves the rest from cache", async () => {
    const getMetadata = vi.fn(async () => [
      {
        timePartitioning: { field: "date_created", type: "DAY" },
        clustering: { fields: ["id"] },
      },
    ]);
    const t = target(getMetadata, "cache_ds_1");
    const first = await getLiveTableMeta(t, "tbl");
    const second = await getLiveTableMeta(t, "tbl");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      exists: true,
      timePartitioning: { field: "date_created", type: "DAY" },
      clusterFields: ["id"],
    });
    expect(getMetadata).toHaveBeenCalledTimes(1);
  });

  it("does not cache a table that does not exist", async () => {
    const getMetadata = vi.fn(async () => {
      throw Object.assign(new Error("Not found"), { code: 404 });
    });
    const t = target(getMetadata, "cache_ds_2");
    expect(await getLiveTableMeta(t, "tbl")).toMatchObject({ exists: false });
    await getLiveTableMeta(t, "tbl");
    expect(getMetadata).toHaveBeenCalledTimes(2);
  });
});

describe("the unpruned MERGE warning's job read", () => {
  it("gives up after 5 seconds and still logs, without the bytes", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(bqLog, "warn").mockImplementation(() => undefined);
      const adapter = new BigQueryDestinationAdapter({
        destinationDatabaseId: "db",
        workspaceId: "ws",
        tableDestination: { connectionId: "c", schema: "ds", tableName: "t" },
      }) as unknown as {
        warnUnprunedMerge: (t: unknown, p: unknown) => Promise<void>;
      };
      const done = adapter.warnUnprunedMerge(
        {
          bq: {
            job: () => ({ getMetadata: () => new Promise(() => undefined) }),
          },
          projectId: "p",
          dataset: "ds",
          destination: {},
          datasetLocation: "EU",
        },
        {
          unpruned: { reason: "no_probe", tableField: "d" },
          liveTable: "slow_job_table",
          path: "final",
          job: { jobId: "j" },
        },
      );
      await vi.advanceTimersByTimeAsync(5001);
      await done;
      const calls = (
        warn.mock.calls as unknown as Array<[string, Record<string, unknown>]>
      ).filter(c => c[0].includes("without partition pruning"));
      expect(calls).toHaveLength(1);
      expect(calls[0][1].total_bytes_billed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
