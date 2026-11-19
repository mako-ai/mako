import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BigQueryDestinationAdapter } from "./adapters/bigquery";
import { buildCdcEntityLayout } from "./adapters/registry";
import type { CdcStoredEvent } from "./events";
import { segmentAroundDeletes } from "./normalization";
import { ABSENT_COLUMNS_FIELD, prepareSparseBatch } from "./sparse-rows";
import {
  DEFAULT_CDC_MATERIALIZE_WINDOW_MS,
  cdcMaterializeWindowMs,
  coalesceWaitMs,
} from "./materialize-window";

/**
 * Coalesced materialization (materialize-window.ts) gives the same live table
 * as materializing every webhook batch on its own.
 *
 * The consumer reads pending events in ingest-seq order and hands one slice
 * to `applyEvents`. Coalescing changes only where the slices end: a window
 * holds the events of several old batches, back to back. So the old path is
 * `applyEvents` once per batch, and the new path is `applyEvents` once per
 * run of consecutive batches.
 *
 * Both paths run the real BigQuery adapter: latest-change selection, sparse
 * payload merge, soft and hard deletes, staging row shape. Only the BigQuery
 * I/O is replaced. `writeViaParquet` stages rows with the real
 * `prepareSparseBatch` and applies them with an in-memory MERGE that follows
 * `buildMergeStatement`; `hardDeleteBatch` deletes by id + data source.
 */

const DATA_SOURCE_ID = "ds-1";
const FLOW_ID = "507f1f77bcf86cd799439011";
const FIXED_NOW = new Date("2026-11-19T17:00:00.000Z");

type Row = Record<string, unknown>;
type Table = { columns: Set<string>; rows: Map<string, Row> };

let table: Table;

function freshTable(): Table {
  return { columns: new Set(), rows: new Map() };
}

function ts(value: unknown): number {
  if (value == null) return 0;
  return new Date(value as string | Date).getTime();
}

/**
 * The MERGE of buildMergeStatement, append_dedup, no partition filter:
 * - USING: staging deduped by key, newest `_mako_source_ts` first (QUALIFY);
 * - WHEN MATCHED AND stg.source_ts >= live.source_ts: update every staged
 *   non-key column, keeping the live value where the row marks it absent;
 * - WHEN NOT MATCHED: insert every live column, NULL where staging lacks it.
 * addMissingLiveColumns adds staged columns to live first.
 */
function mergeIntoLive(records: Row[], keyColumns: string[]): void {
  const { rows, presentColumns } = prepareSparseBatch(records);
  for (const column of presentColumns) table.columns.add(column);
  const keyOf = (row: Row) => keyColumns.map(k => String(row[k])).join("|");

  const newest = new Map<string, Row>();
  for (const row of rows) {
    const key = keyOf(row);
    const seen = newest.get(key);
    if (!seen || ts(row._mako_source_ts) > ts(seen._mako_source_ts)) {
      newest.set(key, row);
    }
  }

  for (const [key, stg] of newest) {
    const absent = new Set(
      String(stg[ABSENT_COLUMNS_FIELD] ?? "")
        .split(",")
        .filter(Boolean),
    );
    const live = table.rows.get(key);
    if (live) {
      if (ts(stg._mako_source_ts) < ts(live._mako_source_ts)) continue;
      for (const column of presentColumns) {
        if (keyColumns.includes(column)) continue;
        if (absent.has(column)) continue;
        live[column] = stg[column] ?? null;
      }
      continue;
    }
    const inserted: Row = {};
    for (const column of table.columns) {
      inserted[column] = presentColumns.has(column)
        ? (stg[column] ?? null)
        : null;
    }
    table.rows.set(key, inserted);
  }
}

function hardDelete(deletes: CdcStoredEvent[], dataSourceId?: string): void {
  for (const event of deletes) {
    const row = table.rows.get(String(event.recordId));
    if (!row) continue;
    if (dataSourceId && row._dataSourceId !== dataSourceId) continue;
    table.rows.delete(String(event.recordId));
  }
}

function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Row count + one sha256 per row over every live column, sorted by id. */
function snapshot(t: Table): { count: number; checksums: string[] } {
  const columns = [...t.columns].sort();
  const checksums = [...t.rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, row]) => {
      const values = columns.map(c => [c, canonical(row[c])]);
      return `${id}:${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16)}`;
    });
  return { count: t.rows.size, checksums };
}

