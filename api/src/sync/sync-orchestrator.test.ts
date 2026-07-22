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

const truncateLiveTable = vi.fn().mockResolvedValue(undefined);
const prepareStaging = vi.fn().mockResolvedValue(undefined);
const fakeAdapter: Partial<CdcDestinationAdapter> = {
  destinationType: "bigquery",
  truncateLiveTable,
  prepareStaging,
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
