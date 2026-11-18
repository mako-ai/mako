import { describe, it, expect, vi, beforeEach } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CdcDestinationAdapter } from "../sync-cdc/adapters/registry";

/**
 * Regression for the Close FR backfill loss of 17 Nov 2026.
 *
 * A backfill cancelled at 16:42 had buffered opportunities for 2021-Q1 to
 * 2022-Q4 in its flush buffer, and its checkpoint cursor had already moved
 * past them. The new run at 16:43 loaded that cursor (checkpoints were keyed
 * by flow and entity only), dropped the old run's buffer as stale, and went
 * on from 2023. It logged "61,423 written, 61,423 fetched": "written" counted
 * buffered rows. 5,846 opportunities never reached the destination.
 *
 * This drives the real sync-backfill-entity handler and the real bulk
 * orchestrator, with a fake source, an in-memory flush buffer, an in-memory
 * checkpoint store and a fake destination. A cancel is a step that never runs.
 */

vi.hoisted(() => {
  process.env.SYNC_BULK_FLUSH_BATCH_SIZE = "5000";
});

// ── In-memory Mongo (flush buffer + CdcEntityState) ───────────────────────

type Doc = Record<string, any>;

function getPath(doc: Doc, path: string): unknown {
  return path.split(".").reduce<any>((v, k) => (v == null ? v : v[k]), doc);
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = getPath(doc, key);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$ne" in cond) return value !== cond.$ne;
      if ("$in" in cond) return (cond.$in as unknown[]).includes(value);
    }
    return String(value) === String(cond);
  });
}

const collections = new Map<string, FakeCollection>();
let nextId = 1;

class FakeCollection {
  docs: Doc[] = [];
  constructor(private name: string) {}
  async insertMany(rows: Doc[]) {
    for (const row of rows) this.docs.push({ ...row, _id: nextId++ });
    return { insertedCount: rows.length };
  }
  async countDocuments(filter: Doc = {}) {
    return this.docs.filter(d => matches(d, filter)).length;
  }
  find(filter: Doc, opts?: { projection?: Record<string, 0> }) {
    let limit = Infinity;
    const omit = Object.keys(opts?.projection ?? {});
    const cursor = {
      sort: () => cursor,
      limit: (n: number) => {
        limit = n;
        return cursor;
      },
      [Symbol.asyncIterator]: async function* (this: FakeCollection) {
        const hits = this.docs
          .filter(d => matches(d, filter))
          .sort((a, b) => a._id - b._id)
          .slice(0, limit);
        for (const d of hits) {
          const out: Doc = { ...d };
          for (const k of omit) delete out[k];
          yield out;
        }
      }.bind(this),
    };
    return cursor;
  }
  async updateMany(filter: Doc, update: { $set?: Doc; $unset?: Doc }) {
    let modifiedCount = 0;
    for (const d of this.docs) {
      if (!matches(d, filter)) continue;
      Object.assign(d, update.$set ?? {});
      for (const k of Object.keys(update.$unset ?? {})) delete d[k];
      modifiedCount++;
    }
    return { modifiedCount };
  }
  async updateOne() {
    return { modifiedCount: 0 };
  }
  async deleteMany(filter: Doc = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter(d => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async drop() {
    collections.delete(this.name);
  }
}

function collection(name: string): FakeCollection {
  let c = collections.get(name);
  if (!c) {
    c = new FakeCollection(name);
    collections.set(name, c);
  }
  return c;
}

/** CdcEntityState: the calls sync-state.ts makes for checkpoints. */
let entityStates: Doc[] = [];
const fakeEntityState = {
  findOne: (filter: Doc) => ({
    lean: async () => entityStates.find(d => matches(d, filter)) ?? null,
  }),
  find: (filter: Doc) => ({
    select: () => ({
      lean: async () => entityStates.filter(d => matches(d, filter)),
    }),
  }),
  updateOne: async (
    filter: Doc,
    update: { $set?: Doc; $inc?: Doc },
    opts?: { upsert?: boolean },
  ) => {
    let doc = entityStates.find(d => matches(d, filter));
    if (!doc) {
      if (!opts?.upsert) return { modifiedCount: 0 };
      doc = { ...filter };
      entityStates.push(doc);
    }
    Object.assign(doc, update.$set ?? {});
    for (const [k, v] of Object.entries(update.$inc ?? {})) {
      doc[k] = (doc[k] ?? 0) + (v as number);
    }
    return { modifiedCount: 1 };
  },
  updateMany: async (filter: Doc, update: { $unset?: Doc }) => {
    for (const d of entityStates.filter(x => matches(x, filter))) {
      for (const k of Object.keys(update.$unset ?? {})) delete d[k];
    }
    return { modifiedCount: 1 };
  },
};

vi.mock("../database/workspace-schema", () => ({
  DatabaseConnection: {
    findOne: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({ type: "bigquery" }),
      }),
    })),
  },
  Flow: { db: { collection: (name: string) => collection(name) } },
  get CdcEntityState() {
    return fakeEntityState;
  },
}));

