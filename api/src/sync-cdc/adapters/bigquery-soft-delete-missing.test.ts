import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseConnectionService } from "../../services/database-connection.service";
import { currentQueryLabels } from "../../services/bigquery-labels";
import { BigQueryDestinationAdapter } from "./bigquery";
import { buildCdcEntityLayout } from "./registry";

/**
 * The BigQuery side of the soft-delete sweep: the SQL it sends, the label
 * its job carries, and the row count it reads back.
 */

const layout = buildCdcEntityLayout({
  entity: "users",
  tableName: "users",
  deleteMode: "soft",
});

const sent: Array<{ sql: string; labels: Record<string, string | undefined> }> =
  [];
let spy: ReturnType<typeof vi.spyOn>;

function makeAdapter() {
  const adapter = new BigQueryDestinationAdapter({
    destinationDatabaseId: "db",
    workspaceId: "ws",
    tableDestination: {
      connectionId: "conn",
      schema: "ds",
      tableName: "users",
    },
  });
  (adapter as unknown as { _resolvedClient: unknown })._resolvedClient = {
    bq: {
      dataset: () => ({
        table: () => ({
          getMetadata: async () => [{ clustering: { fields: ["id"] } }],
        }),
      }),
      job: () => ({
        getMetadata: async () => [
          {
            statistics: {
              query: { totalBytesBilled: "10485760", numDmlAffectedRows: "2" },
            },
          },
        ],
      }),
    },
    projectId: "proj",
    dataset: "ds",
    destination: { type: "bigquery", workspaceId: "ws" },
    datasetLocation: "EU",
  };
  return adapter;
}

beforeEach(() => {
  process.env.CDC_TABLE_WRITE_LEASE = "off";
  sent.length = 0;
  spy = vi
    .spyOn(databaseConnectionService, "executeQuery")
    .mockImplementation((async (_db: unknown, sql: unknown, opts: any) => {
      sent.push({ sql: String(sql), labels: { ...currentQueryLabels() } });
      opts?.onJobStarted?.({ jobId: "job1", location: "EU" });
      if (String(sql).startsWith("SELECT")) {
        return { success: true, data: [{ live: "5", missing: "2" }] };
      }
      return { success: true, data: [] };
    }) as never);
});

afterEach(() => {
  spy.mockRestore();
  delete process.env.CDC_TABLE_WRITE_LEASE;
});

describe("BigQuery soft-delete of rows missing from a listing", () => {
  it("counts live rows and the ones outside the listing in one SELECT", async () => {
    const out = await makeAdapter().countLiveRows(layout, "id", ["a", "b"]);
    expect(out).toEqual({ live: 5, missing: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0].sql).toContain("`is_deleted` IS NOT TRUE");
    expect(sent[0].sql).toContain("NOT IN UNNEST(['a', 'b'])");
  });

  it("sends one UPDATE that never touches a deleted row, under the soft_delete_missing label", async () => {
    const out = await makeAdapter().softDeleteRowsNotIn(layout, "id", [
      "a",
      "it's",
      "x\\y",
    ]);
    expect(out.marked).toBe(2);
    expect(sent).toHaveLength(1);
    const { sql, labels } = sent[0];
    expect(sql).toMatch(/^UPDATE `proj`\.`ds`\.`users`/);
    expect(sql).toContain("`is_deleted` = TRUE");
    expect(sql).toContain("`deleted_at` = CURRENT_TIMESTAMP()");
    expect(sql).toContain("`_mako_deleted_at` = CURRENT_TIMESTAMP()");
    expect(sql).toContain("`is_deleted` IS NOT TRUE");
    expect(sql).toContain(
      "CAST(`id` AS STRING) NOT IN UNNEST(['a', 'it\\'s', 'x\\\\y'])",
    );
    expect(labels.mako_merge_path).toBe("soft_delete_missing");
  });
});
