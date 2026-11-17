import { describe, it, expect, vi, beforeEach } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CdcDestinationAdapter } from "../sync-cdc/adapters/registry";
import type { ConnectorEntitySchema } from "../connectors/base/BaseConnector";

/**
 * Regression for the schema-less flush of 17 Nov 2026.
 *
 * The PT Close shadow leads flush (ws:close) logged "Schema resolution
 * failed: [unavailable] the connection to sandbox … ended before the stream
 * completed", swallowed it, and flushed with no field types. Every Date in the
 * buffer went to Parquet as a JSON-quoted string, BigQuery's SAFE_CAST turned
 * it into NULL, and 11,165 rows landed with NULL date_created, date_updated,
 * _syncedAt and _mako_source_ts.
 *
 * The fake destination below reads each staged Parquet file the way the
 * BigQuery MERGE does: TRY_CAST to TIMESTAMP (DuckDB's SAFE_CAST), then a
 * merge guarded by COALESCE(_mako_source_ts, 1970).
 */

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
    findOne: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({ type: "bigquery" }),
      }),
    })),
  },
  Flow: { db: { collection: (name: string) => collection(name) } },
}));

// ── Fake source with a typed schema that can fail on demand ───────────────

const CREATED = "2026-05-13T11:53:05.000Z";
const UPDATED = "2026-11-17T15:30:00.000Z";
const PAGE = 50;
let sourceRows: Record<string, unknown>[] = [];
let sourceType = "ws:close";

const LEADS_SCHEMA: ConnectorEntitySchema = {
  entity: "leads",
  unknownFieldPolicy: "string",
  keyColumns: ["id"],
  fields: {
    id: { type: "string", nullable: false },
    display_name: { type: "string", nullable: true },
    date_created: { type: "timestamp", nullable: true },
    date_updated: { type: "timestamp", nullable: true },
    _syncedAt: { type: "timestamp", nullable: true },
    _mako_source_ts: { type: "timestamp", nullable: true },
  },
};

/** How the next resolveSchema calls answer, in order; then the schema. */
let schemaAnswers: Array<"throw" | "null"> = [];

const fakeConnector = {
  supportsResumableFetching: () => true,
  resolveSchema: async () => {
    const answer = schemaAnswers.shift();
    if (answer === "throw") {
      throw new Error(
        "[unavailable] the connection to sandbox it1vcgkcdx1dnfr9g2hs5 ended before the stream completed",
      );
    }
    if (answer === "null") return null;
    return LEADS_SCHEMA;
  },
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
      name: "pt_close_shadow",
      type: sourceType,
      workspaceId: "6846e6a01b05af0948070582",
      active: true,
      settings: { rate_limit_delay_ms: 1 },
      connection: {},
    })),
  },
}));

vi.mock("./connector-registry", () => ({
  syncConnectorRegistry: { getConnectorFor: vi.fn(async () => fakeConnector) },
}));

// ── Fake BigQuery: SAFE_CAST on load, source-ts-guarded MERGE ─────────────

type LiveRow = {
  id: string;
  date_created: number | null;
  date_updated: number | null;
  _syncedAt: number | null;
  _mako_source_ts: number | null;
};

let staging: LiveRow[] = [];
let live = new Map<string, LiveRow>();
let loadCalls = 0;

function micros(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number((v as { micros: bigint }).micros / 1000n);
}

