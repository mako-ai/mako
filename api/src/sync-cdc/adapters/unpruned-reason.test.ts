/**
 * Why a MERGE ran without a partition filter on a partitioned table:
 * `resolveLivePartitionFilter` reports the reason the runtime warning logs.
 */
import { describe, expect, it, vi } from "vitest";

import { databaseConnectionService } from "../../services/database-connection.service";
import { BigQueryDestinationAdapter } from "./bigquery";

// The partitioning cache is keyed by project, dataset and table.
let n = 0;

async function reasonFor(p: {
  tableField: string;
  layoutField: string;
  types: Record<string, string>;
  probeRows: number;
}): Promise<string | undefined> {
  const spy = vi
    .spyOn(databaseConnectionService, "executeQuery")
    .mockResolvedValue({
      success: true,
      data: Array.from({ length: p.probeRows }, (_, i) => ({
        p: `2025-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00`,
      })),
    } as never);
  try {
    let reported: { reason?: string } | undefined;
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: "db",
      workspaceId: "ws",
      tableDestination: { connectionId: "c", schema: "ds", tableName: "t" },
    }) as unknown as {
      resolveLivePartitionFilter: (t: unknown, p: unknown) => Promise<unknown>;
    };
    await adapter.resolveLivePartitionFilter(
      {
        bq: {
          dataset: () => ({
            table: () => ({
              getMetadata: async () => [
                { timePartitioning: { type: "DAY", field: p.tableField } },
              ],
            }),
          }),
        },
        projectId: "p",
        dataset: "ds",
        destination: {},
        datasetLocation: "EU",
      },
      {
        layout: {
          entity: "e",
          tableName: `unpruned_${n++}`,
          keyColumns: ["id"],
          partitioning: { field: p.layoutField, granularity: "day" },
        },
        fullLive: "`p`.`ds`.`t`",
        fullStaging: "`p`.`ds`.`s`",
        liveTypes: new Map(Object.entries(p.types)),
        onUnpruned: (u: { reason: string }) => {
          reported = u;
        },
      },
    );
    return reported?.reason;
  } finally {
    spy.mockRestore();
  }
}

describe("why a MERGE ran unpruned", () => {
  it("reports a layout mismatch when the table column cannot be pruned", async () => {
    expect(
      await reasonFor({
        tableField: "d",
        layoutField: "_syncedAt",
        types: { d: "DATE" },
        probeRows: 0,
      }),
    ).toBe("layout_mismatch");
  });

  it("reports too many partitions", async () => {
    expect(
      await reasonFor({
        tableField: "d",
        layoutField: "d",
        types: { d: "TIMESTAMP" },
        probeRows: 401,
      }),
    ).toBe("too_many_partitions");
  });

  it("reports no probe for a column it cannot prune, with a matching layout", async () => {
    expect(
      await reasonFor({
        tableField: "d",
        layoutField: "d",
        types: { d: "DATE" },
        probeRows: 0,
      }),
    ).toBe("no_probe");
  });

  it("reports nothing when the MERGE is pruned", async () => {
    expect(
      await reasonFor({
        tableField: "d",
        layoutField: "_syncedAt",
        types: { d: "TIMESTAMP" },
        probeRows: 3,
      }),
    ).toBeUndefined();
  });
});
