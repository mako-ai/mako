import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The `since` an incremental CDC poll hands its connector (first chunk).
 *
 * It used to be MAX(_syncedAt) of the live table: Mako's write time, which
 * webhook writes advance too. Now the poll's own cursor wins
 * (sync-cdc/poll-cursor.ts); the destination is only a fallback, on
 * MAX(_mako_source_ts) first, MAX(_syncedAt) when the table has no source
 * timestamp, both minus the overlap.
 */

const { maxByColumn, probeError, getMaxTrackingValue, fetchEntityChunk } =
  vi.hoisted(() => {
    const maxByColumn: Record<string, string | undefined> = {};
    // When set, every destination probe fails with this error.
    const probeError: { value?: string } = {};
    return {
      maxByColumn,
      probeError,
      getMaxTrackingValue: vi.fn(
        async (_conn: unknown, _table: string, column: string) =>
          probeError.value
            ? { success: false, error: probeError.value }
            : { success: true, maxValue: maxByColumn[column] },
      ),
      fetchEntityChunk: vi.fn(async (_opts: { since?: Date }) => ({
        totalProcessed: 0,
        iterationsInChunk: 1,
        hasMore: false,
      })),
    };
  });
vi.mock("../services/destination-writer.service", async () => ({
  ...(await vi.importActual<object>("../services/destination-writer.service")),
  getMaxTrackingValue,
}));

vi.mock("../database/workspace-schema", () => {
  // findOne(...).select().lean() for the destination type, and a bare
  // awaited findOne(...) for the anchor's destination connection.
  const doc = { type: "bigquery" };
  const query = {
    select: () => ({ lean: () => Promise.resolve(doc) }),
    then: (resolve: (v: unknown) => unknown) => resolve(doc),
  };
  return {
    DatabaseConnection: { findOne: vi.fn(() => query) },
    Flow: {
      db: {
        collection: vi.fn(() => ({
          updateMany: async () => ({ modifiedCount: 0 }),
          deleteMany: async () => ({ deletedCount: 0 }),
          countDocuments: async () => 0,
        })),
      },
    },
  };
});

vi.mock("./database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn(async () => ({
      id: "ds1",
      name: "close",
      type: "ws:close",
      active: true,
    })),
  },
}));

vi.mock("./connector-registry", () => ({
  syncConnectorRegistry: {
    getConnectorFor: vi.fn(async () => ({
      resolveSchema: async () => null,
      declaresUntypedSchema: async () => true,
      supportsResumableFetching: () => true,
      fetchEntityChunk,
    })),
  },
}));

vi.mock("../sync-cdc/adapters/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../sync-cdc/adapters/registry")
  >("../sync-cdc/adapters/registry");
  return { ...actual, resolveCdcDestinationAdapter: vi.fn(() => ({})) };
});

import { performSyncChunk } from "./sync-orchestrator";

const pollOptions = {
  dataSourceId: "ds1",
  destinationId: "dest1",
  flowId: "flow1",
  workspaceId: "ws1",
  syncEngine: "cdc" as const,
  entity: "activities:Call",
  isIncremental: true,
  writeMode: "append_dedup" as const,
  tableDestination: {
    connectionId: "conn1",
    schema: "close",
    tableName: "",
  },
} as any;

const sinceOfFirstFetch = () =>
  (fetchEntityChunk.mock.calls[0]?.[0] as { since?: Date } | undefined)?.since;

const logs: Array<{ level: string; message: string }> = [];
const logger = {
  log: (level: string, message: string) => logs.push({ level, message }),
};

