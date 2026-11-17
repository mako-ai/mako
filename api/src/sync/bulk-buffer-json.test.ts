import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import { BSON, Binary, ObjectId } from "mongodb";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ConnectorEntitySchema } from "../connectors/base/BaseConnector";
import { buildParquetFromBatches } from "../utils/streaming-parquet-builder";
import { nestedValuesAsJsonText } from "./bulk-buffer-json";

const schema = {
  fields: {
    attendees: { type: "json" },
    counts: { type: "integer" },
  },
} as unknown as ConnectorEntitySchema;

/** What the flush reads back: the record after a BSON round trip. */
const roundTrip = (record: Record<string, unknown>) =>
  BSON.deserialize(BSON.serialize(record));

async function parquetText(
  records: Record<string, unknown>[],
): Promise<unknown[][]> {
  const built = await buildParquetFromBatches({
    filenameBase: "bulk-buffer-json",
    fields: [
      { name: "k", type: "string" },
      { name: "attendees", type: "json" },
      { name: "counts", type: "integer" },
      { name: "extra", type: undefined },
    ],
    streamBatches: async insert => insert(records),
  });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const read = await conn.run(
      `SELECT k, attendees, counts, extra FROM read_parquet('${built.filePath}') ORDER BY k`,
    );
    return (await read.getRows()).map(r => r.map(c => c ?? null));
  } finally {
    conn.closeSync();
    await fs.rm(built.filePath, { force: true });
  }
}

const RECORDS: Record<string, unknown>[] = [
  {
    k: "a",
    attendees: [
      { email: "a@x.fr", is_organizer: true, name: null, n: 1.5 },
      { email: "l'été@x.fr", when: new Date("2026-11-17T09:00:00.000Z") },
    ],
    counts: 3,
    extra: { nested: { deep: [1, "two", false, null] } },
  },
  { k: "b", attendees: [], counts: 0, extra: {} },
  // Not JSON-plain: kept as a document, so it reads back as before.
  {
    k: "c",
    attendees: [{ id: new ObjectId("65a1b2c3d4e5f60718293a4b") }],
    counts: 1,
    extra: { bin: new Binary(Buffer.from("hi")) },
  },
];

void test("buffered as JSON text, nested values reach Parquet unchanged", async () => {
  const before = await parquetText(RECORDS.map(roundTrip));
  const after = await parquetText(
    RECORDS.map(r => roundTrip(nestedValuesAsJsonText(r, schema))),
  );
  assert.deepEqual(after, before);
  assert.equal(
    before[0][1],
    '[{"email":"a@x.fr","is_organizer":true,"name":null,"n":1.5},{"email":"l\'été@x.fr","when":"2026-11-17T09:00:00.000Z"}]',
  );
});

void test("only JSON-plain values in VARCHAR columns become text", () => {
  const record = {
    attendees: [{ email: "a@x.fr" }],
    counts: [5],
    extra: { ok: true },
    oid: { id: new ObjectId() },
    hole: { gone: undefined },
    when: new Date(0),
    text: "plain",
  };
  const out = nestedValuesAsJsonText(record, schema);
  assert.equal(out.attendees, '[{"email":"a@x.fr"}]');
  assert.deepEqual(out.counts, [5], "an integer column keeps its value");
  assert.equal(out.extra, '{"ok":true}');
  assert.equal(out.oid, record.oid, "a BSON type stays a document");
  assert.equal(out.hole, record.hole, "an undefined member stays a document");
  assert.equal(out.when, record.when);
  assert.equal(out.text, "plain");
  assert.notEqual(out, record, "the input record is not mutated");
  assert.deepEqual(record.attendees, [{ email: "a@x.fr" }]);
});
