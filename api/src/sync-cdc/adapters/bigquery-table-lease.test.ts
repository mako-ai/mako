import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { databaseConnectionService } from "../../services/database-connection.service";
import { currentQueryLabels } from "../../services/bigquery-labels";
import { BigQueryDestinationAdapter } from "./bigquery";
import { bigQueryStagingTableName } from "./bigquery-sql";
import { buildCdcEntityLayout, type CdcEntityLayout } from "./registry";
import { ABSENT_COLUMNS_FIELD, prepareSparseBatch } from "../sparse-rows";
import { CdcTableWriteLease, type CdcMergePath } from "../table-write-lease";
import type { CdcStoredEvent } from "../events";

/**
 * The table write lease closes the probe-to-MERGE race on a pruned MERGE.
 *
 * An in-memory warehouse stands in for BigQuery. It answers the queries the
 * adapter sends (INFORMATION_SCHEMA, the partition probe, the MERGE) with
 * the semantics that matter here: rows live in day partitions of
 * `date_created`, the probe lists the partitions holding the staged keys, and
 * the MERGE matches a staged key only against live rows inside its ON-clause
 * partition ranges. A staged key with no match inside those ranges is
 * inserted, as BigQuery does. Everything else is the real adapter.
 */

// --- The in-memory warehouse --------------------------------------------

type Row = Record<string, unknown>;
type Range = { from: number; to: number };

const LIVE_TYPES: Record<string, string> = {
  id: "STRING",
  name: "STRING",
  date_created: "TIMESTAMP",
  date_updated: "TIMESTAMP",
  _mako_source_ts: "TIMESTAMP",
  _mako_ingest_seq: "INT64",
  _mako_deleted_at: "TIMESTAMP",
  is_deleted: "BOOL",
  deleted_at: "TIMESTAMP",
  _syncedAt: "TIMESTAMP",
  _dataSourceId: "STRING",
};

const PARTITION_FIELD = "date_created";
const DAY_MS = 24 * 60 * 60 * 1000;

function ms(value: unknown): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function dayOf(value: unknown): number | null {
  const t = ms(value);
  return t == null ? null : Math.floor(t / DAY_MS) * DAY_MS;
}

const bucketLabel = (day: number) => new Date(day).toISOString().slice(0, 19);

interface MergeRecord {
  sql: string;
  live: string;
  ranges: Range[] | null;
  hasNull: boolean;
  /** Partitions of live the MERGE may read (its ON-clause ranges). */
  readPartitions: Array<number | null>;
  labels: Record<string, string>;
}

class FakeWarehouse {
  tables = new Map<string, Row[]>();
  log: Array<{
    kind: string;
    sql: string;
    leaseHolder?: string | null;
    labels?: Record<string, string>;
  }> = [];
  merges: MergeRecord[] = [];
  probes: Array<{ live: string; buckets: Array<string | null> }> = [];
  private jobSeq = 0;

