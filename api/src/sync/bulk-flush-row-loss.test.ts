import { describe, it, expect, vi, beforeEach } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CdcDestinationAdapter } from "../sync-cdc/adapters/registry";

/**
 * End-to-end regression for the bulk backfill row loss of 13 Nov 2026.
 *
 * The full resync of PL Close leads fetched 16,495 rows and wrote 4,495.
 * Every lead shares one `date_created` day, which looked like a cursor bug.
 * The logs showed a different cause: a staging load failed on the 5th flush
 * batch ("Field X has changed mode from REQUIRED to NULLABLE"), Inngest
 * retried the flush step, and the retry dropped the staging table. Batches
 * 1-4 were already deleted from the Mongo buffer, so 8,000 rows vanished; the
 * final flush lost 4,000 more the same way. The run reported "completed".
 *
 * This file drives the real orchestrator the way sync-entity.ts does: a fake
 * source pages rows that all share ONE cursor value, flushes run through the
 * real Parquet builder, and a fake destination keeps staging and live in
 * memory. Each flow must land every row in live exactly once, whether or not
 * a staging load fails mid-flush.
 */

// Small flush batches so a few hundred rows make several batches per flush.
vi.hoisted(() => {
  process.env.SYNC_BULK_FLUSH_BATCH_SIZE = "50";
  process.env.SYNC_BULK_FLUSH_MIN_BATCH_SIZE = "10";
});

// ── In-memory Mongo collection (the subset the orchestrator uses) ─────────

type Doc = Record<string, unknown> & { _id: number };
type Filter = Record<string, unknown>;

function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("$ne" in c) return value !== c.$ne;
      if ("$in" in c) return (c.$in as unknown[]).includes(value);
    }
    return value === cond;
  });
}

const collections = new Map<string, FakeCollection>();
let nextId = 1;

class FakeCollection {
  docs: Doc[] = [];
  constructor(private name: string) {}
  async insertMany(rows: Record<string, unknown>[]) {
    for (const row of rows) this.docs.push({ ...row, _id: nextId++ });
    return { insertedCount: rows.length };
  }
  async countDocuments(filter: Filter = {}) {
    return this.docs.filter(d => matches(d, filter)).length;
  }
  find(filter: Filter, opts?: { projection?: Record<string, 0> }) {
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
          const out: Record<string, unknown> = { ...d };
          for (const k of omit) delete out[k];
          yield out;
        }
      }.bind(this),
    };
    return cursor;
  }
  async updateMany(
    filter: Filter,
    update: { $set?: Filter; $unset?: Record<string, ""> },
  ) {
    let modifiedCount = 0;
    for (const d of this.docs) {
      if (!matches(d, filter)) continue;
      Object.assign(d, update.$set ?? {});
      for (const k of Object.keys(update.$unset ?? {})) delete d[k];
      modifiedCount++;
    }
    return { modifiedCount };
  }
  async deleteMany(filter: Filter = {}) {
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

vi.mock("../database/workspace-schema", () => ({
  DatabaseConnection: {
    // Scoped by workspace (utils/workspace-scope.ts): findOne, not findById.
    findOne: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({ type: "bigquery" }),
      }),
    })),
  },
  Flow: { db: { collection: (name: string) => collection(name) } },
}));

// ── Fake source: every row shares one cursor value ────────────────────────

const SAME_DAY = "2026-05-13T11:53:05.000Z";
const PAGE = 50;
let sourceRows: Record<string, unknown>[] = [];

