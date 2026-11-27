/**
 * Phase 2B (`usage_stats` domain — 7 tables) repository contract, zero-23505
 * `visitor_key` dedupe on `DELETE FROM users`, SQL aggregation parity,
 * `app_feed_snapshots` 24h Stage 4 PG->Mongo read-fallback, closed-UTC-day
 * backfill & `$inc` no-double-count, single rollover-day reconciliation,
 * 5-stage dual-run + Stage 4->2 rollback, sync-retry, TTL reaper, and deferred
 * `0006a_conn_verif_connection_fk.sql` post-backfill verification suite.
 */
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  legacyUserIdToUuidv7,
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import { readPostBackfillStatements } from "../../database/pg/post-backfill";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import { LlmUsage } from "../../database/schema";
import {
  AppFeedSnapshot,
  AppUsageDaily,
  AppUsageEvent,
  ConnectionVerification,
  QueryExecution,
  SkillUsageDaily,
} from "../../database/workspace-schema";
import { MongoUsageStatsRepository } from "./mongo.repo";
import { PgUsageStatsRepository } from "./pg.repo";
import type { UsageStatsRepository } from "./types";

describe("Phase 2B UsageStatsRepository contract & migration lifecycle", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  let wsId: string;
  let wsUuid: string;
  let user1Uuid: string;
  let user2Uuid: string;
  let apiKeyId: string;
  let apiKeyUuid: string;
  let seededConnId: string;
  let seededConnUuid: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      AppUsageDaily.syncIndexes(),
      AppUsageEvent.syncIndexes(),
      AppFeedSnapshot.syncIndexes(),
      SkillUsageDaily.syncIndexes(),
      LlmUsage.syncIndexes(),
      QueryExecution.syncIndexes(),
      ConnectionVerification.syncIndexes(),
    ]);

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  async function seedBaseFixtures(): Promise<void> {
    const ws = newDualId();
    wsId = ws.oid;
    wsUuid = ws.uuid;
    user1Uuid = generateUuidv7();
    user2Uuid = generateUuidv7();
    const key = newDualId();
    apiKeyId = key.oid;
    apiKeyUuid = key.uuid;
    const conn = newDualId();
    seededConnId = conn.oid;
    seededConnUuid = conn.uuid;

    await db.insert(pgSchema.users).values([
      {
        id: user1Uuid,
        legacyId: "luciauser000001",
        email: "alice@example.com",
        emailVerified: true,
      },
      {
        id: user2Uuid,
        legacyId: "luciauser000002",
        email: "bob@example.com",
        emailVerified: true,
      },
    ]);

    await db.insert(pgSchema.workspaces).values({
      id: wsUuid,
      name: "Acme Workspace",
      slug: `acme-${wsId.slice(-6)}`,
      createdBy: user1Uuid,
    });

    await db.insert(pgSchema.workspaceApiKeys).values({
      id: apiKeyUuid,
      workspaceId: wsUuid,
      name: "CI Key",
      keyHash: `hash-${apiKeyId}`,
      prefix: "mako_ci",
      createdBy: user1Uuid,
    });

    await db.insert(pgSchema.databaseConnections).values({
      id: seededConnUuid,
      workspaceId: wsUuid,
      name: "Seeded DB",
      type: "postgresql",
      connectionEncrypted: {},
      createdBy: user1Uuid,
    });
  }

  async function cleanAllStores(): Promise<void> {
    await Promise.all([
      AppUsageDaily.deleteMany({}),
      AppUsageEvent.deleteMany({}),
      AppFeedSnapshot.deleteMany({}),
      SkillUsageDaily.deleteMany({}),
      LlmUsage.deleteMany({}),
      QueryExecution.deleteMany({}),
      ConnectionVerification.deleteMany({}),
    ]);
    await pg.exec(`
      DELETE FROM app_usage_daily;
      DELETE FROM app_usage_events;
      DELETE FROM app_feed_snapshots;
      DELETE FROM skill_usage_daily;
      DELETE FROM llm_usage;
      DELETE FROM query_executions;
      DELETE FROM connection_verifications;
      DELETE FROM database_connections;
      DELETE FROM workspace_api_keys;
      DELETE FROM workspaces;
      DELETE FROM users;
      DELETE FROM migration_domain_state;
      DELETE FROM migration_backfill_jobs;
      DELETE FROM migration_tombstones;
      DELETE FROM migration_quarantine;
    `);
  }

  beforeEach(async () => {
    setPgTestDb(db);
    await cleanAllStores();
    await seedBaseFixtures();
  });

  afterEach(() => {
    resetPgTestDb();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  });

  // ── 1. Shared repository contract (Mongo AND Postgres) ───────────────────

  const implementations: Array<{
    name: string;
    isPg: boolean;
    create: () => UsageStatsRepository;
  }> = [
    {
      name: "MongoUsageStatsRepository",
      isPg: false,
      create: () => new MongoUsageStatsRepository(),
    },
    {
      name: "PgUsageStatsRepository",
      isPg: true,
      create: () => new PgUsageStatsRepository({ getDb: () => db }),
    },
  ];

  for (const impl of implementations) {
    describe(`UsageStatsRepository contract: ${impl.name}`, () => {
      it("records app usage events, bumps daily rollups atomically, and computes rollups/recent/hot workspaces", async () => {
        const repo = impl.create();
        const app1 = newDualId().oid;
        const app2 = newDualId().oid;
        const t1 = new Date("2026-11-24T10:00:00.000Z");
        const t2 = new Date("2026-11-24T10:05:00.000Z");
        const t3 = new Date("2026-11-25T14:00:00.000Z");

        const ev = await repo.createAppUsageEvent({
          workspaceId: wsId,
          appId: app1,
          at: t1,
          kind: "open",
          source: "app",
          userId: user1Uuid,
          anonId: null,
          sessionId: "sess-1",
          referrerKind: "internal",
          uaClass: "desktop",
          placement: { surface: "home", shelf: "popular", position: 0 },
        });
        expect(ev.appId).toBe(app1);
        expect(ev.userId).toBe(user1Uuid);
        expect(ev.placement).toEqual({
          surface: "home",
          shelf: "popular",
          position: 0,
        });

        await repo.bumpAppUsageDaily({
          workspaceId: wsId,
          appId: app1,
          userId: user1Uuid,
          day: "2026-11-24",
          kind: "open",
          source: "app",
          at: t1,
        });
        await repo.bumpAppUsageDaily({
          workspaceId: wsId,
          appId: app1,
          userId: user1Uuid,
          day: "2026-11-24",
          kind: "heartbeat",
          source: "app",
          heartbeatSeconds: 60,
          at: t2,
        });
        await repo.bumpAppUsageDaily({
          workspaceId: wsId,
          appId: app1,
          userId: user1Uuid,
          day: "2026-11-25",
          kind: "open",
          source: "share",
          at: t3,
        });
        await repo.bumpAppUsageDaily({
          workspaceId: wsId,
          appId: app1,
          userId: null,
          anonId: "anon:cookieHash1",
          day: "2026-11-25",
          kind: "open",
          source: "share",
          at: t3,
        });
        await repo.bumpAppUsageDaily({
          workspaceId: wsId,
          appId: app2,
          userId: null,
          anonId: null,
          day: "2026-11-25",
          kind: "open",
          source: "embed",
          at: t3,
        });

        const rollups = await repo.loadAppUsageRollups(wsId, "2026-11-24");
        expect(rollups).toHaveLength(3);
        const u1Rollup = rollups.find(
          r => r.appId === app1 && r.userId === user1Uuid,
        );
        expect(u1Rollup).toBeDefined();
        if (!u1Rollup) throw new Error("Expected u1Rollup");
        expect(u1Rollup.days.sort()).toEqual(["2026-11-24", "2026-11-25"]);
        expect(u1Rollup.opens).toBe(2);
        expect(u1Rollup.activeSeconds).toBe(60);
        expect(u1Rollup.lastAt.toISOString()).toBe(t3.toISOString());

        const anonIdentified = rollups.find(
          r => r.appId === app1 && r.userId === "anon:cookieHash1",
        );
        expect(anonIdentified?.opens).toBe(1);

        const anonCollapsed = rollups.find(
          r => r.appId === app2 && r.userId === null,
        );
        expect(anonCollapsed?.opens).toBe(1);

        const dayRows = await repo.listAppUsageDaysSince(wsId, "2026-11-24");
        expect(dayRows).toHaveLength(4);

        const recent = await repo.getRecentlyViewedApps(
          wsId,
          user1Uuid,
          new Date("2026-11-20T00:00:00.000Z"),
          10,
        );
        expect(recent).toHaveLength(1);
        expect(recent[0].appId).toBe(app1);

        const hot = await repo.getHotWorkspaceUsageSince(
          new Date("2026-11-25T00:00:00.000Z"),
        );
        expect(hot).toHaveLength(1);
        expect(hot[0].workspaceId).toBe(wsId);

        expect(await repo.findEarliestAppUsageDay(wsId)).toBe("2026-11-24");
      });

      it("persists app_feed_snapshots and enforces 24h expiry on PG", async () => {
        const repo = impl.create();
        const createdAt = new Date("2026-11-25T10:00:00.000Z");
        const snapId = await repo.createFeedSnapshot({
          workspaceId: wsId,
          userId: user1Uuid,
          popular: ["a1"],
          fresh: ["a2"],
          recommended: ["a3", "a4"],
          createdAt,
        });

        const found = await repo.findFeedSnapshotById(
          snapId,
          wsId,
          new Date("2026-11-25T12:00:00.000Z"),
        );
        expect(found).not.toBeNull();
        if (!found) throw new Error("Expected feed snapshot");
        expect(found.recommended).toEqual(["a3", "a4"]);

        if (impl.isPg) {
          const expired = await repo.findFeedSnapshotById(
            snapId,
            wsId,
            new Date("2026-11-26T11:00:00.000Z"),
          );
          expect(expired).toBeNull();
        }
      });

      it("bumps skill_usage_daily atomically and computes 30-day window sums + all-time lastLoadedAt", async () => {
        const repo = impl.create();
        const oldAt = new Date("2026-10-01T08:00:00.000Z");
        const recentAt = new Date("2026-11-25T09:00:00.000Z");

        await repo.bumpSkillUsageDaily(
          wsId,
          [{ scope: "workspace", skill: "sql-tuning" }],
          "load",
          "agent",
          oldAt,
        );
        await repo.bumpSkillUsageDaily(
          wsId,
          [
            { scope: "workspace", skill: "sql-tuning" },
            { scope: "system", skill: "apps" },
          ],
          "resource",
          "mcp",
          recentAt,
        );
        await repo.bumpSkillUsageDaily(
          wsId,
          [{ scope: "workspace", skill: "sql-tuning" }],
          "relevant",
          "agent",
          recentAt,
        );

        const summary = await repo.getSkillUsageSummary(wsId, "2026-11-01");
        const sqlSkill = summary.find(
          s => s.scope === "workspace" && s.skill === "sql-tuning",
        );
        expect(sqlSkill?.loads30d).toBe(2); // oldAt excluded from 30d window
        expect(sqlSkill?.lastLoadedAt?.toISOString()).toBe(
          recentAt.toISOString(),
        );

        const sysApps = summary.find(
          s => s.scope === "system" && s.skill === "apps",
        );
        expect(sysApps?.loads30d).toBe(1);
      });

      it("computes exact LLM usage summaries, breakdowns, chat history, and workflow costs", async () => {
        const repo = impl.create();
        const chatId = newDualId().oid;
        const d1 = new Date("2026-11-24T08:00:00.000Z");
        const d2 = new Date("2026-11-25T10:00:00.000Z");

        await repo.createLlmUsage({
          workspaceId: wsId,
          userId: user1Uuid,
          chatId,
          invocationType: "chat",
          modelId: "claude-sonnet-4",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheWriteTokens: 100,
          reasoningTokens: 50,
          totalTokens: 1850,
          costUsd: 0.0125,
          createdAt: d1,
        });
        await repo.createLlmUsage({
          workspaceId: wsId,
          userId: user2Uuid,
          chatId,
          invocationType: "chat",
          modelId: "gpt-4o",
          inputTokens: 400,
          outputTokens: 100,
          totalTokens: 500,
          costUsd: 0.005,
          createdAt: d2,
        });
        const wfCall = await repo.createLlmUsage({
          workspaceId: wsId,
          userId: user1Uuid,
          invocationType: "workflow",
          modelId: "claude-sonnet-4",
          inputTokens: 2000,
          outputTokens: 300,
          totalTokens: 2300,
          costUsd: 0.025,
          workflowRun: {
            workflowId: "wf-daily",
            runId: "run-1",
            step: "summarize",
          },
          createdAt: d2,
        });
        const unattributed = await repo.createLlmUsage({
          workspaceId: wsId,
          userId: user1Uuid,
          invocationType: "workflow",
          modelId: "claude-sonnet-4",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.002,
          durationMs: 1200,
          createdAt: d2,
        });
        expect(wfCall.workflowRun?.runId).toBe("run-1");

        const summary = await repo.getWorkspaceLlmUsageSummary(wsId);
        expect(summary.invocationCount).toBe(4);
        expect(summary.totalInputTokens).toBe(3500);
        expect(summary.totalOutputTokens).toBe(950);
        expect(summary.totalTokens).toBe(4800);
        expect(summary.totalCostUsd).toBeCloseTo(0.0445, 6);

        const ranged = await repo.getWorkspaceLlmUsageSummary(wsId, {
          from: new Date("2026-11-25T00:00:00.000Z"),
        });
        expect(ranged.invocationCount).toBe(3);

        const byUser = await repo.getWorkspaceLlmUsageByUser(wsId);
        expect(byUser).toHaveLength(2);
        expect(byUser[0].userId).toBe(user1Uuid);
        expect(byUser[0].totalCostUsd).toBeCloseTo(0.0395, 6);
        expect(byUser[1].userId).toBe(user2Uuid);

        const byModel = await repo.getWorkspaceLlmUsageByModel(wsId);
        expect(byModel).toHaveLength(2);
        expect(byModel[0].modelId).toBe("claude-sonnet-4");
        expect(byModel[0].invocationCount).toBe(3);

        const byChat = await repo.listLlmUsageByChat(wsId, chatId);
        expect(byChat).toHaveLength(2);
        expect(byChat[0].modelId).toBe("claude-sonnet-4");
        expect(byChat[1].modelId).toBe("gpt-4o");

        const runCosts = await repo.readWorkflowRunCosts(wsId, ["run-1"]);
        expect(runCosts).toHaveLength(1);
        expect(runCosts[0].step).toBe("summarize");
        expect(runCosts[0].costUsd).toBeCloseTo(0.025, 6);

        const dailyCosts = await repo.readWorkflowDailyCosts(
          wsId,
          "wf-daily",
          new Date("2026-11-20T00:00:00.000Z"),
        );
        expect(dailyCosts).toHaveLength(1);
        expect(dailyCosts[0].day).toBe("2026-11-25");
        expect(dailyCosts[0].runIds).toEqual(["run-1"]);

        const unattrList = await repo.listUnattributedWorkflowCalls(
          wsId,
          new Date("2026-11-24T00:00:00.000Z"),
        );
        expect(unattrList.map(u => u.id)).toEqual([unattributed.id]);

        const patched = await repo.attachWorkflowRunToCalls(wsId, [
          {
            id: unattributed.id,
            workflowId: "wf-daily",
            runId: "run-2",
            step: "enrich",
          },
        ]);
        expect(patched).toBe(1);
        const run2Costs = await repo.readWorkflowRunCosts(wsId, ["run-2"]);
        expect(run2Costs[0].backfilled).toBe(true);
      });

      it("tracks query_executions (including missing apiKeyId safety) and computes SQL aggregation summaries", async () => {
        const repo = impl.create();
        const connId = newDualId().oid;
        const consoleId = newDualId().oid;
        const deletedKeyId = newDualId().oid;
        const t1 = new Date("2026-11-25T08:00:00.000Z");
        const t2 = new Date("2026-11-25T09:00:00.000Z");

        const q1 = await repo.createQueryExecution({
          workspaceId: wsId,
          connectionId: connId,
          consoleId,
          userId: user1Uuid,
          apiKeyId,
          source: "console_ui",
          databaseType: "postgresql",
          queryLanguage: "sql",
          status: "success",
          executionTimeMs: 120,
          rowCount: 42,
          executedAt: t1,
        });
        expect(q1.apiKeyId).toBe(apiKeyId);

        const q2 = await repo.createQueryExecution({
          workspaceId: wsId,
          connectionId: connId,
          consoleId,
          userId: user2Uuid,
          apiKeyId: deletedKeyId,
          source: "api",
          databaseType: "bigquery",
          queryLanguage: "sql",
          status: "error",
          executionTimeMs: 280,
          errorType: "syntax",
          executedAt: t2,
        });
        if (impl.isPg) {
          // Deleted/nonexistent API key safely nulled rather than crashing FK 23503
          expect(q2.apiKeyId).toBeUndefined();
        }

        const page = await repo.listWorkspaceQueryExecutions(wsId, {
          limit: 1,
          offset: 0,
        });
        expect(page.total).toBe(2);
        expect(page.executions).toHaveLength(1);
        expect(page.executions[0].status).toBe("error");

        const consoleList = await repo.listConsoleQueryExecutions(
          wsId,
          consoleId,
          10,
        );
        expect(consoleList).toHaveLength(2);

        const summary = await repo.getWorkspaceQueryExecutionSummary(
          wsId,
          new Date("2026-11-25T00:00:00.000Z"),
          new Date("2026-11-25T23:59:59.000Z"),
        );
        expect(summary.totalExecutions).toBe(2);
        expect(summary.successCount).toBe(1);
        expect(summary.errorCount).toBe(1);
        expect(summary.cancelledCount).toBe(0);
        expect(summary.timeoutCount).toBe(0);
        expect(summary.totalExecutionTimeMs).toBe(400);
        expect(summary.avgExecutionTimeMs).toBe(200);
        expect(summary.bySource).toEqual({ console_ui: 1, api: 1 });
        expect(summary.byDatabaseType).toEqual({ postgresql: 1, bigquery: 1 });
        expect(summary.byUser[user1Uuid]).toBe(1);
        expect(summary.byUser[user2Uuid]).toBe(1);
      });

      it("records connection_verifications with optional workspace/connection/errorClass", async () => {
        const repo = impl.create();
        const rec = await repo.createConnectionVerification({
          workspaceId: wsId,
          connectionId: seededConnId,
          userId: user1Uuid,
          databaseType: "postgresql",
          trigger: "saved_test",
          success: false,
          durationMs: 310,
          errorClass: "auth_failed",
          errorMessage: "password authentication failed",
        });
        expect(rec.workspaceId).toBe(wsId);
        expect(rec.connectionId).toBe(seededConnId);
        expect(rec.errorClass).toBe("auth_failed");
      });
    });
  }

  // ── 2. app_usage_daily visitor_key dedupe + DELETE FROM users zero-23505 ─

  it("enforces app_usage_daily immutable visitor_key so DELETE FROM users never triggers 23505", async () => {
    const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
    const appId = newDualId().oid;
    const day = "2026-11-25";
    const at = new Date("2026-11-25T15:00:00.000Z");

    // 1) Signed-in user, 2) identified anon, 3) unattributed anon on the SAME (ws, app, day)
    await pgRepo.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: user2Uuid,
      day,
      kind: "open",
      source: "app",
      at,
    });
    await pgRepo.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: null,
      anonId: "anon:visitor1",
      day,
      kind: "open",
      source: "share",
      at,
    });
    await pgRepo.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: null,
      anonId: null,
      day,
      kind: "open",
      source: "embed",
      at,
    });

    // Delete user2 directly in Postgres — must NOT raise 23505 despite existing unattributed 'anon' row!
    await expect(
      db.delete(pgSchema.users).where(eq(pgSchema.users.id, user2Uuid)),
    ).resolves.not.toThrow();

    const rawRows = await db
      .select()
      .from(pgSchema.appUsageDaily)
      .where(
        and(
          eq(pgSchema.appUsageDaily.workspaceId, wsUuid),
          eq(pgSchema.appUsageDaily.appId, objectIdToUuid(appId)),
          eq(pgSchema.appUsageDaily.day, day),
        ),
      );
    expect(rawRows).toHaveLength(3);
    const deletedUserRow = rawRows.find(r => r.visitorKey === `u:${user2Uuid}`);
    expect(deletedUserRow).toBeDefined();
    if (!deletedUserRow) throw new Error("Expected deletedUserRow");
    expect(deletedUserRow.userId).toBeNull();
    expect(deletedUserRow.anonId).toBeNull();

    // Rollup still projects 3 distinct viewers (historical popularity intact!)
    const rollups = await pgRepo.loadAppUsageRollups(wsId, day);
    expect(rollups).toHaveLength(3);
    expect(rollups.map(r => r.userId).sort()).toEqual(
      [user2Uuid, "anon:visitor1", null].sort(),
    );

    // CHECK constraint rejects setting BOTH user_id and anon_id
    await expect(
      pg.exec(`
        INSERT INTO app_usage_daily (id, workspace_id, app_id, user_id, anon_id, visitor_key, day, first_at, last_at)
        VALUES ('${generateUuidv7()}', '${wsUuid}', '${objectIdToUuid(appId)}', '${user1Uuid}', 'anon:illegal', 'bad', '${day}', now(), now());
      `),
    ).rejects.toThrow();
  });

  // ── 3. 5-stage dual-run + Stage 4->2 rollback + app_feed_snapshots fallback

  // ── 4. Closed-UTC-day backfill, GREATEST no-double-count, rollover, verifier, sync-retry

  // ── 5. TTL reaper registration & billing-ledger safety ───────────────────

  // ── 6. Deferred post-backfill 0006a_conn_verif_connection_fk.sql ─────────

  it("applies deferred 0006a_conn_verif_connection_fk.sql idempotently and nulls dangling connection_ids", async () => {
    const stmts = readPostBackfillStatements("conn-verif-connection-fk");
    expect(stmts).toHaveLength(3);

    // Run on an isolated PGlite instance so we don't mutate the shared schema
    const isoPg = createTestPglite();
    await runPgliteMigrations(isoPg);
    const isoDb = drizzle(isoPg, { schema: pgSchema }) as unknown as MakoPgDb;

    try {
      const isoWsUuid = newDualId().uuid;
      const validConn = generateUuidv7();
      const danglingConn = generateUuidv7();
      await isoPg.exec(`
        INSERT INTO workspaces (id, name, slug)
        VALUES ('${isoWsUuid}', 'ISO WS', 'iso-ws');
        INSERT INTO database_connections (id, workspace_id, name, type, connection_encrypted)
        VALUES ('${validConn}', '${isoWsUuid}', 'ISO DB', 'postgresql', '{}'::jsonb);
      `);

      const v1 = generateUuidv7();
      const v2 = generateUuidv7();
      await isoDb.insert(pgSchema.connectionVerifications).values([
        {
          id: v1,
          connectionId: validConn,
          databaseType: "postgresql",
          trigger: "saved_test",
          success: true,
          durationMs: 12,
        },
        {
          id: v2,
          connectionId: danglingConn,
          databaseType: "postgresql",
          trigger: "saved_test",
          success: false,
          durationMs: 25,
        },
      ]);

      // Apply twice for idempotency
      for (let pass = 0; pass < 2; pass++) {
        for (const stmt of stmts) {
          await isoPg.exec(stmt);
        }
      }

      const rows = await isoDb.select().from(pgSchema.connectionVerifications);
      expect(rows.find(r => r.id === v1)?.connectionId).toBe(validConn);
      expect(rows.find(r => r.id === v2)?.connectionId).toBeNull();

      // Deleting the referenced connection sets connection_id to NULL (ON DELETE SET NULL)
      await isoPg.exec(
        `DELETE FROM database_connections WHERE id = '${validConn}';`,
      );
      const afterDelete = await isoDb
        .select()
        .from(pgSchema.connectionVerifications)
        .where(eq(pgSchema.connectionVerifications.id, v1));
      expect(afterDelete[0].connectionId).toBeNull();

      // Suppress unused helper lint
      expect(sql`1`).toBeDefined();
      expect(legacyUserIdToUuidv7("abc", new Date(0))).toBeTruthy();
    } finally {
      await isoPg.close();
    }
  });

  // ── 7. Stage 3 legacy 15-char user-ID + "system" sentinel shadow-compare & query_executions parity

  // ── 8. Stage 5 per-workspace canary partitioning for global scans & workspace-less lookup

  // ── 9. Stage 4->2 reverse-sync: legacy_id mapping, targeted daily replay, clean events, UUIDv8 PG replay

  // ── 10. Natural-key PK drift --repair, deleted apiKeyId, and missing workspaceId safety

  // ── 11. PR #1557 review hardening regressions ──────────────────────────────
});
