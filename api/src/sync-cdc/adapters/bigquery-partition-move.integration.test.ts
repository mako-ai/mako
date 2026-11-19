import { afterAll, describe, expect, it } from "vitest";
import { BigQuery } from "@google-cloud/bigquery";
import {
  buildLivePartitionFilter,
  buildLivePartitionProbeQuery,
  buildMergeStatement,
} from "./bigquery-sql";

/**
 * A key that changes partition, against real BigQuery: live row K on day D1,
 * staged row K on day D2, pruned MERGE → exactly one K, on D2.
 *
 * Gated. It creates two tables in a scratch dataset and drops them after.
 * Collected only with RUN_DB_INTEGRATION=1, and skipped unless
 * BQ_CDC_INTEGRATION_PROJECT and BQ_CDC_INTEGRATION_DATASET name a dataset
 * the application default credentials can write.
 *
 *   RUN_DB_INTEGRATION=1 BQ_CDC_INTEGRATION_PROJECT=p BQ_CDC_INTEGRATION_DATASET=d \
 *     pnpm --filter api exec vitest run --config vitest.destinations.config.ts \
 *     src/sync-cdc/adapters/bigquery-partition-move.integration.test.ts
 *
 * The in-memory version of this case is in bigquery-table-lease.test.ts.
 */

const projectId = process.env.BQ_CDC_INTEGRATION_PROJECT;
const dataset = process.env.BQ_CDC_INTEGRATION_DATASET;
const location = process.env.BQ_CDC_INTEGRATION_LOCATION;
const enabled = Boolean(projectId && dataset);

const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const liveName = `cdc_partition_move_live_${suffix}`;
const stagingName = `cdc_partition_move_stg_${suffix}`;

describe.skipIf(!enabled)("pruned MERGE moves a key across partitions", () => {
  const bq = new BigQuery({ projectId, location });
  const fq = (t: string) => `\`${projectId}\`.\`${dataset}\`.\`${t}\``;
  const run = async (sql: string) => {
    const [rows] = await bq.query({ query: sql, location });
    return rows as Array<Record<string, unknown>>;
  };

  afterAll(async () => {
    if (!enabled) return;
    await run(`DROP TABLE IF EXISTS ${fq(liveName)}`);
    await run(`DROP TABLE IF EXISTS ${fq(stagingName)}`);
  });

  it("leaves exactly one row for K, on D2", async () => {
    await run(
      `CREATE TABLE ${fq(liveName)} (id STRING, name STRING, date_created TIMESTAMP, _mako_source_ts TIMESTAMP) PARTITION BY TIMESTAMP_TRUNC(date_created, DAY)`,
    );
    await run(
      `INSERT INTO ${fq(liveName)} (id, name, date_created, _mako_source_ts) VALUES ('K', 'old', TIMESTAMP '2026-11-01 10:00:00 UTC', TIMESTAMP '2026-11-01 10:00:00 UTC'), ('Z', 'other', TIMESTAMP '2026-11-03 10:00:00 UTC', TIMESTAMP '2026-11-03 10:00:00 UTC')`,
    );
    await run(
      `CREATE TABLE ${fq(stagingName)} AS SELECT 'K' AS id, 'moved' AS name, TIMESTAMP '2026-11-05 10:00:00 UTC' AS date_created, TIMESTAMP '2026-11-06 10:00:00 UTC' AS _mako_source_ts`,
    );

    const liveTypes = new Map([
      ["id", "STRING"],
      ["name", "STRING"],
      ["date_created", "TIMESTAMP"],
      ["_mako_source_ts", "TIMESTAMP"],
    ]);
    const probe = await run(
      buildLivePartitionProbeQuery({
        fullLive: fq(liveName),
        fullStaging: fq(stagingName),
        keyColumns: ["id"],
        partitionField: "date_created",
        granularity: "day",
        liveTypes,
        limit: 400,
      }),
    );
    const buckets = probe.map(r => (r.p == null ? null : String(r.p)));
    expect(buckets).toEqual(["2026-11-01T00:00:00"]);
    const livePartitionFilter = buildLivePartitionFilter({
      partitionField: "date_created",
      granularity: "day",
      buckets,
    });
    await run(
      buildMergeStatement({
        fullLive: fq(liveName),
        fullStaging: fq(stagingName),
        columns: [...liveTypes.keys()],
        keyColumns: ["id"],
        stagingCols: new Set(liveTypes.keys()),
        liveTypes,
        livePartitionFilter,
      }),
    );

    const rows = await run(
      `SELECT name, FORMAT_TIMESTAMP('%F', date_created, 'UTC') AS day FROM ${fq(liveName)} WHERE id = 'K'`,
    );
    expect(rows).toEqual([{ name: "moved", day: "2026-11-05" }]);
  });
});
