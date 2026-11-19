import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  MERGE_PRUNE_MAX_PARTITIONS,
  buildLivePartitionFilter,
  buildLivePartitionProbeQuery,
  buildMergeStatement,
} from "./bigquery";

/**
 * One live row per key after the CDC MERGE (append_dedup).
 *
 * The statements are the real ones: buildLivePartitionProbeQuery, then
 * buildLivePartitionFilter, then buildMergeStatement, as
 * BigQueryDestinationAdapter.mergeStagingToLive runs them with
 * prunePartitions on. DuckDB executes them after a literal BigQuery → DuckDB
 * rewrite (identifiers, casts, timestamp literals). DuckDB, like BigQuery,
 * has no key constraint on the live table and lets two transactions that
 * only append both commit.
 *
 * Production, 19 Nov 2026: `ch_close_sellers.email_activities` got 2 copies
 * of one email. A poll MERGE (11:03:47–11:03:58 UTC) and a webhook MERGE
 * (11:03:57–11:03:58 UTC) of the same flow ran at once. Neither saw the
 * other's row, so both took WHEN NOT MATCHED.
 */

const LIVE = "`live`";
const STAGING = "`stg`";
const KEY = ["id"];
const COLUMNS = ["id", "name", "date_created", "_mako_source_ts"];
const LIVE_TYPES = new Map([
  ["id", "STRING"],
  ["name", "STRING"],
  ["date_created", "TIMESTAMP"],
  ["_mako_source_ts", "TIMESTAMP"],
]);

type StagedRow = {
  id: string;
  name: string;
  date_created: string;
  _mako_source_ts: string;
};

/** BigQuery SQL from the builders → the same statement in DuckDB terms. */
function toDuckDb(sql: string): string {
  return sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\bSAFE_CAST\(/g, "TRY_CAST(")
    .replace(/ AS STRING\)/g, " AS VARCHAR)")
    .replace(/ AS INT64\)/g, " AS BIGINT)")
    .replace(/ AS TIMESTAMP\)/g, " AS TIMESTAMPTZ)")
    .replace(/TIMESTAMP '([^']+) UTC'/g, "TIMESTAMPTZ '$1+00'")
    .replace(/TIMESTAMP\('([^']+) UTC'\)/g, "TIMESTAMPTZ '$1+00'")
    .replace(
      /TIMESTAMP_TRUNC\(([^,]+), (HOUR|DAY|MONTH|YEAR)\)/g,
      (_m, col: string, gran: string) =>
        `date_trunc('${gran.toLowerCase()}', ${col})`,
    )
    .replace(
      /FORMAT_TIMESTAMP\('%FT%T', (.+?), 'UTC'\) AS p/g,
      "strftime($1, '%Y-%m-%dT%H:%M:%S') AS p",
    );
}

let instance: DuckDBInstance;

beforeEach(async () => {
  instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("SET TimeZone = 'UTC'");
  await conn.run(
    'CREATE TABLE live (id VARCHAR, name VARCHAR, date_created TIMESTAMPTZ, "_mako_source_ts" TIMESTAMPTZ)',
  );
  conn.closeSync();
});

afterEach(() => {
  instance.closeSync();
});

async function connect(): Promise<DuckDBConnection> {
  const conn = await instance.connect();
  await conn.run("SET TimeZone = 'UTC'");
  return conn;
}

/** Load a batch into its own staging table, as one writer's flush does. */
async function stage(
  conn: DuckDBConnection,
  table: string,
  rows: StagedRow[],
): Promise<void> {
  await conn.run(
    `CREATE OR REPLACE TABLE ${table} (id VARCHAR, name VARCHAR, date_created VARCHAR, "_mako_source_ts" VARCHAR)`,
  );
  for (const r of rows) {
    await conn.run(
      `INSERT INTO ${table} VALUES ('${r.id}', '${r.name}', '${r.date_created}', '${r._mako_source_ts}')`,
    );
  }
}

/**
 * One writer's materialization: probe the live partitions of the staged
 * keys, then MERGE with that filter in the ON clause. Runs on `conn` inside
 * whatever transaction the caller opened.
 */
