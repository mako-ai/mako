import assert from "node:assert/strict";
import {
  mapPostgresOidToType,
  normalizePostgresFields,
  normalizePostgresRows,
  stripTrailingSqlSemicolon,
} from "./pg-type-utils";

function testMapPostgresOidToType() {
  assert.equal(mapPostgresOidToType(20), "BIGINT");
  assert.equal(mapPostgresOidToType(701), "DOUBLE PRECISION");
  assert.equal(mapPostgresOidToType(1043), "VARCHAR");
}

function testNormalizePostgresFields() {
  const fields = normalizePostgresFields([
    { name: "total_leads", dataTypeID: 20 },
    { name: "country", dataTypeID: 1043 },
  ]);

  assert.deepEqual(fields, [
    { name: "total_leads", dataTypeID: 20, type: "BIGINT" },
    { name: "country", dataTypeID: 1043, type: "VARCHAR" },
  ]);
}

function testNormalizePostgresRows() {
  const fields = normalizePostgresFields([
    { name: "total_leads", dataTypeID: 20 },
    { name: "country", dataTypeID: 1043 },
  ]);

  const rows = normalizePostgresRows(
    [
      { total_leads: "7401", country: "CH" },
      { total_leads: "9223372036854775807", country: "FR" },
    ],
    fields,
  );

  assert.equal(rows[0]?.total_leads, 7401);
  assert.equal(rows[0]?.country, "CH");
  assert.equal(rows[1]?.total_leads, "9223372036854775807");
}

function testStripTrailingSqlSemicolon() {
  assert.equal(stripTrailingSqlSemicolon("SELECT 1;\n"), "SELECT 1");
  assert.equal(
    stripTrailingSqlSemicolon("SELECT * FROM foo"),
    "SELECT * FROM foo",
  );
}

function main() {
  testMapPostgresOidToType();
  testNormalizePostgresFields();
  testNormalizePostgresRows();
  testStripTrailingSqlSemicolon();
}

main();