async function rowsInParquet(filePath: string): Promise<LiveRow[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const cast = (c: string) => `TRY_CAST("${c}" AS TIMESTAMP) AS "${c}"`;
    const reader = await conn.runAndReadAll(
      `SELECT CAST(id AS VARCHAR) AS id, ${[
        "date_created",
        "date_updated",
        "_syncedAt",
        "_mako_source_ts",
      ]
        .map(cast)
        .join(", ")} FROM read_parquet('${filePath.replace(/'/g, "''")}')`,
    );
    return reader.getRowObjects().map(r => ({
      id: String(r.id),
      date_created: micros(r.date_created),
      date_updated: micros(r.date_updated),
      _syncedAt: micros(r._syncedAt),
      _mako_source_ts: micros(r._mako_source_ts),
    }));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

const EPOCH = 0;

const fakeAdapter: Partial<CdcDestinationAdapter> = {
  destinationType: "bigquery",
  truncateLiveTable: (async () => {
    live = new Map();
  }) as any,
  prepareStaging: (async () => {
    staging = [];
  }) as any,
  cleanupStaging: (async () => {
    staging = [];
  }) as any,
  loadStagingFromParquet: (async (filePath: string) => {
    loadCalls++;
    const rows = await rowsInParquet(filePath);
    staging.push(...rows);
    return { loaded: rows.length };
  }) as any,
  mergeFromStaging: (async () => {
    // bigquery-sql.ts: WHEN MATCHED AND COALESCE(stg.ts, 1970) >=
    // COALESCE(live.ts, 1970) THEN UPDATE; WHEN NOT MATCHED THEN INSERT.
    for (const row of staging) {
      const current = live.get(row.id);
      if (
        !current ||
        (row._mako_source_ts ?? EPOCH) >= (current._mako_source_ts ?? EPOCH)
      ) {
        live.set(row.id, row);
      }
    }
    return { written: staging.length };
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
  performRescueAndPrepareStaging,
  performStagingCleanup,
  performStagingMerge,
  performSyncChunk,
  SchemaResolutionError,
} from "./sync-orchestrator";
import { MissingRowTimestampError } from "../utils/streaming-parquet-builder";

const FLOW_ID = "5ba3b584e84144f28d86700a";
const ENTITY = "leads";

/** An Inngest step: a throw re-runs the whole callback, up to 4 attempts. */
async function step(fn: () => Promise<unknown>): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return attempt;
    } catch (err) {
      if (attempt >= 4) throw err;
    }
  }
}

function runOptions(): any {
  return {
    dataSourceId: "69c781737eb58b93e5ac3385",
    destinationId: "dest1",
    flowId: FLOW_ID,
    workspaceId: "6846e6a01b05af0948070582",
    syncEngine: "cdc",
    entity: ENTITY,
    isIncremental: false,
    writeMode: "append_dedup",
    tableDestination: {
      connectionId: "69c2719490eb18199aafa882",
      schema: "pt_close_crm_shadow",
      tableName: "",
    },
  };
}

/** Fetch every chunk into the Mongo buffer (no mid-run flush). */
async function fetchAll(): Promise<void> {
  const options = runOptions();
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
  }
}

/** The final flush and merge steps of sync-entity.ts. */
async function flushAndMerge(): Promise<number> {
  const options = runOptions();
  const flushAttempts = await step(async () => {
    await performRescueAndPrepareStaging(options, { dedupOnly: true });
    await performBulkFlush(options);
  });
  await step(async () => {
    await performStagingMerge(options);
    await performStagingCleanup(options);
  });
  return flushAttempts;
}

function expectEveryRowTimestamped() {
  expect(live.size).toBe(sourceRows.length);
  const rows = [...live.values()];
  const nulls = {
    date_created: rows.filter(r => r.date_created === null).length,
    date_updated: rows.filter(r => r.date_updated === null).length,
    _syncedAt: rows.filter(r => r._syncedAt === null).length,
    _mako_source_ts: rows.filter(r => r._mako_source_ts === null).length,
  };
  expect(nulls).toEqual({
    date_created: 0,
    date_updated: 0,
    _syncedAt: 0,
    _mako_source_ts: 0,
  });
  expect(rows[0].date_created).toBe(Date.parse(CREATED));
  expect(rows[0].date_updated).toBe(Date.parse(UPDATED));
  // Newer source ts wins: the row is stamped with its date_updated.
  expect(rows[0]._mako_source_ts).toBe(Date.parse(UPDATED));
}

