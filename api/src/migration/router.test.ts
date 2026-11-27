import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
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
import { createTestPglite } from "../database/pg/test-pglite";
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
    pg = createTestPglite();
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

  it("preserves case-sensitive text PKs in tombstones (e.g. base64url desktop_auth_codes)", async () => {
    const codeA = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AaBbC";
    const codeB = "abcdefghIjKlMnOpQrStUvWxYz0123456789_-AaBbC";
    await recordMigrationTombstone("desktop_auth_codes", codeA, db);
    await recordMigrationTombstone("desktop_auth_codes", codeB, db);

    const rows = await db.select().from(schema.migrationTombstones);
    expect(rows.map(r => r.entityId).sort()).toEqual([codeA, codeB].sort());
  });

  it("serves stale cached state on transient PG refresh failure instead of split-braining to mongo_only", async () => {
    let shouldFail = false;
    const router = new MigrationRouter({
      enablePubSub: false,
      cacheTtlMs: 1,
      getDb: () => {
        if (shouldFail) throw new Error("transient neon blip");
        return db;
      },
    });

    await router.setDomainState({
      domain: "auth",
      mode: "pg_only",
    });

    // Warm cache with pg_only
    expect((await router.getState("auth")).mode).toBe("pg_only");

    // Expire cache and simulate transient PG failure
    await new Promise(resolve => setTimeout(resolve, 10));
    shouldFail = true;

    expect((await router.getState("auth")).mode).toBe("pg_only");
  });

  it("isolates throwing custom onSecondaryFailure hooks without failing the primary write", async () => {
    const router = new MigrationRouter({
      enablePubSub: false,
      onSecondaryFailure: async () => {
        throw new Error("custom dead-letter hook exploded");
      },
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    const result = await router.executeWrite(
      { domain: "auth", operation: "update", entityId: "u_99" },
      {
        mongo: async () => "primary-ok",
        pg: async () => {
          throw new Error("pg unavailable");
        },
      },
    );
    expect(result).toBe("primary-ok");
  });

  it("preserves stale fallback across invalidateCache on PG blips and fails closed on cold cache misses", async () => {
    let shouldFail = false;
    const router = new MigrationRouter({
      enablePubSub: false,
      cacheTtlMs: 60_000,
      getDb: () => {
        if (shouldFail) throw new Error("transient neon timeout");
        return db;
      },
    });

    const ws1 = newDualId();
    const wsUnseen = newDualId();

    // 1. Cold cache + PG outage -> fail closed (throw), never silently route to mongo_only
    shouldFail = true;
    await expect(router.getState("auth", ws1.oid)).rejects.toThrow(
      /transient neon timeout/,
    );
    shouldFail = false;

    // 2. Promote auth to pg_only and warm cache
    await router.setDomainState({
      domain: "auth",
      mode: "pg_only",
    });
    expect((await router.getState("auth")).mode).toBe("pg_only");
    expect((await router.getState("auth", ws1.oid)).mode).toBe("pg_only");

    // 3. Invalidation (e.g. canary override on another workspace) marks entries stale
    //    instead of deleting them -> immediate PG blip STILL serves pg_only!
    router.invalidateCache("auth");
    shouldFail = true;
    expect((await router.getState("auth")).mode).toBe("pg_only");
    expect((await router.getState("auth", ws1.oid)).mode).toBe("pg_only");
    // Even a previously unseen workspace falls back to cached auth::global instead of mongo_only
    expect((await router.getState("auth", wsUnseen.oid)).mode).toBe("pg_only");
  });

  it("prevents an in-flight SELECT from re-caching a stale stage after invalidation and subscribes eagerly", async () => {
    // Part A: in-flight SELECT race guarded by per-domain generation counter
    let releaseSlowQuery!: () => void;
    let slowQueryStarted!: () => void;
    const slowStartedPromise = new Promise<void>(resolve => {
      slowQueryStarted = resolve;
    });
    let interceptOnce = true;

    const router = new MigrationRouter({
      enablePubSub: false,
      cacheTtlMs: 60_000,
      getDb: () => {
        if (!interceptOnce) return db;
        interceptOnce = false;
        return {
          select: () => ({
            from: () => ({
              where: async () => {
                // Read row BEFORE rollback happens
                const rows = await db
                  .select()
                  .from(schema.migrationDomainState);
                slowQueryStarted();
                await new Promise<void>(resolve => {
                  releaseSlowQuery = resolve;
                });
                return rows;
              },
            }),
          }),
        } as unknown as MakoPgDb;
      },
    });

    // Seed DB with dual_write_pg_read (bypassing router so cache is empty)
    await db.insert(schema.migrationDomainState).values({
      domain: "chat",
      scopeKey: "global",
      workspaceId: null,
      mode: "dual_write_pg_read",
      shadowSampleRate: 0.5,
    });

    // Start slow read (captures pre-rollback snapshot)
    const inflightRead = router.getState("chat");
    await slowStartedPromise;

    // Rollback commits in DB and pub/sub invalidation fires while slow read is still in flight
    await db
      .update(schema.migrationDomainState)
      .set({ mode: "dual_write_mongo_read" });
    router.invalidateCache("chat");

    // Release slow query: returns the old mode to its own caller, but MUST NOT cache it
    releaseSlowQuery();
    expect((await inflightRead).mode).toBe("dual_write_pg_read");

    // Next read immediately observes the rollback without waiting for cacheTtlMs!
    expect((await router.getState("chat")).mode).toBe("dual_write_mongo_read");

    // Part B: eager pub/sub subscription at construction (without manual startInvalidationListener call)
    const routerA = new MigrationRouter({
      enablePubSub: true,
      cacheTtlMs: 60_000,
    });
    const routerB = new MigrationRouter({
      enablePubSub: true,
      cacheTtlMs: 60_000,
    });
    try {
      // Allow eager constructor subscription microtasks to settle
      await new Promise(resolve => setTimeout(resolve, 10));
      expect((await routerB.getState("connections")).mode).toBe("mongo_only");

      await routerA.setDomainState({
        domain: "connections",
        mode: "dual_write_pg_read",
      });
      expect((await routerB.getState("connections")).mode).toBe(
        "dual_write_pg_read",
      );
    } finally {
      await routerA.stopInvalidationListener();
      await routerB.stopInvalidationListener();
    }
  });

  it("preserves shadowSampleRate when omitted on stage transitions and rejects dual_write_shadow_compare with rate 0", async () => {
    const router = new MigrationRouter({ enablePubSub: false });

    // Reject entering dual_write_shadow_compare without a positive rate
    await expect(
      router.setDomainState({
        domain: "mcp",
        mode: "dual_write_shadow_compare",
      }),
    ).rejects.toThrow(/shadowSampleRate > 0/);
    await expect(
      router.setDomainState({
        domain: "mcp",
        mode: "dual_write_shadow_compare",
        shadowSampleRate: 0,
      }),
    ).rejects.toThrow(/shadowSampleRate > 0/);

    // Enter Stage 3 with 0.75 sample rate
    const s3 = await router.setDomainState({
      domain: "mcp",
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 0.75,
    });
    expect(s3.shadowSampleRate).toBe(0.75);

    // Promote to Stage 4 without passing shadowSampleRate -> MUST preserve 0.75
    const s4 = await router.setDomainState({
      domain: "mcp",
      mode: "dual_write_pg_read",
    });
    expect(s4.mode).toBe("dual_write_pg_read");
    expect(s4.shadowSampleRate).toBe(0.75);
    expect((await router.getState("mcp")).shadowSampleRate).toBe(0.75);

    // Roll back to Stage 3 without passing shadowSampleRate -> preserves existing 0.75
    const backToS3 = await router.setDomainState({
      domain: "mcp",
      mode: "dual_write_shadow_compare",
    });
    expect(backToS3.shadowSampleRate).toBe(0.75);

    // Explicitly passing 0 clears shadowSampleRate on non-Stage-3 modes
    const s4Zero = await router.setDomainState({
      domain: "mcp",
      mode: "dual_write_pg_read",
      shadowSampleRate: 0,
    });
    expect(s4Zero.shadowSampleRate).toBe(0);
    expect((await router.getState("mcp")).shadowSampleRate).toBe(0);
  });

  it("aborts timed-out secondary writes via AbortSignal and attaches idempotencyKey + updatedAt to retry context", async () => {
    const failures: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      secondaryTimeoutMs: 30,
      onSecondaryFailure: async ctx => {
        failures.push(ctx);
      },
    });

    await router.setDomainState({
      domain: "usage_stats",
      mode: "dual_write_mongo_read",
    });

    let receivedSignal: AbortSignal | undefined;
    let signalWasAbortedWhenHookRan = false;
    let committedDespiteAbort = false;
    const writeTs = new Date("2026-11-27T08:00:00.000Z");

    const res = await router.executeWrite(
      {
        domain: "usage_stats",
        operation: "incrementDaily",
        entityId: "stat_1",
        idempotencyKey: "idem-key-123",
        updatedAt: writeTs,
        retryPayload: { delta: 1 },
      },
      {
        mongo: async () => "primary-ok",
        pg: signal => {
          receivedSignal = signal;
          return new Promise<string>(resolve => {
            const t = setTimeout(() => {
              if (!signal?.aborted) {
                committedDespiteAbort = true;
              }
              resolve("pg-late");
            }, 80);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve("pg-aborted");
              },
              { once: true },
            );
          });
        },
        onSecondaryFailure: async ctx => {
          signalWasAbortedWhenHookRan = Boolean(receivedSignal?.aborted);
          failures.push(ctx);
        },
      },
    );

    expect(res).toBe("primary-ok");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(receivedSignal?.aborted).toBe(true);
    expect(signalWasAbortedWhenHookRan).toBe(true);
    expect(committedDespiteAbort).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0].timedOut).toBe(true);
    expect(failures[0].idempotencyKey).toBe("idem-key-123");
    expect(failures[0].updatedAt).toBe(writeTs.toISOString());

    // Non-timeout error generates a default UUIDv7 idempotencyKey and timedOut: false
    await router.executeWrite(
      { domain: "usage_stats", operation: "updateStat", entityId: "stat_2" },
      {
        mongo: async () => "ok",
        pg: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(failures).toHaveLength(2);
    expect(failures[1].timedOut).toBe(false);
    expect(failures[1].idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(failures[1].updatedAt).toBeDefined();
  });

  it("does not open a Redis subscriber on bare module import and does not re-subscribe after stopInvalidationListener", async () => {
    // 1. Bare import of router.ts with POSTGRES_URL + unreachable REDIS_URL must exit cleanly (no hang)
    const apiRoot = path.resolve(__dirname, "../..");
    const tsxBin = path.resolve(apiRoot, "../node_modules/.bin/tsx");
    const stdout = execFileSync(
      tsxBin,
      [
        "-e",
        'import { MigrationRouter, migrationRouter } from "./src/migration/router"; console.log("imported", Boolean(MigrationRouter && migrationRouter));',
      ],
      {
        cwd: apiRoot,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          POSTGRES_URL: "postgresql://localhost:5432/mako",
          REDIS_URL: "redis://127.0.0.1:1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(stdout).toContain("imported true");

    // 2. After stopInvalidationListener(), a late getState() must NOT re-open the subscriber
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
      await routerB.stopInvalidationListener();

      // Prime routerB cache AFTER stopping listener (must not re-subscribe)
      expect((await routerB.getState("dbt")).mode).toBe("mongo_only");

      // Broadcast from routerA -> routerB stays cached because listener remained stopped
      await routerA.setDomainState({
        domain: "dbt",
        mode: "dual_write_pg_read",
      });
      expect((await routerB.getState("dbt")).mode).toBe("mongo_only");
    } finally {
      await routerA.stopInvalidationListener();
      await routerB.stopInvalidationListener();
    }
  });

  it("closes its Redis publisher on stopInvalidationListener so short-lived CLIs exit cleanly", async () => {
    // Spin up a minimal RESP2 server that accepts ioredis INFO/PUBLISH/QUIT commands
    // and records every command sent by the child process.
    const receivedCommands: string[] = [];
    const server = net.createServer(socket => {
      let buf = "";
      socket.on("data", chunk => {
        buf += chunk.toString("utf8");
        while (buf.length > 0) {
          if (!buf.startsWith("*")) break;
          const firstCrlf = buf.indexOf("\r\n");
          if (firstCrlf === -1) break;
          const count = Number.parseInt(buf.slice(1, firstCrlf), 10);
          let pos = firstCrlf + 2;
          const args: string[] = [];
          let complete = true;
          for (let i = 0; i < count; i++) {
            if (buf[pos] !== "$") {
              complete = false;
              break;
            }
            const lenEnd = buf.indexOf("\r\n", pos);
            if (lenEnd === -1) {
              complete = false;
              break;
            }
            const len = Number.parseInt(buf.slice(pos + 1, lenEnd), 10);
            const argStart = lenEnd + 2;
            const argEnd = argStart + len;
            if (buf.length < argEnd + 2) {
              complete = false;
              break;
            }
            args.push(buf.slice(argStart, argEnd));
            pos = argEnd + 2;
          }
          if (!complete) break;
          buf = buf.slice(pos);

          const cmd = (args[0] ?? "").toUpperCase();
          receivedCommands.push(cmd);
          if (cmd === "INFO") {
            socket.write("$0\r\n\r\n");
          } else if (cmd === "PUBLISH") {
            socket.write(":1\r\n");
          } else if (cmd === "QUIT") {
            socket.write("+OK\r\n");
            socket.end();
          } else {
            socket.write("+OK\r\n");
          }
        }
      });
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected TCP server address");
    }

    const apiRoot = path.resolve(__dirname, "../..");
    const tsxBin = path.resolve(apiRoot, "../node_modules/.bin/tsx");
    const script = `
      import { drizzle } from "drizzle-orm/pglite";
      import { createTestPglite } from "./src/database/pg/test-pglite";
      import { runPgliteMigrations } from "./src/database/pg/migrate";
      import * as schema from "./src/database/pg/schema";
      import { MigrationRouter } from "./src/migration/router";
      import type { MakoPgDb } from "./src/database/pg/client";

      async function run() {
        const pg = createTestPglite();
        await runPgliteMigrations(pg);
        const db = drizzle(pg, { schema }) as unknown as MakoPgDb;
        const router = new MigrationRouter({
          enablePubSub: true,
          autoSubscribe: false,
          getDb: () => db,
          hasPg: () => true,
        });
        try {
          await router.setDomainState({
            domain: "mcp",
            mode: "dual_write_mongo_read",
            updatedBy: "test:redis-quit",
          });
        } finally {
          await router.stopInvalidationListener();
          await pg.close();
        }
        console.log("clean-exit-ok");
      }
      run().catch(err => {
        console.error(err);
        process.exitCode = 1;
      });
    `;

    try {
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(tsxBin, ["-e", script], {
          cwd: apiRoot,
          env: {
            ...process.env,
            REDIS_URL: `redis://127.0.0.1:${addr.port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", d => {
          stdout += String(d);
        });
        child.stderr.on("data", d => {
          stderr += String(d);
        });
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `Child hung waiting for Redis publisher socket to close (stdout=${stdout}, stderr=${stderr})`,
            ),
          );
        }, 10_000);
        child.on("close", code => {
          clearTimeout(timeout);
          resolve({ code, stdout, stderr });
        });
        child.on("error", err => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("clean-exit-ok");
      expect(receivedCommands).toContain("PUBLISH");
      expect(receivedCommands).toContain("QUIT");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
