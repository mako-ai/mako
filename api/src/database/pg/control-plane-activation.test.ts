import mongoose, { Types, type mongo } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  WorkflowRecordedRun,
  WorkflowRecordedWrite,
} from "../models/workflow-recorded-writes";
import {
  NotificationDelivery,
  NotificationRule,
} from "../models/notifications";
import { ModelCatalogSnapshot } from "../schema";
import { appsBoxPolicyRepo } from "../../repositories/control-plane-app";
import { notificationsRepo } from "../../repositories/notifications";
import { activateControlPlane } from "../../repositories/control-plane-fence";
import { warmCatalog } from "../../services/model-catalog.service";
import { keepRecordedWrite } from "../../workflows/recorded-writes";
import { copyAndVerifyControlPlane } from "./cli/backfill-control-plane-small";
import { resetPgTestDb, setPgTestDb, type MakoPgDb } from "./client";
import { newDualId, generateUuidv7 } from "./id-codec";
import { runPgliteMigrations } from "./migrate";
import * as schema from "./schema";
import { createTestPglite } from "./test-pglite";

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

// Observe a server command from a second session trying to acquire the fence.
// A timeout or an assumed Cloud Run request duration is not evidence of draining.
function nextFenceAttempt() {
  const client = mongoose.connection.getClient();
  return new Promise<void>(done => {
    const listener = (event: mongo.CommandStartedEvent) => {
      if (event.command.findAndModify !== "migration_writer_fences") return;
      client.off("commandStarted", listener);
      done();
    };
    client.on("commandStarted", listener);
  });
}

