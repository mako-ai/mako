import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  buildLivePartitionFilter,
  buildLivePartitionProbeQuery,
  buildMergeStatement,
  type BuildMergeStatementParams,
} from "./bigquery";

/**
 * Contract tests for the BigQuery CDC MERGE builder. This SQL is
 * correctness-critical (dedup, ordering guards, typed NULL inserts) and was
 * previously untested. Inline snapshots lock the exact statement; the explicit
 * assertions document the invariants that must hold for any future change.
 */

const FULL_LIVE = "`proj`.`ds`.live_users";
const FULL_STAGING = "`proj`.`mako_internal`.stg_users";

function params(
  overrides: Partial<BuildMergeStatementParams>,
): BuildMergeStatementParams {
  return {
    fullLive: FULL_LIVE,
    fullStaging: FULL_STAGING,
    columns: ["id", "name"],
    keyColumns: ["id"],
    stagingCols: new Set(["id", "name"]),
    liveTypes: new Map([
      ["id", "INT64"],
      ["name", "STRING"],
    ]),
    ...overrides,
  };
}

describe("buildMergeStatement", () => {
  it("dedups by key, casts to live types, and guards by _mako_source_ts", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["id", "name", "_mako_source_ts", "is_deleted"],
        stagingCols: new Set(["id", "name", "_mako_source_ts", "is_deleted"]),
        liveTypes: new Map([
          ["id", "INT64"],
          ["name", "STRING"],
          ["_mako_source_ts", "TIMESTAMP"],
          ["is_deleted", "BOOL"],
        ]),
      }),
    );

    expect(sql).toMatchInlineSnapshot(`
      "MERGE INTO \`proj\`.\`ds\`.live_users __live
      USING (SELECT SAFE_CAST(\`id\` AS INT64) AS \`id\`, SAFE_CAST(\`name\` AS STRING) AS \`name\`, SAFE_CAST(\`_mako_source_ts\` AS TIMESTAMP) AS \`_mako_source_ts\`, SAFE_CAST(\`is_deleted\` AS BOOL) AS \`is_deleted\` FROM \`proj\`.\`mako_internal\`.stg_users QUALIFY ROW_NUMBER() OVER (PARTITION BY \`id\` ORDER BY \`_mako_source_ts\` DESC) = 1) __stg
      ON __live.\`id\` = __stg.\`id\`
      WHEN MATCHED AND COALESCE(__stg.\`_mako_source_ts\`, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(__live.\`_mako_source_ts\`, TIMESTAMP('1970-01-01 00:00:00 UTC')) THEN UPDATE SET \`name\` = __stg.\`name\`, \`_mako_source_ts\` = __stg.\`_mako_source_ts\`, \`is_deleted\` = __stg.\`is_deleted\`
      WHEN NOT MATCHED THEN INSERT (\`id\`, \`name\`, \`_mako_source_ts\`, \`is_deleted\`) VALUES (__stg.\`id\`, __stg.\`name\`, __stg.\`_mako_source_ts\`, __stg.\`is_deleted\`)"
    `);

    // Invariants:
    expect(sql).toContain("MERGE INTO `proj`.`ds`.live_users __live");
    // dedup keeps newest per key
    expect(sql).toContain(
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY `id` ORDER BY `_mako_source_ts` DESC) = 1",
    );
    // join on key
    expect(sql).toContain("ON __live.`id` = __stg.`id`");
    // ordering guard prevents stale overwrites
    expect(sql).toContain(
      "WHEN MATCHED AND COALESCE(__stg.`_mako_source_ts`, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(__live.`_mako_source_ts`, TIMESTAMP('1970-01-01 00:00:00 UTC')) THEN UPDATE SET",
    );
    // key column is never in the UPDATE SET list (only in the ON clause)
    const setClause = sql.split("THEN UPDATE SET ")[1]?.split("\n")[0] ?? "";
    expect(setClause).not.toContain("`id`");
    // staging values cast to live types
    expect(sql).toContain("SAFE_CAST(`name` AS STRING) AS `name`");
    expect(sql).toContain("SAFE_CAST(`is_deleted` AS BOOL) AS `is_deleted`");
  });

  it("falls back to ORDER BY 1 and omits the guard when no ordering column exists", () => {
    const sql = buildMergeStatement(params({}));
    expect(sql).toContain(
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY `id` ORDER BY 1) = 1",
    );
    expect(sql).toContain("WHEN MATCHED THEN UPDATE SET `name` = __stg.`name`");
    expect(sql).not.toContain("COALESCE(__stg.");
  });

  it("omits WHEN MATCHED entirely when every column is a key", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["id"],
        stagingCols: new Set(["id"]),
        liveTypes: new Map([["id", "INT64"]]),
      }),
    );
    expect(sql).not.toContain("WHEN MATCHED");
    expect(sql).toContain(
      "WHEN NOT MATCHED THEN INSERT (`id`) VALUES (__stg.`id`)",
    );
  });

  it("inserts CAST(NULL AS <type>) for live columns missing from staging", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["id", "name", "extra"],
        stagingCols: new Set(["id", "name"]),
        liveTypes: new Map([
          ["id", "INT64"],
          ["name", "STRING"],
          ["extra", "FLOAT64"],
        ]),
      }),
    );
    // `extra` exists on live but not staging → typed NULL on insert, untouched on update
    expect(sql).toContain("CAST(NULL AS FLOAT64)");
    expect(sql).toContain("WHEN MATCHED THEN UPDATE SET `name` = __stg.`name`");
    expect(sql).not.toContain("`extra` = __stg.`extra`");
  });

  it("refreshes _syncedAt on update by including it in the UPDATE SET clause", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["id", "name", "_syncedAt"],
        stagingCols: new Set(["id", "name", "_syncedAt"]),
        liveTypes: new Map([
          ["id", "INT64"],
          ["name", "STRING"],
          ["_syncedAt", "TIMESTAMP"],
        ]),
      }),
    );
    // `_syncedAt` is stamped fresh on every materialized row (see withSyncedAt),
    // so an updated row must overwrite the live `_syncedAt`.
    const setClause = sql.split("THEN UPDATE SET ")[1]?.split("\n")[0] ?? "";
    expect(setClause).toContain("`_syncedAt` = __stg.`_syncedAt`");
    expect(sql).toContain("SAFE_CAST(`_syncedAt` AS TIMESTAMP) AS `_syncedAt`");
  });

  it("supports composite keys", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["tenant", "id", "name"],
        keyColumns: ["tenant", "id"],
        stagingCols: new Set(["tenant", "id", "name"]),
        liveTypes: new Map([
          ["tenant", "STRING"],
          ["id", "INT64"],
          ["name", "STRING"],
        ]),
      }),
    );
    expect(sql).toContain("PARTITION BY `tenant`, `id`");
    expect(sql).toContain(
      "ON __live.`tenant` = __stg.`tenant` AND __live.`id` = __stg.`id`",
    );
  });
});

