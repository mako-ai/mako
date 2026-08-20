/**
 * Regression tests for minimizeDirtyPaths.
 *
 * Bug: app_set_binding_schedule / app_set_binding_materialization assign a
 * nested binding field (dirtying e.g.
 * "dataBindings.2.materializationSchedule.enabled") AND call
 * markModified("dataBindings"). saveAndPublish turned every directly
 * modified path into a `$set` key, and MongoDB rejects an update that
 * writes both a path and one of its descendants:
 *   "Updating the path 'dataBindings' would create a conflict at
 *    'dataBindings'"
 * The failure was data-dependent (only apps where the assignment actually
 * changed a tracked leaf), which made it look like per-app doc corruption.
 *
 * Run: tsx src/utils/mongoose-dirty-paths.test.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { minimizeDirtyPaths } from "./mongoose-dirty-paths";

// --- pure helper -----------------------------------------------------------
{
  assert.deepEqual(minimizeDirtyPaths([]), []);
  // Unrelated paths pass through untouched.
  assert.deepEqual(minimizeDirtyPaths(["title", "entrypoint"]), [
    "title",
    "entrypoint",
  ]);
  // Descendants of a dirty ancestor are dropped, in either input order.
  assert.deepEqual(
    minimizeDirtyPaths([
      "dataBindings",
      "dataBindings.2.materializationSchedule.enabled",
    ]),
    ["dataBindings"],
  );
  assert.deepEqual(
    minimizeDirtyPaths(["dataBindings.0.code", "dataBindings"]),
    ["dataBindings"],
  );
  // A shared string prefix without a "." boundary is NOT an ancestor.
  assert.deepEqual(minimizeDirtyPaths(["data", "dataBindings"]), [
    "data",
    "dataBindings",
  ]);
  // Deep chains collapse to the shortest ancestor.
  assert.deepEqual(minimizeDirtyPaths(["a.b.c", "a.b", "a"]), ["a"]);
}

// --- real Mongoose behavior: the exact shape that caused the bug -----------
{
  const bindingSchema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      materialization: { type: String, default: "live" },
      materializationSchedule: {
        enabled: { type: Boolean, default: false },
        cron: { type: String, default: null },
        timezone: { type: String, default: "UTC" },
      },
    },
    { _id: false },
  );
  const appSchema = new mongoose.Schema({
    title: String,
    dataBindings: { type: [bindingSchema], default: [] },
  });
  const TestApp = mongoose.model("MinimizeDirtyPathsTestApp", appSchema);

  // hydrate() simulates a doc loaded from the DB (nothing modified yet).
  const doc = TestApp.hydrate({
    _id: new mongoose.Types.ObjectId(),
    title: "t",
    dataBindings: [
      {
        name: "engagement_v5",
        materialization: "parquet",
        materializationSchedule: {
          enabled: false,
          cron: null,
          timezone: "UTC",
        },
      },
    ],
  });
  assert.deepEqual(doc.directModifiedPaths(), []);

  // What the schedule tool does: assign the nested field, then markModified.
  doc.dataBindings[0].materializationSchedule = {
    enabled: true,
    cron: "0 * * * *",
    timezone: "UTC",
  };
  doc.markModified("dataBindings");

  const dirty = doc.directModifiedPaths();
  // The buggy combination Mongoose reports: ancestor + descendant(s).
  assert.ok(dirty.includes("dataBindings"), `dirty=${JSON.stringify(dirty)}`);
  assert.ok(
    dirty.some(p => p.startsWith("dataBindings.")),
    `expected a nested dataBindings.* path, got ${JSON.stringify(dirty)}`,
  );

  // Minimized, only the ancestor survives — a single non-conflicting $set
  // key whose value (read from the mutated doc) carries the schedule change.
  assert.deepEqual(minimizeDirtyPaths(dirty), ["dataBindings"]);
  const value = doc.get("dataBindings");
  assert.equal(value[0].materializationSchedule.enabled, true);
  assert.equal(value[0].materializationSchedule.cron, "0 * * * *");
}

process.stdout.write("mongoose-dirty-paths.test.ts: all assertions passed\n");
