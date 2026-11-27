/**
 * A flow's entity layouts against the BigQuery tables they write, at save and
 * in the MERGE path. On 17 Nov 2026 two Close shadow flows had layouts naming
 * `_syncedAt` over tables partitioned on `date_created`, and each MERGE
 * scanned the full table. The cases here:
 *
 * - the pure comparison (field, granularity, clustering, missing table);
 * - the flow save (create and update) refuses a mismatch and passes a match
 *   or a table that does not exist yet;
 * - the unpruned-MERGE warning is logged once per table per hour.
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
import {
  ensureTestDatabaseConnection,
  ensureTestSourceConnection,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";

import { Flow } from "../../database/workspace-schema";
import {
  applyFlowUpdate,
  buildNewFlow,
} from "../../services/flow-mutation.service";
import { BigQueryDestinationAdapter } from "./bigquery";
import { bqLog } from "./bigquery-target";
import {
  UNPRUNED_MERGE_WARN_INTERVAL_MS,
  claimUnprunedMergeWarning,
  resetUnprunedMergeWarnings,
} from "./merge-prune-warning";
import type { LiveTableDescription } from "./registry";
import {
  compareLayoutToTable,
  findLayoutTableMismatches,
} from "../layout-table-check";

const DATE_CREATED_TABLE: LiveTableDescription = {
  exists: true,
  timePartitioning: { field: "date_created", type: "DAY" },
  clusterFields: ["id"],
};

describe("compareLayoutToTable", () => {
  const base = { entity: "activities:Email", table: "email_activities" };

  it("names entity, table, layout value and real value for a partition field mismatch", () => {
    const out = compareLayoutToTable({
      ...base,
      layout: { entity: "activities:Email", partitionField: "_syncedAt" },
      real: DATE_CREATED_TABLE,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      entity: "activities:Email",
      table: "email_activities",
      kind: "partition_field",
      layoutValue: "_syncedAt",
      realValue: "date_created",
    });
    expect(out[0].message).toContain("activities:Email");
    expect(out[0].message).toContain("email_activities");
    expect(out[0].message).toContain("`_syncedAt`");
    expect(out[0].message).toContain("`date_created`");
    expect(out[0].message).toContain("repartition the table explicitly");
  });

  it("passes a matching layout", () => {
    expect(
      compareLayoutToTable({
        ...base,
        layout: {
          entity: "activities:Email",
          partitionField: "date_created",
          partitionGranularity: "day",
          clusterFields: ["id"],
        },
        real: DATE_CREATED_TABLE,
      }),
    ).toEqual([]);
  });

  it("passes a table that does not exist yet", () => {
    expect(
      compareLayoutToTable({
        ...base,
        layout: { entity: "activities:Email", partitionField: "_syncedAt" },
        real: { exists: false, clusterFields: [] },
      }),
    ).toEqual([]);
  });

  it("flags a granularity mismatch on the same column", () => {
    const out = compareLayoutToTable({
      ...base,
      layout: {
        entity: "activities:Email",
        partitionField: "date_created",
        partitionGranularity: "month",
      },
      real: DATE_CREATED_TABLE,
    });
    expect(out.map(m => [m.kind, m.layoutValue, m.realValue])).toEqual([
      ["partition_granularity", "month", "day"],
    ]);
  });

  it("flags a clustering mismatch and compares order", () => {
    const out = compareLayoutToTable({
      ...base,
      layout: {
        entity: "activities:Email",
        partitionField: "date_created",
        clusterFields: ["status", "id"],
      },
      real: { ...DATE_CREATED_TABLE, clusterFields: ["id", "status"] },
    });
    expect(out.map(m => [m.kind, m.layoutValue, m.realValue])).toEqual([
      ["cluster_fields", "status, id", "id, status"],
    ]);
  });

  it("flags a layout that names a column on an unpartitioned table", () => {
    const out = compareLayoutToTable({
      ...base,
      layout: { entity: "activities:Email", partitionField: "_syncedAt" },
      real: { exists: true, clusterFields: [] },
    });
    expect(out[0]).toMatchObject({
      kind: "partition_field",
      realValue: "no partitioning",
    });
  });
});

let pg: PgTestDb;
let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const SOURCE = new Types.ObjectId();
const DEST = new Types.ObjectId();
const PG_DEST = new Types.ObjectId();

beforeAll(async () => {
  pg = await setupPgTestDb();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await pg?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await pg.reset();
  await ensureTestSourceConnection(pg.db, {
    id: String(SOURCE),
    workspaceId: String(WS),
    name: "Close",
    type: "close",
  });
  await ensureTestDatabaseConnection(pg.db, {
    id: String(DEST),
    workspaceId: String(WS),
    name: "bq",
    type: "bigquery",
  });
  await ensureTestDatabaseConnection(pg.db, {
    id: String(PG_DEST),
    workspaceId: String(WS),
    name: "pg",
    type: "postgresql",
  });
});

function describeTablesAs(
  byTable: Record<string, LiveTableDescription | undefined>,
) {
  return vi
    .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
    .mockImplementation(async (table: string) => byTable[table]);
}

const syncedAtLayout = {
  entity: "activities:Email",
  partitionField: "_syncedAt",
  partitionGranularity: "day",
};

const tableDestination = (connectionId: Types.ObjectId = DEST) => ({
  connectionId,
  schema: "close",
  tableName: "",
});

describe("findLayoutTableMismatches", () => {
  const flow = (over: Record<string, unknown> = {}) => ({
    workspaceId: WS,
    destinationDatabaseId: DEST,
    tableDestination: tableDestination(),
    entityLayouts: [syncedAtLayout],
    entityFilter: ["activities:Email"],
    ...over,
  });

  it("detects a layout that disagrees with the existing table", async () => {
    const spy = describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    const out = await findLayoutTableMismatches(flow());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      entity: "activities:Email",
      kind: "partition_field",
      layoutValue: "_syncedAt",
      realValue: "date_created",
    });
  });

  it("passes when the table does not exist yet", async () => {
    describeTablesAs({
      email_activities: { exists: false, clusterFields: [] },
    });
    expect(await findLayoutTableMismatches(flow())).toEqual([]);
  });

  it("passes a matching layout", async () => {
    describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    expect(
      await findLayoutTableMismatches(
        flow({
          entityLayouts: [
            { ...syncedAtLayout, partitionField: "date_created" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("passes when the metadata read fails", async () => {
    describeTablesAs({ email_activities: undefined });
    expect(await findLayoutTableMismatches(flow())).toEqual([]);
  });

  it("skips a destination that is not BigQuery", async () => {
    const spy = describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    expect(
      await findLayoutTableMismatches(
        flow({ tableDestination: tableDestination(PG_DEST) }),
      ),
    ).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips a disabled layout", async () => {
    describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    expect(
      await findLayoutTableMismatches(
        flow({ entityLayouts: [{ ...syncedAtLayout, enabled: false }] }),
      ),
    ).toEqual([]);
  });
});

describe("flow save", () => {
  const createBody = (over: Record<string, unknown> = {}) => ({
    name: "close shadow",
    dataSourceId: String(SOURCE),
    syncMode: "full",
    tableDestination: {
      connectionId: String(DEST),
      schema: "close",
      tableName: "",
    },
    entityFilter: ["activities:Email"],
    entityLayouts: [syncedAtLayout],
    ...over,
  });

  it("create refuses a layout that disagrees with its table", async () => {
    describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    await expect(
      buildNewFlow({ workspaceId: String(WS), body: createBody() }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("`_syncedAt`"),
      extra: {
        layoutMismatches: [
          expect.objectContaining({
            table: "email_activities",
            realValue: "date_created",
          }),
        ],
      },
    });
  });

  it("create passes when the table does not exist yet", async () => {
    describeTablesAs({
      email_activities: { exists: false, clusterFields: [] },
    });
    await expect(
      buildNewFlow({ workspaceId: String(WS), body: createBody() }),
    ).resolves.toMatchObject({ sourceType: "connector" });
  });

  function existingFlow() {
    return new Flow({
      workspaceId: WS,
      slug: "close-shadow",
      name: "close shadow",
      createdBy: "u",
      sourceType: "connector",
      dataSourceId: SOURCE,
      syncEngine: "cdc",
      syncMode: "full",
      destinationDatabaseId: DEST,
      tableDestination: { connectionId: DEST, schema: "close", tableName: "" },
      entityFilter: ["activities:Email"],
      entityLayouts: [
        {
          entity: "activities:Email",
          partitionField: "date_created",
          partitionGranularity: "day",
        },
      ],
    }) as never;
  }

  it("update refuses a layout edit that disagrees with the table", async () => {
    describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    await expect(
      applyFlowUpdate({
        workspaceId: String(WS),
        flow: existingFlow(),
        body: { entityLayouts: [syncedAtLayout] },
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("email_activities"),
    });
  });

  it("update passes a layout that matches the table", async () => {
    describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    await expect(
      applyFlowUpdate({
        workspaceId: String(WS),
        flow: existingFlow(),
        body: {
          entityLayouts: [
            { ...syncedAtLayout, partitionField: "date_created" },
          ],
        },
      }),
    ).resolves.toBeDefined();
  });

  it("an update that leaves the layouts alone is not judged", async () => {
    const spy = describeTablesAs({ email_activities: DATE_CREATED_TABLE });
    await applyFlowUpdate({
      workspaceId: String(WS),
      flow: existingFlow(),
      body: { name: "renamed" },
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("unpruned MERGE warning", () => {
  beforeEach(() => resetUnprunedMergeWarnings());

  it("rate limits to one claim per table per hour", () => {
    const t0 = 1_000_000;
    expect(claimUnprunedMergeWarning("p.ds.a", t0)).toBe(true);
    expect(claimUnprunedMergeWarning("p.ds.a", t0 + 1000)).toBe(false);
    expect(
      claimUnprunedMergeWarning(
        "p.ds.a",
        t0 + UNPRUNED_MERGE_WARN_INTERVAL_MS - 1,
      ),
    ).toBe(false);
    expect(claimUnprunedMergeWarning("p.ds.b", t0 + 1000)).toBe(true);
    expect(
      claimUnprunedMergeWarning("p.ds.a", t0 + UNPRUNED_MERGE_WARN_INTERVAL_MS),
    ).toBe(true);
  });

  const target = (bytes?: string) =>
    ({
      bq: {
        job: () => ({
          getMetadata: async () => [
            { statistics: { query: { totalBytesBilled: bytes } } },
          ],
        }),
      },
      projectId: "p",
      dataset: "ds",
      destination: {},
      datasetLocation: "EU",
    }) as never;

  const adapter = () =>
    new BigQueryDestinationAdapter({
      destinationDatabaseId: "db",
      workspaceId: "ws",
      tableDestination: { connectionId: "c", schema: "ds", tableName: "t" },
    }) as unknown as {
      warnUnprunedMerge: (t: unknown, p: unknown) => Promise<void>;
    };

  const unpruned = {
    reason: "layout_mismatch",
    tableField: "date_created",
    tableGranularity: "DAY",
    layoutField: "_syncedAt",
  };

  it("logs one structured warning per table per hour, with the billed bytes", async () => {
    const warn = vi.spyOn(bqLog, "warn").mockImplementation(() => undefined);
    const a = adapter();
    const args = {
      unpruned,
      liveTable: "email_activities",
      flowId: "flow1",
      path: "final",
      job: { jobId: "j1", location: "EU" },
    };
    await a.warnUnprunedMerge(target("33285996544"), args);
    await a.warnUnprunedMerge(target("33285996544"), args);
    await a.warnUnprunedMerge(target("33285996544"), {
      ...args,
      liveTable: "other_table",
    });
    const calls = (
      warn.mock.calls as unknown as Array<[string, unknown]>
    ).filter(c => String(c[0]).includes("without partition pruning"));
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      flowId: "flow1",
      table: "email_activities",
      reason: "layout_mismatch",
      tablePartitionField: "date_created",
      layoutPartitionField: "_syncedAt",
      total_bytes_billed: "33285996544",
    });
  });
});