// ---------------------------------------------------------------------------
// Event streams.

/** mulberry32: a small seeded PRNG, so a failing seed replays. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type StreamOptions = {
  events: number;
  records: number;
  /** Chance an event's source time runs behind the previous one (0 = in order). */
  outOfOrder: number;
  /** Chance an upsert carries only some fields, like a Close webhook. */
  sparse: number;
  deletes: number;
};

function makeStream(seed: number, o: StreamOptions): CdcStoredEvent[] {
  const random = rng(seed);
  const base = Date.parse("2026-11-19T16:00:00.000Z");
  const events: CdcStoredEvent[] = [];
  let clock = base;
  for (let i = 0; i < o.events; i++) {
    clock += 1000 + Math.floor(random() * 5000);
    const late = random() < o.outOfOrder;
    const sourceMs = late ? clock - Math.floor(random() * 120_000) : clock;
    const sourceTs = new Date(sourceMs);
    const recordId = `lead_${Math.floor(random() * o.records)}`;
    const isDelete = random() < o.deletes;
    let payload: Row | undefined;
    if (!isDelete) {
      const full: Row = {
        display_name: `name-${i}`,
        status_label: ["Lead", "Qualified", "Won", "Lost"][i % 4],
        amount: Math.floor(random() * 10_000),
        // A field the source cleared: null is a value, not an absence.
        owner_id: random() < 0.2 ? null : `user_${i % 7}`,
        date_updated: sourceTs.toISOString(),
      };
      if (random() < o.sparse) {
        payload = { date_updated: full.date_updated };
        for (const key of [
          "display_name",
          "status_label",
          "amount",
          "owner_id",
        ]) {
          if (random() < 0.5) payload[key] = full[key];
        }
      } else {
        payload = full;
      }
    }
    events.push({
      id: `evt_${i}`,
      workspaceId: "ws",
      flowId: FLOW_ID,
      source: "webhook",
      entity: "leads",
      recordId,
      operation: isDelete ? "delete" : "upsert",
      sourceTs,
      ingestTs: new Date(clock),
      ingestSeq: i + 1,
      idempotencyKey: `k_${i}`,
      payload,
      materializationStatus: "pending",
    } as CdcStoredEvent);
  }
  return events;
}