vi.mock("../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn((_o: unknown, handler: unknown) => ({ handler })),
    send: vi.fn(async () => ({})),
  },
}));

vi.mock("../services/flow-execution-tracking", () => ({
  appendExecutionLog: vi.fn(),
  touchExecutionHeartbeat: vi.fn(async () => undefined),
  withHeartbeat: (_id: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../sync-cdc/backfill-fetch-resolver", () => ({
  resolveBackfillFetchForEntity: vi.fn(async () => null),
}));

vi.mock("../sync-cdc/poll-cursor-resolver", () => ({
  resolvePollCursorForEntity: vi.fn(),
  stampPollRunStartedAt: vi.fn(),
}));

// ── Fake source: offset paging, records where each chunk starts ──────────

const PAGE = 50;
let sourceRows: Doc[] = [];
let chunkStartOffsets: number[] = [];

const fakeConnector = {
  supportsResumableFetching: () => true,
  resolveSchema: async () => null,
  fetchEntityChunk: async (o: {
    state?: { metadata?: { offset?: number } };
    maxIterations?: number;
    onBatch: (rows: Doc[]) => Promise<void>;
  }) => {
    let offset = o.state?.metadata?.offset ?? 0;
    chunkStartOffsets.push(offset);
    let iterations = 0;
    while (iterations < (o.maxIterations ?? 10) && offset < sourceRows.length) {
      const page = sourceRows.slice(offset, offset + PAGE);
      await o.onBatch(page);
      offset += page.length;
      iterations++;
    }
    return {
      totalProcessed: offset,
      hasMore: offset < sourceRows.length,
      iterationsInChunk: iterations,
      metadata: { offset },
    };
  },
};

vi.mock("./database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn(async () => ({
      id: "69c781737eb58b93e5ac3385",
      name: "fake_close",
      type: "fake",
      active: true,
      settings: { rate_limit_delay_ms: 1 },
      connection: {},
    })),
  },
}));

vi.mock("./connector-registry", () => ({
  syncConnectorRegistry: { getConnectorFor: vi.fn(async () => fakeConnector) },
}));

// ── Fake destination: staging and live as lists of row ids ──────────────

/** Staging tables by suffix: each lane (backfill, poll) has its own. */
let staging = new Map<string, string[]>();
let live: string[] = [];
let writeModeOfRun: "append_dedup" | "append" = "append_dedup";
/**
 * Merges of a non-empty staging table (1-based) that fail, as the 17 Nov
 * schema reads did. Merges of an empty staging table are not counted.
 */
let failingMerges = new Set<number>();
let mergeCalls = 0;

const suffixOf = (o?: { stagingSuffix?: string }) =>
  o?.stagingSuffix ?? "backfill_staging";
const stagingOf = (o?: { stagingSuffix?: string }) => {
  const key = suffixOf(o);
  if (!staging.has(key)) staging.set(key, []);
  return staging.get(key) as string[];
};

async function idsInParquet(filePath: string): Promise<string[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const reader = await conn.runAndReadAll(
      `SELECT id FROM read_parquet('${filePath.replace(/'/g, "''")}')`,
    );
    return reader.getRowObjects().map(r => String(r.id));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

const fakeAdapter: Partial<CdcDestinationAdapter> = {
  destinationType: "bigquery",
  truncateLiveTable: (async () => {
    live = [];
  }) as any,
  prepareStaging: (async (_l: unknown, _f: string, o?: any) => {
    staging.set(suffixOf(o), []);
  }) as any,
  cleanupStaging: (async (_l: unknown, _f: string, o?: any) => {
    staging.set(suffixOf(o), []);
  }) as any,
  loadStagingFromParquet: (async (
    filePath: string,
    _l: unknown,
    _f: string,
    o?: any,
  ) => {
    const ids = await idsInParquet(filePath);
    stagingOf(o).push(...ids);
    return { loaded: ids.length };
  }) as any,
  mergeFromStaging: (async (
    _l: unknown,
    _flow: unknown,
    _f: string,
    _s: unknown,
    o?: any,
  ) => {
    const rowsInStaging = stagingOf(o);
    if (rowsInStaging.length > 0) mergeCalls++;
    if (rowsInStaging.length > 0 && failingMerges.has(mergeCalls)) {
      throw new Error("git ls-tree failed: fatal: not a tree object");
    }
    const written = rowsInStaging.length;
    if (writeModeOfRun === "append_dedup") {
      const seen = new Set(live);
      for (const id of new Set(rowsInStaging)) {
        if (!seen.has(id)) {
          live.push(id);
          seen.add(id);
        }
      }
    } else {
      live.push(...rowsInStaging);
    }
    return { written };
  }) as any,
};

vi.mock("../sync-cdc/adapters/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../sync-cdc/adapters/registry")
  >("../sync-cdc/adapters/registry");
  return {
    ...actual,
    resolveCdcDestinationAdapter: vi.fn(() => fakeAdapter),
  };
});

