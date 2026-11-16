/**
 * The default LIMIT an agent's SELECT gets, and run_console's wait over MCP.
 *
 * Run: tsx src/agent-lib/tools/sql-default-limit.test.ts
 */
import assert from "node:assert/strict";
import { appendLimitIfMissing } from "./sql-tools";
import {
  MCP_QUERY_SOFT_TIMEOUT_MS,
  QUERY_SOFT_TIMEOUT_MS,
} from "../../config/long-running-queries";

// --- every engine: LIMIT at the end, unless the query has one ---------------
assert.equal(
  appendLimitIfMissing("select 1 from t;"),
  "select 1 from t\nLIMIT 500;",
);
assert.equal(
  appendLimitIfMissing("select 1 from t limit 3"),
  "select 1 from t limit 3",
);
assert.equal(appendLimitIfMissing("show tables"), "show tables");

// --- ClickHouse: LIMIT goes before the trailing SETTINGS / FORMAT -----------
assert.equal(
  appendLimitIfMissing(
    "select count() from t settings max_execution_time = 10",
    "clickhouse",
  ),
  "select count() from t\nLIMIT 500\nsettings max_execution_time = 10;",
);
assert.equal(
  appendLimitIfMissing("SELECT a FROM t FORMAT JSONEachRow", "clickhouse"),
  "SELECT a FROM t\nLIMIT 500\nFORMAT JSONEachRow;",
);
// A column named settings or format is no clause.
assert.equal(
  appendLimitIfMissing("select settings, format from t", "clickhouse"),
  "select settings, format from t\nLIMIT 500;",
);
// Inside a subquery or a string it is not the query's own clause.
assert.equal(
  appendLimitIfMissing(
    "select * from (select 1 settings max_threads = 1) where x = 'settings a = 1'",
    "clickhouse",
  ),
  "select * from (select 1 settings max_threads = 1) where x = 'settings a = 1'\nLIMIT 500;",
);
// Other engines keep the plain append.
assert.equal(
  appendLimitIfMissing("select format('%s', a) from t", "postgresql"),
  "select format('%s', a) from t\nLIMIT 500;",
);

// --- run_console answers over MCP before a client's 60s abort ---------------
assert.ok(MCP_QUERY_SOFT_TIMEOUT_MS < 60_000);
assert.ok(MCP_QUERY_SOFT_TIMEOUT_MS <= QUERY_SOFT_TIMEOUT_MS);

// eslint-disable-next-line no-console
console.log("sql-default-limit.test.ts: all assertions passed");