  rowsOf(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  countOf(table: string, id: string): number {
    return this.rowsOf(table).filter(r => r.id === id).length;
  }

  stage(table: string, rows: Row[]): void {
    this.rowsOf(table).push(...rows.map(r => ({ ...r })));
  }

  partitionsOf(table: string): Set<number | null> {
    return new Set(this.rowsOf(table).map(r => dayOf(r[PARTITION_FIELD])));
  }

  async run(
    sql: string,
    options?: { onJobStarted?: (j: { jobId: string }) => void },
  ): Promise<{ success: boolean; data?: Row[]; error?: string }> {
    const leaseDoc = await CdcTableWriteLease.findOne({}).lean();
    if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) {
      this.log.push({ kind: "schema", sql });
      const names = [...sql.matchAll(/'([^']+)'/g)].map(m => m[1]);
      const data: Row[] = [];
      for (const name of names) {
        if (!this.tables.has(name)) continue;
        const cols = name.startsWith("stg_")
          ? new Set(this.rowsOf(name).flatMap(r => Object.keys(r)))
          : new Set(Object.keys(LIVE_TYPES));
        for (const c of cols) {
          data.push({
            table_name: name,
            column_name: c,
            data_type: LIVE_TYPES[c] ?? "STRING",
          });
        }
      }
      return { success: true, data };
    }
    if (sql.startsWith("SELECT DISTINCT FORMAT_TIMESTAMP")) {
      this.log.push({ kind: "probe", sql, leaseHolder: leaseDoc?.holder });
      const m = sql.match(
        /FROM `[^`]+`\.`[^`]+`\.`([^`]+)` __live JOIN \(SELECT DISTINCT .* FROM `[^`]+`\.`[^`]+`\.`([^`]+)`\) __stg/,
      );
      if (!m) throw new Error(`Unparsed probe: ${sql}`);
      const [, live, stg] = m;
      const keys = new Set(this.rowsOf(stg).map(r => String(r.id)));
      const buckets = new Set<string | null>();
      for (const row of this.rowsOf(live)) {
        if (!keys.has(String(row.id))) continue;
        const day = dayOf(row[PARTITION_FIELD]);
        buckets.add(day == null ? null : bucketLabel(day));
      }
      this.probes.push({ live, buckets: [...buckets] });
      return { success: true, data: [...buckets].map(p => ({ p })) };
    }
    if (sql.startsWith("MERGE INTO")) {
      this.log.push({ kind: "merge", sql, leaseHolder: leaseDoc?.holder });
      options?.onJobStarted?.({ jobId: `job_${++this.jobSeq}` });
      this.merge(sql);
      return { success: true, data: [] };
    }
    if (sql.startsWith("DROP TABLE IF EXISTS")) {
      const m = sql.match(/`([^`]+)`$/);
      if (m) this.tables.delete(m[1]);
      return { success: true, data: [] };
    }
    this.log.push({
      kind: "other",
      sql,
      leaseHolder: leaseDoc?.holder,
      labels: currentQueryLabels(),
    });
    return { success: true, data: [] };
  }

  private merge(sql: string): void {
    const live = sql.match(
      /^MERGE INTO `[^`]+`\.`[^`]+`\.`([^`]+)` __live/,
    )![1];
    const stg = sql.match(/FROM `[^`]+`\.`[^`]+`\.`([^`]+)` QUALIFY/)![1];
    const on = sql.match(/\nON (.*)\n/)![1];
    const filterText = on.includes(" AND (")
      ? on.slice(on.indexOf(" AND (") + 6, -1)
      : null;
    let ranges: Range[] | null = null;
    let hasNull = false;
    if (filterText !== null) {
      ranges = [];
      if (filterText !== "FALSE") {
        for (const r of filterText.matchAll(
          /__live\.`\w+` >= TIMESTAMP '([^']+) UTC' AND __live\.`\w+` < TIMESTAMP '([^']+) UTC'/g,
        )) {
          ranges.push({
            from: ms(`${r[1].replace(" ", "T")}Z`)!,
            to: ms(`${r[2].replace(" ", "T")}Z`)!,
          });
        }
        hasNull = /IS NULL/.test(filterText);
      }
    }
    const inFilter = (row: Row) => {
      if (ranges === null) return true;
      const t = ms(row[PARTITION_FIELD]);
      if (t == null) return hasNull;
      return ranges.some(r => t >= r.from && t < r.to);
    };
    const liveRows = this.rowsOf(live);
    this.merges.push({
      sql,
      live,
      ranges,
      hasNull,
      readPartitions: [...this.partitionsOf(live)].filter(day =>
        day == null
          ? ranges === null || hasNull
          : ranges === null || ranges.some(r => day >= r.from && day < r.to),
      ),
      labels: currentQueryLabels(),
    });

    // USING: newest staged row per key.
    const newest = new Map<string, Row>();
    for (const row of this.rowsOf(stg)) {
      const k = String(row.id);
      const seen = newest.get(k);
      if (
        !seen ||
        (ms(row._mako_source_ts) ?? 0) > (ms(seen._mako_source_ts) ?? 0)
      ) {
        newest.set(k, row);
      }
    }
    for (const [k, s] of newest) {
      const absent = new Set(
        String(s[ABSENT_COLUMNS_FIELD] ?? "")
          .split(",")
          .filter(Boolean),
      );
      const matched = liveRows.filter(r => String(r.id) === k && inFilter(r));
      if (matched.length > 0) {
        for (const m of matched) {
          if ((ms(s._mako_source_ts) ?? 0) < (ms(m._mako_source_ts) ?? 0)) {
            continue;
          }
          for (const [c, v] of Object.entries(s)) {
            if (c === "id" || c === ABSENT_COLUMNS_FIELD) continue;
            if (absent.has(c)) continue;
            m[c] = v;
          }
        }
        continue;
      }
      const inserted: Row = {};
      for (const c of Object.keys(LIVE_TYPES)) {
        inserted[c] = absent.has(c) ? null : (s[c] ?? null);
      }
      liveRows.push(inserted);
    }
  }
}

// Parquet build and load go to the in-memory warehouse.
const parquetStash = new Map<string, Row[]>();
let warehouse: FakeWarehouse;

vi.mock("./bigquery-load", async importOriginal => {
  const real = await importOriginal<typeof import("./bigquery-load")>();
  let seq = 0;
  return {
    ...real,
    buildCdcParquet: async (_entity: string, records: Row[]) => {
      const { rows, absentColumns } = prepareSparseBatch(records);
      const filePath = `mem://${++seq}`;
      parquetStash.set(filePath, rows);
      return { filePath, byteSize: 0, rowCount: rows.length, absentColumns };
    },
    loadParquetToStaging: async (
      _target: unknown,
      filePath: string,
      stagingTable: string,
    ) => {
      const rows = parquetStash.get(filePath) ?? [];
      parquetStash.delete(filePath);
      warehouse.stage(stagingTable, rows);
      return { loaded: rows.length };
    },
    expireStagingTable: async () => undefined,
    dropStagingTable: async (_target: unknown, stagingTable: string) => {
      warehouse.tables.delete(stagingTable);
    },
  };
});