async function probeAndMerge(
  conn: DuckDBConnection,
  stagingTable: string,
  opts: { prune: boolean },
): Promise<void> {
  const fullStaging = STAGING.replace("stg", stagingTable);
  let livePartitionFilter: string | undefined;
  if (opts.prune) {
    const probe = buildLivePartitionProbeQuery({
      fullLive: LIVE,
      fullStaging,
      keyColumns: KEY,
      partitionField: "date_created",
      granularity: "day",
      liveTypes: LIVE_TYPES,
      limit: MERGE_PRUNE_MAX_PARTITIONS,
    });
    const buckets = (await conn.runAndReadAll(toDuckDb(probe)))
      .getRowObjects()
      .map(r => (r.p == null ? null : String(r.p)));
    livePartitionFilter = buildLivePartitionFilter({
      partitionField: "date_created",
      granularity: "day",
      buckets,
    });
    expect(livePartitionFilter).toBeDefined();
  }
  const merge = buildMergeStatement({
    fullLive: LIVE,
    fullStaging,
    columns: COLUMNS,
    keyColumns: KEY,
    stagingCols: new Set(COLUMNS),
    liveTypes: LIVE_TYPES,
    livePartitionFilter,
  });
  await conn.run(toDuckDb(merge));
}

async function liveRows(): Promise<Record<string, unknown>[]> {
  const conn = await connect();
  const rows = (
    await conn.runAndReadAll(
      "SELECT id, name, strftime(date_created, '%Y-%m-%d') AS day FROM live ORDER BY id, name",
    )
  ).getRowObjects();
  conn.closeSync();
  return rows;
}

async function duplicateKeys(): Promise<number> {
  const conn = await connect();
  const rows = (
    await conn.runAndReadAll(
      "SELECT COUNT(*) - COUNT(DISTINCT id) AS d FROM live",
    )
  ).getRowObjects();
  conn.closeSync();
  return Number(rows[0]!.d);
}

const V1: StagedRow = {
  id: "acti_1",
  name: "v1",
  date_created: "2026-10-09 03:42:08",
  _mako_source_ts: "2026-10-09 03:42:17",
};

describe("CDC MERGE keeps one live row per key", () => {
  for (const prune of [true, false]) {
    const label = prune ? "partition-pruned" : "unfiltered";

    it(`a row whose partition value changes between batches stays one row (${label})`, async () => {
      const conn = await connect();
      await stage(conn, "stg_1", [V1]);
      await probeAndMerge(conn, "stg_1", { prune });
      // Batch 2 moves the row to another day partition.
      await stage(conn, "stg_2", [
        {
          ...V1,
          name: "v2",
          date_created: "2026-11-19 11:03:08",
          _mako_source_ts: "2026-11-19 11:03:44",
        },
      ]);
      await probeAndMerge(conn, "stg_2", { prune });
      conn.closeSync();

      expect(await liveRows()).toEqual([
        { id: "acti_1", name: "v2", day: "2026-11-19" },
      ]);
    });

    it(`two writers one after the other land one row (${label})`, async () => {
      const poll = await connect();
      const webhook = await connect();
      await stage(poll, "stg_poll", [V1]);
      await stage(webhook, "stg_webhook", [{ ...V1, name: "webhook" }]);

      await poll.run("BEGIN TRANSACTION");
      await probeAndMerge(poll, "stg_poll", { prune });
      await poll.run("COMMIT");
      await webhook.run("BEGIN TRANSACTION");
      await probeAndMerge(webhook, "stg_webhook", { prune });
      await webhook.run("COMMIT");
      poll.closeSync();
      webhook.closeSync();

      expect(await duplicateKeys()).toBe(0);
    });

    // Expected to fail until writes to one live table are serialized (the
    // per-table write lease, coming in its own PR). Both writers probe and
    // MERGE before either commits, so each takes WHEN NOT MATCHED and the
    // key lands twice, as on ch_close_sellers.email_activities on
    // 19 Nov 2026. When the lease lands, route both writers through it and
    // turn this `it.fails` into `it`.
    it.fails(`two writers that overlap land one row (${label})`, async () => {
      const poll = await connect();
      const webhook = await connect();
      await stage(poll, "stg_poll", [V1]);
      await stage(webhook, "stg_webhook", [{ ...V1, name: "webhook" }]);

      await poll.run("BEGIN TRANSACTION");
      await webhook.run("BEGIN TRANSACTION");
      await probeAndMerge(poll, "stg_poll", { prune });
      await probeAndMerge(webhook, "stg_webhook", { prune });
      await poll.run("COMMIT");
      await webhook.run("COMMIT");
      poll.closeSync();
      webhook.closeSync();

      expect(await duplicateKeys()).toBe(0);
    });
  }
});