/** Cut a stream into consecutive batches of 1..maxSize events. */
function split<T>(items: T[], random: () => number, maxSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length;) {
    const size = 1 + Math.floor(random() * maxSize);
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Join runs of consecutive batches: what one window materializes. */
function coarsen<T>(
  batches: T[][],
  random: () => number,
  maxRun: number,
): T[][] {
  return split(batches, random, maxRun).map(run => run.flat());
}

/**
 * Materialize batches as the consumer does: each batch is one materializeEntity
 * read, applied segment by segment (segmentAroundDeletes). `segmented: false`
 * is the consumer before this change, one applyEvents per batch.
 */
async function materialize(
  batches: CdcStoredEvent[][],
  deleteMode: "hard" | "soft",
  { segmented = true }: { segmented?: boolean } = {},
): Promise<{ count: number; checksums: string[] }> {
  table = freshTable();
  const adapter = new BigQueryDestinationAdapter({
    destinationDatabaseId: "db",
    workspaceId: "ws",
    tableDestination: {
      connectionId: "conn",
      schema: "ds",
      tableName: "leads",
    },
  });
  const layout = buildCdcEntityLayout({
    entity: "leads",
    tableName: "leads",
    deleteMode,
  });
  for (const batch of batches) {
    for (const segment of segmented ? segmentAroundDeletes(batch) : [batch]) {
      await adapter.applyEvents({
        events: segment,
        layout,
        flow: { _id: FLOW_ID, deleteMode, dataSourceId: DATA_SOURCE_ID } as any,
      });
    }
  }
  return snapshot(table);
}

beforeAll(() => {
  // _syncedAt and the soft-delete stamp read the clock: hold it still so the
  // two paths are compared on data, not on when they ran.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  // The adapter's two BigQuery I/O methods (private), typed for the spies.
  const proto = BigQueryDestinationAdapter.prototype as unknown as {
    writeViaParquet: (params: {
      records: Row[];
      layout: { keyColumns: string[] };
    }) => Promise<{ written: number }>;
    hardDeleteBatch: (
      layout: unknown,
      deletes: CdcStoredEvent[],
      dataSourceId?: string,
    ) => Promise<void>;
  };
  vi.spyOn(proto, "writeViaParquet").mockImplementation(params => {
    mergeIntoLive(params.records, params.layout.keyColumns);
    return Promise.resolve({ written: params.records.length });
  });
  vi.spyOn(proto, "hardDeleteBatch").mockImplementation(
    (_layout, deletes, dataSourceId) => {
      hardDelete(deletes, dataSourceId);
      return Promise.resolve();
    },
  );
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

describe("coalesced materialization equals per-batch materialization", () => {
  for (const deleteMode of ["hard", "soft"] as const) {
    it(`in-order streams with sparse rows, deletes and hot keys (${deleteMode} deletes)`, async () => {
      let nonTrivial = 0;
      for (const seed of SEEDS) {
        const stream = makeStream(seed, {
          events: 120,
          records: 8,
          outOfOrder: 0,
          sparse: 0.4,
          deletes: 0.12,
        });
        const random = rng(seed * 7919);
        const perBatch = split(stream, random, 6);
        const windows = coarsen(perBatch, random, 8);
        const oldPath = await materialize(perBatch, deleteMode);
        const newPath = await materialize(windows, deleteMode);
        const oneBatch = await materialize([stream], deleteMode);
        expect(newPath, `seed ${seed}`).toEqual(oldPath);
        expect(oneBatch, `seed ${seed}`).toEqual(oldPath);
        if (oldPath.count > 0) nonTrivial++;
      }
      expect(nonTrivial).toBeGreaterThan(100);
    });

    it(`out-of-order streams of full rows with deletes (${deleteMode} deletes)`, async () => {
      let lateEvents = 0;
      for (const seed of SEEDS) {
        const stream = makeStream(seed + 10_000, {
          events: 120,
          records: 8,
          outOfOrder: 0.25,
          sparse: 0,
          deletes: 0.12,
        });
        lateEvents += stream.filter(
          (e, i) => i > 0 && e.sourceTs < stream[i - 1].sourceTs,
        ).length;
        const random = rng(seed * 104_729);
        const perBatch = split(stream, random, 6);
        const windows = coarsen(perBatch, random, 8);
        const oldPath = await materialize(perBatch, deleteMode);
        const newPath = await materialize(windows, deleteMode);
        expect(newPath, `seed ${seed}`).toEqual(oldPath);
      }
      expect(lateEvents).toBeGreaterThan(1000);
    });
  }

  it("the same key updated 200 times in one window ends on its newest version", async () => {
    const stream = makeStream(42, {
      events: 200,
      records: 1,
      outOfOrder: 0,
      sparse: 0.3,
      deletes: 0,
    });
    const perBatch = stream.map(event => [event]);
    const oldPath = await materialize(perBatch, "hard");
    const newPath = await materialize([stream], "hard");
    expect(newPath).toEqual(oldPath);
    expect(newPath.count).toBe(1);
  });
});

/**
 * Why the consumer segments around deletes. Before this change one batch went
 * to applyEvents whole, and selectLatestChangePerRecord kept one change per
 * record. A delete then swallowed the upserts before it in the same batch,
 * and a sparse upsert after a hard delete MERGEd onto the deleted row. Rows
 * changed with where a batch ended, so coalescing alone would have changed
 * them.
 */
describe("segments around deletes", () => {
  function event(
    seq: number,
    operation: "upsert" | "delete",
    payload?: Row,
  ): CdcStoredEvent {
    const sourceTs = new Date(Date.parse("2026-11-19T16:00:00Z") + seq * 1000);
    return {
      id: `e${seq}`,
      workspaceId: "ws",
      flowId: FLOW_ID,
      source: "webhook",
      entity: "leads",
      recordId: "lead_1",
      operation,
      sourceTs,
      ingestTs: sourceTs,
      ingestSeq: seq,
      idempotencyKey: `k${seq}`,
      payload: payload && { ...payload, date_updated: sourceTs.toISOString() },
      materializationStatus: "pending",
    } as CdcStoredEvent;
  }

  const created = event(1, "upsert", { display_name: "Acme", amount: 10 });
  const deleted = event(2, "delete");
  const recreated = event(3, "upsert", { display_name: "Acme again" });

  it("cuts a slice so a record has upserts only or one delete per segment", () => {
    const other = { ...event(4, "upsert", { amount: 1 }), recordId: "lead_2" };
    expect(
      segmentAroundDeletes([created, other, deleted, recreated]).map(s =>
        s.map(e => e.ingestSeq),
      ),
    ).toEqual([[1, 4], [2], [3]]);
    expect(segmentAroundDeletes([created, other])).toHaveLength(1);
  });

  it("a sparse re-create after a hard delete lands the same in one window", async () => {
    const perBatch = await materialize(
      [[created], [deleted], [recreated]],
      "hard",
    );
    const oneWindow = await materialize(
      [[created, deleted, recreated]],
      "hard",
    );
    expect(oneWindow).toEqual(perBatch);
    // The consumer before this change: the deleted row's amount survived.
    const unsegmented = await materialize(
      [[created], [deleted, recreated]],
      "hard",
      { segmented: false },
    );
    expect(unsegmented).not.toEqual(perBatch);
  });

  it("a soft-delete tombstone keeps the upsert just before it in one window", async () => {
    const perBatch = await materialize([[created], [deleted]], "soft");
    const oneWindow = await materialize([[created, deleted]], "soft");
    expect(oneWindow).toEqual(perBatch);
    const unsegmented = await materialize([[created, deleted]], "soft", {
      segmented: false,
    });
    expect(unsegmented.count).toBe(1);
    expect(unsegmented).not.toEqual(perBatch);
  });
});

/**
 * The one case batching still decides: a late sparse row (source time older
 * than the newest version) is judged field by field inside a batch
 * (selectLatestChangePerRecord fills the newest row's missing keys from it)
 * and rejected whole across batches (the MERGE ordering guard). Today's batch
 * ends follow webhook arrival timing, so such streams already land
 * differently run to run.
 *
 * The truth is every event applied alone, in source-time order. Coalescing
 * lands as close to it as today does: in these 150 streams (25% late, 40%
 * sparse, far worse than Close traffic) today misses 120 of 1,055 rows with
 * hard deletes and coalescing 124; 67 and 69 of 1,200 with soft deletes.
 */
describe("late sparse rows: as close to event-time truth as today", () => {
  for (const deleteMode of ["hard", "soft"] as const) {
    it(`${deleteMode} deletes`, async () => {
      let todayVsOtherTiming = 0;
      let todayOff = 0;
      let coalescedOff = 0;
      for (const seed of SEEDS) {
        const stream = makeStream(seed + 20_000, {
          events: 120,
          records: 8,
          outOfOrder: 0.25,
          sparse: 0.4,
          deletes: 0.12,
        });
        const random = rng(seed * 15_485_863);
        const today = split(stream, random, 6);
        const otherTiming = split(stream, random, 6);
        const windows = coarsen(today, random, 8);
        const bySourceTime = [...stream].sort(
          (x, y) =>
            x.sourceTs.getTime() - y.sourceTs.getTime() ||
            x.ingestSeq - y.ingestSeq,
        );
        const truth = await materialize(
          bySourceTime.map(e => [e]),
          deleteMode,
        );
        const a = await materialize(today, deleteMode);
        const b = await materialize(otherTiming, deleteMode);
        const w = await materialize(windows, deleteMode);
        const rowsOff = (x: typeof truth) =>
          truth.checksums.filter(c => !x.checksums.includes(c)).length +
          Math.abs(truth.count - x.count);
        if (JSON.stringify(a) !== JSON.stringify(b)) todayVsOtherTiming++;
        todayOff += rowsOff(a);
        coalescedOff += rowsOff(w);
      }
      expect(todayVsOtherTiming).toBeGreaterThan(0);
      expect(coalescedOff).toBeLessThanOrEqual(Math.ceil(todayOff * 1.1));
    });
  }
});

describe("materialize window", () => {
  it("defaults to 60 s, reads CDC_MATERIALIZE_WINDOW_MS, caps at 15 min", () => {
    expect(cdcMaterializeWindowMs({})).toBe(DEFAULT_CDC_MATERIALIZE_WINDOW_MS);
    expect(
      cdcMaterializeWindowMs({ CDC_MATERIALIZE_WINDOW_MS: "300000" }),
    ).toBe(300_000);
    expect(cdcMaterializeWindowMs({ CDC_MATERIALIZE_WINDOW_MS: "0" })).toBe(0);
    expect(cdcMaterializeWindowMs({ CDC_MATERIALIZE_WINDOW_MS: "junk" })).toBe(
      60_000,
    );
    expect(
      cdcMaterializeWindowMs({ CDC_MATERIALIZE_WINDOW_MS: "99999999" }),
    ).toBe(900_000);
  });

  it("waits for the rest of the window since the last materialization", () => {
    const now = Date.parse("2026-11-19T17:00:00Z");
    const at = (msAgo: number) => new Date(now - msAgo);
    const windowMs = 60_000;
    expect(
      coalesceWaitMs({ lastMaterializedAt: at(20_000), now, windowMs }),
    ).toBe(40_000);
    expect(
      coalesceWaitMs({ lastMaterializedAt: at(60_000), now, windowMs }),
    ).toBe(0);
    expect(coalesceWaitMs({ lastMaterializedAt: null, now, windowMs })).toBe(0);
    expect(
      coalesceWaitMs({
        lastMaterializedAt: at(20_000),
        now,
        windowMs,
        force: true,
      }),
    ).toBe(0);
    expect(
      coalesceWaitMs({ lastMaterializedAt: at(20_000), now, windowMs: 0 }),
    ).toBe(0);
    // A clock ahead of ours waits one window, never longer.
    expect(
      coalesceWaitMs({ lastMaterializedAt: at(-500_000), now, windowMs }),
    ).toBe(60_000);
  });

  /**
   * The Inngest side, modelled: cdc-materialize is a singleton per flow +
   * entity (mode skip). A run sleeps coalesceWaitMs, then reads every pending
   * event, applies them and stamps lastMaterializedAt. Triggers come from
   * the 1-minute webhook batch dispatcher and the 5-minute stale cron.
   */
  it("runs at most once per window and applies every event exactly once", () => {
    const random = rng(7);
    const windowMs = 60_000;
    const applyMs = 20_000;
    const horizon = 3 * 3600_000;
    // Webhooks: bursts, quiet spells, one event every 1-40 s on average.
    const arrivals: number[] = [];
    for (let t = 0; t < horizon;) {
      t += random() < 0.1 ? 120_000 : 1000 + Math.floor(random() * 40_000);
      arrivals.push(t);
    }
    const triggers: number[] = [];
    for (let t = 60_000; t < horizon + 600_000; t += 60_000) triggers.push(t);

    const applied = new Map<number, number>();
    const runs: number[] = [];
    let busyUntil = -1;
    let lastMaterializedAt: number | null = null;
    let applyEnd = -1;
    for (const trigger of triggers) {
      if (trigger < busyUntil) continue; // singleton skip
      // Dispatcher only fires for entities with pending events; the stale
      // cron does the same. Model: a trigger with nothing pending is a no-op.
      const pendingNow = arrivals.some(
        (a, i) => a <= trigger && !applied.has(i),
      );
      if (!pendingNow) continue;
      const wait = coalesceWaitMs({
        lastMaterializedAt,
        now: trigger,
        windowMs,
      });
      const readAt = trigger + wait;
      arrivals.forEach((a, i) => {
        if (a <= readAt && !applied.has(i)) {
          applied.set(i, (applied.get(i) ?? 0) + 1);
        }
      });
      runs.push(readAt);
      applyEnd = readAt + applyMs;
      lastMaterializedAt = applyEnd;
      busyUntil = applyEnd;
    }
    expect(applyEnd).toBeGreaterThan(0);
    expect(applied.size).toBe(arrivals.length);
    expect([...applied.values()].every(n => n === 1)).toBe(true);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i] - runs[i - 1]).toBeGreaterThanOrEqual(windowMs);
    }
  });
});