describe("live control-plane activation", () => {
  let mongo: MongoMemoryReplSet;
  let pg: PGlite;
  let db: MakoPgDb;
  const ws = newDualId();
  const connectionId = String(new Types.ObjectId());
  const now = new Date();
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(mongo.getUri(), { monitorCommands: true });
    await Promise.all([
      WorkflowRecordedRun.init(),
      WorkflowRecordedWrite.init(),
      NotificationRule.init(),
      NotificationDelivery.init(),
      ModelCatalogSnapshot.init(),
    ]);
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
    setPgTestDb(db);
    const user = generateUuidv7();
    await db
      .insert(schema.users)
      .values({ id: user, email: "writer@example.com" });
    await db.insert(schema.workspaces).values({
      id: ws.uuid,
      name: "Fixture",
      slug: "fixture",
      createdBy: user,
    });
  });
  beforeEach(async () => {
    vi.stubEnv("MAKO_CONTROL_PLANE_FENCE_V1", "1");
    await pg.exec("TRUNCATE migration_domain_state");
    await pg.exec(
      "TRUNCATE notification_rules, notification_deliveries, workflow_recorded_runs, workflow_recorded_writes, model_catalog_snapshots, apps_box_policy",
    );
    for (const name of [
      "migration_writer_fences",
      "notification_rules",
      "notification_deliveries",
      "workflow_recorded_runs",
      "workflow_recorded_writes",
      "modelcatalogsnapshots",
      "apps_box_policy",
    ]) {
      await mongoose.connection.collection(name).deleteMany({});
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    resetPgTestDb();
    await pg?.close();
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it("drains a recorded HTTP write, then routes late worker and startup mutations through PG", async () => {
    const rule = await notificationsRepo.createRule({
      workspaceId: ws.oid,
      resourceType: "flow",
      resourceId: connectionId,
      enabled: true,
      triggers: ["failure"],
      channel: { type: "email", recipients: ["fixture@example.com"] },
      createdBy: "fixture",
    });
    await notificationsRepo.ensurePendingDelivery({
      workspaceId: ws.oid,
      resourceType: "flow",
      resourceId: connectionId,
      runId: "flow-run",
      ruleId: rule.id,
      trigger: "failure",
      channelType: "email",
      idempotencyKey: "pending",
    });
    const inserted = signal(),
      finishInsert = signal(),
      gateEntered = signal(),
      finishGate = signal();
    const collection = WorkflowRecordedWrite.collection;
    const insert = collection.insertOne.bind(collection);
    vi.spyOn(collection, "insertOne").mockImplementationOnce(
      async (...args) => {
        inserted.resolve();
        await finishInsert.promise;
        return insert(...args);
      },
    );
    const oldRequest = keepRecordedWrite(
      ws.oid,
      { runId: "in-flight" },
      { _id: connectionId, name: "fixture" },
      {
        method: "POST",
        url: "https://fixture.invalid",
        headers: {},
        body: "last Mongo write",
      },
    );
    await inserted.promise;
    const contending = nextFenceAttempt();
    let entered = false;
    const activation = activateControlPlane(async at => {
      entered = true;
      gateEntered.resolve();
      await finishGate.promise;
      await copyAndVerifyControlPlane(db, at);
    });
    try {
      await contending;
      expect(entered).toBe(false);
      expect(await WorkflowRecordedRun.countDocuments()).toBe(0);
    } finally {
      finishInsert.resolve();
    }
    expect(await oldRequest).toBe("kept");
    await gateEntered.promise;
    const blocked = nextFenceAttempt();
    const worker = notificationsRepo.completeDelivery("pending", {
      status: "sent",
      completedAt: now,
      countAttempt: true,
    });
    const fetched = signal();
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: "fixture/m" + i,
      type: "language",
    }));
    vi.stubGlobal("fetch", async () => {
      fetched.resolve();
      return Response.json({ data });
    });
    const startup = warmCatalog();
    try {
      await Promise.all([blocked, fetched.promise]);
      expect(
        await NotificationDelivery.countDocuments({ status: "sent" }),
      ).toBe(0);
      expect(await ModelCatalogSnapshot.countDocuments()).toBe(0);
    } finally {
      finishGate.resolve();
    }
    expect(await activation).toBe("activated");
    expect(await worker).toBe(true);
    await startup;
    expect(
      (await db.select().from(schema.workflowRecordedRuns)).map(r => r.count),
    ).toEqual([1]);
    expect(
      (await db.select().from(schema.workflowRecordedWrites)).map(r => r.seq),
    ).toEqual([0]);
    expect(await WorkflowRecordedWrite.countDocuments()).toBe(1);
    expect(
      (await db.select().from(schema.notificationDeliveries))[0].status,
    ).toBe("sent");
    expect(
      await NotificationDelivery.countDocuments({ status: "pending" }),
    ).toBe(1);
    expect(
      (await db.select().from(schema.modelCatalogSnapshots))
        .map(r => r.id)
        .sort(),
    ).toEqual(["gateway", "gateway-raw", "pricing"]);
    expect(await ModelCatalogSnapshot.countDocuments()).toBe(0);
    expect(
      await activateControlPlane(async () => {
        throw Error("unexpected recopy");
      }),
    ).toBe("already active");
    // The activation image can boot and write using PG alone.
    vi.stubEnv("MAKO_CONTROL_PLANE_PG_ACTIVE", "1");
    const mongoLookup = vi.spyOn(mongoose.connection, "collection");
    expect(await appsBoxPolicyRepo.ensureSince("after-deploy", now)).toEqual(
      now,
    );
    expect(mongoLookup).not.toHaveBeenCalled();
  });

  it("refuses same-key content drift, rolls back PG and lets a waiting writer continue on Mongo", async () => {
    await appsBoxPolicyRepo.ensureSince("activity-tracking", now);
    await db
      .insert(schema.appsBoxPolicy)
      .values({ id: "activity-tracking", since: new Date(+now + 1000) });
    const entered = signal(),
      release = signal();
    const failure = expect(
      activateControlPlane(async at => {
        entered.resolve();
        await release.promise;
        await copyAndVerifyControlPlane(db, at);
      }),
    ).rejects.toMatchObject({
      phase: "before",
      reports: {
        apps_box_policy: {
          parity: {
            different: 1,
            differentFields: { since: 1 },
            missingInPg: 0,
            pgOnly: 0,
          },
        },
      },
    });
    await entered.promise;
    const waiting = nextFenceAttempt();
    const kept = keepRecordedWrite(
      ws.oid,
      { runId: "after-abort" },
      { _id: connectionId, name: "fixture" },
      { method: "POST", url: "https://fixture.invalid", headers: {} },
    );
    try {
      await waiting;
    } finally {
      release.resolve();
    }
    await failure;
    expect(await kept).toBe("kept");
    expect(
      await WorkflowRecordedWrite.countDocuments({ runId: "after-abort" }),
    ).toBe(1);
    expect(await db.select().from(schema.workflowRecordedWrites)).toHaveLength(
      0,
    );
    expect(await appsBoxPolicyRepo.readSince("activity-tracking")).toEqual(now);
    expect((await db.select().from(schema.appsBoxPolicy))[0].since).toEqual(
      new Date(+now + 1000),
    );
  });
  it("rolls back staged inserts on a post-copy content mismatch", async () => {
    await appsBoxPolicyRepo.ensureSince("activity-tracking", now);
    await pg.exec(`
      CREATE FUNCTION fixture_drift() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.since := NEW.since + interval '1 second'; RETURN NEW; END
      $$;
      CREATE TRIGGER fixture_drift BEFORE INSERT ON apps_box_policy FOR EACH ROW EXECUTE FUNCTION fixture_drift();
    `);
    try {
      await expect(
        activateControlPlane(at => copyAndVerifyControlPlane(db, at)),
      ).rejects.toMatchObject({
        phase: "after",
        reports: {
          apps_box_policy: {
            parity: { different: 1, differentFields: { since: 1 } },
          },
        },
      });
      expect(await db.select().from(schema.appsBoxPolicy)).toHaveLength(0);
      expect(await appsBoxPolicyRepo.ensureSince("second", now)).toEqual(now);
      expect(
        await mongoose.connection
          .collection("apps_box_policy")
          .countDocuments(),
      ).toBe(2);
    } finally {
      await pg.exec(
        "DROP TRIGGER fixture_drift ON apps_box_policy; DROP FUNCTION fixture_drift()",
      );
    }
  });
});
