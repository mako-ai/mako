/* eslint-disable no-console */
import assert from "node:assert/strict";
import {
  buildMergeStatement,
  type BuildMergeStatementParams,
} from "./bigquery";

function make(
  overrides: Partial<BuildMergeStatementParams> = {},
): BuildMergeStatementParams {
  return {
    fullLive: "`proj`.`ds`.`live`",
    fullStaging: "`proj`.`ds`.`staging`",
    columns: ["id", "name", "date_created", "date_updated", "_mako_source_ts"],
    keyColumns: ["id"],
    stagingCols: new Set(["id", "name", "date_updated"]),
    liveTypes: new Map([
      ["id", "STRING"],
      ["name", "STRING"],
      ["date_created", "TIMESTAMP"],
      ["date_updated", "TIMESTAMP"],
      ["_mako_source_ts", "TIMESTAMP"],
    ]),
    ...overrides,
  };
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 1. Basic shape — missing-in-staging cols absent from UPDATE SET
// ---------------------------------------------------------------------------

function testBasicShape() {
  console.log("  basic shape: UPDATE SET excludes missing-in-staging cols");

  const sql = buildMergeStatement(make());

  assert.match(sql, /MERGE INTO/);
  assert.match(sql, /USING/);
  assert.match(sql, /ON/);

  // UPDATE SET must include name and date_updated (in staging, non-key)
  assert.match(sql, /UPDATE SET.*`name`\s*=\s*__stg\.`name`/);
  assert.match(sql, /UPDATE SET.*`date_updated`\s*=\s*__stg\.`date_updated`/);

  // UPDATE SET must NOT include date_created or _mako_source_ts (not in staging)
  const updateSetMatch = sql.match(
    /WHEN MATCHED.*?THEN UPDATE SET (.+?)(?:\nWHEN|\n?$)/s,
  );
  assert.ok(updateSetMatch, "should have WHEN MATCHED clause");
  const updateSetBody = updateSetMatch?.[1] ?? "";
  assert.ok(
    !updateSetBody.includes("`date_created`"),
    "date_created must not be in UPDATE SET",
  );
  assert.ok(
    !updateSetBody.includes("`_mako_source_ts`"),
    "_mako_source_ts must not be in UPDATE SET",
  );

  // INSERT covers all live cols
  assert.match(
    sql,
    /INSERT \(`id`, `name`, `date_created`, `date_updated`, `_mako_source_ts`\)/,
  );
  // Missing-from-staging cols use CAST(NULL AS ...)
  assert.match(sql, /CAST\(NULL AS TIMESTAMP\)/);
}

// ---------------------------------------------------------------------------
// 2. Production repro — parameterised per Close entity
// ---------------------------------------------------------------------------

function makeProductionCase(
  liveCols: string[],
  stagingCols: string[],
  keyCol = "id",
) {
  const liveTypes = new Map<string, string>();
  for (const c of liveCols) {
    if (
      c.includes("date") ||
      c === "_mako_source_ts" ||
      c === "_syncedAt" ||
      c === "starts_at" ||
      c === "ends_at" ||
      c === "activity_at"
    ) {
      liveTypes.set(c, "TIMESTAMP");
    } else if (c === "_mako_ingest_seq") {
      liveTypes.set(c, "INT64");
    } else if (
      c === "custom" ||
      c === "contacts" ||
      c === "opportunities" ||
      c === "tasks" ||
      c === "primary_email" ||
      c === "primary_phone" ||
      c === "integration_links"
    ) {
      liveTypes.set(c, "JSON");
    } else {
      liveTypes.set(c, "STRING");
    }
  }

  return make({
    columns: liveCols,
    keyColumns: [keyCol],
    stagingCols: new Set(stagingCols),
    liveTypes,
  });
}

function assertNoneInUpdateSet(sql: string, forbidden: string[]) {
  const updateSetMatch = sql.match(
    /WHEN MATCHED.*?THEN UPDATE SET (.+?)(?:\nWHEN|\n?$)/s,
  );
  if (!updateSetMatch) return;
  const body = updateSetMatch[1];
  for (const col of forbidden) {
    assert.ok(!body.includes(`\`${col}\``), `${col} must not be in UPDATE SET`);
  }
}

function assertAllInInsert(sql: string, expected: string[]) {
  for (const col of expected) {
    assert.ok(
      sql.includes(`CAST(NULL AS`) || sql.includes(`\`${col}\``),
      `${col} must appear in INSERT`,
    );
  }
}

function testLeadsProduction() {
  console.log("  production repro: leads");

  const droppedFields = [
    "date_created",
    "date_updated",
    "_syncedAt",
    "_mako_source_ts",
    "custom",
    "integration_links",
    "html_url",
    "contacts",
    "opportunities",
    "tasks",
    "primary_email",
    "primary_phone",
  ];
  const preserved = [
    "id",
    "name",
    "display_name",
    "status_id",
    "status_label",
    "source",
    "addresses",
    "contact_ids",
    "_mako_ingest_seq",
  ];

  const params = makeProductionCase(
    [...preserved, ...droppedFields],
    preserved,
  );
  const sql = buildMergeStatement(params);

  assertNoneInUpdateSet(sql, droppedFields);
  assertAllInInsert(sql, droppedFields);
}

function testOpportunitiesProduction() {
  console.log("  production repro: opportunities");

  const droppedFields = [
    "date_created",
    "date_updated",
    "_syncedAt",
    "_mako_source_ts",
    "custom",
    "integration_links",
    "pipeline_name",
    "status_display_name",
    "stall_status",
  ];
  const preserved = [
    "id",
    "lead_id",
    "status_id",
    "status_label",
    "pipeline_id",
    "_mako_ingest_seq",
  ];

  const params = makeProductionCase(
    [...preserved, ...droppedFields],
    preserved,
  );
  const sql = buildMergeStatement(params);

  assertNoneInUpdateSet(sql, droppedFields);
  assertAllInInsert(sql, droppedFields);
}

function testMeetingsProduction() {
  console.log("  production repro: meetings");

  const droppedFields = [
    "date_created",
    "date_updated",
    "_syncedAt",
    "_mako_source_ts",
    "starts_at",
    "ends_at",
    "activity_at",
    "outcome_id",
  ];
  const preserved = ["id", "lead_id", "title", "location", "_mako_ingest_seq"];

  const params = makeProductionCase(
    [...preserved, ...droppedFields],
    preserved,
  );
  const sql = buildMergeStatement(params);

  assertNoneInUpdateSet(sql, droppedFields);
  assertAllInInsert(sql, droppedFields);
}

function testCallsProduction() {
  console.log("  production repro: calls");

  const droppedFields = [
    "date_created",
    "date_updated",
    "_syncedAt",
    "_mako_source_ts",
    "disposition",
  ];
  const preserved = [
    "id",
    "lead_id",
    "direction",
    "phone",
    "status",
    "_mako_ingest_seq",
  ];

  const params = makeProductionCase(
    [...preserved, ...droppedFields],
    preserved,
  );
  const sql = buildMergeStatement(params);

  assertNoneInUpdateSet(sql, droppedFields);
  assertAllInInsert(sql, droppedFields);
}

// ---------------------------------------------------------------------------
// 3. All columns in staging — full-row UPDATE (no regression)
// ---------------------------------------------------------------------------

function testAllColumnsInStaging() {
  console.log("  all columns in staging: full-row UPDATE");

  const cols = [
    "id",
    "name",
    "date_created",
    "date_updated",
    "_mako_source_ts",
  ];
  const params = make({
    columns: cols,
    stagingCols: new Set(cols),
  });
  const sql = buildMergeStatement(params);

  // UPDATE SET should include every non-key column
  for (const col of cols.filter(c => c !== "id")) {
    assert.match(
      sql,
      new RegExp(`\`${col}\`\\s*=\\s*__stg\\.\`${col}\``),
      `${col} should be in UPDATE SET`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Only key columns in staging — WHEN MATCHED arm omitted
// ---------------------------------------------------------------------------

function testOnlyKeyColumnsInStaging() {
  console.log("  only key columns in staging: no WHEN MATCHED arm");

  const params = make({
    columns: ["id", "date_created", "_mako_source_ts"],
    keyColumns: ["id"],
    stagingCols: new Set(["id"]),
  });
  const sql = buildMergeStatement(params);

  assert.ok(
    !sql.includes("WHEN MATCHED"),
    "WHEN MATCHED should be omitted when only key cols in staging",
  );
  assert.match(sql, /WHEN NOT MATCHED THEN INSERT/);
}

// ---------------------------------------------------------------------------
// 5. Ordering guard — _mako_source_ts
// ---------------------------------------------------------------------------

function testOrderingGuardSourceTs() {
  console.log("  ordering guard: _mako_source_ts COALESCE guard present");

  const cols = ["id", "name", "_mako_source_ts"];
  const params = make({
    columns: cols,
    stagingCols: new Set(cols),
  });
  const sql = buildMergeStatement(params);

  assert.match(
    sql,
    /COALESCE\(__stg\.`_mako_source_ts`.*TIMESTAMP\('1970-01-01 00:00:00 UTC'\)\)/,
    "should have source_ts COALESCE guard on staging side",
  );
  assert.match(
    sql,
    /COALESCE\(__live\.`_mako_source_ts`.*TIMESTAMP\('1970-01-01 00:00:00 UTC'\)\)/,
    "should have source_ts COALESCE guard on live side",
  );
}

// ---------------------------------------------------------------------------
// 6. Ordering guard — _mako_ingest_seq fallback
// ---------------------------------------------------------------------------

function testOrderingGuardIngestSeq() {
  console.log("  ordering guard: _mako_ingest_seq fallback when no source_ts");

  const cols = ["id", "name", "_mako_ingest_seq"];
  const params = make({
    columns: cols,
    keyColumns: ["id"],
    stagingCols: new Set(cols),
    liveTypes: new Map([
      ["id", "STRING"],
      ["name", "STRING"],
      ["_mako_ingest_seq", "INT64"],
    ]),
  });
  const sql = buildMergeStatement(params);

  assert.match(
    sql,
    /COALESCE\(__stg\.`_mako_ingest_seq`, -1\)/,
    "should have ingest_seq COALESCE guard on staging side",
  );
  assert.match(
    sql,
    /COALESCE\(__live\.`_mako_ingest_seq`, -1\)/,
    "should have ingest_seq COALESCE guard on live side",
  );
  assert.ok(
    !sql.includes("_mako_source_ts"),
    "should NOT have source_ts guard when source_ts not in staging",
  );
}

// ---------------------------------------------------------------------------
// 7. USING subquery dedup
// ---------------------------------------------------------------------------

function testDedupInUsingSubquery() {
  console.log("  USING subquery includes QUALIFY ROW_NUMBER dedup");

  const sql = buildMergeStatement(make());
  const norm = normalise(sql);

  assert.match(
    norm,
    /QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY `id` ORDER BY/,
    "should have QUALIFY ROW_NUMBER dedup",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  console.log("Running buildMergeStatement tests...\n");

  testBasicShape();
  console.log("    PASSED");

  testLeadsProduction();
  console.log("    PASSED");

  testOpportunitiesProduction();
  console.log("    PASSED");

  testMeetingsProduction();
  console.log("    PASSED");

  testCallsProduction();
  console.log("    PASSED");

  testAllColumnsInStaging();
  console.log("    PASSED");

  testOnlyKeyColumnsInStaging();
  console.log("    PASSED");

  testOrderingGuardSourceTs();
  console.log("    PASSED");

  testOrderingGuardIngestSeq();
  console.log("    PASSED");

  testDedupInUsingSubquery();
  console.log("    PASSED");

  console.log("\nAll buildMergeStatement tests passed.");
}

main();
