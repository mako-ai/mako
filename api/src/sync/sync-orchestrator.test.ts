import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CdcDestinationAdapter } from "../sync-cdc/adapters/registry";

/**
 * Regression coverage for bug B1 (docs/sync-modes-hardening-plan.md, Phase 1):
 * `Full Refresh | Overwrite` bulk-staging runs used to truncate the live
 * table on *every* flush cycle (via `performPrepareStaging`), so only the
 * last flush of a run survived. The fix splits the once-per-run truncate
 * into `performOverwriteTruncate`, called only from the initial
 * `prepare-staging-*` Inngest step — `performPrepareStaging` itself must
 * never truncate, no matter how many times a run calls it.
 */

vi.mock("../repositories/connections", () => ({
  connectionsRepo: {
    findDatabaseConnectionSummary: vi.fn(async () => ({ type: "bigquery" })),
  },
}));

vi.mock("../database/workspace-schema", () => ({
  // performPrepareStaging clears the staged marks in the flush buffer.
  Flow: {
    db: {
      collection: vi.fn(() => ({
        updateMany: async () => ({ modifiedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
      })),
    },
  },
}));

// A workspace source whose catalog declares the stream untyped (a REST
// folder's entity): the merge runs with default key columns. No built-in
// source connector is left.
const SOURCE = { id: "ds1", name: "rest", type: "ws:rest", active: true };
vi.mock("./database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn(),
  },
}));

vi.mock("./connector-registry", () => ({
  syncConnectorRegistry: {
    getConnectorFor: vi.fn(async () => ({
      resolveSchema: async () => null,
      declaresUntypedSchema: async () => true,
    })),
  },
}));

// A tiny stateful destination: `staging` and `live` hold row ids, so a test
// can assert where rows ended up, not just which methods were called.
const staging: string[] = [];
const live: string[] = [];
const truncateLiveTable = vi.fn().mockResolvedValue(undefined);
const prepareStaging = vi.fn(async () => {
  staging.length = 0;
});
const mergeFromStaging = vi.fn(async () => {
  const written = staging.length;
  live.push(...staging);
  staging.length = 0;
  return { written };
});
const fakeAdapter: Partial<CdcDestinationAdapter> = {
  destinationType: "bigquery",
  truncateLiveTable,
  prepareStaging: prepareStaging as any,
  mergeFromStaging: mergeFromStaging as any,
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
  performPrepareStaging,
  performOverwriteTruncate,
  performRescueAndPrepareStaging,
  performStagingMerge,
  performSyncChunk,
} from "./sync-orchestrator";
import { sourceConnectionManager } from "./database-data-source-manager";
import { syncConnectorRegistry } from "./connector-registry";

beforeEach(() => {
  vi.mocked(sourceConnectionManager.getSourceConnection).mockResolvedValue(
    SOURCE as any,
  );
});

const baseOptions = {
  dataSourceId: "ds1",
  destinationId: "dest1",
  destinationDatabaseName: "db",
  flowId: "flow1",
  workspaceId: "ws1",
  syncEngine: "cdc" as const,
  entity: "users",
  isIncremental: false,
  tableDestination: {
    connectionId: "conn1",
    schema: "public",
    tableName: "users",
  },
} as any;

