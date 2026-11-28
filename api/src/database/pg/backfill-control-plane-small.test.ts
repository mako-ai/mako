/**
 * One-shot control-plane backfill (cli/backfill-control-plane-small.ts):
 * a dry run writes nothing, the fixture copy imports every valid row, a re-run
 * writes nothing new. Orphaned delivery history survives the copy and read-only replay.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BSON } from "mongodb";
import { PgNotificationsRepository } from "../../repositories/notifications/pg.repo";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillControlPlaneSmall } from "./cli/backfill-control-plane-small";
import { setPgTestDb, resetPgTestDb, type MakoPgDb } from "./client";
import { generateUuidv7, objectIdToUuid, toWireId } from "./id-codec";
import { runPgliteMigrations } from "./migrate";
import * as pgSchema from "./schema";
import { createTestPglite } from "./test-pglite";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("backfill-control-plane-small", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  const now = new Date();
  const wsOid = new Types.ObjectId();
  const otherWsOid = new Types.ObjectId();
  const missingWsOid = new Types.ObjectId();
  const flowOid = new Types.ObjectId();
  const ruleOid = new Types.ObjectId();
  const orphanRuleOid = new Types.ObjectId();
  const userId = generateUuidv7();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
    setPgTestDb(db);

    await pg.query(
      `INSERT INTO users (id, email) VALUES ($1, 'bf@example.com')`,
      [userId],
    );
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'BF', 'bf', $2)`,
      [objectIdToUuid(wsOid.toHexString()), userId],
    );

    await db.insert(pgSchema.workspaces).values({
      id: objectIdToUuid(otherWsOid.toHexString()),
      name: "Other",
      slug: "other",
      createdBy: userId,
    });

    const col = (name: string) => mongoose.connection.collection(name);
    const channel = {
      type: "webhook",
      urlEncrypted: "iv:cipher-url",
      signingSecretEncrypted: "iv:cipher-secret",
    };
    await col("notification_rules").insertMany([
      {
        _id: ruleOid,
        workspaceId: wsOid,
        resourceType: "flow",
        resourceId: flowOid,
        enabled: true,
        triggers: ["failure"],
        channel,
        createdBy: userId,
        createdAt: new Date(now.getTime() - DAY_MS),
        updatedAt: new Date(now.getTime() - DAY_MS),
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: missingWsOid,
        resourceType: "flow",
        resourceId: flowOid,
        enabled: true,
        triggers: ["success"],
        channel: { type: "email", recipients: ["a@example.com"] },
        createdBy: "unknown",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const delivery = (over: Record<string, unknown>) => ({
      _id: new Types.ObjectId(),
      workspaceId: wsOid,
      ruleId: ruleOid,
      resourceType: "flow",
      resourceId: flowOid,
      runId: "run-1",
      trigger: "failure",
      channelType: "webhook",
      status: "sent",
      attempts: 1,
      sentAt: now,
      completedAt: now,
      createdAt: now,
      ...over,
    });
    await col("notification_deliveries").insertMany([
      delivery({
        idempotencyKey: "fresh",
        lastError: "HTTP 500: before\0after",
        status: "pending",
        attempts: 0,
        sentAt: null,
        completedAt: null,
      }),
      delivery({ workspaceId: otherWsOid, idempotencyKey: "wrong-workspace" }),
      delivery({}),
      delivery({ ruleId: orphanRuleOid, idempotencyKey: "orphan" }),
      delivery({
        idempotencyKey: "old",
        createdAt: new Date(now.getTime() - 91 * DAY_MS),
      }),
    ]);
    await col("workflow_recorded_runs").insertMany([
      {
        _id: new Types.ObjectId(),
        workspaceId: wsOid,
        runId: "r1",
        count: 1,
        at: now,
      },
    ]);
    await col("workflow_recorded_writes").insertMany([
      {
        _id: new Types.ObjectId(),
        workspaceId: wsOid,
        runId: "r1",
        userId: "vera",
        connectionId: new Types.ObjectId(),
        connection: "slack",
        request: { method: "POST", url: "https://x", headers: {} },
        seq: 0,
        at: now,
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: wsOid,
        runId: "r0",
        connectionId: new Types.ObjectId(),
        connection: "slack",
        request: { method: "POST", url: "https://x", headers: {} },
        seq: 0,
        at: new Date(now.getTime() - 8 * DAY_MS),
      },
    ]);
    await col("modelcatalogsnapshots").insertMany([
      { _id: "gateway", data: [{ id: "a" }], fetchedAt: now, itemCount: 1 },
      { _id: "gateway-raw", data: [{ raw: 1 }], fetchedAt: now, itemCount: 1 },
      { _id: "unknown-id", data: [], fetchedAt: now, itemCount: 0 },
    ] as unknown as Parameters<ReturnType<typeof col>["insertMany"]>[0]);
    await col("apps_box_policy").insertOne({
      _id: "activity-tracking",
      since: new Date(now.getTime() - 30 * DAY_MS),
    } as unknown as Parameters<ReturnType<typeof col>["insertOne"]>[0]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    resetPgTestDb();
    await pg.close();
  });

  it("rejects an operator pre-apply before opening either database", async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/database/pg/cli/backfill-control-plane-small.ts",
          "--apply",
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: "mongodb://127.0.0.1:1/fixture",
            POSTGRES_DIRECT_URL: "postgres://127.0.0.1:1/fixture",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unfenced --apply is disabled"),
    });
  });

  it("dry run counts candidates and writes nothing", async () => {
    const report = await backfillControlPlaneSmall({ db, apply: false, now });
    expect(report.notification_rules).toMatchObject({
      source: 2,
      candidates: 1,
      written: 0,
      skipped: { "orphan workspace lacks a unique approved archive": 1 },
    });
    expect(report.notification_deliveries).toMatchObject({
      source: 5,
      candidates: 2,
      skipped: {
        "rule belongs to another workspace": 1,
        "invalid delivery details": 1,
        "older than 90d TTL": 1,
      },
    });
    expect(report.workflow_recorded_writes).toMatchObject({
      candidates: 1,
      skipped: { "older than 7d TTL": 1 },
    });
    expect(report.model_catalog_snapshots).toMatchObject({
      candidates: 2,
      skipped: { "unknown snapshot id": 1 },
    });
    const rows = await pg.query(`SELECT 1 FROM notification_rules`);
    expect(rows.rows).toHaveLength(0);
  });

  it("apply copies valid rows verbatim and a re-run writes nothing", async () => {
    // The new API may already have initialized this marker during cutover.
    await db
      .insert(pgSchema.appsBoxPolicy)
      .values({ id: "activity-tracking", since: now });
    const sourceSnapshots = mongoose.connection.collection<{
      _id: string;
      data: unknown;
      fetchedAt: Date;
      itemCount: number;
    }>("modelcatalogsnapshots");
    const older = new Date(now.getTime() - DAY_MS);
    const curation = {
      models: [{ modelId: "m", tier: "free", visible: true }],
      defaultFreeChatModelId: "m",
      defaultChatModelId: "m",
      utilityModelId: null,
      lastRefreshError: null,
    };
    await sourceSnapshots.insertMany([
      { _id: "curation", data: curation, fetchedAt: older, itemCount: 1 },
      {
        _id: "capabilities",
        data: { thinkingModes: { a: "manual", b: "manual" } },
        fetchedAt: older,
        itemCount: 2,
      },
    ]);
    await db.insert(pgSchema.modelCatalogSnapshots).values([
      {
        id: "curation",
        data: {
          models: [],
          defaultFreeChatModelId: null,
          defaultChatModelId: null,
          utilityModelId: null,
          lastRefreshError: "recent failure",
        },
        fetchedAt: now,
        itemCount: 0,
      },
      {
        id: "capabilities",
        data: { thinkingModes: { b: "adaptive", c: "manual" } },
        fetchedAt: now,
        itemCount: 2,
      },
    ]);
    const first = await backfillControlPlaneSmall({ db, apply: true, now });
    expect(first.notification_rules.written).toBe(1);
    const historyWithErrors = await new PgNotificationsRepository({
      getDb: () => db,
    }).listDeliveriesForResource(
      wsOid.toHexString(),
      "flow",
      flowOid.toHexString(),
      100,
    );
    expect(
      historyWithErrors.find(row => row.idempotencyKey === "fresh")?.lastError,
    ).toBe("HTTP 500: before\0after");
    expect(first.notification_deliveries.written).toBe(2);
    expect(first.workflow_recorded_runs.written).toBe(1);
    expect(first.workflow_recorded_writes.written).toBe(1);
    expect(first.model_catalog_snapshots.written).toBe(4);
    const snapshots = await db.select().from(pgSchema.modelCatalogSnapshots);
    expect(snapshots.find(row => row.id === "capabilities")).toMatchObject({
      data: { thinkingModes: { a: "manual", b: "adaptive", c: "manual" } },
      itemCount: 3,
      fetchedAt: now,
    });
    expect(snapshots.find(row => row.id === "curation")).toMatchObject({
      data: { ...curation, lastRefreshError: "recent failure" },
      itemCount: 1,
    });
    expect(first.apps_box_policy.written).toBe(1);
    const [policy] = await db.select().from(pgSchema.appsBoxPolicy);
    expect(policy.since).toEqual(new Date(now.getTime() - 30 * DAY_MS));

    const rule = await pg.query<{
      id: string;
      resource_id: string;
      channel: Record<string, string>;
      created_by_user_id: string | null;
    }>(
      `SELECT id::text, resource_id::text, channel, created_by_user_id::text FROM notification_rules`,
    );
    expect(toWireId(rule.rows[0].id)).toBe(ruleOid.toHexString());
    expect(toWireId(rule.rows[0].resource_id)).toBe(flowOid.toHexString());
    expect(rule.rows[0].channel.urlEncrypted).toBe("iv:cipher-url");
    expect(rule.rows[0].channel.signingSecretEncrypted).toBe(
      "iv:cipher-secret",
    );
    expect(rule.rows[0].created_by_user_id).toBe(userId);

    const write = await pg.query<{ user_id: string }>(
      `SELECT user_id FROM workflow_recorded_writes`,
    );
    expect(write.rows).toEqual([{ user_id: "vera" }]);

    const compared = await backfillControlPlaneSmall({
      db,
      apply: false,
      replay: true,
      now,
    });
    expect(compared.notification_rules.parity).toMatchObject({
      matched: 1,
      different: 0,
      missingInPg: 0,
      pgOnly: 0,
    });
    expect(compared.notification_deliveries.parity).toMatchObject({
      matched: 2,
      different: 0,
    });
    expect(compared.workflow_recorded_runs.parity?.matched).toBe(1);
    expect(compared.workflow_recorded_writes.parity?.matched).toBe(1);
    expect(compared.apps_box_policy.parity?.matched).toBe(1);
    // Recovered capabilities and curation deliberately retain newer PG data.
    expect(compared.model_catalog_snapshots.parity).toMatchObject({
      matched: 2,
      different: 2,
      differentFields: { data: 2 },
    });

    const second = await backfillControlPlaneSmall({ db, apply: true, now });
    for (const r of Object.values(second)) {
      expect(r.written).toBe(0);
    }

    const rules = mongoose.connection.collection("notification_rules");
    const deliveries = mongoose.connection.collection(
      "notification_deliveries",
    );
    const changedAt = new Date(now.getTime() + 1);
    await rules.updateOne(
      { _id: ruleOid },
      {
        $set: {
          enabled: false,
          channel: { type: "email", recipients: ["test@example.com"] },
          updatedAt: changedAt,
        },
      },
    );
    await deliveries.updateOne(
      { idempotencyKey: "fresh" },
      {
        $set: {
          status: "sent",
          sentAt: changedAt,
          completedAt: changedAt,
          attempts: 1,
        },
      },
    );
    const catchup = await backfillControlPlaneSmall({ db, apply: true, now });
    expect(catchup.notification_rules.written).toBe(1);
    expect(catchup.notification_deliveries.written).toBe(1);
    const [edited] = await db.select().from(pgSchema.notificationRules);
    expect(edited).toMatchObject({
      enabled: false,
      updatedAt: changedAt,
      channel: { type: "email", recipients: ["test@example.com"] },
    });
    await db
      .insert(pgSchema.notificationRules)
      .values({ ...edited, id: generateUuidv7(), importedFromMongo: false });
    await deliveries.deleteOne({ idempotencyKey: "wrong-workspace" });
    await rules.deleteOne({ _id: ruleOid });
    const dry = await backfillControlPlaneSmall({
      db,
      apply: false,
      reconcileDeletedRules: true,
      now,
    });
    expect(dry.notification_rules).toMatchObject({
      missingInMongo: 1,
    });
    const final = await backfillControlPlaneSmall({
      db,
      apply: true,
      reconcileDeletedRules: true,
      now,
    });
    expect(final.notification_rules).toMatchObject({
      missingInMongo: 1,
    });
    const remainingRules = await db.select().from(pgSchema.notificationRules);
    expect(remainingRules.map(r => r.importedFromMongo).sort()).toEqual([
      false,
      true,
    ]);
    const history = await db.select().from(pgSchema.notificationDeliveries);
    expect(history).toHaveLength(2);
    expect(history.find(d => d.idempotencyKey === "fresh")).toMatchObject({
      ruleId: edited.id,
      status: "sent",
      attempts: 1,
      completedAt: changedAt,
    });
    expect(history.find(d => d.idempotencyKey === "orphan")?.ruleId).toBe(
      objectIdToUuid(orphanRuleOid.toHexString()),
    );
    const repeat = await backfillControlPlaneSmall({
      db,
      apply: true,
      reconcileDeletedRules: true,
      now,
    });
    expect(Object.values(repeat).every(r => r.written === 0)).toBe(true);
    expect(repeat.notification_rules.missingInMongo).toBe(1);
  });

  it("copies multiple batches of large writes, including the exact TTL boundary", async () => {
    const cutoff = new Date(now.getTime() - 7 * DAY_MS);
    const request = {
      method: "POST",
      url: "https://fixture",
      headers: { "x-example": "a\u0000b" },
      body: "x".repeat(64_000),
    };
    const writes = Array.from({ length: 123 }, (_, seq) => ({
      _id: new Types.ObjectId(),
      workspaceId: wsOid,
      runId: "multi",
      seq,
      connectionId: flowOid,
      connection: "fixture",
      request,
      at: seq === 122 ? new Date(cutoff.getTime() - 1) : cutoff,
    }));
    await mongoose.connection
      .collection("workflow_recorded_writes")
      .insertMany(writes);
    const copied = await backfillControlPlaneSmall({ db, apply: true, now });
    expect(copied.workflow_recorded_writes.written).toBe(122);
    const rows = await pg.query<{ seq: number; header: string; size: number }>(
      "SELECT seq, request->'headers'->>'x-example' AS header, length(request->>'body') AS size FROM workflow_recorded_writes WHERE run_id = 'multi' ORDER BY seq",
    );
    expect(rows.rows.map(r => r.seq)).toEqual(
      writes.slice(0, 122).map(w => w.seq),
    );
    expect(rows.rows.every(r => r.header === "ab" && r.size === 64000)).toBe(
      true,
    );
    const repeated = await backfillControlPlaneSmall({ db, apply: true, now });
    expect(repeated.workflow_recorded_writes.written).toBe(0);
    const report = await backfillControlPlaneSmall({
      db,
      apply: false,
      replay: true,
      now,
    });
    expect(report.workflow_recorded_writes.parity).toMatchObject({
      matched: 123,
      different: 0,
      pgOnly: 0,
      missingInPg: 0,
    });
  });

  it("audits post-switch PG edits, deletions and target-only rows without changing them", async () => {
    const rules = mongoose.connection.collection("notification_rules");
    const original = {
      workspaceId: wsOid,
      resourceType: "flow",
      resourceId: flowOid,
      enabled: true,
      triggers: ["failure"],
      channel: { type: "email", recipients: ["source@example.com"] },
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    const sourceDeletedInPg = new Types.ObjectId();
    await rules.insertMany([
      { ...original, _id: ruleOid },
      { ...original, _id: sourceDeletedInPg },
    ]);
    await backfillControlPlaneSmall({ db, apply: true, now });
    const editedId = objectIdToUuid(ruleOid.toHexString());
    const deletedId = objectIdToUuid(sourceDeletedInPg.toHexString());
    // Equal timestamps are enough to expose an accidental replay upsert.
    await pg.query(
      "UPDATE notification_rules SET enabled=false, updated_at=$2 WHERE id=$1",
      [editedId, now.toISOString()],
    );
    await pg.query("DELETE FROM notification_rules WHERE id=$1", [deletedId]);
    await pg.exec(`
      UPDATE notification_deliveries SET attempts=42 WHERE idempotency_key='fresh';
      UPDATE workflow_recorded_runs SET count=99 WHERE run_id='r1';
      UPDATE workflow_recorded_writes SET request='{}' WHERE run_id='r1';
      UPDATE model_catalog_snapshots SET data='[]' WHERE id='gateway';
      UPDATE apps_box_policy SET since=since + interval '1 day';
    `);
    await expect(
      backfillControlPlaneSmall({ db, apply: true, replay: true, now }),
    ).rejects.toThrow(/mutually exclusive/);
    const first = await backfillControlPlaneSmall({
      db,
      apply: false,
      replay: true,
      now,
    });
    expect(first.notification_rules.parity).toMatchObject({
      missingInPg: 1,
      pgOnly: 1,
      different: 1,
      differentFields: { enabled: 1 },
    });
    expect(first.notification_deliveries.parity?.differentFields.attempts).toBe(
      1,
    );
    expect(first.workflow_recorded_runs.parity?.differentFields.count).toBe(1);
    expect(first.workflow_recorded_writes.parity?.differentFields.request).toBe(
      1,
    );
    expect(
      first.model_catalog_snapshots.parity?.differentFields.data,
    ).toBeGreaterThan(0);
    expect(first.apps_box_policy.parity?.differentFields.since).toBe(1);
    expect(Object.values(first).every(report => report.written === 0)).toBe(
      true,
    );
    expect(
      await backfillControlPlaneSmall({ db, apply: false, replay: true, now }),
    ).toEqual(first);
    const saved = await pg.query<{ id: string; enabled: boolean }>(
      "SELECT id,enabled FROM notification_rules WHERE id IN ($1,$2)",
      [editedId, deletedId],
    );
    expect(saved.rows).toEqual([{ id: editedId, enabled: false }]);
    expect(JSON.stringify(first)).not.toContain("source@example.com");
  });
  it("requires an exact approved BSON archive for each missing-workspace row", async () => {
    const parent = new Types.ObjectId();
    const workspaceId = objectIdToUuid(parent.toHexString());
    const cases = [
      ["notification_rules", { resourceId: flowOid }],
      [
        "notification_deliveries",
        { resourceId: flowOid, ruleId: ruleOid, createdAt: now },
      ],
      ["workflow_recorded_runs", { runId: "orphan", count: 1, at: now }],
      [
        "workflow_recorded_writes",
        {
          runId: "orphan",
          connectionId: flowOid,
          seq: 0,
          request: { method: "GET" },
          at: now,
        },
      ],
    ] as const;
    const reports = () =>
      backfillControlPlaneSmall({ db, apply: false, replay: true, now });
    for (const [name, fields] of cases) {
      const doc = {
        _id: new Types.ObjectId(),
        workspaceId: parent,
        ...fields,
        extra: "private\0history",
      };
      await mongoose.connection.collection(name).insertOne(doc);
      await db.insert(pgSchema.migrationQuarantine).values({
        domain: "control-plane-small-v1",
        collectionName: name,
        mongoId: doc._id.toHexString(),
        workspaceId,
        reason: "approved-orphan-workspace",
        payload: {
          bsonBase64: Buffer.from(BSON.serialize(doc)).toString("base64"),
        },
        resolvedAt: now,
      });
    }
    const ok = await reports();
    for (const [name] of cases) expect(ok[name].retainedOrphans).toBe(1);

    await mongoose.connection
      .collection("workspaces")
      .insertOne({ _id: parent });
    const live = await reports();
    for (const [name] of cases) {
      expect(live[name].skipped["source workspace missing in Postgres"]).toBe(
        1,
      );
    }
    await mongoose.connection
      .collection("workspaces")
      .deleteOne({ _id: parent });

    await mongoose.connection
      .collection("workflow_recorded_writes")
      .updateOne({ workspaceId: parent }, { $set: { extra: "changed" } });
    await pg.query(
      "UPDATE migration_quarantine SET resolved_at = NULL WHERE collection_name = 'workflow_recorded_runs' AND workspace_id = $1",
      [workspaceId],
    );
    const bad = await reports();
    expect(
      bad.workflow_recorded_writes.skipped["orphan workspace archive differs"],
    ).toBe(1);
    expect(
      bad.workflow_recorded_runs.skipped[
        "orphan workspace lacks a unique approved archive"
      ],
    ).toBe(1);
    expect(bad.workflow_recorded_writes.retainedOrphans).toBeUndefined();
  });
});
