/**
 * Who may write through a connection, without a database: what counts as a
 * write, which table a write changes, and whether a writer may run it.
 */
import assert from "node:assert/strict";
import {
  actingPrincipal,
  asSystem,
  checkConnectionWrite,
  inReadOnlyTransaction,
  ownResult,
  decideWrite,
  isWrite,
  refusal,
  writeTarget,
} from "./connection-writes";
import { requestContextStorage } from "../logging/context";
import { checkPreviewQuerySafety } from "../services/query-pagination.service";
import { countTopLevelSemicolons } from "../services/sql-query-utils";
import { assertReadOnlyMaterializationQuery } from "../services/parquet-build.service";

// --- What counts as a write --------------------------------------------------

const reads = [
  "select 1",
  "  -- comment\nSELECT * FROM finance.invoices",
  "WITH a AS (SELECT 1) SELECT * FROM a",
  "select 'insert into x' as text",
  "SHOW TABLES",
  "DESCRIBE finance.invoices",
  "EXPLAIN SELECT * FROM t",
];
for (const q of reads) assert.equal(isWrite("postgresql", q), false, q);

const writes = [
  "INSERT INTO mako_out.labels VALUES (1)",
  "update crm.leads set x = 1",
  "DELETE FROM t",
  "CREATE TABLE finance.copy AS SELECT * FROM finance.invoices",
  "DROP TABLE finance.invoices",
  "TRUNCATE finance.invoices",
  "MERGE INTO a USING b ON a.id = b.id WHEN MATCHED THEN DELETE",
  "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
  "EXPLAIN ANALYZE DELETE FROM t",
  "SELECT 1; DROP TABLE t",
  "GRANT SELECT ON t TO x",
  "CALL finance.rebuild()",
];
for (const q of writes) assert.equal(isWrite("postgresql", q), true, q);

// --- Statement boundaries are read by the engine's own quote rules -----------

// PostgreSQL does not treat a backslash as an escape: 'a\' is a whole string,
// so everything after it is SQL. Read as an escape, the rest hid in a string
// and the COMMIT ended the read-only transaction ahead of the write.
const POSTGRES_ESCAPES = [
  String.raw`SELECT 'a\'; COMMIT; DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$; SELECT 'x'`,
  String.raw`SELECT 1 AS "a\"; COMMIT; DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$; SELECT 1 AS "b"`,
  // A quote inside a dollar-quoted string opens nothing.
  "SELECT $$'$$; COMMIT; DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$; SELECT $$'$$",
  "SELECT $t$'$t$; ROLLBACK; CALL finance.rebuild(); SELECT $t$'$t$",
  String.raw`SELECT 'a\'; SET default_transaction_read_only = off; SELECT 'x'`,
  String.raw`SELECT 'a\'; COPY t TO PROGRAM 'id'; SELECT 'x'`,
];
for (const q of POSTGRES_ESCAPES) {
  for (const type of ["postgresql", "cloudsql-postgres", "redshift"]) {
    assert.equal(isWrite(type, q), true, `${type}: ${q}`);
  }
  // No dialect given: refused under every reading.
  assert.equal(checkPreviewQuerySafety(q).safe, false, q);
}
// The QA payload names each statement it smuggles.
{
  const errors = checkPreviewQuerySafety(
    POSTGRES_ESCAPES[0],
    "postgresql",
  ).errors.join(" ");
  assert.match(errors, /forbidden COMMIT after a statement boundary/);
  assert.match(errors, /single SQL statement/);
}
// E'' strings do take backslash escapes on PostgreSQL, and a dollar-quoted
// string may hold semicolons: both stay one read.
for (const q of [
  String.raw`SELECT E'it\'s; fine' AS note`,
  "SELECT $$a; b$$ AS note",
  String.raw`SELECT 'C:\' AS drive`,
  "SELECT 'it''s; fine' AS note;",
]) {
  assert.equal(isWrite("postgresql", q), false, q);
}
// Where a backslash does escape (BigQuery, MySQL, ClickHouse), the same
// text is one string, and the reverse trick is the one refused.
for (const type of ["bigquery", "mysql", "clickhouse"]) {
  assert.equal(isWrite(type, String.raw`SELECT 'it\'s; fine' AS note`), false);
  assert.equal(
    isWrite(type, String.raw`SELECT 'a\''; DELETE FROM t WHERE x = ''`),
    true,
  );
}
assert.deepEqual(
  countTopLevelSemicolons(String.raw`SELECT 'a\'; SELECT 'b'`, "postgresql"),
  { count: 1, lastIndex: 11 },
);
assert.equal(
  countTopLevelSemicolons(String.raw`SELECT 'a\'; SELECT 'b'`, "bigquery")
    .count,
  0,
);

