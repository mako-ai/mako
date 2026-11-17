/**
 * The legacy unique { jobId, eventId } index made an event id unique across
 * flows. Dropping it lets two flows store the same Close event; the real
 * { flowId, eventId } key still dedups within a flow.
 *
 * Run: node --import tsx src/migrations/2026-11-17-160000_drop_webhookevents_jobid_eventid_index.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { up } from "./2026-11-17-160000_drop_webhookevents_jobid_eventid_index";

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db("t");
});
after(async () => {
  await client.close();
  await mongo.stop();
});

void test("drops the legacy index, keeps flow dedup, and is idempotent", async () => {
  const events = db.collection("webhookevents");
  await events.createIndex({ jobId: 1, eventId: 1 }, { unique: true });
  await events.createIndex({ flowId: 1, eventId: 1 }, { unique: true });
  const [flowA, flowB] = [new ObjectId(), new ObjectId()];

  await events.insertOne({ flowId: flowA, eventId: "ev_1" });
  await assert.rejects(
    events.insertOne({ flowId: flowB, eventId: "ev_1" }),
    /E11000/,
    "the bug: the second flow cannot store the same event",
  );

  await up(db);
  await up(db);

  await events.insertOne({ flowId: flowB, eventId: "ev_1" });
  await assert.rejects(
    events.insertOne({ flowId: flowB, eventId: "ev_1" }),
    /E11000/,
    "one flow still stores an event once",
  );
  const names = (await events.indexes()).map(i => i.name);
  assert.ok(!names.includes("jobId_1_eventId_1"));
  assert.ok(names.includes("flowId_1_eventId_1"));
});