/**
 * Close lead webhook, 17 Nov 2026: the webhook stamped date_updated
 * 09:28:27.865, the API returned .863 for the same version. The live row then
 * outranked every later backfill, so a damaged webhook write stayed pinned on
 * 3 CH-sellers leads. A full read (backfill or resync) wins within 1 s; a
 * webhook or poll write keeps the strict guard.
 */
describe("MERGE ordering guard: full-read skew tolerance", () => {
  const STORED = "2026-11-17 09:28:27.865";
  let instance: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    // The two BigQuery functions the guard uses, in DuckDB terms.
    await conn.run("CREATE MACRO TIMESTAMP_SUB(t, i) AS t - i");
    await conn.run("CREATE MACRO bq_timestamp(s) AS CAST(s AS TIMESTAMPTZ)");
  });
  afterAll(() => {
    conn.closeSync();
    instance.closeSync();
  });

  const guardOf = (fullRead: boolean | undefined) => {
    const sql = buildMergeStatement(
      params({
        columns: ["id", "name", "_mako_source_ts"],
        stagingCols: new Set(["id", "name", "_mako_source_ts"]),
        liveTypes: new Map([
          ["id", "INT64"],
          ["name", "STRING"],
          ["_mako_source_ts", "TIMESTAMP"],
        ]),
        fullRead,
      }),
    );
    return sql.split("WHEN MATCHED AND ")[1]!.split(" THEN UPDATE")[0]!;
  };

  /** Does a staged row stamped `incoming` overwrite a live row stamped `stored`? */
  const wins = async (
    fullRead: boolean | undefined,
    incoming: string,
    stored: string,
  ) => {
    const predicate = guardOf(fullRead)
      .replaceAll("__stg.`_mako_source_ts`", `TIMESTAMPTZ '${incoming}+00'`)
      .replaceAll("__live.`_mako_source_ts`", `TIMESTAMPTZ '${stored}+00'`)
      .replaceAll("TIMESTAMP('", "bq_timestamp('");
    const rows = (
      await conn.runAndReadAll(`SELECT (${predicate}) AS wins`)
    ).getRowObjects();
    return rows[0]!.wins;
  };

  it("a backfill row 2 ms behind a webhook-written row overwrites it", async () => {
    expect(await wins(true, "2026-11-17 09:28:27.863", STORED)).toBe(true);
  });

  it("a webhook or poll row 2 ms behind does not", async () => {
    expect(await wins(false, "2026-11-17 09:28:27.863", STORED)).toBe(false);
    expect(await wins(undefined, "2026-11-17 09:28:27.863", STORED)).toBe(
      false,
    );
  });

  it("a backfill row more than 1 s behind still loses", async () => {
    expect(await wins(true, "2026-11-17 09:28:26.864", STORED)).toBe(false);
    expect(await wins(true, "2026-11-17 09:28:26.865", STORED)).toBe(true);
  });

  it("newer rows win either way", async () => {
    expect(await wins(true, "2026-11-17 09:28:28.000", STORED)).toBe(true);
    expect(await wins(false, "2026-11-17 09:28:28.000", STORED)).toBe(true);
  });

  it("only a full read shifts the live side by 1 s", () => {
    expect(guardOf(true)).toBe(
      "COALESCE(__stg.`_mako_source_ts`, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= TIMESTAMP_SUB(COALESCE(__live.`_mako_source_ts`, TIMESTAMP('1970-01-01 00:00:00 UTC')), INTERVAL 1 SECOND)",
    );
    expect(guardOf(false)).toBe(
      "COALESCE(__stg.`_mako_source_ts`, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(__live.`_mako_source_ts`, TIMESTAMP('1970-01-01 00:00:00 UTC'))",
    );
  });

  it("keeps the absent-column handling under a full read", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["id", "name", "_mako_source_ts"],
        stagingCols: new Set([
          "id",
          "name",
          "_mako_source_ts",
          "_mako_absent_cols",
        ]),
        fullRead: true,
      }),
    );
    expect(sql).toContain(
      "`name` = IF(STRPOS(IFNULL(__stg.`_mako_absent_cols`, ''), ',name,') > 0, __live.`name`, __stg.`name`)",
    );
    expect(sql).toContain("INTERVAL 1 SECOND");
  });

  it("leaves the ingest-seq guard strict", () => {
    const sql = buildMergeStatement(
      params({
        columns: ["id", "name", "_mako_ingest_seq"],
        stagingCols: new Set(["id", "name", "_mako_ingest_seq"]),
        fullRead: true,
      }),
    );
    expect(sql).toContain(
      "COALESCE(__stg.`_mako_ingest_seq`, -1) >= COALESCE(__live.`_mako_ingest_seq`, -1)",
    );
    expect(sql).not.toContain("INTERVAL");
  });
});