const fakeConnector = {
  supportsResumableFetching: () => true,
  resolveSchema: async () => null,
  fetchEntityChunk: async (o: {
    state?: { metadata?: { offset?: number } };
    maxIterations?: number;
    onBatch: (rows: Record<string, unknown>[]) => Promise<void>;
  }) => {
    let offset = o.state?.metadata?.offset ?? 0;
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

// ── Fake destination: staging and live as lists of row ids ────────────────

let staging: string[] = [];
let live: string[] = [];
let loadCalls = 0;
/** Load calls (1-based) that fail, as BigQuery rejected the 13 Nov loads. */
let failingLoadCalls = new Set<number>();
let mergeCalls = 0;
let prepareCalls = 0;
/** prepareStaging calls (1-based) whose DROP fails (rate limit, 5xx). */
let failingPrepareCalls = new Set<number>();
/** Merge calls (1-based) that commit in live and then throw (poll error). */
let mergesThatThrowAfterCommit = new Set<number>();
/** Merge calls (1-based) that fail and write nothing. */
let mergesThatFail = new Set<number>();
let writeModeOfRun: "append_dedup" | "append" | "overwrite" = "append_dedup";

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
  prepareStaging: (async (
    _l: unknown,
    _f: string,
    o?: { strict?: boolean },
  ) => {
    prepareCalls++;
    if (failingPrepareCalls.has(prepareCalls)) {
      // A real adapter swallows this unless strict.
      if (o?.strict) {
        throw new Error("Exceeded rate limits: table update operations");
      }
      return;
    }
    staging = [];
  }) as any,
  cleanupStaging: (async () => {
    staging = [];
  }) as any,
  loadStagingFromParquet: (async (filePath: string) => {
    loadCalls++;
    if (failingLoadCalls.has(loadCalls)) {
      throw new Error(
        "Provided Schema does not match Table p:d.leads__backfill_staging. Field custom_cf_x has changed mode from REQUIRED to NULLABLE",
      );
    }
    const ids = await idsInParquet(filePath);
    staging.push(...ids);
    return { loaded: ids.length };
  }) as any,
  mergeFromStaging: (async () => {
    if (mergesThatFail.has(mergeCalls + 1)) {
      mergeCalls++;
      throw new Error("Job exceeded rate limits");
    }
    const written = staging.length;
    if (writeModeOfRun === "append_dedup") {
      const seen = new Set(live);
      for (const id of new Set(staging)) if (!seen.has(id)) live.push(id);
    } else {
      live.push(...staging);
    }
    mergeCalls++;
    if (mergesThatThrowAfterCommit.has(mergeCalls)) {
      throw new Error("Job polling failed after the MERGE committed");
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

import {
  getTempCollectionCount,
  performBulkFlush,
  performOverwriteTruncate,
  performRescueAndPrepareStaging,
  performStagingCleanup,
  performStagingMerge,
  performSyncChunk,
} from "./sync-orchestrator";

// ── Driver: the bulk path of sync-entity.ts, with Inngest step retries ────

const FLOW_ID = "6a69c1409e5425b9c1181582";
const ENTITY = "leads";

/** An Inngest step: a throw re-runs the whole callback, up to 4 attempts. */
async function step(fn: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
    }
  }
}

function runOptions(writeMode: "append_dedup" | "append" | "overwrite"): any {
  return {
    dataSourceId: "69c781737eb58b93e5ac3385",
    destinationId: "dest1",
    flowId: FLOW_ID,
    workspaceId: "6846e6a01b05af0948070582",
    syncEngine: "cdc",
    entity: ENTITY,
    isIncremental: false,
    writeMode,
    tableDestination: {
      connectionId: "69c2719490eb18199aafa882",
      schema: "pl_close_crm",
      tableName: "",
    },
  };
}

async function runEntity(
  writeMode: "append_dedup" | "append" | "overwrite",
  flushThreshold: number,
): Promise<void> {
  writeModeOfRun = writeMode;
  const options = runOptions(writeMode);

  await step(async () => {
    await performRescueAndPrepareStaging(options);
    await performOverwriteTruncate(options);
  });

  let state: any;
  let completed = false;
  while (!completed) {
    const result = await performSyncChunk({
      ...options,
      state,
      maxIterations: 2,
    });
    state = result.state;
    completed = result.completed;
    if (!completed) {
      const inBuffer = await getTempCollectionCount(FLOW_ID, ENTITY);
      if (inBuffer >= flushThreshold) {
        await step(async () => {
          await performRescueAndPrepareStaging(options, { dedupOnly: true });
          await performBulkFlush(options);
        });
        await step(async () => {
          await performStagingMerge(options);
          await performStagingCleanup(options);
        });
      }
    }
  }

  if ((await getTempCollectionCount(FLOW_ID, ENTITY)) > 0) {
    await step(async () => {
      await performRescueAndPrepareStaging(options, { dedupOnly: true });
      await performBulkFlush(options);
    });
    await step(async () => {
      await performStagingMerge(options);
      await performStagingCleanup(options);
    });
  }
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

describe("bulk backfill lands every row exactly once", () => {
  beforeEach(() => {
    collections.clear();
    staging = [];
    live = [];
    loadCalls = 0;
    failingLoadCalls = new Set();
    mergeCalls = 0;
    mergesThatThrowAfterCommit = new Set();
    mergesThatFail = new Set();
    prepareCalls = 0;
    failingPrepareCalls = new Set();
    // 730 rows, one cursor value: 3 mid-run flushes of 200+ rows (5 batches
    // of 50 each) and a final flush.
    sourceRows = Array.from({ length: 730 }, (_, i) => ({
      id: `lead_${String(i).padStart(4, "0")}`,
      date_created: SAME_DAY,
      date_updated: SAME_DAY,
      // Dense in the first batches, sparse later: the column shape that made
      // DuckDB 2.0 write REQUIRED and BigQuery reject the next load.
      custom_cf_x: i < 120 ? `v${i}` : i % 3 === 0 ? null : `v${i}`,
    }));
  });

  it.each(["append_dedup", "append", "overwrite"] as const)(
    "%s: rows sharing one cursor value, no failure",
    async writeMode => {
      await runEntity(writeMode, 200);
      expectEveryRowExactlyOnce();
      expect(staging).toEqual([]);
      expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(0);
    },
    60_000,
  );

  it.each(["append_dedup", "append", "overwrite"] as const)(
    "%s: a staging load fails mid-flush and the step is retried",
    async writeMode => {
      // Load calls 3-5 are the three in-process attempts of the 3rd batch of
      // the first flush; 13-15 hit a later flush the same way. Each throws
      // out of the step, which Inngest retries from the top.
      failingLoadCalls = new Set([3, 4, 5, 13, 14, 15]);
      await runEntity(writeMode, 200);
      expectEveryRowExactlyOnce();
      expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(0);
    },
    120_000,
  );
  it.each(["append_dedup", "append", "overwrite"] as const)(
    "%s: a merge fails without committing, and its step is retried",
    async writeMode => {
      // Merge 1 is the start-of-run rescue (staging empty); merge 2 is the
      // first flush-apply. It writes nothing and throws.
      mergesThatFail = new Set([2]);
      await runEntity(writeMode, 200);
      expectEveryRowExactlyOnce();
      expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(0);
    },
    60_000,
  );

  it("append_dedup: a merge commits and then throws: still exactly once", async () => {
    mergesThatThrowAfterCommit = new Set([2]);
    await runEntity("append_dedup", 200);
    expectEveryRowExactlyOnce();
  }, 60_000);

  it.each(["append", "overwrite"] as const)(
    "%s: a merge commits and then throws: no row lost, that flush appended twice",
    async writeMode => {
      // A plain INSERT retry cannot tell this from a merge that failed.
      // At-least-once: the retried merge appends the same flush again.
      mergesThatThrowAfterCommit = new Set([2]);
      await runEntity(writeMode, 200);
      const ids = new Set(live);
      expect(sourceRows.every(r => ids.has(String(r.id)))).toBe(true);
      expect(live.length).toBe(sourceRows.length + 200);
    },
    60_000,
  );

  it.each(["append_dedup", "append"] as const)(
    "%s: a run resumed after a crash between flush and merge",
    async writeMode => {
      writeModeOfRun = writeMode;
      const options = runOptions(writeMode);
      sourceRows = sourceRows.slice(0, 120);
      // Attempt 1: rows buffered and flushed into staging, then the worker
      // dies before the merge. Rows are marked staged in the buffer.
      await performSyncChunk({ ...options, maxIterations: 10 });
      await performBulkFlush(options);
      expect(staging).toHaveLength(120);
      // The resumed run starts with the rescue, then flushes what is left.
      await performRescueAndPrepareStaging(options);
      await performBulkFlush(options);
      await performStagingMerge(options);
      await performStagingCleanup(options);
      expectEveryRowExactlyOnce();
      expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(0);
    },
    60_000,
  );
  it.each(["append_dedup", "append", "overwrite"] as const)(
    "%s: the retry's staging drop fails once",
    async writeMode => {
      // Prepare 1 starts the run, prepare 2 the first flush. The load of the
      // 3rd batch fails, and the retry's drop (prepare 3) fails too.
      failingLoadCalls = new Set([3, 4, 5]);
      failingPrepareCalls = new Set([3]);
      await runEntity(writeMode, 200);
      expectEveryRowExactlyOnce();
    },
    60_000,
  );
});