describe("Overwrite live-table truncation (bug B1)", () => {
  beforeEach(() => {
    truncateLiveTable.mockClear();
    prepareStaging.mockClear();
  });

  it("performPrepareStaging never truncates the live table, even in overwrite mode", async () => {
    await performPrepareStaging({ ...baseOptions, writeMode: "overwrite" });
    expect(truncateLiveTable).not.toHaveBeenCalled();
    expect(prepareStaging).toHaveBeenCalledTimes(1);
  });

  it("performPrepareStaging called multiple times (simulating N flush cycles) still never truncates", async () => {
    for (let i = 0; i < 4; i++) {
      await performPrepareStaging({ ...baseOptions, writeMode: "overwrite" });
    }
    expect(truncateLiveTable).not.toHaveBeenCalled();
    expect(prepareStaging).toHaveBeenCalledTimes(4);
  });

  it("performOverwriteTruncate truncates once when writeMode is overwrite", async () => {
    await performOverwriteTruncate({ ...baseOptions, writeMode: "overwrite" });
    expect(truncateLiveTable).toHaveBeenCalledTimes(1);
  });

  it("performOverwriteTruncate is a no-op for append_dedup / append", async () => {
    await performOverwriteTruncate({
      ...baseOptions,
      writeMode: "append_dedup",
    });
    await performOverwriteTruncate({ ...baseOptions, writeMode: "append" });
    expect(truncateLiveTable).not.toHaveBeenCalled();
  });

  it("a full run — one performOverwriteTruncate + N performPrepareStaging — truncates exactly once", async () => {
    const options = { ...baseOptions, writeMode: "overwrite" };
    // Mirrors sync-entity.ts: prepare-staging step (truncate once + prepare),
    // then flush-merge-* / flush-final-* steps calling only prepare-staging.
    await performOverwriteTruncate(options);
    await performPrepareStaging(options);
    await performPrepareStaging(options); // flush-merge cycle 1
    await performPrepareStaging(options); // flush-merge cycle 2
    await performPrepareStaging(options); // flush-final

    expect(truncateLiveTable).toHaveBeenCalledTimes(1);
    expect(prepareStaging).toHaveBeenCalledTimes(4);
  });
});

/**
 * Regression coverage for silent row loss in bulk backfills. A flush deletes
 * each batch from the temp buffer once it is loaded into staging, so until
 * the merge succeeds staging is the only copy. A retried flush step used to
 * begin by dropping staging, losing every batch the failed attempt had
 * loaded (seen as whole 2,000-row gaps in Close call backfills, with the run
 * reporting "completed").
 */
// performStagingMerge builds an ObjectId from the flow id.
const rescueOptions = { ...baseOptions, flowId: "69cf92622ebc493f45843489" };

describe("Retry-safe staging prepare (lost flush batches)", () => {
  beforeEach(() => {
    staging.length = 0;
    live.length = 0;
    prepareStaging.mockClear();
    mergeFromStaging.mockClear();
    mergeFromStaging.mockImplementation(async () => {
      const written = staging.length;
      live.push(...staging);
      staging.length = 0;
      return { written };
    });
  });

  it("a bare performPrepareStaging drops rows a failed attempt left in staging (the bug)", async () => {
    staging.push("a", "b");
    await performPrepareStaging(rescueOptions);
    expect(live).toEqual([]);
    expect(staging).toEqual([]);
  });

  it("merges rows left in staging into live before dropping it", async () => {
    // Attempt 1 loaded two batches into staging (and deleted them from the
    // buffer), then its merge failed. Attempt 2 starts here.
    staging.push("a", "b");
    const result = await performRescueAndPrepareStaging(rescueOptions);

    expect(result).toEqual({ rescued: 2 });
    expect(live).toEqual(["a", "b"]);
    expect(staging).toEqual([]);
    expect(mergeFromStaging.mock.invocationCallOrder[0]).toBeLessThan(
      prepareStaging.mock.invocationCallOrder[0],
    );
  });

  it("is a no-op rescue when staging is empty, and still prepares staging", async () => {
    const result = await performRescueAndPrepareStaging(rescueOptions);
    expect(result).toEqual({ rescued: 0 });
    expect(prepareStaging).toHaveBeenCalledTimes(1);
  });

  it("does not drop staging when the rescue merge fails", async () => {
    staging.push("a", "b");
    mergeFromStaging.mockRejectedValueOnce(new Error("Job timed out"));

    await expect(performRescueAndPrepareStaging(rescueOptions)).rejects.toThrow(
      "Job timed out",
    );
    expect(prepareStaging).not.toHaveBeenCalled();
    expect(staging).toEqual(["a", "b"]);

    // The next retry merges them.
    await performRescueAndPrepareStaging(rescueOptions);
    expect(live).toEqual(["a", "b"]);
  });

  it("treats a missing destination dataset as nothing to rescue", async () => {
    mergeFromStaging.mockRejectedValueOnce(
      new Error("Not found: Dataset p:d was not found in location EU"),
    );
    const result = await performRescueAndPrepareStaging(rescueOptions);
    expect(result).toEqual({ rescued: 0 });
    expect(prepareStaging).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a missing-table MERGE failure (staging is kept)", async () => {
    staging.push("a", "b");
    mergeFromStaging.mockRejectedValueOnce(
      new Error("Not found: Table p:d.users was not found"),
    );
    await expect(performRescueAndPrepareStaging(rescueOptions)).rejects.toThrow(
      "Not found: Table",
    );
    expect(prepareStaging).not.toHaveBeenCalled();
    expect(staging).toEqual(["a", "b"]);
  });

  it.each(["append", "overwrite"] as const)(
    "per-flush steps never rescue in %s mode (plain INSERT would duplicate)",
    async writeMode => {
      // Staging may hold rows whose merge already committed, or rows still in
      // the buffer; re-merging either would write them to live twice.
      staging.push("a", "b");
      const result = await performRescueAndPrepareStaging(
        { ...rescueOptions, writeMode },
        { dedupOnly: true },
      );
      expect(result).toEqual({ rescued: 0 });
      expect(mergeFromStaging).not.toHaveBeenCalled();
      expect(live).toEqual([]);
      expect(prepareStaging).toHaveBeenCalledTimes(1);
    },
  );

  it("per-flush steps rescue in append_dedup mode, explicit or default", async () => {
    staging.push("a");
    await performRescueAndPrepareStaging(
      { ...rescueOptions, writeMode: "append_dedup" },
      { dedupOnly: true },
    );
    staging.push("b");
    await performRescueAndPrepareStaging(rescueOptions, { dedupOnly: true });
    expect(live).toEqual(["a", "b"]);
  });
});