// --- Harness ---------------------------------------------------------------

const PROJECT = "proj";
let mongo: MongoMemoryServer;
let tableSeq = 0;
let dataset: string;
let liveTable: string;
let layout: CdcEntityLayout;

function fakeTarget() {
  const table = () => ({
    getMetadata: async () => [
      { timePartitioning: { type: "DAY", field: PARTITION_FIELD } },
    ],
    exists: async () => [true],
    setMetadata: async () => [{}],
  });
  return {
    bq: {
      dataset: () => ({ table, get: async () => [{}] }),
      job: () => ({
        getMetadata: async () => [{ status: { state: "DONE" } }],
        cancel: async () => [{}],
      }),
    },
    projectId: PROJECT,
    dataset,
    destination: { type: "bigquery", workspaceId: "ws" },
    datasetLocation: "EU",
  };
}

function makeAdapter(opts?: {
  beforeMerge?: (ctx: {
    liveTable: string;
    path: CdcMergePath;
  }) => Promise<void>;
}): BigQueryDestinationAdapter {
  const adapter = new BigQueryDestinationAdapter({
    destinationDatabaseId: "db",
    workspaceId: "ws",
    tableDestination: {
      connectionId: "conn",
      schema: dataset,
      tableName: liveTable,
    },
    hooks: {
      beforeMerge: opts?.beforeMerge,
      lease: { backoffMinMs: 5, backoffMaxMs: 20 },
    },
  });
  (adapter as unknown as { _resolvedClient: unknown })._resolvedClient =
    fakeTarget();
  return adapter;
}

const flowRef = (flowId: string) => ({
  _id: new Types.ObjectId(flowId),
  dataSourceId: undefined,
});

let stageSeq = 0;
/** Stage rows the way a flush does, then merge them on `path`. */
async function stageAndMerge(
  adapter: BigQueryDestinationAdapter,
  flowId: string,
  rows: Row[],
  path: CdcMergePath,
) {
  const suffix = `t${++stageSeq}`;
  warehouse.stage(bigQueryStagingTableName(liveTable, flowId, suffix), rows);
  await adapter.mergeFromStaging(
    layout,
    flowRef(flowId) as never,
    flowId,
    undefined,
    {
      stagingSuffix: suffix,
      knownStagingRowCount: rows.length,
      mergePath: path,
    },
  );
}

const D1 = "2026-11-01T10:00:00.000Z";
const D2 = "2026-11-05T10:00:00.000Z";
const FLOW_A = "507f1f77bcf86cd799439011";
const FLOW_B = "507f1f77bcf86cd799439022";

