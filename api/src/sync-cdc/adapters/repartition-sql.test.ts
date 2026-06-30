import { describe, it, expect } from "vitest";
import {
  bigQueryPartitionClause,
  bigQueryClusterClause,
  buildBigQueryRepartitionStatements,
} from "./bigquery";
import {
  clickHousePartitionClause,
  buildClickHouseRepartitionStatements,
} from "./clickhouse";
import type { CdcEntityLayout } from "./registry";

/**
 * Contract tests for the in-place repartition SQL (copy + swap). This SQL
 * rewrites a live table's partition/clustering without re-fetching from the
 * source, so its exact shape is correctness-critical. The gated ClickHouse
 * integration test (`clickhouse/repartition.integration.test.ts`) executes the
 * same builder against a real engine; these run offline in CI.
 */

function layout(overrides: Partial<CdcEntityLayout> = {}): CdcEntityLayout {
  return {
    entity: "leads",
    tableName: "close_leads",
    keyColumns: ["id"],
    partitioning: { type: "time", field: "_syncedAt", granularity: "day" },
    clustering: { fields: ["_dataSourceId", "id"] },
    ...overrides,
  };
}

describe("ClickHouse repartition SQL", () => {
  it("maps granularity to the right partition function", () => {
    expect(clickHousePartitionClause(layout({ partitioning: undefined }))).toBe(
      "",
    );
    expect(
      clickHousePartitionClause(
        layout({ partitioning: { field: "_syncedAt", granularity: "day" } }),
      ),
    ).toBe("PARTITION BY toYYYYMMDD(`_syncedAt`)");
    expect(
      clickHousePartitionClause(
        layout({ partitioning: { field: "date_created", granularity: "hour" } }),
      ),
    ).toBe("PARTITION BY toStartOfHour(`date_created`)");
    expect(
      clickHousePartitionClause(
        layout({ partitioning: { field: "_syncedAt", granularity: "month" } }),
      ),
    ).toBe("PARTITION BY toYYYYMM(`_syncedAt`)");
    expect(
      clickHousePartitionClause(
        layout({ partitioning: { field: "_syncedAt", granularity: "year" } }),
      ),
    ).toBe("PARTITION BY toYear(`_syncedAt`)");
  });

  it("builds create/copy/exchange that preserve columns + dedupe by source_ts", () => {
    const stmts = buildClickHouseRepartitionStatements({
      fullLive: "`mako_cdc`.`close_leads`",
      fullTmp: "`mako_cdc`.`close_leads__repart_x`",
      partitionClause: clickHousePartitionClause(layout()),
      orderByColumns: ["id"],
    });
    // new table copies the live structure but overrides engine + partition + sort
    expect(stmts.createTmp).toBe(
      "CREATE TABLE `mako_cdc`.`close_leads__repart_x` AS `mako_cdc`.`close_leads` " +
        "ENGINE = ReplacingMergeTree(`_mako_source_ts`) " +
        "PARTITION BY toYYYYMMDD(`_syncedAt`) ORDER BY (`id`)",
    );
    // full-column copy (no projection) so existing data is preserved exactly
    expect(stmts.copy).toBe(
      "INSERT INTO `mako_cdc`.`close_leads__repart_x` SELECT * FROM `mako_cdc`.`close_leads`",
    );
    // atomic swap
    expect(stmts.exchange).toBe(
      "EXCHANGE TABLES `mako_cdc`.`close_leads` AND `mako_cdc`.`close_leads__repart_x`",
    );
  });

  it("supports composite sort keys", () => {
    const stmts = buildClickHouseRepartitionStatements({
      fullLive: "`d`.`t`",
      fullTmp: "`d`.`t2`",
      partitionClause: "",
      orderByColumns: ["tenant", "id"],
    });
    expect(stmts.createTmp).toContain("ORDER BY (`tenant`, `id`)");
  });
});

describe("BigQuery repartition SQL", () => {
  it("builds partition + cluster clauses", () => {
    expect(bigQueryPartitionClause(layout({ partitioning: undefined }))).toBe(
      "",
    );
    expect(bigQueryPartitionClause(layout())).toBe(
      "PARTITION BY TIMESTAMP_TRUNC(`_syncedAt`, DAY)",
    );
    expect(
      bigQueryPartitionClause(
        layout({ partitioning: { field: "date_created", granularity: "month" } }),
      ),
    ).toBe("PARTITION BY TIMESTAMP_TRUNC(`date_created`, MONTH)");
    expect(bigQueryClusterClause(layout({ clustering: undefined }))).toBe("");
    expect(bigQueryClusterClause(layout())).toBe(
      "CLUSTER BY `_dataSourceId`, `id`",
    );
  });

  it("builds CREATE OR REPLACE + drop + rename swap", () => {
    const stmts = buildBigQueryRepartitionStatements({
      fullLive: "`proj`.`ds`.`close_leads`",
      fullTmp: "`proj`.`ds`.`close_leads__repart_x`",
      liveName: "close_leads",
      layout: layout(),
    });
    expect(stmts.createTmp).toBe(
      "CREATE OR REPLACE TABLE `proj`.`ds`.`close_leads__repart_x` " +
        "PARTITION BY TIMESTAMP_TRUNC(`_syncedAt`, DAY) " +
        "CLUSTER BY `_dataSourceId`, `id` AS SELECT * FROM `proj`.`ds`.`close_leads`",
    );
    expect(stmts.dropLive).toBe("DROP TABLE `proj`.`ds`.`close_leads`");
    expect(stmts.rename).toBe(
      "ALTER TABLE `proj`.`ds`.`close_leads__repart_x` RENAME TO `close_leads`",
    );
  });

  it("omits clauses when no partitioning/clustering configured", () => {
    const stmts = buildBigQueryRepartitionStatements({
      fullLive: "`p`.`d`.`t`",
      fullTmp: "`p`.`d`.`t2`",
      liveName: "t",
      layout: layout({ partitioning: undefined, clustering: undefined }),
    });
    expect(stmts.createTmp).toBe(
      "CREATE OR REPLACE TABLE `p`.`d`.`t2` AS SELECT * FROM `p`.`d`.`t`",
    );
  });
});