/**
 * A flow reads its source connection in its own workspace only
 * (flow-connection-scope.ts): a connection of another workspace reads as
 * missing, on the polling read and on the staging merge.
 */
describe("source connection lookups are scoped to the flow's workspace", () => {
  const lookup = vi.mocked(sourceConnectionManager.getSourceConnection);
  beforeEach(() => {
    lookup.mockClear();
    lookup.mockResolvedValue(null);
  });

  it("the polling read looks the connection up in the flow's workspace, and a miss fails the chunk", async () => {
    await expect(performSyncChunk(baseOptions)).rejects.toThrow(
      "Data source 'ds1' not found",
    );
    expect(lookup).toHaveBeenCalledWith("ds1", "ws1");
  });

  it("the staging merge looks the connection up in the flow's workspace, and a miss fails the merge", async () => {
    // Without the connection there is no schema (no key columns): the merge
    // step fails and retries instead of merging on default keys.
    await expect(performRescueAndPrepareStaging(rescueOptions)).rejects.toThrow(
      "source connection ds1 not found",
    );
    expect(lookup).toHaveBeenCalled();
    for (const call of lookup.mock.calls) expect(call).toEqual(["ds1", "ws1"]);
  });
});

describe("a flow's queries reach the connector the merge resolves its schema from", () => {
  // A GraphQL folder's entities are the flow's queries: a connector built
  // from the stored connection alone has no stream for them (#1358 review).
  const build = vi.mocked(syncConnectorRegistry.getConnectorFor);
  beforeEach(() => {
    build.mockClear();
    vi.mocked(sourceConnectionManager.getSourceConnection).mockResolvedValue({
      ...SOURCE,
      type: "ws:graphql",
      connection: { endpoint: "https://x.test/graphql" },
    } as any);
  });

  it("the staging merge builds the connector with the flow's queries", async () => {
    const queries = [{ name: "users", query: "{ users { id } }" }];
    await performStagingMerge({ ...baseOptions, queries }).catch(() => {});
    expect(build).toHaveBeenCalled();
    for (const [connection] of build.mock.calls) {
      expect((connection as any).connection).toEqual({
        endpoint: "https://x.test/graphql",
        queries,
      });
    }
  });

  it("without queries the stored connection is used as it is", async () => {
    await performStagingMerge(baseOptions).catch(() => {});
    for (const [connection] of build.mock.calls) {
      expect((connection as any).connection).toEqual({
        endpoint: "https://x.test/graphql",
      });
    }
  });
});