/**
 * A composite key with a NULL part. Meta ads `ads_insights_region` keys on
 * date_start, account_id, ad_id, region, and Meta sends zero-delivery days
 * with no region. With `=` in the ON clause the NULL never matched, so each
 * daily sync inserted the row again: 106,281 extra rows in 8 Meta tables on
 * 19 Nov 2026. The probe joins on the same keys, so it runs here too.
 */
describe("CDC MERGE matches a NULL part of a composite key", () => {
  const NK_KEY = ["ad_id", "region"];
  const NK_COLUMNS = ["ad_id", "region", "spend", "_syncedAt"];
  const NK_TYPES = new Map([
    ["ad_id", "STRING"],
    ["region", "STRING"],
    ["spend", "STRING"],
    ["_syncedAt", "TIMESTAMP"],
  ]);

  async function stageAndMerge(
    conn: DuckDBConnection,
    rows: Array<{ region: string | null; spend: string; syncedAt: string }>,
    prune: boolean,
  ): Promise<void> {
    await conn.run(
      'CREATE OR REPLACE TABLE nk_stg (ad_id VARCHAR, region VARCHAR, spend VARCHAR, "_syncedAt" VARCHAR)',
    );
    for (const r of rows) {
      const region = r.region === null ? "NULL" : `'${r.region}'`;
      await conn.run(
        `INSERT INTO nk_stg VALUES ('ad_1', ${region}, '${r.spend}', '${r.syncedAt}')`,
      );
    }
    let livePartitionFilter: string | undefined;
    if (prune) {
      const probe = buildLivePartitionProbeQuery({
        fullLive: "`nk_live`",
        fullStaging: "`nk_stg`",
        keyColumns: NK_KEY,
        partitionField: "_syncedAt",
        granularity: "day",
        liveTypes: NK_TYPES,
        limit: MERGE_PRUNE_MAX_PARTITIONS,
      });
      const buckets = (await conn.runAndReadAll(toDuckDb(probe)))
        .getRowObjects()
        .map(r => (r.p == null ? null : String(r.p)));
      livePartitionFilter = buildLivePartitionFilter({
        partitionField: "_syncedAt",
        granularity: "day",
        buckets,
      });
    }
    const merge = buildMergeStatement({
      fullLive: "`nk_live`",
      fullStaging: "`nk_stg`",
      columns: NK_COLUMNS,
      keyColumns: NK_KEY,
      stagingCols: new Set(NK_COLUMNS),
      liveTypes: NK_TYPES,
      livePartitionFilter,
    });
    await conn.run(toDuckDb(merge));
  }

  for (const prune of [true, false]) {
    const label = prune ? "partition-pruned" : "unfiltered";

    it(`the same NULL-region row synced twice stays one row (${label})`, async () => {
      const conn = await connect();
      await conn.run(
        'CREATE TABLE nk_live (ad_id VARCHAR, region VARCHAR, spend VARCHAR, "_syncedAt" TIMESTAMPTZ)',
      );
      await stageAndMerge(
        conn,
        [
          { region: null, spend: "0", syncedAt: "2026-11-18 12:26:06" },
          { region: "Paris", spend: "4.2", syncedAt: "2026-11-18 12:26:06" },
        ],
        prune,
      );
      await stageAndMerge(
        conn,
        [
          { region: null, spend: "0.5", syncedAt: "2026-11-19 06:45:57" },
          { region: "Paris", spend: "4.3", syncedAt: "2026-11-19 06:45:57" },
        ],
        prune,
      );
      const rows = (
        await conn.runAndReadAll(
          "SELECT region, spend FROM nk_live ORDER BY region NULLS FIRST",
        )
      ).getRowObjects();
      conn.closeSync();

      expect(rows).toEqual([
        { region: null, spend: "0.5" },
        { region: "Paris", spend: "4.3" },
      ]);
    });
  }
});