// BigQuery EXTERNAL_QUERY sends its SQL to another database: a write inside
// it is a write, and SQL that is not a literal cannot be checked.
for (const q of [
  `SELECT * FROM EXTERNAL_QUERY("p.eu.conn", "DELETE FROM leads")`,
  `SELECT * FROM EXTERNAL_QUERY('p.eu.conn', '''UPDATE leads SET x = 1 RETURNING *''')`,
  `SELECT * FROM external_query("p.eu.conn", "SELECT 1; DROP TABLE leads")`,
  String.raw`SELECT * FROM EXTERNAL_QUERY("p.eu.conn", "SELECT 'a\\'; COMMIT; DROP TABLE leads; SELECT 'x'")`,
  `SELECT * FROM EXTERNAL_QUERY("p.eu.conn", CONCAT("DELETE ", "FROM leads"))`,
]) {
  assert.equal(isWrite("bigquery", q), true, q);
}
assert.equal(
  isWrite(
    "bigquery",
    `SELECT * FROM EXTERNAL_QUERY("p.eu.conn", "SELECT id, 'it''s' FROM leads")`,
  ),
  false,
);

assert.equal(isWrite("mongodb", "db.users.find({})"), false);
assert.equal(isWrite("mongodb", "db.users.insertOne({a: 1})"), true);
assert.equal(
  isWrite("mongodb", 'db.x.aggregate([{ $match: {} }, { $out: "y" }])'),
  true,
);
assert.equal(isWrite("mongodb", "db.runCommand({ drop: 'y' })"), true);
assert.equal(isWrite("mongodb", "db.adminCommand({ shutdown: 1 })"), true);
assert.equal(isWrite("mongodb", { operation: "find" }), false);
assert.equal(isWrite("mongodb", { operation: "updateMany" }), true);

// A read-only transaction in one round trip; a trailing comment can't
// swallow the COMMIT.
assert.equal(
  inReadOnlyTransaction("select 1 -- note"),
  "BEGIN TRANSACTION READ ONLY;\nselect 1 -- note\n;COMMIT",
);
assert.equal(ownResult(["begin", "rows", "commit"]), "rows");
assert.equal(ownResult(["begin", "a", "b", "commit"]), "b");

// An app binding only reads, MongoDB and KV included.
const binding = (q: unknown, type: string) => {
  try {
    assertReadOnlyMaterializationQuery(q as string, type);
    return "read";
  } catch {
    return "refused";
  }
};
assert.equal(binding("db.users.find({})", "mongodb"), "read");
assert.equal(
  binding({ collection: "u", operation: "find" }, "mongodb"),
  "read",
);
assert.equal(binding("db.users.deleteMany({})", "mongodb"), "refused");
assert.equal(
  binding({ collection: "u", operation: "deleteMany" }, "mongodb"),
  "refused",
);
assert.equal(
  binding(
    { collection: "u", operation: "aggregate", pipeline: [{ $out: "x" }] },
    "mongodb",
  ),
  "refused",
);
assert.equal(binding("put k v", "cloudflare-kv"), "refused");
assert.equal(binding("DELETE FROM t", "postgresql"), "refused");

// --- Which table a write changes ----------------------------------------------

const target = (q: string) => {
  const t = writeTarget(q);
  return t ? [t.schema, t.table].filter(Boolean).join(".") : null;
};
assert.equal(
  target("INSERT INTO mako_out.labels VALUES (1)"),
  "mako_out.labels",
);
assert.equal(
  target("insert into `realadvisor-prod.mako_out.labels` select 1"),
  "mako_out.labels",
);
assert.equal(
  target("INSERT INTO `realadvisor-prod`.mako_out.labels SELECT 1"),
  "mako_out.labels",
);
assert.equal(
  target('UPDATE "Finance"."Invoices" SET x = 1'),
  "Finance.Invoices",
);
assert.equal(
  target("CREATE OR REPLACE TABLE finance.copy AS SELECT 1"),
  "finance.copy",
);
assert.equal(target("create table if not exists s.t (a int)"), "s.t");
assert.equal(target("DROP TABLE IF EXISTS s.t"), "s.t");
assert.equal(target("TRUNCATE TABLE s.t"), "s.t");
assert.equal(
  target("MERGE s.t USING x ON true WHEN MATCHED THEN DELETE"),
  "s.t",
);
assert.equal(target("DELETE FROM t WHERE id = 1"), "t");
assert.equal(target("DELETE `p.crm.leads` WHERE true"), "crm.leads");
assert.equal(
  target("LOAD DATA OVERWRITE mako_out.t FROM FILES(uris=['gs://x'])"),
  "mako_out.t",
);
assert.equal(
  target("LOAD DATA INTO mako_out.t FROM FILES(uris=['gs://x'])"),
  "mako_out.t",
);
// No single, named target: never guessed.
assert.equal(
  target("WITH x AS (SELECT 1) INSERT INTO s.t SELECT * FROM x"),
  null,
);
assert.equal(target("INSERT INTO s.t VALUES (1); DROP TABLE s.u"), null);
assert.equal(target("CALL s.rebuild()"), null);

