import assert from "node:assert/strict";
import { Readable } from "stream";
import { GcsConnector, resolveObjectPrefix } from "./connector";
import { fileMatchesGlob, parseCsvStream } from "./csv";
import { resolveGcsEntitySchema } from "./schema";

function createConnector(config: Record<string, unknown> = {}) {
  return new GcsConnector({
    id: "ds_gcs",
    name: "GCS",
    type: "gcs",
    config: {
      bucket: "realadvisor-sway",
      service_account_json: JSON.stringify({
        type: "service_account",
        project_id: "demo",
        client_email: "svc@demo.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
      }),
      ...config,
    },
  } as any);
}

function testConfigSchemaExposesCredentialsAndFolders() {
  const schema = GcsConnector.getConfigSchema();
  const fieldNames = schema.fields.map((f: { name: string }) => f.name);
  assert.ok(fieldNames.includes("service_account_json"));
  assert.ok(fieldNames.includes("bucket"));
  assert.ok(schema.transferQueries);
  assert.equal(schema.transferQueries.label, "Folders");
  const qFields = schema.transferQueries.fields.map(
    (f: { name: string }) => f.name,
  );
  assert.ok(qFields.includes("name"));
  assert.ok(qFields.includes("prefix"));
  assert.ok(qFields.includes("glob"));
}

function testValidateConfigRequiresBucketAndSa() {
  const empty = new GcsConnector({
    id: "x",
    name: "x",
    type: "gcs",
    config: {},
  } as any);
  const result = empty.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /bucket/i.test(e)));
  assert.ok(result.errors.some(e => /service account/i.test(e)));
}

function testValidateConfigAcceptsValidSa() {
  const connector = createConnector({
    queries: [{ name: "daily", prefix: "exports/", glob: "*.csv" }],
  });
  const result = connector.validateConfig();
  assert.equal(result.valid, true, result.errors.join("; "));
}

function testAvailableEntitiesComeFromFlowQueries() {
  const connector = createConnector({
    queries: [
      { name: "orders", prefix: "orders/" },
      { name: "users", prefix: "users/" },
    ],
  });
  assert.deepEqual(connector.getAvailableEntities(), ["orders", "users"]);
}

function testResolveObjectPrefixStripsBucketUri() {
  assert.equal(
    resolveObjectPrefix(
      "gs://realadvisor-sway/exports/daily/",
      "realadvisor-sway",
    ),
    "exports/daily/",
  );
  assert.equal(
    resolveObjectPrefix("realadvisor-sway/exports/daily/", "realadvisor-sway"),
    "exports/daily/",
  );
  assert.equal(
    resolveObjectPrefix("exports/daily/", "realadvisor-sway"),
    "exports/daily/",
  );
  assert.equal(
    resolveObjectPrefix("gs://realadvisor-sway", "realadvisor-sway"),
    "",
  );
  assert.equal(
    resolveObjectPrefix("gs://other-bucket/path/", "realadvisor-sway"),
    "path/",
  );
}

function testFileMatchesGlob() {
  assert.equal(fileMatchesGlob("exports/a.csv", "*.csv"), true);
  assert.equal(fileMatchesGlob("exports/a.CSV", "*.csv"), true);
  assert.equal(fileMatchesGlob("exports/a.json", "*.csv"), false);
  assert.equal(
    fileMatchesGlob("exports/orders_2026-07-22.csv", "orders_*.csv"),
    true,
  );
  assert.equal(fileMatchesGlob("exports/readme.txt", "*.csv"), false);
}

async function testParseCsvStreamEmitsRowsWithSourceKey() {
  const csv = "id,name\n1,alice\n2,bob\n";
  const batches: Array<Record<string, unknown>[]> = [];
  const result = await parseCsvStream(
    Readable.from([csv]),
    {
      sourceKey: "exports/daily/file.csv",
      sourceGeneration: "123",
      sourceUpdatedAt: "2026-07-22T00:00:00.000Z",
      hasHeader: true,
      batchSize: 10,
      primaryKey: "id",
    },
    async batch => {
      batches.push(batch);
    },
  );

  assert.equal(result.rowsEmitted, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].id, "1");
  assert.equal(batches[0][0].name, "alice");
  assert.equal(batches[0][0]._source_key, "exports/daily/file.csv");
  assert.equal(batches[0][1].id, "2");
}

async function testParseCsvStreamSkipRows() {
  const csv = "id,name\n1,alice\n2,bob\n3,carol\n";
  const rows: Array<Record<string, unknown>> = [];
  const result = await parseCsvStream(
    Readable.from([csv]),
    {
      sourceKey: "f.csv",
      hasHeader: true,
      skipRows: 1,
      primaryKey: "id",
    },
    async batch => {
      rows.push(...batch);
    },
  );
  assert.equal(result.rowsEmitted, 2);
  assert.deepEqual(
    rows.map(r => r.id),
    ["2", "3"],
  );
}

function testResolveSchemaDeclaresSystemFields() {
  const schema = resolveGcsEntitySchema("daily");
  assert.equal(schema.entity, "daily");
  assert.equal(schema.unknownFieldPolicy, "string");
  assert.ok(schema.fields.id);
  assert.ok(schema.fields._source_key);
  assert.ok(schema.fields._mako_deleted_at);
  assert.deepEqual(schema.keyColumns, ["id"]);
}

function testSupportsResumableFetching() {
  const connector = createConnector();
  assert.equal(connector.supportsResumableFetching(), true);
}

async function main() {
  testConfigSchemaExposesCredentialsAndFolders();
  testValidateConfigRequiresBucketAndSa();
  testValidateConfigAcceptsValidSa();
  testAvailableEntitiesComeFromFlowQueries();
  testResolveObjectPrefixStripsBucketUri();
  testFileMatchesGlob();
  await testParseCsvStreamEmitsRowsWithSourceKey();
  await testParseCsvStreamSkipRows();
  testResolveSchemaDeclaresSystemFields();
  testSupportsResumableFetching();
  // eslint-disable-next-line no-console
  console.log("gcs connector tests passed");
}

void main();
