/**
 * Run-history retention against an in-memory Mongo:
 *
 * - the FlowExecution schema declares a TTL index on completedAt, partial on
 *   the terminal statuses, with the configured retention;
 * - the TTL monitor expires an old finished run but never a running one,
 *   whatever its dates;
 * - the migration backfills completedAt, creates the index, is idempotent
 *   (run twice: one index), adopts an index built under another name, and
 *   collMods the TTL when FLOW_EXECUTION_RETENTION_DAYS changes.
 *
 * Run: npx tsx src/database/flow-execution-retention.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { FlowExecution } from "./workspace-schema";
import {
  DEFAULT_FLOW_EXECUTION_RETENTION_DAYS,
  FLOW_EXECUTION_TTL_INDEX_NAME,
  FLOW_EXECUTION_TTL_PARTIAL_FILTER,
  flowExecutionRetentionDays,
  flowExecutionRetentionSeconds,
} from "./flow-execution-retention";
import { up } from "../migrations/2026-11-14-204132_flow_executions_retention_ttl";

const DAY = 24 * 60 * 60;

interface ListedIndex {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

async function ttlIndexes(db: mongoose.mongo.Db): Promise<ListedIndex[]> {
  const indexes = (await db
    .collection("flow_executions")
    .listIndexes()
    .toArray()) as ListedIndex[];
  return indexes.filter(
    idx => JSON.stringify(idx.key) === JSON.stringify({ completedAt: 1 }),
  );
}

function envParsing(): void {
  assert.equal(flowExecutionRetentionDays({}), 90);
  assert.equal(DEFAULT_FLOW_EXECUTION_RETENTION_DAYS, 90);
  assert.equal(
    flowExecutionRetentionDays({ FLOW_EXECUTION_RETENTION_DAYS: "30" }),
    30,
  );
  for (const bad of ["0", "-5", "abc", "", "  "]) {
    assert.equal(
      flowExecutionRetentionDays({ FLOW_EXECUTION_RETENTION_DAYS: bad }),
      90,
      `invalid ${JSON.stringify(bad)} falls back to the default`,
    );
  }
  assert.equal(
    flowExecutionRetentionSeconds({ FLOW_EXECUTION_RETENTION_DAYS: "7" }),
    7 * DAY,
  );
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return check();
}

async function schemaIndexAndExpiry(): Promise<void> {
  await FlowExecution.init();
  const db = FlowExecution.db.db;
  assert.ok(db, "connected");
  const [index, ...others] = await ttlIndexes(db);
  assert.equal(others.length, 0);
  assert.ok(index, "schema declares the TTL index");
  assert.equal(index.name, FLOW_EXECUTION_TTL_INDEX_NAME);
  assert.equal(index.expireAfterSeconds, 90 * DAY);
  assert.deepEqual(
    index.partialFilterExpression,
    FLOW_EXECUTION_TTL_PARTIAL_FILTER,
  );
  assert.deepEqual(
    (index.partialFilterExpression?.status as { $in: string[] }).$in,
    ["completed", "failed", "cancelled", "abandoned"],
  );

  // Let the TTL monitor run every second.
  await db.admin().command({ setParameter: 1, ttlMonitorSleepSecs: 1 });

  const old = new Date(Date.now() - 200 * DAY * 1000);
  const base = {
    flowId: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    startedAt: old,
    success: false,
    logs: [],
  };
  const running = new Types.ObjectId();
  const finished = new Types.ObjectId();
  const abandoned = new Types.ObjectId();
  const recent = new Types.ObjectId();
  await FlowExecution.collection.insertMany([
    // A running run with a stale completedAt (e.g. reclaimed): never expires.
    { ...base, _id: running, status: "running", completedAt: old },
    { ...base, _id: finished, status: "completed", completedAt: old },
    { ...base, _id: abandoned, status: "abandoned", completedAt: old },
    { ...base, _id: recent, status: "failed", completedAt: new Date() },
  ]);

  const expired = await waitFor(
    async () =>
      (await FlowExecution.collection.countDocuments({
        _id: { $in: [finished, abandoned] },
      })) === 0,
    10_000,
  );
  assert.ok(expired, "old finished runs expire");
  assert.ok(
    await FlowExecution.collection.findOne({ _id: running }),
    "a running execution is never expired",
  );
  assert.ok(
    await FlowExecution.collection.findOne({ _id: recent }),
    "a recent finished run is kept",
  );
}

async function migration(client: mongoose.mongo.MongoClient): Promise<void> {
  // A database the model never touched: autoIndex has built nothing.
  const db = client.db("retention_migration");
  const executions = db.collection("flow_executions");
  const heartbeat = new Date("2026-01-02T00:00:00Z");
  const started = new Date("2026-01-01T00:00:00Z");
  await executions.insertMany([
    { status: "completed", startedAt: started, lastHeartbeat: heartbeat },
    { status: "failed", startedAt: started },
    { status: "running", startedAt: started, lastHeartbeat: heartbeat },
    {
      status: "cancelled",
      startedAt: started,
      completedAt: new Date("2026-03-01T00:00:00Z"),
    },
  ]);

  await up(db);
  await up(db); // idempotent

  const indexes = await ttlIndexes(db);
  assert.equal(indexes.length, 1, "running twice leaves one index");
  assert.equal(indexes[0].expireAfterSeconds, 90 * DAY);
  assert.deepEqual(
    indexes[0].partialFilterExpression,
    FLOW_EXECUTION_TTL_PARTIAL_FILTER,
  );

  const byStatus = new Map(
    (await executions.find().toArray()).map(doc => [doc.status, doc]),
  );
  assert.deepEqual(byStatus.get("completed")?.completedAt, heartbeat);
  assert.deepEqual(byStatus.get("failed")?.completedAt, started);
  assert.equal(
    byStatus.get("running")?.completedAt,
    undefined,
    "a running execution is not stamped",
  );
  assert.deepEqual(
    byStatus.get("cancelled")?.completedAt,
    new Date("2026-03-01T00:00:00Z"),
    "an existing completedAt is kept",
  );

  // The override changes: the existing index's TTL is collMod-ed.
  process.env.FLOW_EXECUTION_RETENTION_DAYS = "30";
  try {
    await up(db);
    await up(db);
  } finally {
    delete process.env.FLOW_EXECUTION_RETENTION_DAYS;
  }
  const updated = await ttlIndexes(db);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].expireAfterSeconds, 30 * DAY);

  // An equivalent index under another name is adopted, not duplicated.
  const other = client.db("retention_migration_named");
  await other.collection("flow_executions").createIndex(
    { completedAt: 1 },
    {
      name: "completedAt_1",
      expireAfterSeconds: 5 * DAY,
      partialFilterExpression: FLOW_EXECUTION_TTL_PARTIAL_FILTER,
    },
  );
  await up(other);
  const adopted = await ttlIndexes(other);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].name, "completedAt_1");
  assert.equal(adopted[0].expireAfterSeconds, 90 * DAY);
}

async function main(): Promise<void> {
  delete process.env.FLOW_EXECUTION_RETENTION_DAYS;
  envParsing();

  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    await schemaIndexAndExpiry();
    await migration(mongoose.connection.getClient());
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
  console.info("flow-execution-retention db tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
