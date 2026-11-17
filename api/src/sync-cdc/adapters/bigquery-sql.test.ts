import { describe, it, expect } from "vitest";
import {
  bigQueryStagingTableName,
  buildCreateLiveTableStatement,
  escId,
  sqlString,
} from "./bigquery-sql";
import type { CdcEntityLayout } from "./registry";

/**
 * The small statement helpers split out of the BigQuery adapter: live-table
 * DDL, string literals and staging table names.
 */
describe("bigquery-sql helpers", () => {
  const layout = {
    entity: "charges",
    tableName: "charges",
    keyColumns: ["id"],
    partitioning: { field: "_syncedAt", granularity: "day" },
    clustering: { fields: ["_dataSourceId", "id"] },
  } as unknown as CdcEntityLayout;

  it("creates the live table typed by the schema contract, partitioned and clustered", () => {
    expect(
      buildCreateLiveTableStatement({
        fullLive: "`p`.`d`.`charges`",
        columns: ["id", "amount", "_syncedAt", "unknown"],
        layout,
        entitySchema: {
          entity: "charges",
          fields: {
            id: { type: "string" },
            amount: { type: "number" },
          },
        } as never,
      }),
    ).toBe(
      "CREATE TABLE IF NOT EXISTS `p`.`d`.`charges` (`id` STRING, `amount` FLOAT64, `_syncedAt` TIMESTAMP, `unknown` STRING) PARTITION BY TIMESTAMP_TRUNC(`_syncedAt`, DAY) CLUSTER BY `_dataSourceId`, `id`",
    );
  });

  it("leaves the layout clauses empty for an unpartitioned table", () => {
    expect(
      buildCreateLiveTableStatement({
        fullLive: "`p`.`d`.`t`",
        columns: ["id"],
        layout: { tableName: "t", keyColumns: ["id"] } as never,
      }),
    ).toBe("CREATE TABLE IF NOT EXISTS `p`.`d`.`t` (`id` STRING)  ");
  });

  it("quotes string literals by doubling single quotes", () => {
    expect(sqlString("o'brien")).toBe("'o''brien'");
    expect(sqlString("")).toBe("''");
  });

  it("names staging tables per flow (last 8 alphanumerics) and suffix", () => {
    expect(bigQueryStagingTableName("charges", "65f0-abcd-1234-5678")).toBe(
      "charges__12345678__staging",
    );
    expect(bigQueryStagingTableName("t", "flow_1", "stg_x")).toBe(
      "t__flow1__stg_x",
    );
  });
});

describe("escId", () => {
  it("quotes a plain name", () => {
    expect(escId("leads")).toBe("`leads`");
  });

  it("escapes a backtick and a backslash, so neither ends the identifier", () => {
    expect(escId("a`b")).toBe("`a\\`b`");
    // A trailing backslash would otherwise escape the closing backtick.
    expect(escId("x\\")).toBe("`x\\\\`");
    expect(escId("x\\` OR 1=1 --")).toBe("`x\\\\\\` OR 1=1 --`");
  });
});