import { syncBackfillEntityFunction } from "../inngest/functions/sync-entity";
import { cdcBackfillCheckpointService } from "../sync-cdc/sync-state";

// ── Driver ────────────────────────────────────────────────────────────────

const FLOW_ID = "6a69c1409e5425b9c1181582";
const WORKSPACE_ID = "6846e6a01b05af0948070582";
const ENTITY = "opportunities";

class Cancelled extends Error {}

/**
 * One invocation of the entity function; `cancelAt` is a step that never
 * runs. `poll` runs a scheduled poll instead of a backfill. `interleave`
 * yields before each step, so two invocations run their steps in turn, as
 * Inngest runs two executions of one flow.
 */
async function invoke(params: {
  runId: string;
  cancelAt?: string;
  tableName?: string;
  poll?: boolean;
  interleave?: boolean;
}): Promise<{ completed: boolean; rowsWritten: number }> {
  const step = {
    run: async (id: string, fn: () => Promise<unknown>) => {
      if (id === params.cancelAt) throw new Cancelled(id);
      if (params.interleave) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const out = await fn();
      // Inngest stores step output as JSON.
      return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
    },
    sleep: async () => undefined,
  };
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  return (
    syncBackfillEntityFunction as unknown as {
      handler: (ctx: unknown) => Promise<any>;
    }
  ).handler({
    event: {
      data: {
        flowId: FLOW_ID,
        entity: ENTITY,
        dataSourceId: "69c781737eb58b93e5ac3385",
        workspaceId: WORKSPACE_ID,
        backfill: !params.poll,
        backfillRunId: params.poll ? undefined : params.runId,
        checkpointEnabled: !params.poll,
        cdcBackfillRunId: params.poll ? undefined : params.runId,
        destinationId: "dest1",
        syncMode: "full",
        writeMode: writeModeOfRun,
        syncEngine: "cdc",
        tableDestination: {
          connectionId: "69c2719490eb18199aafa882",
          schema: "fr_close_crm",
          tableName: params.tableName ?? "",
        },
        isCdcEnabled: true,
        destinationType: "bigquery",
      },
    },
    step,
    logger,
  });
}

function expectEveryRowExactlyOnce() {
  const counts = new Map<string, number>();
  for (const id of live) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing = sourceRows.filter(r => !counts.has(String(r.id))).length;
  const duplicated = [...counts.values()].filter(n => n > 1).length;
  expect({ missing, duplicated, live: live.length }).toEqual({
    missing: 0,
    duplicated: 0,
    live: sourceRows.length,
  });
}

function rows(n: number): Doc[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `opp_${String(i).padStart(5, "0")}`,
    date_created: "2021-01-01T00:00:00.000Z",
    date_updated: "2021-01-01T00:00:00.000Z",
  }));
}

