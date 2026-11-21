import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterEach,
  afterAll,
} from "vitest";
import mongoose, { Types, type Connection } from "mongoose";
import {
  CdcEntityState as CdcEntityStateModel,
  type ICdcEntityState,
} from "../database/models/cdc";
import {
  closeRestEntityAdmission,
  type RestEntityOverwrite,
} from "../sync-cdc/rest-entity-admission";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { closeInlineWebhookAdmission } from "../sync-cdc/inline-webhook-admission";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CdcDestinationAdapter } from "../sync-cdc/adapters/registry";
import { sourceConnectionManager } from "./database-data-source-manager";

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
let admissionConnection: Connection | undefined;
let admissionEntityState: typeof CdcEntityStateModel | undefined;
const fakeEntityState = {
  findOne: (filter: Doc) => ({
    lean: async () => entityStates.find(d => matches(d, filter)) ?? null,
    select: () => ({
      lean: async () => entityStates.find(d => matches(d, filter)) ?? null,
    }),
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
  Flow: {
    db: {
      collection: (name: string) =>
        name === "flow_executions" && admissionConnection?.db
          ? admissionConnection.db.collection(name)
          : collection(name),
      get db() {
        return admissionConnection?.db;
      },
    },
  },
  get CdcEntityState() {
    return admissionEntityState ?? fakeEntityState;
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

vi.mock("../services/destination-writer.service", () => ({
  getMaxTrackingValue: vi.fn(async () => ({
    success: true,
    maxValue: "2026-01-01T00:00:00.000Z",
  })),
}));

// ── Fake source: offset paging, records where each chunk starts ──────────

const PAGE = 50;
let sourceRows: Doc[] = [];
let chunkStartOffsets: number[] = [];
let failSyntheticRead = false;
let sourceType = "fake";
let onSyntheticRead: (() => Promise<void>) | undefined;

/**
 * When set, the fake grows its page cap the way SandboxedConnector does:
 * it reads `chunkPages` from the engine's state, uses it as its cap, and
 * hands back twice that (up to 8x the engine's) for the next chunk.
 */
let growChunkPages = false;
/** Per chunk: the `chunkPages` the engine handed in, and the pages read. */
let chunkCaps: Array<{ carried: number | undefined; pages: number }> = [];

const fakeConnector = {
  supportsResumableFetching: () => true,
  resolveSchema: async () => null,
  fetchEntityChunk: async (o: {
    state?: { metadata?: { offset?: number }; chunkPages?: number };
    maxIterations?: number;
    onBatch: (rows: Doc[]) => Promise<void>;
  }) => {
    let offset = o.state?.metadata?.offset ?? 0;
    chunkStartOffsets.push(offset);
    await onSyntheticRead?.();
    if (failSyntheticRead) throw new Error("synthetic source read failed");
    const base = o.maxIterations ?? 10;
    const carried = o.state?.chunkPages;
    const cap = growChunkPages ? Math.min(carried ?? base, base * 8) : base;
    let iterations = 0;
    while (iterations < cap && offset < sourceRows.length) {
      const page = sourceRows.slice(offset, offset + PAGE);
      await o.onBatch(page);
      offset += page.length;
      iterations++;
    }
    chunkCaps.push({ carried, pages: iterations });
    const hasMore = offset < sourceRows.length;
    return {
      totalProcessed: offset,
      hasMore,
      iterationsInChunk: iterations,
      metadata: { offset },
      ...(growChunkPages && hasMore
        ? { chunkPages: Math.min(cap * 2, base * 8) }
        : {}),
    };
  },
};

vi.mock("./database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn(async () => ({
      id: "69c781737eb58b93e5ac3385",
      name: "fake_close",
      type: sourceType,
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
let writeModeOfRun: "append_dedup" | "append" | "overwrite" = "append_dedup";
let useDirectDestination = false;
let beforeTruncate: (() => Promise<void>) | undefined;
let beforePrepareStaging: (() => Promise<void>) | undefined;
/**
 * Merges of a non-empty staging table (1-based) that fail, as the 17 Nov
 * schema reads did. Merges of an empty staging table are not counted.
 */
let failingMerges = new Set<number>();
let mergeCalls = 0;
/**
 * Rows a flush leaves in the buffer, as when flushBulkBuffer stops early on
 * an empty parquet: put back into the buffer by the next staging cleanup.
 */
let leftoverOnCleanup: Doc[] = [];

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
    await beforeTruncate?.();
    live = [];
  }) as any,
  prepareStaging: (async (_l: unknown, _f: string, o?: any) => {
    await beforePrepareStaging?.();
    staging.set(suffixOf(o), []);
  }) as any,
  cleanupStaging: (async (_l: unknown, _f: string, o?: any) => {
    staging.set(suffixOf(o), []);
    if (leftoverOnCleanup.length > 0) {
      await collection(`backfill_tmp_${FLOW_ID}_${ENTITY}`).insertMany(
        leftoverOnCleanup,
      );
      leftoverOnCleanup = [];
    }
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

const directAdapter: Partial<CdcDestinationAdapter> = {
  destinationType: "postgresql",
  truncateLiveTable: fakeAdapter.truncateLiveTable,
  applyBatch: async ({ records }) => {
    live.push(...records.map(record => String(record.id)));
    return { written: records.length };
  },
};

vi.mock("../sync-cdc/adapters/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../sync-cdc/adapters/registry")
  >("../sync-cdc/adapters/registry");
  return {
    ...actual,
    resolveCdcDestinationAdapter: vi.fn(() =>
      useDirectDestination ? directAdapter : fakeAdapter,
    ),
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
  executionId?: string;
  cancelAt?: string;
  /** Cancel the step that follows this one. */
  cancelAfter?: string;
  /**
   * Steps memoized by the pre-#1366 code: they ran, and their recorded
   * result is null (the old flush-apply returned nothing).
   */
  legacyNullSteps?: string[];
  tableName?: string;
  poll?: boolean;
  interleave?: boolean;
  incremental?: boolean;
  memo?: Map<string, unknown>;
}): Promise<{ completed: boolean; rowsWritten: number }> {
  let cancelNext = false;
  const step = {
    run: async (id: string, fn: () => Promise<unknown>) => {
      if (params.memo?.has(id)) return params.memo.get(id);
      if (id === params.cancelAt || cancelNext) throw new Cancelled(id);
      if (id === params.cancelAfter) cancelNext = true;
      if (params.interleave) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const out = await fn();
      if (params.legacyNullSteps?.includes(id)) return null;
      // Inngest stores step output as JSON.
      const saved =
        out === undefined ? undefined : JSON.parse(JSON.stringify(out));
      params.memo?.set(id, saved);
      return saved;
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
        executionId: params.executionId,
        backfill: !params.poll,
        backfillRunId: params.poll ? undefined : params.runId,
        checkpointEnabled: !params.poll,
        cdcBackfillRunId: params.poll ? undefined : params.runId,
        destinationId: "dest1",
        syncMode: params.incremental ? "incremental" : "full",
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
    leftoverOnCleanup = [];
    growChunkPages = false;
    chunkCaps = [];
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

  it("a flush that leaves rows in the buffer does not move the cursor past them", async () => {
    sourceRows = rows(15_000);
    // The first flush's cleanup finds a row it never staged.
    leftoverOnCleanup = [{ ...sourceRows[0], _bulkRunId: "run-A" }];
    await expect(
      invoke({ runId: "run-A", cancelAt: "sync-opportunities-chunk-26" }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(
      await cdcBackfillCheckpointService.loadEntityCheckpoint({
        workspaceId: WORKSPACE_ID,
        flowId: FLOW_ID,
        scope: `run-A|dest1|69c2719490eb18199aafa882|fr_close_crm|`,
        entity: ENTITY,
      }),
    ).toBeUndefined();

    chunkStartOffsets = [];
    await invoke({ runId: "run-A" });
    expect(chunkStartOffsets[0]).toBe(0);
    expectEveryRowExactlyOnce();
  }, 120_000);

  it("append: a cancel right after a merge resumes after the merged rows", async () => {
    writeModeOfRun = "append";
    sourceRows = rows(15_000);
    await expect(
      invoke({ runId: "run-A", cancelAfter: "flush-apply-opportunities-0" }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(live).toHaveLength(10_000);

    chunkStartOffsets = [];
    await invoke({ runId: "run-A" });
    expect(chunkStartOffsets[0]).toBe(10_000);
    expectEveryRowExactlyOnce();
  }, 120_000);

  it("a pre-#1366 checkpoint (no scope) is ignored: the entity starts fresh", async () => {
    sourceRows = rows(12_000);
    // The document a pre-#1366 run left: flow + entity, cursor, no scope.
    entityStates.push({
      workspaceId: WORKSPACE_ID,
      flowId: FLOW_ID,
      entity: ENTITY,
      backfillCursor: {
        totalProcessed: 5_000,
        hasMore: true,
        iterationsInChunk: 10,
        metadata: { offset: 5_000, rowsWrittenTotal: null },
      },
    });
    const result = await invoke({ runId: "run-A" });
    expect(chunkStartOffsets[0]).toBe(0);
    expectEveryRowExactlyOnce();
    expect(result.rowsWritten).toBe(12_000);
  }, 120_000);

  it("an in-flight flush-apply result without `written` does not fail the run", async () => {
    // Deploy of #1366 at 01:29 UTC on 18 Nov: 4 keyed backfills replayed
    // flush-apply results memoized by the old code (null) and failed with
    // "Cannot read properties of null (reading 'written')".
    sourceRows = rows(25_000);
    const result = await invoke({
      runId: "run-A",
      legacyNullSteps: [
        "flush-merge-opportunities-0",
        "flush-apply-opportunities-0",
      ],
    });
    expect(result.completed).toBe(true);
    expectEveryRowExactlyOnce();
    // The legacy flush counted nothing; the later flushes count theirs.
    expect(result.rowsWritten).toBe(15_000);
  }, 120_000);
});

describe("queued REST entity admission", () => {
  let mongo: MongoMemoryReplSet;
  const previousAnchor = new Date("2026-01-01T00:00:00.000Z");
  const runStartedAt = new Date("2026-01-02T00:00:00.000Z");
  const executionId = new Types.ObjectId();
  const scope = {
    workspaceId: new Types.ObjectId(WORKSPACE_ID),
    flowId: new Types.ObjectId(FLOW_ID),
    sourceConnectionId: new Types.ObjectId("69c781737eb58b93e5ac3385"),
  };
  const connection = () => {
    if (!admissionConnection?.db) {
      throw new Error("Synthetic MongoDB is not connected");
    }
    return admissionConnection;
  };
  const database = () => {
    const db = connection().db;
    if (!db) throw new Error("Synthetic MongoDB is not connected");
    return db;
  };
  const admissionId = [
    scope.workspaceId,
    scope.flowId,
    scope.sourceConnectionId,
  ]
    .map(value => value.toHexString())
    .join(":");
  const admissionRecord = () =>
    database()
      .collection<{
        _id: string;
        closed: boolean;
        pendingOverwrites?: RestEntityOverwrite[];
      }>("rest_entity_admissions")
      .findOne({ _id: admissionId });
  const entityState = { flowId: scope.flowId, entity: ENTITY };
  const anchor = async () => {
    const row = await admissionEntityState?.findOne(entityState).lean();
    return row?.lastPollRunStartedAt;
  };
  const poll = {
    runId: "queued",
    poll: true,
    incremental: true,
    executionId: executionId.toHexString(),
  };
  const invokeQueued = (memo: Map<string, unknown>) =>
    invoke({ ...poll, memo });
  const queue = async () => {
    const memo = new Map<string, unknown>();
    await expect(
      invoke({
        ...poll,
        memo,
        cancelAt: `sync-${ENTITY}-chunk-0`,
      }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(memo.get(`resolve-poll-cursor-${ENTITY}`)).toMatchObject({
      runStartedAt: runStartedAt.toISOString(),
    });
    expect(chunkStartOffsets).toHaveLength(0);
    return memo;
  };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    admissionConnection = await mongoose
      .createConnection(mongo.getUri())
      .asPromise();
    const model = admissionConnection.model<ICdcEntityState>(
      CdcEntityStateModel.modelName,
      CdcEntityStateModel.schema,
    );
    await model.init();
    admissionEntityState = model;
  }, 120_000);
  afterAll(async () => {
    await admissionConnection?.close();
    await mongo?.stop();
    admissionConnection = undefined;
    admissionEntityState = undefined;
    sourceType = "fake";
    failSyntheticRead = false;
    onSyntheticRead = undefined;
  });
  beforeEach(async () => {
    vi.stubEnv("REST_ENTITY_ADMISSION_ENABLED", "1");
    await database().dropDatabase();
    collections.clear();
    await admissionEntityState?.create({
      ...entityState,
      workspaceId: scope.workspaceId,
      lastPollRunStartedAt: previousAnchor,
    });
    await database()
      .collection("flow_executions")
      .insertOne({ _id: executionId, startedAt: runStartedAt });
    staging = new Map();
    live = [];
    sourceRows = rows(1);
    chunkStartOffsets = [];
    sourceType = "rest";
    writeModeOfRun = "append_dedup";
    failSyntheticRead = false;
    onSyntheticRead = undefined;
  });
  afterEach(() => {
    useDirectDestination = false;
    beforeTruncate = undefined;
    beforePrepareStaging = undefined;
    vi.unstubAllEnvs();
  });

  it("runs the native path with a closed REST admission gate by default", async () => {
    vi.stubEnv("REST_ENTITY_ADMISSION_ENABLED", undefined);
    await closeRestEntityAdmission(connection(), scope);

    await expect(invoke(poll)).resolves.toMatchObject({ completed: true });
    expect(chunkStartOffsets).toEqual([0]);
    expect(live).toEqual(["opp_00000"]);
    expect(await anchor()).toEqual(runStartedAt);
  });

  it("prepares staging without a reservation when REST admission is disabled", async () => {
    vi.stubEnv("REST_ENTITY_ADMISSION_ENABLED", undefined);
    writeModeOfRun = "overwrite";
    await closeRestEntityAdmission(connection(), scope);
    const prepare = vi.fn(async () => {
      expect((await admissionRecord())?.pendingOverwrites).toBeUndefined();
    });
    beforePrepareStaging = prepare;

    await expect(invoke(poll)).resolves.toEqual({
      completed: true,
      rowsWritten: 1,
    });
    expect(prepare).toHaveBeenCalled();
    expect(live).toEqual(["opp_00000"]);
  });

  it("denies a fresh overwrite before staging or clearing the live table", async () => {
    writeModeOfRun = "overwrite";
    live = ["previous-live-row"];
    staging.set("poll_staging", ["previous-staged-row"]);
    await closeRestEntityAdmission(connection(), scope);

    await expect(invoke(poll)).rejects.toThrow(
      "REST entity admission is closed",
    );
    expect(chunkStartOffsets).toEqual([]);
    expect(live).toEqual(["previous-live-row"]);
    expect(staging.get("poll_staging")).toEqual(["previous-staged-row"]);
  });

  it("holds REST admission before clearing existing overwrite staging", async () => {
    writeModeOfRun = "overwrite";
    live = ["previous-live-row"];
    staging.set("poll_staging", ["previous-staged-row"]);
    const close = () => closeRestEntityAdmission(connection(), scope);
    const prepare = vi.fn(async () => {
      expect(live).toEqual(["previous-live-row"]);
      expect(staging.get("poll_staging")).toEqual(["previous-staged-row"]);
      await expect(close()).rejects.toThrow(
        "REST overwrite is still in flight",
      );
    });
    beforePrepareStaging = prepare;

    await expect(
      invoke({ ...poll, cancelAt: `sync-${ENTITY}-chunk-0` }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(staging.get("poll_staging")).toEqual([]);
    expect(live).toEqual([]);
    expect(chunkStartOffsets).toEqual([]);
    await expect(close()).rejects.toThrow("REST overwrite is still in flight");
  });

  it("advances the stored anchor when an open REST poll lands its rows", async () => {
    expect(await anchor()).toEqual(previousAnchor);
    const memo = await queue();

    await expect(invokeQueued(memo)).resolves.toEqual({
      completed: true,
      rowsWritten: 1,
    });
    expect(chunkStartOffsets).toEqual([0]);
    expect(live).toEqual(["opp_00000"]);
    expect(await anchor()).toEqual(runStartedAt);
  });

  it("keeps a truncated overwrite admitted under the stored connection and grants", async () => {
    writeModeOfRun = "overwrite";
    live = ["previous-live-row"];
    const sources = database().collection("connectors");
    const source = {
      _id: scope.sourceConnectionId,
      workspaceId: scope.workspaceId,
      type: "rest",
      managers: ["synthetic-manager"],
      liveReads: true,
      liveReaders: [{ principal: "synthetic-reader" }],
      writers: [{ principal: "synthetic-writer" }],
    };
    await sources.insertOne(source);
    vi.mocked(sourceConnectionManager.getSourceConnection).mockClear();
    const memo = new Map<string, unknown>();
    await expect(
      invoke({ ...poll, memo, cancelAt: `sync-${ENTITY}-chunk-0` }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(memo.has(`prepare-staging-${ENTITY}`)).toBe(true);
    expect(chunkStartOffsets).toEqual([]);
    expect(live).toEqual([]);
    expect(await anchor()).toEqual(previousAnchor);

    const close = () => closeRestEntityAdmission(connection(), scope);
    await expect(close()).rejects.toThrow("REST overwrite is still in flight");
    await expect(
      closeRestEntityAdmission(connection(), {
        ...scope,
        sourceConnectionId: new Types.ObjectId(),
      }),
    ).resolves.toBeUndefined();
    await expect(invokeQueued(memo)).resolves.toEqual({
      completed: true,
      rowsWritten: 1,
    });
    expect(chunkStartOffsets).toEqual([0]);
    expect(live).toEqual(["opp_00000"]);
    expect(await anchor()).toEqual(previousAnchor);
    expect(sourceConnectionManager.getSourceConnection).toHaveBeenCalledWith(
      source._id.toHexString(),
      source.workspaceId.toHexString(),
    );
    expect(await sources.findOne({ _id: source._id })).toEqual(source);
    expect(await admissionRecord()).toMatchObject({
      closed: false,
      pendingOverwrites: [
        {
          runId: poll.executionId,
          entity: ENTITY,
          destinationId: "dest1",
          destinationDatabaseName: null,
          destinationConnectionId: "69c2719490eb18199aafa882",
          schema: "fr_close_crm",
          tableName: ENTITY,
        },
      ],
    });
    // A completed worker does not supply a destination settlement receipt.
    await expect(close()).rejects.toThrow("REST overwrite is still in flight");
  });

  it("reserves a direct overwrite before the first chunk truncates", async () => {
    useDirectDestination = true;
    writeModeOfRun = "overwrite";
    live = ["previous-live-row"];
    beforeTruncate = async () => {
      expect(live).toEqual(["previous-live-row"]);
      await expect(
        closeRestEntityAdmission(connection(), scope),
      ).rejects.toThrow("REST overwrite is still in flight");
    };
    await expect(invoke(poll)).resolves.toEqual({
      completed: true,
      rowsWritten: 1,
    });
    expect(live).toEqual(["opp_00000"]);
    expect((await admissionRecord())?.pendingOverwrites).toHaveLength(1);
  });

  it("denies a queued retry after REST closure without moving its anchor", async () => {
    const memo = await queue();
    await closeRestEntityAdmission(connection(), scope);
    const gate = await admissionRecord();
    expect(gate?.closed).toBe(true);
    await expect(invokeQueued(memo)).rejects.toThrow(
      "REST entity admission is closed",
    );
    expect(chunkStartOffsets).toHaveLength(0);
    expect(live).toEqual([]);
    expect(await anchor()).toEqual(previousAnchor);
  });

  it("admits one REST source read after webhook-only closure", async () => {
    const memo = await queue();
    await closeInlineWebhookAdmission(connection(), scope);
    await expect(invokeQueued(memo)).resolves.toMatchObject({
      completed: true,
    });
    expect(chunkStartOffsets).toHaveLength(1);
    expect(await anchor()).toEqual(runStartedAt);
  });

  it("does not apply a closed REST gate to another connector type", async () => {
    sourceType = "fake";
    const memo = await queue();
    await closeRestEntityAdmission(connection(), scope);
    await expect(invokeQueued(memo)).resolves.toMatchObject({
      completed: true,
    });
    expect(chunkStartOffsets).toHaveLength(1);
    expect(await anchor()).toEqual(runStartedAt);
  });

  it("keeps an admitted attempt valid and denies its later retry after closure", async () => {
    const memo = await queue();
    failSyntheticRead = true;
    let entered!: () => void;
    let release!: () => void;
    const enteredSource = new Promise<void>(resolve => {
      entered = resolve;
    });
    const resumeSource = new Promise<void>(resolve => {
      release = resolve;
    });
    onSyntheticRead = async () => {
      entered();
      await resumeSource;
    };
    const first = invokeQueued(memo);
    await Promise.race([enteredSource, first]);
    try {
      await closeRestEntityAdmission(connection(), scope);
    } finally {
      release();
    }
    await expect(first).rejects.toThrow("synthetic source read failed");
    onSyntheticRead = undefined;
    await expect(invokeQueued(memo)).rejects.toThrow(
      "REST entity admission is closed",
    );
    expect(chunkStartOffsets).toHaveLength(1);
    expect(await anchor()).toEqual(previousAnchor);
  });
});

describe("an engine-owned chunkPages survives the checkpoint", () => {
  beforeEach(() => {
    collections.clear();
    entityStates = [];
    staging = new Map();
    live = [];
    chunkStartOffsets = [];
    writeModeOfRun = "append_dedup";
    failingMerges = new Set();
    mergeCalls = 0;
    leftoverOnCleanup = [];
    growChunkPages = true;
    chunkCaps = [];
  });

  it("save -> load -> the resumed chunk reads with the grown cap", async () => {
    // Chunks grow 10 -> 20 -> 40 -> 80 pages (500 -> 4,000 rows). The
    // 10,000-row flush saves the cursor; the run is cancelled after it.
    sourceRows = rows(40_000);
    await expect(
      invoke({ runId: "run-A", cancelAt: "sync-opportunities-chunk-6" }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(chunkCaps.slice(0, 4).map(c => c.pages)).toEqual([10, 20, 40, 80]);

    // Saved: the whole FetchState, chunkPages included (CdcEntityState).
    const saved = entityStates.find(d => d.entity === ENTITY)?.backfillCursor;
    expect(saved?.hasMore).toBe(true);
    expect(saved?.chunkPages).toBe(80);
    const savedOffset = saved?.metadata?.offset;

    // Loaded: the resumed run's first chunk gets chunkPages back and uses it.
    chunkCaps = [];
    chunkStartOffsets = [];
    const result = await invoke({ runId: "run-A" });
    expect(chunkStartOffsets[0]).toBe(savedOffset);
    expect(chunkCaps[0]).toEqual({ carried: 80, pages: 80 });
    expect(result.completed).toBe(true);
    expectEveryRowExactlyOnce();
  }, 120_000);
});
