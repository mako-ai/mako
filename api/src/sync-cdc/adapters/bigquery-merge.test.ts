import { describe, it, expect } from "vitest";
import {
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
