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

vi.mock("../database/workspace-schema", () => ({
  DatabaseConnection: {
    findById: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({ type: "bigquery" }),
      }),
    })),
  },
  Flow: { db: { collection: vi.fn() } },
}));

vi.mock("./database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn().mockResolvedValue(null),
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
} from "./sync-orchestrator";

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

  it("treats a missing staging table as nothing to rescue", async () => {
    mergeFromStaging.mockRejectedValueOnce(
      new Error("Not found: Table p:d.users__backfill_staging"),
    );
    const result = await performRescueAndPrepareStaging(rescueOptions);
    expect(result).toEqual({ rescued: 0 });
    expect(prepareStaging).toHaveBeenCalledTimes(1);
  });
});
