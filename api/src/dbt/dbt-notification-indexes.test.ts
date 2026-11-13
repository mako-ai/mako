/**
 * The two indexes dbt job notifications rely on, and the migrations that
 * build them where Mongoose autoIndex does not.
 *
 * - `notification_deliveries { idempotencyKey }` unique: the fan-out claims
 *   a delivery with an upsert on that key. Migration 2026-05-01-140000 has
 *   built it since notifications shipped; the schema now declares the same
 *   index under the same name, so the two never conflict.
 * - `dbt_runs { jobId, status, completedAt }`: the previous run and the last
 *   success of a job in completion order, each one index seek.
 *
 * Real MongoDB (mongodb-memory-server). Both orders are covered: migration
 * first, and autoIndex first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DbtRun, NotificationDelivery } from "../database/workspace-schema";
import { up as createNotificationCollections } from "../migrations/2026-05-01-140000_flow_run_notifications_collections";
import { up as addCompletionOrderIndex } from "../migrations/2026-11-13-090000_dbt_runs_job_status_completed_index";

let mongo: MongoMemoryServer;

function nativeDb() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("mongoose is not connected");
  return db;
}

async function indexesOn(collection: string, keys: Record<string, number>) {
  const target = JSON.stringify(keys);
  const indexes = await nativeDb().collection(collection).indexes();
  return indexes.filter(index => JSON.stringify(index.key) === target);
}

async function dropIfExists(collection: string): Promise<void> {
  const existing = await nativeDb()
    .listCollections({ name: collection })
    .toArray();
  if (existing.length > 0) await nativeDb().dropCollection(collection);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Let the builds autoIndex started at connect finish before any drop.
  await Promise.all([NotificationDelivery.init(), DbtRun.init()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await dropIfExists("notification_deliveries");
  await dropIfExists("notification_rules");
  await dropIfExists("dbt_runs");
});

describe("notification_deliveries unique idempotencyKey index", () => {
  const KEYS = { idempotencyKey: 1 };

  it("the migration builds it, and the schema's index is the same one", async () => {
    await createNotificationCollections(nativeDb());
    await NotificationDelivery.syncIndexes();

    const found = await indexesOn("notification_deliveries", KEYS);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      unique: true,
      name: "idempotency_key_unique_idx",
    });
  });

  it("autoIndex first, migration second: still one unique index, no conflict", async () => {
    await NotificationDelivery.createIndexes();
    await createNotificationCollections(nativeDb());
    await createNotificationCollections(nativeDb());

    const found = await indexesOn("notification_deliveries", KEYS);
    expect(found).toHaveLength(1);
    expect(found[0].unique).toBe(true);
  });

  it("refuses a second delivery row for one key", async () => {
    await createNotificationCollections(nativeDb());
    const row = {
      workspaceId: new Types.ObjectId(),
      ruleId: new Types.ObjectId(),
      resourceType: "dbt_job",
      resourceId: new Types.ObjectId(),
      runId: "r1",
      trigger: "failure",
      channelType: "email",
      idempotencyKey: "dbt_job:j:r1:failure:email:rule",
      status: "pending",
      createdAt: new Date(),
    };
    const deliveries = nativeDb().collection("notification_deliveries");
    await deliveries.insertOne({ ...row });
    await expect(deliveries.insertOne({ ...row })).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe("dbt_runs completion-order index", () => {
  const KEYS = { jobId: 1, status: 1, completedAt: -1 };

  it("the migration is idempotent and skips a database with no dbt_runs yet", async () => {
    // No collection: nothing to do, and no error.
    await addCompletionOrderIndex(nativeDb());
    expect(
      await nativeDb().listCollections({ name: "dbt_runs" }).toArray(),
    ).toHaveLength(0);

    await nativeDb().createCollection("dbt_runs");
    await addCompletionOrderIndex(nativeDb());
    await addCompletionOrderIndex(nativeDb());
    expect(await indexesOn("dbt_runs", KEYS)).toHaveLength(1);
  });

  it("migration and autoIndex converge on one index, in either order", async () => {
    await nativeDb().createCollection("dbt_runs");
    await addCompletionOrderIndex(nativeDb());
    await DbtRun.createIndexes();
    expect(await indexesOn("dbt_runs", KEYS)).toHaveLength(1);

    await dropIfExists("dbt_runs");
    await DbtRun.createIndexes();
    await addCompletionOrderIndex(nativeDb());
    const found = await indexesOn("dbt_runs", KEYS);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("jobId_1_status_1_completedAt_-1");
  });

  it("answers the previous-run and last-success lookups without sorting run documents", async () => {
    await DbtRun.createIndexes();
    const workspaceId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const earlier = {
      workspaceId,
      jobId,
      _id: { $ne: new Types.ObjectId() },
      completedAt: { $lt: new Date() },
    };

    const stagesOf = (plan: unknown): string[] => {
      const stages: string[] = [];
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const stage = node as {
          stage?: string;
          indexName?: string;
          inputStage?: unknown;
          inputStages?: unknown[];
        };
        if (stage.stage) {
          stages.push(
            stage.indexName ? `${stage.stage}:${stage.indexName}` : stage.stage,
          );
        }
        walk(stage.inputStage);
        for (const input of stage.inputStages ?? []) walk(input);
      };
      walk(plan);
      return stages;
    };
    const winningPlan = async (filter: Record<string, unknown>) => {
      const explained = (await DbtRun.findOne(filter)
        .sort({ completedAt: -1 })
        .select("status completedAt")
        .explain("queryPlanner")) as unknown as {
        queryPlanner: { winningPlan: unknown };
      };
      return stagesOf(explained.queryPlanner.winningPlan);
    };

    for (const status of [{ $in: ["success", "error"] }, "success"]) {
      const stages = await winningPlan({ ...earlier, status });
      expect(stages).toContain("IXSCAN:jobId_1_status_1_completedAt_-1");
      // The order comes from the index: no blocking sort over documents.
      expect(stages).not.toContain("SORT");
    }
  });
});