describe("a backfill checkpoint never runs ahead of the flushed rows", () => {
  beforeEach(() => {
    collections.clear();
    entityStates = [];
    staging = new Map();
    live = [];
    chunkStartOffsets = [];
    writeModeOfRun = "append_dedup";
    failingMerges = new Set();
    mergeCalls = 0;
  });

  it.each(["append_dedup", "append"] as const)(
    "%s: a cancel with 6,000 unflushed rows, then a NEW backfill: every row lands once",
    async writeMode => {
      writeModeOfRun = writeMode;
      // 500 rows per chunk; the buffer flushes at 10,000 rows (chunk 20).
      sourceRows = rows(12_000);
      // Cancelled at chunk 12: 6,000 rows buffered, none flushed. The old
      // code had saved a cursor at 5,000 after chunk 9.
      await expect(
        invoke({ runId: "run-A", cancelAt: "sync-opportunities-chunk-12" }),
      ).rejects.toBeInstanceOf(Cancelled);
      expect(live).toHaveLength(0);

      chunkStartOffsets = [];
      const result = await invoke({ runId: "run-B" });
      expect(result.completed).toBe(true);
      // A new backfill starts at the first row, not at the cancelled cursor.
      expect(chunkStartOffsets[0]).toBe(0);
      expectEveryRowExactlyOnce();
      // "written" counts rows merged into the destination.
      expect(result.rowsWritten).toBe(live.length);
    },
    120_000,
  );

  it("append: a resume of the SAME run continues from the last flush and drops the unflushed tail", async () => {
    writeModeOfRun = "append";
    sourceRows = rows(15_000);
    // Flush at chunk 20 (10,000 rows), cursor saved there; chunks 20-25
    // buffer 3,000 more rows, then the run is cancelled.
    await expect(
      invoke({ runId: "run-A", cancelAt: "sync-opportunities-chunk-26" }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(live).toHaveLength(10_000);

    chunkStartOffsets = [];
    const result = await invoke({ runId: "run-A" });
    expect(chunkStartOffsets[0]).toBe(10_000);
    // Plain INSERT merges: a kept tail would land twice.
    expectEveryRowExactlyOnce();
    expect(result.rowsWritten).toBe(15_000);
  }, 120_000);

  it("the same run repointed to another table starts fresh", async () => {
    sourceRows = rows(15_000);
    await expect(
      invoke({ runId: "run-A", cancelAt: "sync-opportunities-chunk-26" }),
    ).rejects.toBeInstanceOf(Cancelled);

    chunkStartOffsets = [];
    live = [];
    await invoke({ runId: "run-A", tableName: "live_table" });
    expect(chunkStartOffsets[0]).toBe(0);
    expectEveryRowExactlyOnce();
  }, 120_000);

  it("an entity completed by a cancelled run is not skipped by a new run", async () => {
    sourceRows = rows(600);
    await invoke({ runId: "run-A" });
    const scopeOf = (runId: string) =>
      `${runId}|dest1|69c2719490eb18199aafa882|fr_close_crm|`;
    expect(
      await cdcBackfillCheckpointService.listCompletedEntities({
        workspaceId: WORKSPACE_ID,
        flowId: FLOW_ID,
        scope: scopeOf("run-A"),
      }),
    ).toEqual([ENTITY]);
    expect(
      await cdcBackfillCheckpointService.listCompletedEntities({
        workspaceId: WORKSPACE_ID,
        flowId: FLOW_ID,
        scope: scopeOf("run-B"),
      }),
    ).toEqual([]);
  }, 60_000);

  it.each(["append_dedup", "append"] as const)(
    "%s: a run FAILS in its first merge, then a new backfill: every row lands once",
    async writeMode => {
      // PandaDoc CH, 17 Nov 23:53: the merge's schema read failed, the run
      // failed, and the next run resumed past 2 unflushed pages.
      writeModeOfRun = writeMode;
      sourceRows = rows(15_000);
      // The first flush's merge fails: 10,000 rows staged, none in live.
      failingMerges = new Set([1]);
      await expect(invoke({ runId: "run-A" })).rejects.toThrow(
        /not a tree object/,
      );
      expect(live).toHaveLength(0);

      chunkStartOffsets = [];
      const result = await invoke({ runId: "run-B" });
      expect(chunkStartOffsets[0]).toBe(0);
      expectEveryRowExactlyOnce();
      expect(result.rowsWritten).toBe(15_000);
    },
    120_000,
  );

  it.each(["append_dedup", "append"] as const)(
    "%s: a run FAILS in its second merge, then recovery resumes the same run: every row lands once",
    async writeMode => {
      writeModeOfRun = writeMode;
      sourceRows = rows(25_000);
      // The first flush (10,000 rows) lands; the second flush's merge fails
      // with 10,000 rows staged and the cursor at 10,000.
      failingMerges = new Set([2]);
      await expect(invoke({ runId: "run-A" })).rejects.toThrow(
        /not a tree object/,
      );
      expect(live).toHaveLength(10_000);

      chunkStartOffsets = [];
      const result = await invoke({ runId: "run-A" });
      expect(chunkStartOffsets[0]).toBe(10_000);
      expectEveryRowExactlyOnce();
      expect(result.rowsWritten).toBe(25_000);
    },
    120_000,
  );

  it("a poll running at the same time as a backfill of the same flow: every row lands once", async () => {
    // PostHog, 17 Nov: a poll and a backfill of one flow shared the buffer;
    // 26 fetched survey_responses never landed.
    sourceRows = rows(12_000);
    const [backfill, poll] = await Promise.all([
      invoke({ runId: "run-A", interleave: true }),
      invoke({ runId: "poll", poll: true, interleave: true }),
    ]);
    expect(backfill.completed).toBe(true);
    expect(poll.completed).toBe(true);
    expectEveryRowExactlyOnce();
    // Each execution merged every row it fetched.
    expect(backfill.rowsWritten).toBe(12_000);
    expect(poll.rowsWritten).toBe(12_000);
  }, 120_000);
});
