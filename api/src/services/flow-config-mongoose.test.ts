/**
 * flowToFile must survive a LIVE Mongoose document (RFC #904).
 *
 * The write-through is called with the document the route just saved, not a
 * lean object. A document's arrays are DocumentArrays whose subdocuments
 * hold a `$__parent` back-reference to the parent — circular — and
 * `yaml.dump` runs with `noRefs: true`, which recurses instead of emitting
 * an alias. Handing it one overflowed the stack.
 *
 * This was not hypothetical: the first production export failed for 21 of
 * 31 flows with "Maximum call stack size exceeded", every failure a flow
 * with `entityLayouts` populated (i.e. every BigQuery-write flow), and the
 * same path runs on every flow save.
 *
 * Run: npx tsx src/services/flow-config-mongoose.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const { Flow } = await import("../database/workspace-schema");
    const { flowToFile, serializeFlowFile, parseFlowFile } = await import(
      "./flow-config-files"
    );

    // Every DocumentArray on the model populated at once.
    const doc = await Flow.create({
      workspaceId: new Types.ObjectId(),
      type: "webhook",
      name: "bq → warehouse",
      slug: "bq-warehouse",
      sourceType: "connector",
      dataSourceId: new Types.ObjectId(),
      destinationDatabaseId: new Types.ObjectId(),
      createdBy: "u1",
      schedule: { enabled: false },
      tableDestination: {
        tableName: "charges",
        partitioning: { enabled: true, type: "time", field: "created_at" },
        clustering: { enabled: true, fields: ["customer_id"] },
      },
      entityFilter: ["charges"],
      entityLayouts: [
        {
          entity: "charges",
          partitionField: "created_at",
          partitionGranularity: "day",
          clusterFields: ["customer_id"],
          enabled: true,
        },
      ],
      typeCoercions: [
        { column: "amount", targetType: "numeric", transformer: "trim" },
      ],
      queries: [{ name: "q", query: "{ charges }" }],
    });

    // The regression: this threw "Maximum call stack size exceeded".
    const text = serializeFlowFile(flowToFile(doc));
    assert.ok(text.includes("name: bq → warehouse"));

    // Mongoose internals must not leak into the file.
    for (const leak of ["$__", "_doc", "$isNew", "__v", "ObjectId("]) {
      assert.ok(
        !text.includes(leak),
        `Mongoose internals leaked (${leak}):\n${text}`,
      );
    }

    // The blobs survive as data, snake_cased, and read back.
    const parsed = parseFlowFile(text);
    assert.ok(parsed, "parses back");
    assert.equal(parsed.entityLayouts?.length, 1);
    assert.equal(
      (parsed.entityLayouts?.[0] as { entity?: string })?.entity,
      "charges",
    );
    assert.equal(parsed.typeCoercions?.length, 1);
    assert.equal(parsed.queries?.length, 1);
    assert.deepEqual(parsed.entityFilter, ["charges"]);
    assert.equal(
      (parsed.destination.table?.partitioning as { field?: string })?.field,
      "created_at",
    );

    // A lean object must produce the identical file — the write-through and
    // the export take different paths to the same bytes.
    const lean = await Flow.findById(doc._id).lean();
    assert.equal(
      serializeFlowFile(flowToFile(lean as never)),
      text,
      "document and lean projections must agree",
    );

    console.log("flow-config mongoose-safety tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
