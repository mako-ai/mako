import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A poll of an entity whose read ignores `since` soft-deletes the rows its
 * complete listing no longer holds (sync-cdc/soft-delete-missing.ts). This
 * file proves the orchestrator only asks in the cases that are a complete
 * full read: guard 4 (no hasMore, no continuation), mode "none", no backfill.
 */

const { fetchEntityChunk, caps, adapter } = vi.hoisted(() => ({
  fetchEntityChunk: vi.fn(),
  caps: {
    value: { supported: false, mode: "none" } as {
      supported: boolean;
      mode: string;
      perEntity?: Record<string, { mode: string }>;
    },
  },
  adapter: {
    destinationType: "bigquery",
    applyBatch: vi.fn(async (p: { records: unknown[] }) => ({
      written: p.records.length,
    })),
    countLiveRows: vi.fn(),
    softDeleteRowsNotIn: vi.fn(),
  },
}));

vi.mock("../services/destination-writer.service", async () => ({
  ...(await vi.importActual<object>("../services/destination-writer.service")),
  getMaxTrackingValue: vi.fn(async () => ({ success: true, maxValue: "x" })),
}));

vi.mock("../database/workspace-schema", () => {
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
      type: "rest",
      active: true,
    })),
  },
}));

vi.mock("./connector-registry", () => ({
  syncConnectorRegistry: {
    getConnectorFor: vi.fn(async () => ({
      resolveSchema: async () => null,
      supportsResumableFetching: () => true,
      getIncrementalCapabilities: () => caps.value,
      fetchEntityChunk,
    })),
  },
}));

vi.mock("../sync-cdc/adapters/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../sync-cdc/adapters/registry")
  >("../sync-cdc/adapters/registry");
  return { ...actual, resolveCdcDestinationAdapter: vi.fn(() => adapter) };
});

import { entityIsReadInFull, performSyncChunk } from "./sync-orchestrator";

const options = {
  dataSourceId: "ds1",
  destinationId: "dest1",
  flowId: "64b000000000000000000001",
  workspaceId: "ws1",
  syncEngine: "cdc" as const,
  entity: "users",
  isIncremental: true,
  fullRead: false,
  deleteMode: "soft" as const,
  writeMode: "append_dedup" as const,
  tableDestination: { connectionId: "conn1", schema: "close", tableName: "" },
} as any;

/** A read that lists these ids in one batch. */
function lists(ids: string[], hasMore = false) {
  fetchEntityChunk.mockImplementation(
    async (o: { onBatch: (b: unknown[]) => Promise<void> }) => {
      await o.onBatch(ids.map(id => ({ id, name: id })));
      return { totalProcessed: ids.length, iterationsInChunk: 1, hasMore };
    },
  );
}

describe("poll sweep of rows missing from a full read", () => {
  beforeEach(() => {
    fetchEntityChunk.mockReset();
    adapter.applyBatch.mockClear();
    adapter.countLiveRows.mockReset();
    adapter.softDeleteRowsNotIn.mockReset();
    adapter.softDeleteRowsNotIn.mockResolvedValue({ marked: 1 });
    caps.value = { supported: false, mode: "none" };
  });

  it("happy path: a removed id is soft-deleted on the next poll", async () => {
    lists(["a", "b"]);
    adapter.countLiveRows.mockResolvedValue({ live: 3, missing: 1 });
    await performSyncChunk(options);
    expect(adapter.softDeleteRowsNotIn).toHaveBeenCalledTimes(1);
    expect(adapter.softDeleteRowsNotIn.mock.calls[0].slice(1)).toEqual([
      "id",
      ["a", "b"],
    ]);
  });

  it("no change: 0 deletes and no UPDATE", async () => {
    lists(["a", "b"]);
    adapter.countLiveRows.mockResolvedValue({ live: 2, missing: 0 });
    await performSyncChunk(options);
    expect(adapter.softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 4: a read that ended with hasMore never sweeps", async () => {
    lists(["a", "b"], true);
    adapter.countLiveRows.mockResolvedValue({ live: 3, missing: 1 });
    await performSyncChunk(options);
    expect(adapter.countLiveRows).not.toHaveBeenCalled();
    expect(adapter.softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 4: a continuation chunk never sweeps", async () => {
    lists(["a", "b"]);
    adapter.countLiveRows.mockResolvedValue({ live: 3, missing: 1 });
    await performSyncChunk({
      ...options,
      state: { totalProcessed: 5, iterationsInChunk: 0, hasMore: true },
    });
    expect(adapter.softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 4: a read that threw never sweeps", async () => {
    fetchEntityChunk.mockImplementation(
      async (o: { onBatch: (b: unknown[]) => Promise<void> }) => {
        await o.onBatch([{ id: "a" }]);
        throw new Error("boom");
      },
    );
    await expect(
      performSyncChunk({ ...options, maxRetries: 0 }),
    ).rejects.toThrow();
    expect(adapter.countLiveRows).not.toHaveBeenCalled();
  });

  it("guard 1: an empty listing never sweeps", async () => {
    lists([]);
    adapter.countLiveRows.mockResolvedValue({ live: 3, missing: 3 });
    await performSyncChunk(options);
    expect(adapter.softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 3: a hard-delete flow never sweeps", async () => {
    lists(["a"]);
    await performSyncChunk({ ...options, deleteMode: "hard" });
    expect(adapter.countLiveRows).not.toHaveBeenCalled();
  });

  it("a backfill never sweeps", async () => {
    lists(["a"]);
    await performSyncChunk({ ...options, fullRead: true });
    await performSyncChunk({
      ...options,
      backfillFetch: { mode: "full" },
    });
    expect(adapter.countLiveRows).not.toHaveBeenCalled();
  });

  it("an entity that reads incrementally never sweeps", async () => {
    caps.value = {
      supported: true,
      mode: "none",
      perEntity: { users: { mode: "native" } },
    };
    lists(["a"]);
    await performSyncChunk(options);
    expect(adapter.countLiveRows).not.toHaveBeenCalled();
  });

  it("a sweep failure never fails the poll", async () => {
    lists(["a", "b"]);
    adapter.countLiveRows.mockResolvedValue({ live: 3, missing: 1 });
    adapter.softDeleteRowsNotIn.mockRejectedValue(new Error("bq down"));
    const out = await performSyncChunk(options);
    expect(out.completed).toBe(true);
  });

  it("reads the mode per entity, then the connector's own", () => {
    expect(entityIsReadInFull({}, "users")).toBe(false);
    expect(
      entityIsReadInFull(
        {
          getIncrementalCapabilities: () => ({
            supported: false,
            mode: "none",
          }),
        },
        "users",
      ),
    ).toBe(true);
    expect(
      entityIsReadInFull(
        {
          getIncrementalCapabilities: () => ({
            supported: true,
            mode: "none",
            perEntity: { leads: { mode: "native" } },
          }),
        },
        "users",
      ),
    ).toBe(true);
    expect(
      entityIsReadInFull(
        {
          getIncrementalCapabilities: () => ({
            supported: true,
            mode: "none",
            perEntity: { users: { mode: "native" } },
          }),
        },
        "users",
      ),
    ).toBe(false);
  });
});