// --- Whether a writer may run it ----------------------------------------------

const writers = [
  { principal: "user:marc" },
  { principal: "user:anna", where: "finance" },
  { principal: "workflow:crm-chat-issues", where: "mako_out.issue_labels" },
];
const may = (who: string, q: string) => decideWrite(writers, who, q).allowed;

// Anywhere.
assert.equal(may("user:marc", "DROP TABLE finance.invoices"), true);
assert.equal(may("user:marc", "CALL s.rebuild()"), true);
// One schema.
assert.equal(may("user:anna", "INSERT INTO finance.invoices SELECT 1"), true);
assert.equal(may("user:anna", "INSERT INTO FINANCE.x SELECT 1"), true);
assert.equal(may("user:anna", "INSERT INTO crm.leads SELECT 1"), false);
assert.equal(may("user:anna", "INSERT INTO invoices SELECT 1"), false);
// One table.
assert.equal(
  may("workflow:crm-chat-issues", "INSERT INTO mako_out.issue_labels SELECT 1"),
  true,
);
assert.equal(
  may("workflow:crm-chat-issues", "DROP TABLE mako_out.other"),
  false,
);
// Not listed.
assert.equal(may("user:stranger", "INSERT INTO finance.x SELECT 1"), false);
assert.equal(
  decideWrite(undefined, "user:marc", "DELETE FROM t").allowed,
  false,
);

// The refusals say what to do.
assert.match(
  refusal(decideWrite(writers, "user:stranger", "DELETE FROM t"), "BigQuery"),
  /Ask an admin/,
);
assert.match(
  refusal(
    decideWrite(writers, "user:anna", "INSERT INTO crm.x SELECT 1"),
    "BigQuery",
  ),
  /only to finance on BigQuery, not to crm\.x/,
);
assert.match(
  refusal(decideWrite(writers, "user:anna", "CALL x()"), "BigQuery"),
  /names its table as schema\.table/,
);

// --- Who is acting -------------------------------------------------------------

assert.equal(actingPrincipal(), undefined); // no request: the system
assert.equal(actingPrincipal("user:owner"), "user:owner");
requestContextStorage.run(
  { requestId: "r", userId: "marc", method: "POST", path: "/", startTime: 0 },
  () => assert.equal(actingPrincipal(), "user:marc"),
);
// A workflow's request acts as the workflow, not the key's owner.
requestContextStorage.run(
  {
    requestId: "r",
    userId: "deployer",
    workflow: "crm-chat-issues",
    method: "POST",
    path: "/",
    startTime: 0,
  },
  () => assert.equal(actingPrincipal(), "workflow:crm-chat-issues"),
);

// --- A request that identifies no one ---------------------------------------

async function unidentified() {
  const connection = {
    _id: "64b000000000000000000001",
    workspaceId: "64b000000000000000000002",
    name: "warehouse",
    type: "postgresql",
    writers: [{ principal: "user:marc" }],
  } as never;
  const write = "DELETE FROM finance.invoices";
  const anonymous = {
    requestId: "r",
    method: "POST",
    path: "/api/some/public/route",
    startTime: 0,
  };
  // No request at all (a script, startup): Mako's own.
  assert.deepEqual(await checkConnectionWrite(connection, write), {});
  // A request naming no one: its write is refused; its read runs as before.
  await requestContextStorage.run(anonymous, async () => {
    const check = await checkConnectionWrite(connection, write);
    assert.match(check.refused ?? "", /could not tell who is writing/);
    assert.deepEqual(
      await checkConnectionWrite(connection, "SELECT * FROM t"),
      {},
    );
    // Marked as Mako's own (an Inngest function, a flow's destination).
    assert.deepEqual(
      await asSystem(() => checkConnectionWrite(connection, write)),
      {},
    );
  });
  // Marked as Mako's own inside a person's request: the person is dropped.
  await requestContextStorage.run({ ...anonymous, userId: "eve" }, () =>
    asSystem(async () => assert.equal(actingPrincipal(), undefined)),
  );
}

void unidentified().then(
  () => console.log("connection writes tests passed"),
  error => {
    console.error(error);
    process.exitCode = 1;
  },
);
