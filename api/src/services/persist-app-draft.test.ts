/**
 * Regression tests for buildAppDraftUpdate.
 *
 * App restore (and every other draft persist) must `$set` dirty snapshot
 * fields without also writing `version` (that's `$inc`'d by the predicate
 * update) and without emitting ancestor+descendant `$set` keys.
 *
 * Run: tsx src/services/persist-app-draft.test.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { buildAppDraftUpdate } from "./persist-app-draft";

const bindingSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    code: { type: String, default: "" },
  },
  { _id: false },
);
const appSchema = new mongoose.Schema({
  title: String,
  description: String,
  version: { type: Number, default: 1 },
  createdAt: Date,
  updatedAt: Date,
  files: { type: [{ path: String, contents: String }], default: [] },
  dependencies: { type: mongoose.Schema.Types.Mixed, default: {} },
  dataBindings: { type: [bindingSchema], default: [] },
});
const TestApp = mongoose.model("PersistAppDraftTestApp", appSchema);

{
  const doc = TestApp.hydrate({
    _id: new mongoose.Types.ObjectId(),
    title: "draft",
    description: "old",
    version: 10,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    files: [{ path: "src/App.tsx", contents: "old" }],
    dependencies: { react: "18.3.1" },
    dataBindings: [{ name: "q", code: "select 1" }],
  });

  doc.title = "restored";
  doc.description = undefined as unknown as string;
  doc.version = 11;
  doc.files = [{ path: "src/App.tsx", contents: "new" }] as typeof doc.files;
  doc.dependencies = { react: "18.3.1", zod: "3.0.0" };
  doc.markModified("dependencies");
  doc.dataBindings = [
    { name: "q", code: "select 2" },
  ] as typeof doc.dataBindings;
  doc.dataBindings[0].code = "select 2";
  doc.markModified("dataBindings");

  const { setFields, unsetFields } = buildAppDraftUpdate(doc);

  assert.equal(setFields.version, undefined, "version is $inc'd, not $set");
  assert.equal(setFields.createdAt, undefined);
  assert.equal(setFields.updatedAt, undefined);
  assert.equal(setFields.title, "restored");
  assert.deepEqual(unsetFields, { description: "" });
  assert.equal(
    "dataBindings.0.code" in setFields,
    false,
    "nested dataBindings.* must not sit next to dataBindings in $set",
  );
  assert.ok(
    setFields.dataBindings,
    `expected dataBindings $set, got ${JSON.stringify(Object.keys(setFields))}`,
  );
  assert.ok(
    setFields.files,
    `expected files $set, got ${JSON.stringify(Object.keys(setFields))}`,
  );
  assert.ok(setFields.dependencies);
}

process.stdout.write("persist-app-draft.test.ts: all assertions passed\n");