const row = (
  id: string,
  dateCreated: string,
  sourceTs: string,
  name = id,
): Row => ({
  id,
  name,
  date_created: dateCreated,
  date_updated: sourceTs,
  _mako_source_ts: sourceTs,
  _syncedAt: sourceTs,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warehouse = new FakeWarehouse();
  dataset = `ds_lease_${++tableSeq}`;
  liveTable = `live_${tableSeq}`;
  warehouse.rowsOf(liveTable);
  layout = buildCdcEntityLayout({
    entity: "leads",
    tableName: liveTable,
    keyColumns: ["id"],
    partitioning: { type: "time", field: PARTITION_FIELD, granularity: "day" },
  });
  spy = vi
    .spyOn(databaseConnectionService, "executeQuery")
    .mockImplementation(
      async (_db, sql, options) =>
        warehouse.run(String(sql), options as never) as never,
    );
});

afterEach(async () => {
  spy.mockRestore();
  delete process.env.CDC_TABLE_WRITE_LEASE;
  await CdcTableWriteLease.deleteMany({});
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- 2. Bulk merge: lease, probe, MERGE, release --------------------------

describe("bulk MERGE under the table write lease", () => {
  it("probes and filters, in the order lease → probe → MERGE → release", async () => {
    warehouse.rowsOf(liveTable).push(row("K", D1, "2026-11-01T10:00:00Z"));
    warehouse.rowsOf(liveTable).push(row("Z", D2, "2026-11-05T10:00:00Z"));
    const adapter = makeAdapter();
    await stageAndMerge(
      adapter,
      FLOW_A,
      [row("K", D1, "2026-11-10T10:00:00Z", "K2")],
      "final",
    );

    const kinds = warehouse.log
      .filter(e => e.kind === "probe" || e.kind === "merge")
      .map(e => e.kind);
    expect(kinds).toEqual(["probe", "merge"]);
    const probe = warehouse.log.find(e => e.kind === "probe")!;
    const merge = warehouse.log.find(e => e.kind === "merge")!;
    // The lease was held at the probe and at the MERGE, by the same holder…
    expect(probe.leaseHolder).toBeTruthy();
    expect(merge.leaseHolder).toBe(probe.leaseHolder);
    // …and released after it.
    expect(await CdcTableWriteLease.countDocuments({})).toBe(0);

    expect(merge.sql).toContain(
      "AND ((__live.`date_created` >= TIMESTAMP '2026-11-01 00:00:00 UTC' AND __live.`date_created` < TIMESTAMP '2026-11-02 00:00:00 UTC'))",
    );
    expect(warehouse.merges[0].labels).toMatchObject({
      mako_merge_path: "final",
    });
    expect(warehouse.merges[0].labels.mako_lease_wait_ms).toMatch(/^\d+$/);
    expect(warehouse.countOf(liveTable, "K")).toBe(1);
  });

  it("labels every path", async () => {
    const adapter = makeAdapter();
    const paths: CdcMergePath[] = ["live", "flush", "final", "rescue", "poll"];
    for (const path of paths) {
      await stageAndMerge(adapter, FLOW_A, [row("K", D1, D1)], path);
    }
    expect(warehouse.merges.map(m => m.labels.mako_merge_path)).toEqual(paths);
    expect(warehouse.probes).toHaveLength(paths.length);
  });
});

describe("repartition under the table write lease", () => {
  it("runs CTAS, DROP and RENAME holding the lease, then releases it", async () => {
    const result = await makeAdapter().repartitionLiveTable(layout);
    expect(result).toEqual({ repartitioned: true });
    const ddl = warehouse.log.filter(e => e.kind === "other");
    expect(ddl).toHaveLength(3);
    const holders = new Set(ddl.map(e => e.leaseHolder));
    expect(holders.size).toBe(1);
    expect([...holders][0]).toBeTruthy();
    for (const e of ddl) {
      expect(e.labels).toMatchObject({ mako_merge_path: "repartition" });
      expect(e.labels?.mako_lease_wait_ms).toMatch(/^\d+$/);
    }
    expect(await CdcTableWriteLease.countDocuments({})).toBe(0);
  });
});

// --- 3. A key that changes partition --------------------------------------

describe("partition move", () => {
  it("moves K from D1 to D2 and keeps one row", async () => {
    warehouse.rowsOf(liveTable).push(row("K", D1, "2026-11-01T10:00:00Z"));
    await stageAndMerge(
      makeAdapter(),
      FLOW_A,
      [row("K", D2, "2026-11-06T10:00:00Z")],
      "flush",
    );
    const rows = warehouse.rowsOf(liveTable).filter(r => r.id === "K");
    expect(rows).toHaveLength(1);
    expect(dayOf(rows[0].date_created)).toBe(dayOf(D2));
  });
});

// --- 4. The probe-to-MERGE race --------------------------------------------

describe("probe-to-MERGE race", () => {
  /**
   * Writer A probes. The seam then runs writer B's whole MERGE. Then A
   * merges with the partitions it probed before B wrote.
   */
  async function race(p: {
    lease: boolean;
    flowB: string;
    initial: Row[];
    rowA: Row;
    rowB: Row;
  }): Promise<{ count: number; bSettledInSeam: boolean }> {
    if (!p.lease) process.env.CDC_TABLE_WRITE_LEASE = "off";
    warehouse.rowsOf(liveTable).push(...p.initial.map(r => ({ ...r })));
    const adapterB = makeAdapter();
    let writerB: Promise<void> | undefined;
    let bSettledInSeam = false;
    let fired = false;
    const adapterA = makeAdapter({
      beforeMerge: async () => {
        if (fired) return;
        fired = true;
        let settled = false;
        writerB = stageAndMerge(adapterB, p.flowB, [p.rowB], "live").then(
          () => {
            settled = true;
          },
        );
        // Without the lease B finishes here. With it, B waits on A.
        await Promise.race([writerB, sleep(500)]);
        bSettledInSeam = settled;
      },
    });
    await stageAndMerge(adapterA, FLOW_A, [p.rowA], "flush");
    await writerB;
    return { count: warehouse.countOf(liveTable, "K"), bSettledInSeam };
  }

  const moveCase = {
    initial: [row("K", D1, "2026-11-01T10:00:00Z")],
    // A saw K on D1 and stages an older version on D1.
    rowA: row("K", D1, "2026-11-02T10:00:00Z", "from-A"),
    // B moves K to D2.
    rowB: row("K", D2, "2026-11-03T10:00:00Z", "from-B"),
  };
  const insertCase = {
    initial: [],
    rowA: row("K", D1, "2026-11-02T10:00:00Z", "from-A"),
    rowB: row("K", D2, "2026-11-03T10:00:00Z", "from-B"),
  };

  it("lease off: B moves K between A's probe and MERGE → 2 rows (the race is real)", async () => {
    const r = await race({ lease: false, flowB: FLOW_A, ...moveCase });
    expect(r.bSettledInSeam).toBe(true);
    expect(r.count).toBe(2);
  });

  it("lease on: B moves K → 1 row", async () => {
    const r = await race({ lease: true, flowB: FLOW_A, ...moveCase });
    expect(r.bSettledInSeam).toBe(false);
    expect(r.count).toBe(1);
    const k = warehouse.rowsOf(liveTable).find(x => x.id === "K")!;
    expect(k.name).toBe("from-B");
    expect(dayOf(k.date_created)).toBe(dayOf(D2));
  });

  it("lease off: B inserts a new K between A's probe and MERGE → 2 rows", async () => {
    const r = await race({ lease: false, flowB: FLOW_A, ...insertCase });
    expect(r.count).toBe(2);
  });

  it("lease on: B inserts a new K → 1 row", async () => {
    const r = await race({ lease: true, flowB: FLOW_A, ...insertCase });
    expect(r.bSettledInSeam).toBe(false);
    expect(r.count).toBe(1);
  });

  it("two flows on one table: lease off → 2 rows, lease on → 1 row", async () => {
    const off = await race({ lease: false, flowB: FLOW_B, ...moveCase });
    expect(off.count).toBe(2);

    delete process.env.CDC_TABLE_WRITE_LEASE;
    warehouse = new FakeWarehouse();
    const on = await race({ lease: true, flowB: FLOW_B, ...moveCase });
    expect(on.bSettledInSeam).toBe(false);
    expect(on.count).toBe(1);
  });
});

// --- 5. Soak: live, poll and backfill writers on overlapping keys ----------

/** mulberry32: a seeded PRNG, so a failing round replays. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("soak", () => {
  it("50 rounds of live, poll and backfill writers keep one row per id", async () => {
    const rand = prng(20261119);
    const ids = Array.from({ length: 12 }, (_, i) => `k${i}`);
    const day = (i: number) =>
      new Date(Date.UTC(2026, 10, 1 + i, 12)).toISOString();
    const live = makeAdapter();
    const poll = makeAdapter();
    const backfill = makeAdapter();
    let clock = Date.UTC(2026, 10, 20);
    const nextTs = () => new Date((clock += 1000)).toISOString();
    const pick = () => ids.filter(() => rand() < 0.5);
    const delay = () => sleep(Math.floor(rand() * 8));

    const liveEvent = (id: string, seq: number): CdcStoredEvent => {
      const ts = nextTs();
      return {
        id: `e${seq}`,
        workspaceId: "ws",
        flowId: FLOW_A,
        source: "webhook",
        entity: "leads",
        recordId: id,
        operation: "upsert",
        sourceTs: new Date(ts),
        ingestTs: new Date(ts),
        ingestSeq: seq,
        idempotencyKey: `e${seq}`,
        payload: {
          id,
          name: `live-${seq}`,
          date_created: day(Math.floor(rand() * 10)),
          date_updated: ts,
        },
        materializationStatus: "pending",
      } as CdcStoredEvent;
    };

    let seq = 0;
    for (let round = 0; round < 50; round++) {
      const liveIds = pick();
      const pollIds = pick();
      const backfillIds = pick();
      await Promise.all([
        (async () => {
          await delay();
          if (liveIds.length === 0) return;
          await live.applyEvents({
            events: liveIds.map(id => liveEvent(id, ++seq)),
            layout,
            flow: flowRef(FLOW_A) as never,
          });
        })(),
        (async () => {
          await delay();
          if (pollIds.length === 0) return;
          await poll.applyBatch({
            records: pollIds.map(id => ({
              id,
              name: `poll-${round}`,
              date_created: day(Math.floor(rand() * 10)),
              date_updated: nextTs(),
            })),
            layout,
            flow: flowRef(FLOW_B) as never,
          });
        })(),
        (async () => {
          await delay();
          if (backfillIds.length === 0) return;
          await stageAndMerge(
            backfill,
            FLOW_B,
            backfillIds.map(id => {
              const ts = nextTs();
              return row(id, day(Math.floor(rand() * 10)), ts, `bf-${round}`);
            }),
            round % 2 === 0 ? "flush" : "final",
          );
        })(),
      ]);
      const rows = warehouse.rowsOf(liveTable);
      const distinct = new Set(rows.map(r => r.id)).size;
      expect({ round, count: rows.length }).toEqual({ round, count: distinct });
    }
    expect(warehouse.merges.length).toBeGreaterThan(100);
    expect(
      new Set(warehouse.merges.map(m => m.labels.mako_merge_path)),
    ).toEqual(new Set(["live", "poll", "flush", "final"]));
  }, 60_000);
});

// --- 6. Bytes: a pruned MERGE reads only the probed partitions -------------

describe("pruned MERGE reads only the probed partitions", () => {
  it("references the 2 probed partitions out of 30", async () => {
    const rows = warehouse.rowsOf(liveTable);
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 9, 1 + i, 8)).toISOString();
      rows.push(row(`r${i}`, d, d));
    }
    expect(warehouse.partitionsOf(liveTable).size).toBe(30);
    await stageAndMerge(
      makeAdapter(),
      FLOW_A,
      [
        row("r3", "2026-10-04T08:00:00.000Z", "2026-11-19T00:00:00Z"),
        row("r17", "2026-10-18T08:00:00.000Z", "2026-11-19T00:00:00Z"),
        row("new", "2026-11-19T08:00:00.000Z", "2026-11-19T00:00:00Z"),
      ],
      "final",
    );
    const merge = warehouse.merges[0];
    const probed = warehouse.probes[0].buckets.sort();
    expect(probed).toEqual(["2026-10-04T00:00:00", "2026-10-18T00:00:00"]);
    expect(
      merge.readPartitions.map(d => bucketLabel(d as number)).sort(),
    ).toEqual(probed);
    expect(merge.ranges).toHaveLength(2);
    expect(warehouse.rowsOf(liveTable)).toHaveLength(31);
  });
});