describe("incremental poll anchor", () => {
  beforeEach(() => {
    fetchEntityChunk.mockClear();
    getMaxTrackingValue.mockClear();
    logs.length = 0;
    for (const k of Object.keys(maxByColumn)) delete maxByColumn[k];
    // A webhook wrote the newest row at 14:59: both maxima sit there.
    maxByColumn._syncedAt = "2026-11-17T14:59:30.000Z";
    maxByColumn._mako_source_ts = "2026-11-17T14:58:00.000Z";
    delete probeError.value;
  });

  it("uses the poll cursor; the destination is only checked for rows", async () => {
    await performSyncChunk({
      ...pollOptions,
      logger,
      pollCursor: { since: "2026-11-17T13:50:00.000Z", overlapMs: 600_000 },
    });
    expect(sinceOfFirstFetch()?.toISOString()).toBe("2026-11-17T13:50:00.000Z");
    expect(getMaxTrackingValue.mock.calls.map(c => c[2])).toEqual([
      "_syncedAt",
    ]);
  });

  it("a poll cursor on record still fetches everything into an empty live table", async () => {
    delete maxByColumn._mako_source_ts;
    delete maxByColumn._syncedAt;
    await performSyncChunk({
      ...pollOptions,
      logger,
      pollCursor: { since: "2026-11-17T13:50:00.000Z" },
    });
    expect(sinceOfFirstFetch()).toBeUndefined();
  });

  it("a poll cursor on record still fetches everything into a missing live table", async () => {
    probeError.value =
      "Not found: Table realadvisor-prod:pl_close_crm_shadow.call_activities";
    await performSyncChunk({
      ...pollOptions,
      logger,
      pollCursor: { since: "2026-11-17T13:50:00.000Z" },
    });
    expect(sinceOfFirstFetch()).toBeUndefined();
  });

  it("a transient destination error keeps the poll cursor, with a warning", async () => {
    probeError.value = "socket hang up";
    await performSyncChunk({
      ...pollOptions,
      logger,
      pollCursor: { since: "2026-11-17T13:50:00.000Z" },
    });
    expect(sinceOfFirstFetch()?.toISOString()).toBe("2026-11-17T13:50:00.000Z");
    expect(logs.some(l => l.level === "warn")).toBe(true);
  });

  it("without a poll cursor, anchors on MAX(_mako_source_ts) minus the overlap", async () => {
    await performSyncChunk({
      ...pollOptions,
      logger,
      pollCursor: { overlapMs: 600_000 },
    });
    expect(sinceOfFirstFetch()?.toISOString()).toBe("2026-11-17T14:48:00.000Z");
    expect(getMaxTrackingValue.mock.calls.map(c => c[2])).toEqual([
      "_syncedAt",
      "_mako_source_ts",
    ]);
  });

  it("falls back to MAX(_syncedAt) minus the overlap, with a warning, when _mako_source_ts is NULL", async () => {
    delete maxByColumn._mako_source_ts;
    await performSyncChunk({
      ...pollOptions,
      logger,
      pollCursor: { overlapMs: 600_000 },
    });
    expect(sinceOfFirstFetch()?.toISOString()).toBe("2026-11-17T14:49:30.000Z");
    expect(getMaxTrackingValue.mock.calls.map(c => c[2])).toEqual([
      "_syncedAt",
      "_mako_source_ts",
    ]);
    expect(
      logs.some(
        l => l.level === "warn" && l.message.includes("no _mako_source_ts"),
      ),
    ).toBe(true);
  });

  it("an empty live table means a full first read (no since)", async () => {
    delete maxByColumn._mako_source_ts;
    delete maxByColumn._syncedAt;
    await performSyncChunk({ ...pollOptions, logger });
    expect(sinceOfFirstFetch()).toBeUndefined();
  });

  it("a continuation chunk (state set) passes no since: the connector carries its cursor", async () => {
    await performSyncChunk({
      ...pollOptions,
      logger,
      state: { totalProcessed: 10, iterationsInChunk: 0, hasMore: true },
      pollCursor: { since: "2026-11-17T13:50:00.000Z" },
    });
    expect(sinceOfFirstFetch()).toBeUndefined();
  });

  it("a backfill's own fetch scope wins over the poll cursor", async () => {
    await performSyncChunk({
      ...pollOptions,
      logger,
      backfillFetch: { mode: "incremental", since: "2026-11-10T00:00:00Z" },
      pollCursor: { since: "2026-11-17T13:50:00.000Z" },
    });
    expect(sinceOfFirstFetch()?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
});