describe("a flush never runs without the entity schema", () => {
  beforeEach(() => {
    collections.clear();
    staging = [];
    live = new Map();
    loadCalls = 0;
    schemaAnswers = [];
    sourceType = "ws:close";
    sourceRows = Array.from({ length: 230 }, (_, i) => ({
      id: `lead_${String(i).padStart(4, "0")}`,
      display_name: `Lead ${i}`,
      date_created: CREATED,
      date_updated: UPDATED,
    }));
  });

  it("ws: a transient schema failure at flush retries the step and lands every timestamp", async () => {
    await fetchAll();
    // 17 Nov: the sandbox stream dropped on the flush's schema call.
    schemaAnswers = ["throw"];
    const flushAttempts = await flushAndMerge();
    expect(flushAttempts).toBe(2);
    expectEveryRowTimestamped();
    expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(0);
  }, 60_000);

  it("ws: the failed attempt writes nothing to staging", async () => {
    await fetchAll();
    schemaAnswers = ["throw"];
    await expect(performBulkFlush(runOptions())).rejects.toBeInstanceOf(
      SchemaResolutionError,
    );
    expect(loadCalls).toBe(0);
    expect(staging).toEqual([]);
  }, 60_000);

  it("ws: a null schema from a workspace connector is a failure, not a schema-less flush", async () => {
    await fetchAll();
    schemaAnswers = ["null"];
    await expect(performBulkFlush(runOptions())).rejects.toBeInstanceOf(
      SchemaResolutionError,
    );
    expect(loadCalls).toBe(0);
  }, 60_000);

  it("ws: a transient schema failure at chunk time retries the chunk, never buffers untyped rows", async () => {
    schemaAnswers = ["throw"];
    await expect(
      performSyncChunk({ ...runOptions(), maxIterations: 2 }),
    ).rejects.toBeInstanceOf(SchemaResolutionError);
    expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(0);
    await fetchAll();
    await flushAndMerge();
    expectEveryRowTimestamped();
  }, 60_000);

  it("built-in: a transient schema failure also retries", async () => {
    sourceType = "close";
    await fetchAll();
    schemaAnswers = ["throw"];
    expect(await flushAndMerge()).toBe(2);
    expectEveryRowTimestamped();
  }, 60_000);

  it("built-in with no schema at flush (legitimate null): Dates still land, no NULL timestamps", async () => {
    // Typed at fetch time (Dates in the buffer), untyped at flush: the exact
    // shape of the 17 Nov rows. The writer serialises Dates as ISO 8601 and
    // types the system columns TIMESTAMP, so nothing casts to NULL.
    sourceType = "close";
    await fetchAll();
    schemaAnswers = ["null", "null"];
    expect(await flushAndMerge()).toBe(1);
    expectEveryRowTimestamped();
  }, 60_000);

  it("a buffered row without _mako_source_ts fails the flush and reaches no destination", async () => {
    await fetchAll();
    const buffer = [...collections.values()][0];
    delete buffer.docs[7]._mako_source_ts;
    await expect(performBulkFlush(runOptions())).rejects.toBeInstanceOf(
      MissingRowTimestampError,
    );
    expect(loadCalls).toBe(0);
    expect(live.size).toBe(0);
  }, 60_000);

  it("a buffered row with a NULL _syncedAt fails the flush", async () => {
    await fetchAll();
    const buffer = [...collections.values()][0];
    buffer.docs[3]._syncedAt = null;
    await expect(performBulkFlush(runOptions())).rejects.toBeInstanceOf(
      MissingRowTimestampError,
    );
    expect(loadCalls).toBe(0);
  }, 60_000);

  it("merge semantics: a NULL-ts live row is overwritten by the next good row", async () => {
    // Pre-fix damage: live holds the row with NULL timestamps.
    live.set("lead_0000", {
      id: "lead_0000",
      date_created: null,
      date_updated: null,
      _syncedAt: null,
      _mako_source_ts: null,
    });
    await fetchAll();
    await flushAndMerge();
    expectEveryRowTimestamped();
  }, 60_000);

  it("append: a schema failure at merge keeps the staged rows in the buffer", async () => {
    await fetchAll();
    const options = { ...runOptions(), writeMode: "append" };
    await performBulkFlush(options);
    const staged = await getTempCollectionCount(FLOW_ID, ENTITY);
    expect(staged).toBe(sourceRows.length);
    schemaAnswers = ["throw"];
    await expect(performStagingMerge(options)).rejects.toBeInstanceOf(
      SchemaResolutionError,
    );
    // The rows are still in the buffer, so a later flush can load them again.
    expect(await getTempCollectionCount(FLOW_ID, ENTITY)).toBe(staged);
  }, 60_000);
});
