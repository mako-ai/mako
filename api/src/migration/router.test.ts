import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../database/pg/client";
import { newDualId, objectIdToUuid } from "../database/pg/id-codec";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as schema from "../database/pg/schema";
import {
  MigrationRouter,
  purgeMigrationTombstones,
  recordMigrationTombstone,
} from "./router";
import { ShadowCompareRunner, type ShadowCompareEvent } from "./shadow-compare";
import type { SecondaryWriteFailureContext } from "./types";

describe("MigrationRouter (5-stage dual-run state machine)", () => {
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    pg = new PGlite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
  });

  beforeEach(async () => {
    setPgTestDb(db);
    await pg.exec(
      "DELETE FROM migration_domain_state; DELETE FROM migration_tombstones;",
    );
  });

  afterEach(() => {
    resetPgTestDb();
  });

  afterAll(async () => {
    await pg.close();
  });

  it("defaults to mongo_only and resolves workspace override over global default", async () => {
    const router = new MigrationRouter({ enablePubSub: false });
    const ws1 = newDualId();
    const ws2 = newDualId();

    expect((await router.getState("chat", ws1.oid)).mode).toBe("mongo_only");

    // Set global default
    await router.setDomainState({
      domain: "chat",
      mode: "dual_write_mongo_read",
      updatedBy: "ops",
    });
    expect((await router.getState("chat", ws1.oid)).mode).toBe(
      "dual_write_mongo_read",
    );
    expect((await router.getState("chat", ws2.oid)).mode).toBe(
      "dual_write_mongo_read",
    );

    // Override ws1 only (accepts 24-hex ObjectId or 36-char UUID interchangeably)
    await router.setDomainState({
      domain: "chat",
      workspaceId: ws1.oid,
      mode: "dual_write_pg_read",
      shadowSampleRate: 0.25,
    });

    const ws1ByOid = await router.getState("chat", ws1.oid);
    const ws1ByUuid = await router.getState("chat", ws1.uuid);
    const ws2State = await router.getState("chat", ws2.oid);

    expect(ws1ByOid.mode).toBe("dual_write_pg_read");
    expect(ws1ByOid.workspaceId).toBe(objectIdToUuid(ws1.oid));
    expect(ws1ByUuid.mode).toBe("dual_write_pg_read");
    expect(ws2State.mode).toBe("dual_write_mongo_read");
  });

  it("honors MIGRATION_FORCE_MONGO_ONLY kill switch without touching Postgres", async () => {
    const getDbSpy = vi.fn(() => db);
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: getDbSpy,
      isForceMongoOnly: () => true,
    });

    const state = await router.getState("auth");
    expect(state.mode).toBe("mongo_only");
    expect(getDbSpy).not.toHaveBeenCalled();

    const pgWrite = vi.fn(async () => "pg");
    const mongoWrite = vi.fn(async () => "mongo");
    const out = await router.executeWrite(
      { domain: "auth", operation: "create" },
      { mongo: mongoWrite, pg: pgWrite },
    );
    expect(out).toBe("mongo");
    expect(mongoWrite).toHaveBeenCalledTimes(1);
    expect(pgWrite).not.toHaveBeenCalled();
  });

  it("executes all 5 stages with exact read/write & shadow-compare semantics", async () => {
    const events: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      maxInflight: 8,
      onEvent: e => events.push(e),
    });
    const failures: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      shadowRunner,
      rng: () => 0.0, // Always sample when shadowSampleRate > 0
      onSecondaryFailure: async ctx => {
        failures.push(ctx);
      },
    });

    const ws = newDualId();
    const ctx = {
      domain: "apps_metadata" as const,
      operation: "getApp",
      workspaceId: ws.oid,
      entityId: "6745f6f4a1b2c3d4e5f60718",
    };

    // 1. mongo_only
    {
      const mongoR = vi.fn(async () => ({ id: "1", title: "A" }));
      const pgR = vi.fn(async () => ({ id: "1", title: "A" }));
      expect(await router.executeRead(ctx, { mongo: mongoR, pg: pgR })).toEqual(
        { id: "1", title: "A" },
      );
      expect(mongoR).toHaveBeenCalledTimes(1);
      expect(pgR).not.toHaveBeenCalled();
    }

    // 2. dual_write_mongo_read
    await router.setDomainState({
      domain: "apps_metadata",
      workspaceId: ws.oid,
      mode: "dual_write_mongo_read",
    });
    {
      const calls: string[] = [];
      const res = await router.executeWrite(ctx, {
        mongo: async () => {
          calls.push("mongo");
          return "mongo-ok";
        },
        pg: async () => {
          calls.push("pg");
          return "pg-ok";
        },
      });
      expect(res).toBe("mongo-ok");
      expect(calls).toEqual(["mongo", "pg"]);
    }

    // 3. dual_write_shadow_compare
    await router.setDomainState({
      domain: "apps_metadata",
      workspaceId: ws.oid,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    {
      const res = await router.executeRead(ctx, {
        mongo: async () => ({ id: "1", title: "Primary" }),
        pg: async () => ({ id: "1", title: "Drifted" }),
      });
      expect(res).toEqual({ id: "1", title: "Primary" });
      await shadowRunner.flush();
      expect(events).toHaveLength(1);
      expect(events[0].result).toBe("mismatch");
      expect(events[0].diffs.map(d => d.path)).toEqual(["title"]);
    }

    // 4. dual_write_pg_read (PG primary, Mongo secondary, reverse shadow compare)
    await router.setDomainState({
      domain: "apps_metadata",
      workspaceId: ws.oid,
      mode: "dual_write_pg_read",
      shadowSampleRate: 1,
    });
    {
      const calls: string[] = [];
      const writeRes = await router.executeWrite(ctx, {
        mongo: async () => {
          calls.push("mongo");
          return "mongo-res";
        },
        pg: async () => {
          calls.push("pg");
          return "pg-res";
        },
      });
      expect(writeRes).toBe("pg-res");
      expect(calls).toEqual(["pg", "mongo"]);

      const readRes = await router.executeRead(ctx, {
        mongo: async () => ({ id: "1", title: "Match" }),
        pg: async () => ({ id: "1", title: "Match" }),
      });
      expect(readRes).toEqual({ id: "1", title: "Match" });
      await shadowRunner.flush();
      expect(events).toHaveLength(2);
      expect(events[1].result).toBe("match");
    }

    // 5. pg_only
    await router.setDomainState({
      domain: "apps_metadata",
      workspaceId: ws.oid,
      mode: "pg_only",
    });
    {
      const mongoR = vi.fn(async () => "mongo");
      const pgR = vi.fn(async () => "pg");
      const mongoW = vi.fn(async () => "mongo");
      const pgW = vi.fn(async () => "pg");
      expect(await router.executeRead(ctx, { mongo: mongoR, pg: pgR })).toBe(
        "pg",
      );
      expect(await router.executeWrite(ctx, { mongo: mongoW, pg: pgW })).toBe(
        "pg",
      );
      expect(mongoR).not.toHaveBeenCalled();
      expect(mongoW).not.toHaveBeenCalled();
    }

    expect(failures).toHaveLength(0);
  });

  it("isolates secondary write errors and timeouts without failing primary requests", async () => {
    const failures: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      secondaryTimeoutMs: 40,
      onSecondaryFailure: async ctx => {
        failures.push(ctx);
      },
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    // Hard error on PG secondary
    const res1 = await router.executeWrite(
      { domain: "auth", operation: "createUser", entityId: "user_1" },
      {
        mongo: async () => ({ id: "user_1" }),
        pg: async () => {
          throw new Error("PG connection refused");
        },
      },
    );
    expect(res1).toEqual({ id: "user_1" });
    expect(failures).toHaveLength(1);
    expect(failures[0].target).toBe("pg");
    expect(failures[0].entityId).toBe("user_1");

    // Timeout on Mongo secondary during Stage 4
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
    });
    const res2 = await router.executeWrite(
      { domain: "auth", operation: "updateUser", entityId: "user_2" },
      {
        pg: async () => ({ id: "user_2" }),
        mongo: () => new Promise(resolve => setTimeout(resolve, 250)),
      },
    );
    expect(res2).toEqual({ id: "user_2" });
    expect(failures).toHaveLength(2);
    expect(failures[1].target).toBe("mongo");
    expect(String(failures[1].error)).toMatch(/timed out/);
  });

  it("propagates cache invalidation across instances via pub/sub", async () => {
    const routerA = new MigrationRouter({
      enablePubSub: true,
      cacheTtlMs: 60_000,
    });
    const routerB = new MigrationRouter({
      enablePubSub: true,
      cacheTtlMs: 60_000,
    });

    try {
      await routerB.startInvalidationListener();
      // Prime routerB cache with mongo_only
      expect((await routerB.getState("usage_stats")).mode).toBe("mongo_only");

      // Flip state through routerA -> pub/sub invalidates routerB immediately
      await routerA.setDomainState({
        domain: "usage_stats",
        mode: "dual_write_pg_read",
      });

      expect((await routerB.getState("usage_stats")).mode).toBe(
        "dual_write_pg_read",
      );
    } finally {
      await routerA.stopInvalidationListener();
      await routerB.stopInvalidationListener();
    }
  });

  it("records and purges delete tombstones", async () => {
    const id = newDualId().uuid;
    await recordMigrationTombstone("chats", id, db);
    await recordMigrationTombstone("chats", id.toUpperCase(), db); // idempotent upsert

    const rows = await db.select().from(schema.migrationTombstones);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(id);

    // Purging with a future cutoff clears it
    await purgeMigrationTombstones("chats", new Date(Date.now() + 60_000), db);
    expect(await db.select().from(schema.migrationTombstones)).toHaveLength(0);
  });
});