describe("MERGE partition pruning", () => {
  it("ANDs the live partition filter into the ON clause, leaving the rest intact", () => {
    const base = buildMergeStatement(params({}));
    const pruned = buildMergeStatement(
      params({ livePartitionFilter: "__live.`d` IS NULL" }),
    );
    expect(pruned).toContain(
      "ON __live.`id` = __stg.`id` AND (__live.`d` IS NULL)\n",
    );
    expect(pruned.replace(" AND (__live.`d` IS NULL)", "")).toBe(base);
  });

  it("probes only key + partition columns, casting staging keys like the MERGE", () => {
    const sql = buildLivePartitionProbeQuery({
      fullLive: FULL_LIVE,
      fullStaging: FULL_STAGING,
      keyColumns: ["id"],
      partitionField: "date_created",
      granularity: "day",
      liveTypes: new Map([["id", "STRING"]]),
      limit: 400,
    });
    expect(sql).toBe(
      "SELECT DISTINCT FORMAT_TIMESTAMP('%FT%T', TIMESTAMP_TRUNC(__live.`date_created`, DAY), 'UTC') AS p " +
        "FROM `proj`.`ds`.live_users __live JOIN (SELECT DISTINCT SAFE_CAST(`id` AS STRING) AS `id` FROM `proj`.`mako_internal`.stg_users) __stg ON __live.`id` = __stg.`id` " +
        "LIMIT 401",
    );
  });

  it("merges adjacent day buckets into half-open ranges and keeps the NULL partition", () => {
    expect(
      buildLivePartitionFilter({
        partitionField: "date_created",
        granularity: "day",
        buckets: [
          "2026-10-21T00:00:00",
          "2025-05-22T00:00:00",
          "2026-10-20T00:00:00",
          null,
          "2026-10-21T00:00:00",
        ],
      }),
    ).toBe(
      "(__live.`date_created` >= TIMESTAMP '2025-05-22 00:00:00 UTC' AND __live.`date_created` < TIMESTAMP '2025-05-23 00:00:00 UTC')" +
        " OR (__live.`date_created` >= TIMESTAMP '2026-10-20 00:00:00 UTC' AND __live.`date_created` < TIMESTAMP '2026-10-22 00:00:00 UTC')" +
        " OR __live.`date_created` IS NULL",
    );
  });

  it("handles month and hour granularity boundaries", () => {
    expect(
      buildLivePartitionFilter({
        partitionField: "d",
        granularity: "month",
        buckets: ["2025-12-01T00:00:00"],
      }),
    ).toBe(
      "(__live.`d` >= TIMESTAMP '2025-12-01 00:00:00 UTC' AND __live.`d` < TIMESTAMP '2026-01-01 00:00:00 UTC')",
    );
    expect(
      buildLivePartitionFilter({
        partitionField: "d",
        granularity: "hour",
        buckets: ["2026-10-21T23:00:00"],
      }),
    ).toBe(
      "(__live.`d` >= TIMESTAMP '2026-10-21 23:00:00 UTC' AND __live.`d` < TIMESTAMP '2026-10-22 00:00:00 UTC')",
    );
  });

  it("returns FALSE when no staged key exists in live (all rows insert)", () => {
    expect(buildLivePartitionFilter({ partitionField: "d", buckets: [] })).toBe(
      "FALSE",
    );
  });

  it("gives up (undefined → unfiltered MERGE) on an unparseable bucket", () => {
    expect(
      buildLivePartitionFilter({ partitionField: "d", buckets: ["garbage"] }),
    ).toBeUndefined();
  });
});
