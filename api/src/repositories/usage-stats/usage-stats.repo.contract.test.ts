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
import mongoose, { Types } from "mongoose";
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
import { getCurrentPeriodUsage } from "../../billing/billing.service";
import { usageReportingFunction } from "../../inngest/functions/usage-reporting";
import {
  clearBackfillRegistryForTests,
  currentUtcDay,
  listBackfillDomains,
  runBackfill,
} from "../../migration/backfill";
import { registerMigrationDomains } from "../../migration/domains";
import {
  USAGE_TTL_RULES,
  reconcileUsageRolloverDay,
  replayUsageStatsWriteToMongo,
  replayUsageStatsWriteToPg,
} from "../../migration/domains/usage-stats.backfill";
import { MigrationRouter } from "../../migration/router";
import {
  ShadowCompareRunner,
  type ShadowCompareEvent,
} from "../../migration/shadow-compare";
import {
  clearTtlRegistryForTests,
  listTtlRules,
  reapAllRegisteredTables,
} from "../../migration/ttl-reaper";
import type { SecondaryWriteFailureContext } from "../../migration/types";
import {
  clearVerifierRegistryForTests,
  runParityVerification,
} from "../../migration/verifier";
import {
  resetWorkspaceRepoForTests,
  setWorkspaceRepoForTests,
  type WorkspaceRepository,
} from "../workspaces";
import { readRunCosts } from "../../workflows/costs";
import {
  readUnattributedCalls,
  saveMatches,
} from "../../workflows/cost-backfill";
import { DualUsageStatsRepository, USAGE_STATS_DOMAIN } from "./dual.repo";
import {
  resetUsageStatsRepoForTests,
  setUsageStatsRepoForTests,
  usageStatsRepo,
} from "./index";
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

  it("walks all 5 dual-run stages, rollback 4->2, and Stage 4 app_feed_snapshots 24h PG->Mongo fallback", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const retryEvents: SecondaryWriteFailureContext[] = [];
    const shadowRunner = new ShadowCompareRunner({
      maxInflight: 8,
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
      shadowRunner,
      rng: () => 0.0,
      onSecondaryFailure: async ctx => {
        retryEvents.push(ctx);
      },
    });
    const dual = new DualUsageStatsRepository({
      router,
      getDb: () => db,
    });

    const appId = newDualId().oid;
    const at = new Date("2026-11-25T10:00:00.000Z");

    // Stage 1 (mongo_only): seed an ephemeral feed snapshot ONLY in Mongo
    const mongoOnlySnapId = await dual.createFeedSnapshot({
      workspaceId: wsId,
      userId: user1Uuid,
      popular: [appId],
      fresh: [],
      recommended: [],
      createdAt: at,
    });
    expect(
      await dual.pg.findFeedSnapshotById(mongoOnlySnapId, wsId, at),
    ).toBeNull();

    // Stage 2 (dual_write_mongo_read)
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    await dual.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: user1Uuid,
      day: "2026-11-25",
      kind: "open",
      source: "app",
      at,
    });
    expect(await dual.pg.loadAppUsageRollups(wsId, "2026-11-25")).toHaveLength(
      1,
    );

    // Stage 3 (dual_write_shadow_compare, 100%)
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    await dual.loadAppUsageRollups(wsId, "2026-11-25");
    await shadowRunner.flush();
    expect(shadowEvents.filter(e => e.result !== "match")).toHaveLength(0);

    // Stage 4 (dual_write_pg_read): PG->Mongo 24h fallback finds pre-cutover snapshot!
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_pg_read",
    });
    const fallbackHit = await dual.findFeedSnapshotById(
      mongoOnlySnapId,
      wsId,
      new Date("2026-11-25T14:00:00.000Z"),
    );
    expect(fallbackHit).not.toBeNull();
    if (!fallbackHit) throw new Error("Expected fallbackHit");
    expect(fallbackHit.popular).toEqual([appId]);

    // Rollback Stage 4 -> Stage 2: writes continue landing in both stores
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    await dual.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: user1Uuid,
      day: "2026-11-25",
      kind: "open",
      source: "app",
      at: new Date("2026-11-25T15:00:00.000Z"),
    });
    const pgAfterRollback = await dual.pg.loadAppUsageRollups(
      wsId,
      "2026-11-25",
    );
    expect(pgAfterRollback[0].opens).toBe(2);

    // Stage 5 (pg_only): NO fallback to Mongo for pre-cutover snapshot
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });
    expect(
      await dual.findFeedSnapshotById(
        mongoOnlySnapId,
        wsId,
        new Date("2026-11-25T16:00:00.000Z"),
      ),
    ).toBeNull();
    expect(retryEvents).toHaveLength(0);
  });

  // ── 4. Closed-UTC-day backfill, GREATEST no-double-count, rollover, verifier, sync-retry

  it("backfills strictly closed UTC days without double-counting, reconciles rollover day, verifies & repairs, and replays sync-retry", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });

    // app_feed_snapshots must NEVER be registered as a backfill domain
    const domains = listBackfillDomains();
    expect(domains).toContain("usage_stats");
    expect(domains).toContain("usage_stats:app_usage_daily");
    expect(domains).not.toContain("usage_stats:app_feed_snapshots");

    const appId = newDualId().oid;
    const connId = newDualId().oid;
    const closedDay = "2026-11-25";
    const openDay = new Date().toISOString().slice(0, 10);
    const closedAt = new Date("2026-11-25T18:00:00.000Z");
    const openAt = new Date();

    // Seed Mongo with closed-day AND open-day daily rollups + other 4 tables
    await AppUsageDaily.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        appId,
        userId: "luciauser000001",
        day: closedDay,
        opens: 7,
        activeSeconds: 300,
        sources: { app: 5, share: 2 },
        firstAt: closedAt,
        lastAt: closedAt,
      },
      {
        workspaceId: new Types.ObjectId(wsId),
        appId,
        userId: "luciauser000001",
        day: openDay,
        opens: 3,
        activeSeconds: 60,
        sources: { app: 3 },
        firstAt: openAt,
        lastAt: openAt,
      },
    ]);
    await SkillUsageDaily.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        scope: "workspace",
        skill: "pricing",
        source: "agent",
        day: closedDay,
        loads: 5,
        resourceReads: 2,
        relevantHits: 1,
        firstAt: closedAt,
        lastAt: closedAt,
      },
      {
        workspaceId: new Types.ObjectId(wsId),
        scope: "workspace",
        skill: "pricing",
        source: "agent",
        day: openDay,
        loads: 9,
        resourceReads: 0,
        relevantHits: 0,
        firstAt: openAt,
        lastAt: openAt,
      },
    ]);
    await AppUsageEvent.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      at: closedAt,
      kind: "open",
      source: "app",
      userId: "luciauser000001",
      uaClass: "desktop",
    });
    const llmDoc = await LlmUsage.create({
      workspaceId: new Types.ObjectId(wsId),
      userId: "luciauser000001",
      invocationType: "chat",
      modelId: "claude-sonnet-4",
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      costUsd: 0.01,
      createdAt: closedAt,
    });
    await QueryExecution.create({
      executedAt: closedAt,
      userId: "luciauser000001",
      workspaceId: new Types.ObjectId(wsId),
      connectionId: new Types.ObjectId(connId),
      source: "console_ui",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 45,
    });
    await ConnectionVerification.create({
      verifiedAt: closedAt,
      userId: "luciauser000001",
      workspaceId: new Types.ObjectId(wsId),
      connectionId: new Types.ObjectId(connId),
      databaseType: "postgresql",
      trigger: "saved_test",
      success: true,
      durationMs: 22,
    });

    // Run backfill TWICE — closed-day counters must NOT double-count, open day skipped!
    await runBackfill({ domain: USAGE_STATS_DOMAIN, workspaceId: wsId, db });
    await runBackfill({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      resetCursor: true,
      db,
    });

    const pgDaily = await db.select().from(pgSchema.appUsageDaily);
    expect(pgDaily).toHaveLength(1);
    expect(pgDaily[0].day).toBe(closedDay);
    expect(pgDaily[0].opens).toBe(7); // NOT 14!
    expect(pgDaily[0].userId).toBe(user1Uuid);
    expect(pgDaily[0].visitorKey).toBe(`u:${user1Uuid}`);

    const pgSkill = await db.select().from(pgSchema.skillUsageDaily);
    expect(pgSkill).toHaveLength(1);
    expect(pgSkill[0].day).toBe(closedDay);
    expect(pgSkill[0].loads).toBe(5); // NOT 10!

    // Verifier passes with 0 mismatches
    const verifyClean = await runParityVerification({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verifyClean.mismatched).toBe(0);
    expect(verifyClean.missingInPg).toBe(0);

    // Mutate PG row -> verifier detects drift -> --repair heals it
    await db
      .update(pgSchema.llmUsage)
      .set({ totalTokens: 999999 })
      .where(eq(pgSchema.llmUsage.id, objectIdToUuid(llmDoc._id.toString())));
    const verifyDrifted = await runParityVerification({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verifyDrifted.mismatched).toBe(1);
    const verifyRepaired = await runParityVerification({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      repair: true,
      db,
    });
    expect(verifyRepaired.repaired).toBe(1);
    const verifyAfter = await runParityVerification({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verifyAfter.mismatched).toBe(0);

    // Rollover-day reconciliation refuses open day by default, succeeds for closed day in both directions
    await expect(
      reconcileUsageRolloverDay({
        day: openDay,
        direction: "mongo_to_pg",
        workspaceId: wsId,
        db,
      }),
    ).rejects.toThrow(/non-closed UTC day/);

    await AppUsageDaily.updateOne({ day: closedDay }, { $set: { opens: 11 } });
    const recToPg = await reconcileUsageRolloverDay({
      day: closedDay,
      direction: "mongo_to_pg",
      workspaceId: wsId,
      db,
    });
    expect(recToPg.appUsageReconciled).toBe(1);
    expect(recToPg.skillUsageReconciled).toBe(1);
    const pgAfterRec = await db.select().from(pgSchema.appUsageDaily);
    expect(pgAfterRec[0].opens).toBe(11);

    await db
      .update(pgSchema.appUsageDaily)
      .set({ opens: 15 })
      .where(eq(pgSchema.appUsageDaily.day, closedDay));
    const recToMongo = await reconcileUsageRolloverDay({
      day: closedDay,
      direction: "pg_to_mongo",
      workspaceId: wsId,
      db,
    });
    expect(recToMongo.appUsageReconciled).toBe(1);
    const mongoAfterRec = await AppUsageDaily.findOne({
      day: closedDay,
      appId,
    }).lean();
    expect(mongoAfterRec?.opens).toBe(15);

    // Sync-retry replay (PG & Mongo directions)
    const retryLlm = await LlmUsage.create({
      workspaceId: new Types.ObjectId(wsId),
      userId: user1Uuid,
      invocationType: "chat",
      modelId: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.001,
    });
    await replayUsageStatsWriteToPg(
      {
        target: "pg",
        domain: USAGE_STATS_DOMAIN,
        operation: "createLlmUsage",
        workspaceId: wsId,
        entityId: retryLlm._id.toString(),
        payload: { table: "llm_usage", id: retryLlm._id.toString() },
        failedAt: new Date().toISOString(),
        errorMessage: "simulated secondary write error",
      },
      db,
    );
    const pgRetryRow = await db
      .select()
      .from(pgSchema.llmUsage)
      .where(eq(pgSchema.llmUsage.id, objectIdToUuid(retryLlm._id.toString())));
    expect(pgRetryRow).toHaveLength(1);

    await LlmUsage.deleteOne({ _id: retryLlm._id });
    await replayUsageStatsWriteToMongo(
      {
        target: "mongo",
        domain: USAGE_STATS_DOMAIN,
        operation: "createLlmUsage",
        workspaceId: wsId,
        entityId: retryLlm._id.toString(),
        payload: { table: "llm_usage", id: retryLlm._id.toString() },
        failedAt: new Date().toISOString(),
        errorMessage: "simulated reverse write error",
      },
      db,
    );
    expect(await LlmUsage.exists({ _id: retryLlm._id })).not.toBeNull();
  });

  // ── 5. TTL reaper registration & billing-ledger safety ───────────────────

  it("registers TTL rules ONLY for the 5 expiring tables and NEVER reaps llm_usage or app_usage_daily", async () => {
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });

    const rules = listTtlRules();
    const names = rules.map(r => r.tableName);
    for (const expected of USAGE_TTL_RULES) {
      expect(names).toContain(expected.tableName);
    }
    expect(names).not.toContain("llm_usage");
    expect(names).not.toContain("app_usage_daily");

    const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
    const now = new Date("2026-11-26T12:00:00.000Z");
    const veryOld = new Date("2024-01-01T00:00:00.000Z");
    const fresh = new Date("2026-11-26T11:00:00.000Z");
    const appId = newDualId().oid;
    const connId = newDualId().oid;

    // Seed old + fresh in all 7 tables
    await pgRepo.createFeedSnapshot({
      workspaceId: wsId,
      userId: user1Uuid,
      popular: [],
      fresh: [],
      recommended: [],
      createdAt: veryOld,
    });
    await pgRepo.createFeedSnapshot({
      workspaceId: wsId,
      userId: user1Uuid,
      popular: ["fresh"],
      fresh: [],
      recommended: [],
      createdAt: fresh,
    });
    await pgRepo.createQueryExecution({
      workspaceId: wsId,
      connectionId: connId,
      userId: user1Uuid,
      source: "api",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 10,
      executedAt: veryOld,
    });
    await pgRepo.createQueryExecution({
      workspaceId: wsId,
      connectionId: connId,
      userId: user1Uuid,
      source: "api",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 10,
      executedAt: fresh,
    });
    await pgRepo.createConnectionVerification({
      workspaceId: wsId,
      connectionId: connId,
      databaseType: "postgresql",
      trigger: "saved_test",
      success: true,
      durationMs: 10,
      verifiedAt: veryOld,
    });
    await pgRepo.createAppUsageEvent({
      workspaceId: wsId,
      appId,
      at: veryOld,
      kind: "open",
      source: "app",
      userId: user1Uuid,
      uaClass: "desktop",
    });
    await pgRepo.bumpSkillUsageDaily(
      wsId,
      [{ scope: "workspace", skill: "old" }],
      "load",
      "agent",
      veryOld,
    );
    await pgRepo.createLlmUsage({
      workspaceId: wsId,
      userId: user1Uuid,
      invocationType: "chat",
      modelId: "claude-sonnet-4",
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      costUsd: 0.01,
      createdAt: veryOld,
    });
    await pgRepo.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: user1Uuid,
      day: "2024-01-01",
      kind: "open",
      source: "app",
      at: veryOld,
    });

    await reapAllRegisteredTables({ db, now });

    expect(await db.select().from(pgSchema.appFeedSnapshots)).toHaveLength(1);
    expect(await db.select().from(pgSchema.queryExecutions)).toHaveLength(1);
    expect(
      await db.select().from(pgSchema.connectionVerifications),
    ).toHaveLength(0);
    expect(await db.select().from(pgSchema.appUsageEvents)).toHaveLength(0);
    expect(await db.select().from(pgSchema.skillUsageDaily)).toHaveLength(0);
    // Permanent tables untouched!
    expect(await db.select().from(pgSchema.llmUsage)).toHaveLength(1);
    expect(await db.select().from(pgSchema.appUsageDaily)).toHaveLength(1);
  });

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

  it("reconciles legacy 15-char user IDs and 'system' sentinels in Stage 3 shadow-compare with 0 mismatches", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      maxInflight: 16,
      onEvent: e => shadowEvents.push(e),
    });
    let getDbCalls = 0;
    const countedGetDb = () => {
      getDbCalls += 1;
      return db;
    };
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
      shadowRunner,
      rng: () => 0.0,
    });
    const dual = new DualUsageStatsRepository({
      router,
      getDb: countedGetDb,
    });

    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });

    const appId = newDualId().oid;
    const connId = newDualId().oid;
    const chatId = newDualId().oid;
    const consoleId = newDualId().oid;
    const at = new Date("2026-11-25T10:00:00.000Z");

    await dual.bumpAppUsageDaily({
      workspaceId: wsId,
      appId,
      userId: "luciauser000001",
      day: "2026-11-25",
      kind: "open",
      source: "app",
      at,
    });
    const snapId = await dual.createFeedSnapshot({
      workspaceId: wsId,
      userId: "luciauser000001",
      popular: [appId],
      fresh: [],
      recommended: [],
      createdAt: at,
    });
    await dual.createLlmUsage({
      workspaceId: wsId,
      userId: "luciauser000001",
      chatId,
      invocationType: "chat",
      modelId: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.005,
      createdAt: at,
    });
    await dual.createLlmUsage({
      workspaceId: wsId,
      userId: "system",
      chatId,
      invocationType: "workflow",
      modelId: "claude-sonnet-4",
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      costUsd: 0.0025,
      createdAt: at,
    });
    await dual.createQueryExecution({
      workspaceId: wsId,
      connectionId: connId,
      consoleId,
      userId: "luciauser000001",
      source: "console_ui",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 30,
      executedAt: at,
    });
    await dual.createQueryExecution({
      workspaceId: wsId,
      connectionId: connId,
      consoleId,
      userId: "system",
      source: "api",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 20,
      executedAt: at,
    });

    // Verify PG matches Mongo for userId: "system" filter and byUser.system summary!
    const mongoSys = await dual.mongo.listWorkspaceQueryExecutions(wsId, {
      userId: "system",
    });
    const pgSys = await dual.pg.listWorkspaceQueryExecutions(wsId, {
      userId: "system",
    });
    expect(mongoSys.total).toBe(1);
    expect(pgSys.total).toBe(1);
    const pgSummary = await dual.pg.getWorkspaceQueryExecutionSummary(
      wsId,
      new Date("2026-11-25T00:00:00.000Z"),
      new Date("2026-11-26T00:00:00.000Z"),
    );
    expect(pgSummary.byUser.system).toBe(1);

    // Unsampled Stage 3 read executes ZERO extra PG queries
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 0,
    });
    getDbCalls = 0;
    await dual.loadAppUsageRollups(wsId, "2026-11-25");
    await shadowRunner.flush();
    expect(getDbCalls).toBe(0);

    // 100% sampled Stage 3 reads across all 8 user-bearing reads -> 0 mismatches!
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    await dual.loadAppUsageRollups(wsId, "2026-11-25");
    await dual.listAppUsageDaysSince(wsId, "2026-11-25");
    await dual.findFeedSnapshotById(snapId, wsId, at);
    await dual.getWorkspaceLlmUsageByUser(wsId);
    await dual.listLlmUsageByChat(wsId, chatId);
    await dual.listWorkspaceQueryExecutions(wsId, { userId: "system" });
    await dual.listConsoleQueryExecutions(wsId, consoleId);
    await dual.getWorkspaceQueryExecutionSummary(
      wsId,
      new Date("2026-11-25T00:00:00.000Z"),
      new Date("2026-11-26T00:00:00.000Z"),
    );
    await shadowRunner.flush();

    expect(shadowEvents).toHaveLength(8);
    expect(shadowEvents.filter(e => e.result !== "match")).toEqual([]);
  });

  // ── 8. Stage 5 per-workspace canary partitioning for global scans & workspace-less lookup

  it("partitions getHotWorkspaceUsageSince and workspace-less findFeedSnapshotById for a Stage 5 workspace canary", async () => {
    const ws2 = newDualId();
    await db.insert(pgSchema.workspaces).values({
      id: ws2.uuid,
      name: "Non-Canary WS",
      slug: `non-canary-${ws2.oid.slice(-6)}`,
      createdBy: user1Uuid,
    });

    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    const dual = new DualUsageStatsRepository({
      router,
      getDb: () => db,
    });
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: null,
      mode: "mongo_only",
    });
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });

    const now = new Date("2026-11-26T10:00:00.000Z");
    const app1 = newDualId().oid;
    const app2 = newDualId().oid;

    // wsId writes PG ONLY; ws2 writes Mongo ONLY
    await dual.bumpAppUsageDaily({
      workspaceId: wsId,
      appId: app1,
      userId: user1Uuid,
      day: "2026-11-26",
      kind: "open",
      source: "app",
      at: now,
    });
    await dual.bumpAppUsageDaily({
      workspaceId: ws2.oid,
      appId: app2,
      userId: user1Uuid,
      day: "2026-11-26",
      kind: "open",
      source: "app",
      at: now,
    });
    const pgSnapId = await dual.createFeedSnapshot({
      workspaceId: wsId,
      userId: user1Uuid,
      popular: [app1],
      fresh: [],
      recommended: [],
      createdAt: now,
    });
    const mongoSnapId = await dual.createFeedSnapshot({
      workspaceId: ws2.oid,
      userId: user1Uuid,
      popular: [app2],
      fresh: [],
      recommended: [],
      createdAt: now,
    });
    // Stale Mongo snapshot for canary workspace (absent in PG) -> MUST NOT be returned!
    const staleCanarySnapId = await dual.mongo.createFeedSnapshot({
      workspaceId: wsId,
      userId: user1Uuid,
      popular: [app1],
      fresh: [],
      recommended: [],
      createdAt: now,
    });

    const hot = await dual.getHotWorkspaceUsageSince(
      new Date("2026-11-26T00:00:00.000Z"),
    );
    expect(hot.map(h => h.workspaceId).sort()).toEqual([wsId, ws2.oid].sort());

    expect(
      (await dual.findFeedSnapshotById(pgSnapId, undefined, now))?.popular,
    ).toEqual([app1]);
    expect(
      (await dual.findFeedSnapshotById(mongoSnapId, undefined, now))?.popular,
    ).toEqual([app2]);
    expect(
      await dual.findFeedSnapshotById(staleCanarySnapId, undefined, now),
    ).toBeNull();
  });

  // ── 9. Stage 4->2 reverse-sync: legacy_id mapping, targeted daily replay, clean events, UUIDv8 PG replay

  it("reverse-maps legacy_id cleanly in pg_to_mongo rollover/replay, scopes daily replay, omits extraneous id on events, and accepts UUIDv8 in PG replay", async () => {
    const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
    const app1 = newDualId().oid;
    const app2 = newDualId().oid;
    const connId = newDualId().oid;
    const day = "2026-11-24";
    const at = new Date("2026-11-24T12:00:00.000Z");

    // 1. reconcileUsageRolloverDay(pg_to_mongo) with different PG id + legacy Mongo userId -> NO duplicate Mongo doc!
    await AppUsageDaily.create({
      workspaceId: new Types.ObjectId(wsId),
      appId: app1,
      userId: "luciauser000001",
      day,
      opens: 2,
      activeSeconds: 60,
      sources: { app: 2 },
      firstAt: at,
      lastAt: at,
    });
    await pgRepo.bumpAppUsageDaily({
      workspaceId: wsId,
      appId: app1,
      userId: user1Uuid,
      day,
      kind: "open",
      source: "app",
      at,
    });
    await db
      .update(pgSchema.appUsageDaily)
      .set({ opens: 9 })
      .where(eq(pgSchema.appUsageDaily.day, day));
    await reconcileUsageRolloverDay({
      day,
      direction: "pg_to_mongo",
      workspaceId: wsId,
      db,
    });
    const docsAfterRollover = await AppUsageDaily.find({
      workspaceId: new Types.ObjectId(wsId),
      appId: app1,
      day,
    }).lean();
    expect(docsAfterRollover).toHaveLength(1);
    expect(docsAfterRollover[0].userId).toBe("luciauser000001");
    expect(docsAfterRollover[0].opens).toBe(9);

    // 2. Targeted replayUsageStatsWriteToMongo for app_usage_daily & skill_usage_daily does NOT clobber sibling rows!
    await AppUsageDaily.create({
      workspaceId: new Types.ObjectId(wsId),
      appId: app2,
      userId: "luciauser000001",
      day,
      opens: 77,
      activeSeconds: 700,
      sources: { app: 77 },
      firstAt: at,
      lastAt: at,
    });
    await pgRepo.bumpAppUsageDaily({
      workspaceId: wsId,
      appId: app2,
      userId: user1Uuid,
      day,
      kind: "open",
      source: "app",
      at,
    }); // PG has opens=1 for app2; Mongo has 77!
    await db
      .update(pgSchema.appUsageDaily)
      .set({ opens: 12 })
      .where(
        and(
          eq(pgSchema.appUsageDaily.appId, objectIdToUuid(app1)),
          eq(pgSchema.appUsageDaily.day, day),
        ),
      );
    await replayUsageStatsWriteToMongo(
      {
        target: "mongo",
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpAppUsageDaily",
        workspaceId: wsId,
        entityId: `${wsId}:${app1}:${day}`,
        payload: {
          table: "app_usage_daily",
          workspaceId: wsId,
          appId: app1,
          userId: user1Uuid,
          day,
        },
        failedAt: at.toISOString(),
        errorMessage: "simulated",
      },
      db,
    );
    expect(
      (await AppUsageDaily.findOne({ appId: app1, day }).lean())?.opens,
    ).toBe(12);
    // Sibling app2 untouched (still 77, NOT overwritten by PG's 1)!
    expect(
      (await AppUsageDaily.findOne({ appId: app2, day }).lean())?.opens,
    ).toBe(77);

    // Targeted skill_usage_daily replay leaves sibling skill untouched
    await SkillUsageDaily.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        scope: "workspace",
        skill: "target-skill",
        source: "agent",
        day,
        loads: 1,
        resourceReads: 0,
        relevantHits: 0,
        firstAt: at,
        lastAt: at,
      },
      {
        workspaceId: new Types.ObjectId(wsId),
        scope: "workspace",
        skill: "sibling-skill",
        source: "agent",
        day,
        loads: 55,
        resourceReads: 0,
        relevantHits: 0,
        firstAt: at,
        lastAt: at,
      },
    ]);
    await pgRepo.bumpSkillUsageDaily(
      wsId,
      [
        { scope: "workspace", skill: "target-skill" },
        { scope: "workspace", skill: "sibling-skill" },
      ],
      "load",
      "agent",
      at,
    );
    await db
      .update(pgSchema.skillUsageDaily)
      .set({ loads: 8 })
      .where(eq(pgSchema.skillUsageDaily.skill, "target-skill"));
    await replayUsageStatsWriteToMongo(
      {
        target: "mongo",
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpSkillUsageDaily",
        workspaceId: wsId,
        entityId: `${wsId}:${day}`,
        payload: {
          table: "skill_usage_daily",
          workspaceId: wsId,
          day,
          source: "agent",
          targets: [{ scope: "workspace", skill: "target-skill" }],
        },
        failedAt: at.toISOString(),
        errorMessage: "simulated",
      },
      db,
    );
    expect(
      (await SkillUsageDaily.findOne({ skill: "target-skill", day }).lean())
        ?.loads,
    ).toBe(8);
    expect(
      (await SkillUsageDaily.findOne({ skill: "sibling-skill", day }).lean())
        ?.loads,
    ).toBe(55);

    // 3. app_usage_events reverse replay: NO extraneous `id` string field + legacy_id mapped!
    const ev = await pgRepo.createAppUsageEvent({
      workspaceId: wsId,
      appId: app1,
      at,
      kind: "open",
      source: "app",
      userId: user1Uuid,
      uaClass: "desktop",
    });
    await replayUsageStatsWriteToMongo(
      {
        target: "mongo",
        domain: USAGE_STATS_DOMAIN,
        operation: "createAppUsageEvent",
        workspaceId: wsId,
        entityId: ev.id,
        payload: { table: "app_usage_events", id: ev.id, workspaceId: wsId },
        failedAt: at.toISOString(),
        errorMessage: "simulated",
      },
      db,
    );
    const rawEv = await AppUsageEvent.collection.findOne({
      _id: new Types.ObjectId(ev.id),
    });
    expect(rawEv).not.toBeNull();
    expect(rawEv?.userId).toBe("luciauser000001");
    expect(Object.prototype.hasOwnProperty.call(rawEv, "id")).toBe(false);

    // 4. llm_usage, query_executions, connection_verifications, app_feed_snapshots reverse-map legacy_id
    const qe = await pgRepo.createQueryExecution({
      workspaceId: wsId,
      connectionId: connId,
      userId: user1Uuid,
      source: "console_ui",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 12,
      executedAt: at,
    });
    await replayUsageStatsWriteToMongo(
      {
        target: "mongo",
        domain: USAGE_STATS_DOMAIN,
        operation: "createQueryExecution",
        workspaceId: wsId,
        entityId: qe.id,
        payload: { table: "query_executions", id: qe.id },
        failedAt: at.toISOString(),
        errorMessage: "simulated",
      },
      db,
    );
    expect(
      (await QueryExecution.findById(new Types.ObjectId(qe.id)).lean())?.userId,
    ).toBe("luciauser000001");

    // 5. replayUsageStatsWriteToPg accepts UUIDv8 IDs symmetrically!
    const mongoSnap = await AppFeedSnapshot.create({
      workspaceId: new Types.ObjectId(wsId),
      userId: "luciauser000001",
      popular: [app1],
      fresh: [],
      recommended: [],
      createdAt: at,
    });
    const snapUuidv8 = objectIdToUuid(mongoSnap._id.toString());
    await replayUsageStatsWriteToPg(
      {
        target: "pg",
        domain: USAGE_STATS_DOMAIN,
        operation: "createFeedSnapshot",
        workspaceId: wsUuid,
        entityId: snapUuidv8,
        payload: { table: "app_feed_snapshots", id: snapUuidv8 },
        failedAt: at.toISOString(),
        errorMessage: "simulated",
      },
      db,
    );
    expect(
      await pgRepo.findFeedSnapshotById(snapUuidv8, wsUuid, at),
    ).not.toBeNull();
  });

  // ── 10. Natural-key PK drift --repair, deleted apiKeyId, and missing workspaceId safety

  it("heals natural-key PK drift on daily tables, normalizes deleted apiKeyId in verifier, and nulls missing workspaceId on connection_verifications --repair", async () => {
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
    const appId = newDualId().oid;
    const connId = newDualId().oid;
    const closedDay = "2026-11-23";
    const at = new Date("2026-11-23T12:00:00.000Z");

    // Stage 1 Mongo daily docs (_id = ID_M) + Stage 2 PG rows (id = ID_P)
    await AppUsageDaily.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      userId: "luciauser000001",
      day: closedDay,
      opens: 4,
      activeSeconds: 120,
      sources: { app: 4 },
      firstAt: at,
      lastAt: at,
    });
    await pgRepo.bumpAppUsageDaily({
      id: newDualId().oid,
      workspaceId: wsId,
      appId,
      userId: user1Uuid,
      day: closedDay,
      kind: "open",
      source: "app",
      at,
    });

    await SkillUsageDaily.create({
      workspaceId: new Types.ObjectId(wsId),
      scope: "workspace",
      skill: "drift-skill",
      source: "agent",
      day: closedDay,
      loads: 3,
      resourceReads: 0,
      relevantHits: 0,
      firstAt: at,
      lastAt: at,
    });
    await pgRepo.bumpSkillUsageDaily(
      wsId,
      [{ scope: "workspace", skill: "drift-skill" }],
      "load",
      "agent",
      at,
    );

    // QueryExecution referencing a deleted apiKeyId (not in PG workspace_api_keys)
    const deletedApiKeyId = newDualId().oid;
    const qeDoc = await QueryExecution.create({
      executedAt: at,
      userId: "luciauser000001",
      apiKeyId: new Types.ObjectId(deletedApiKeyId),
      workspaceId: new Types.ObjectId(wsId),
      connectionId: new Types.ObjectId(connId),
      source: "api",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 18,
    });
    await pgRepo.createQueryExecution({
      id: qeDoc._id.toString(),
      executedAt: at,
      userId: "luciauser000001",
      apiKeyId: deletedApiKeyId,
      workspaceId: wsId,
      connectionId: connId,
      source: "api",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      executionTimeMs: 18,
    });

    // ConnectionVerification referencing a deleted workspaceId -> --repair nulls workspaceId without 23503!
    const deletedWsId = newDualId().oid;
    const cvDoc = await ConnectionVerification.create({
      verifiedAt: at,
      userId: "luciauser000001",
      workspaceId: new Types.ObjectId(deletedWsId),
      connectionId: new Types.ObjectId(connId),
      databaseType: "postgresql",
      trigger: "saved_test",
      success: true,
      durationMs: 15,
    });

    // Repair wsId tables (heals PK drift on both daily tables, 0 mismatch on deleted apiKeyId)
    const repairedWs = await runParityVerification({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      repair: true,
      db,
    });
    expect(repairedWs.repaired).toBe(2);
    const verifiedWs = await runParityVerification({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verifiedWs.missingInPg).toBe(0);
    expect(verifiedWs.mismatched).toBe(0);

    // Repair connection_verifications with deleted workspaceId -> NO 23503, stored with NULL workspace_id, verifies clean!
    const repairedCv = await runParityVerification({
      domain: `${USAGE_STATS_DOMAIN}:connection_verifications`,
      workspaceId: deletedWsId,
      repair: true,
      db,
    });
    expect(repairedCv.repaired).toBe(1);
    const pgCv = await db
      .select()
      .from(pgSchema.connectionVerifications)
      .where(
        eq(
          pgSchema.connectionVerifications.id,
          objectIdToUuid(cvDoc._id.toString()),
        ),
      );
    expect(pgCv).toHaveLength(1);
    expect(pgCv[0].workspaceId).toBeNull();
    const verifiedCv = await runParityVerification({
      domain: `${USAGE_STATS_DOMAIN}:connection_verifications`,
      workspaceId: deletedWsId,
      db,
    });
    expect(verifiedCv.missingInPg).toBe(0);
    expect(verifiedCv.mismatched).toBe(0);
  });

  // ── 11. PR #1557 review hardening regressions ──────────────────────────────

  it("routes billing getCurrentPeriodUsage and workflow cost-backfill through usageStatsRepo under pg_only (PR #1557 #4717291106 & #4717292781)", async () => {
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    const dual = new DualUsageStatsRepository({ router, getDb: () => db });
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });

    setUsageStatsRepoForTests(dual);
    try {
      const periodStart = new Date("2026-11-01T00:00:00.000Z");
      const callTime = new Date("2026-11-26T12:00:00.000Z");

      // Record LLM usage under pg_only (lands ONLY in PG; Mongo stays empty)
      await usageStatsRepo.createLlmUsage({
        workspaceId: wsId,
        userId: user1Uuid,
        invocationType: "chat",
        modelId: "claude-sonnet-4",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 12.25,
        createdAt: callTime,
      });
      const wfCall = await usageStatsRepo.createLlmUsage({
        workspaceId: wsId,
        userId: null,
        invocationType: "workflow",
        modelId: "claude-sonnet-4",
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        costUsd: 3.75,
        durationMs: 2_000,
        createdAt: callTime,
      });

      expect(await LlmUsage.countDocuments({})).toBe(0);

      // Billing getCurrentPeriodUsage reads exact PG totals under pg_only
      const periodUsage = await getCurrentPeriodUsage(wsId, periodStart);
      expect(periodUsage.totalCostUsd).toBeCloseTo(16.0, 6);
      expect(periodUsage.invocationCount).toBe(2);
      expect(periodUsage.totalTokens).toBe(2000);

      // Inngest usage-reporting computes exact PG overage cents under pg_only
      const prevBillingEnabled = process.env.BILLING_ENABLED;
      process.env.BILLING_ENABLED = "true";
      const claimedOverages: Array<{
        workspaceId: string;
        targetCents: number;
      }> = [];
      setWorkspaceRepoForTests({
        listPaidActiveBilling: async () => [
          {
            id: wsId,
            billing: {
              plan: "pro",
              stripeCustomerId: "cus_pg_only",
              stripeSubscriptionId: "sub_pg_only",
              currentPeriodStart: periodStart,
              usageQuotaUsd: 10,
              lastReportedOverageCents: 0,
              pendingReportedOverageCents: null,
              pendingMeterEventIdempotencyKey: null,
            },
          },
        ],
        claimPendingOverage: async (
          claimedWsId: string,
          _expectedLast: number,
          targetCents: number,
        ) => {
          claimedOverages.push({ workspaceId: claimedWsId, targetCents });
          // Return false so test stops before hitting live Stripe API
          return false;
        },
      } as unknown as WorkspaceRepository);
      try {
        await (
          usageReportingFunction as unknown as {
            fn: (ctx: {
              step: {
                run: <T>(name: string, f: () => Promise<T>) => Promise<T>;
              };
            }) => Promise<unknown>;
          }
        ).fn({
          step: { run: async (_name, f) => f() },
        });
      } finally {
        resetWorkspaceRepoForTests();
        if (prevBillingEnabled === undefined) {
          delete process.env.BILLING_ENABLED;
        } else {
          process.env.BILLING_ENABLED = prevBillingEnabled;
        }
      }
      // $16.00 PG spend - $10.00 included quota = $6.00 overage = 600 cents!
      expect(claimedOverages).toEqual([
        { workspaceId: wsId, targetCents: 600 },
      ]);

      // Workflow cost-backfill reads & attributes PG calls under pg_only
      const unattributed = await readUnattributedCalls(wsId, periodStart);
      expect(unattributed.map(c => c.id)).toEqual([wfCall.id]);

      const saved = await saveMatches(wsId, [
        {
          call: unattributed[0],
          step: {
            workflowId: "wf-billing",
            runId: "run-pg-only-1",
            step: "summarize",
            start: callTime.getTime() - 5_000,
            end: callTime.getTime() + 5_000,
          },
        },
      ]);
      expect(saved).toBe(1);
      expect(await readUnattributedCalls(wsId, periodStart)).toEqual([]);

      const runCosts = await readRunCosts(wsId, ["run-pg-only-1"]);
      expect(runCosts["run-pg-only-1"]?.costUsd).toBeCloseTo(3.75, 6);
      expect(runCosts["run-pg-only-1"]?.backfilled).toBe(true);
    } finally {
      resetUsageStatsRepoForTests();
    }
  });

  it("retains llm_usage billing ledger rows when a workspace is deleted and backfills deleted-workspace rows cleanly (PR #1557 #4717293269)", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
    const ephemeralWs = newDualId();
    await db.insert(pgSchema.workspaces).values({
      id: ephemeralWs.uuid,
      name: "Ephemeral Billing WS",
      slug: `eph-${ephemeralWs.oid.slice(-6)}`,
      createdBy: user1Uuid,
    });

    const recorded = await pgRepo.createLlmUsage({
      workspaceId: ephemeralWs.oid,
      userId: user1Uuid,
      invocationType: "chat",
      modelId: "claude-sonnet-4",
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      costUsd: 4.5,
      createdAt: new Date("2026-11-26T10:00:00.000Z"),
    });

    // Deleting the workspace must NOT cascade-delete its llm_usage billing ledger
    await db
      .delete(pgSchema.workspaces)
      .where(eq(pgSchema.workspaces.id, ephemeralWs.uuid));

    const remaining = await db
      .select()
      .from(pgSchema.llmUsage)
      .where(eq(pgSchema.llmUsage.id, objectIdToUuid(recorded.id)));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].workspaceId).toBe(ephemeralWs.uuid);

    // Backfill + parity verify also succeed for Mongo llm_usage rows of a deleted workspace
    const deletedWs = newDualId();
    await LlmUsage.create({
      workspaceId: new Types.ObjectId(deletedWs.oid),
      userId: "luciauser000001",
      invocationType: "chat",
      modelId: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 1.25,
      createdAt: new Date("2026-11-25T10:00:00.000Z"),
    });

    await runBackfill({
      domain: `${USAGE_STATS_DOMAIN}:llm_usage`,
      workspaceId: deletedWs.oid,
      db,
    });
    const verified = await runParityVerification({
      domain: `${USAGE_STATS_DOMAIN}:llm_usage`,
      workspaceId: deletedWs.oid,
      db,
    });
    expect(verified.missingInPg).toBe(0);
    expect(verified.mismatched).toBe(0);
  });

  it("handles deleted connection_id cleanly in backfill, verifier, and --repair after 0006a FK is attached (PR #1557 #4717295078)", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const isoPg = createTestPglite();
    await runPgliteMigrations(isoPg);
    const isoDb = drizzle(isoPg, { schema: pgSchema }) as unknown as MakoPgDb;

    try {
      // Apply deferred 0006a FK constraint BEFORE backfill & repair!
      for (const stmt of readPostBackfillStatements(
        "conn-verif-connection-fk",
      )) {
        await isoPg.exec(stmt);
      }

      const isoWs = newDualId();
      const validConn = newDualId();
      const deletedConn = newDualId();
      const at = new Date("2026-11-25T12:00:00.000Z");

      await isoDb.insert(pgSchema.users).values({
        id: user1Uuid,
        legacyId: "luciauser000001",
        email: "alice@example.com",
        emailVerified: true,
      });
      await isoDb.insert(pgSchema.workspaces).values({
        id: isoWs.uuid,
        name: "Post-0006a WS",
        slug: `post0006a-${isoWs.oid.slice(-6)}`,
        createdBy: user1Uuid,
      });
      await isoDb.insert(pgSchema.databaseConnections).values({
        id: validConn.uuid,
        workspaceId: isoWs.uuid,
        name: "Live DB",
        type: "postgresql",
        connectionEncrypted: {},
        createdBy: user1Uuid,
      });

      const validCvDoc = await ConnectionVerification.create({
        verifiedAt: at,
        userId: "luciauser000001",
        workspaceId: new Types.ObjectId(isoWs.oid),
        connectionId: new Types.ObjectId(validConn.oid),
        databaseType: "postgresql",
        trigger: "saved_test",
        success: true,
        durationMs: 10,
      });
      const deletedCvDoc = await ConnectionVerification.create({
        verifiedAt: at,
        userId: "luciauser000001",
        workspaceId: new Types.ObjectId(isoWs.oid),
        connectionId: new Types.ObjectId(deletedConn.oid),
        databaseType: "postgresql",
        trigger: "saved_test",
        success: false,
        durationMs: 35,
        errorClass: "network",
      });

      // Backfill with 0006a FK active succeeds (NO 23503!)
      await runBackfill({
        domain: `${USAGE_STATS_DOMAIN}:connection_verifications`,
        workspaceId: isoWs.oid,
        db: isoDb,
      });

      const pgRows = await isoDb
        .select()
        .from(pgSchema.connectionVerifications);
      expect(
        pgRows.find(r => r.id === objectIdToUuid(validCvDoc._id.toString()))
          ?.connectionId,
      ).toBe(validConn.uuid);
      expect(
        pgRows.find(r => r.id === objectIdToUuid(deletedCvDoc._id.toString()))
          ?.connectionId,
      ).toBeNull();

      // Verifier reports 0 mismatches for both valid & deleted connections
      const verified = await runParityVerification({
        domain: `${USAGE_STATS_DOMAIN}:connection_verifications`,
        workspaceId: isoWs.oid,
        db: isoDb,
      });
      expect(verified.missingInPg).toBe(0);
      expect(verified.mismatched).toBe(0);

      // Delete the PG row for deletedConn and run --repair -> NO 23503, heals cleanly!
      await isoDb
        .delete(pgSchema.connectionVerifications)
        .where(
          eq(
            pgSchema.connectionVerifications.id,
            objectIdToUuid(deletedCvDoc._id.toString()),
          ),
        );
      const repaired = await runParityVerification({
        domain: `${USAGE_STATS_DOMAIN}:connection_verifications`,
        workspaceId: isoWs.oid,
        repair: true,
        db: isoDb,
      });
      expect(repaired.repaired).toBe(1);

      const verifiedAfterRepair = await runParityVerification({
        domain: `${USAGE_STATS_DOMAIN}:connection_verifications`,
        workspaceId: isoWs.oid,
        db: isoDb,
      });
      expect(verifiedAfterRepair.missingInPg).toBe(0);
      expect(verifiedAfterRepair.mismatched).toBe(0);
    } finally {
      await isoPg.close();
    }
  });

  it("replays open-day dead-letter daily usage increments without overwriting live PG or Mongo bumps (PR #1557 #4717295799)", async () => {
    const pgRepo = new PgUsageStatsRepository({ getDb: () => db });
    const appId = newDualId().oid;
    const now = new Date("2026-11-27T14:00:00.000Z");
    const openDay = currentUtcDay(now);

    // Scenario A (app_usage_daily PG replay on open day):
    // Initial write landed in Mongo (opens = 5), missed PG (opens = 4), then a live
    // bump landed in both stores (Mongo = 6, PG = 5). Replaying the failed open delta
    // must increment PG to 6 instead of overwriting PG with a stale Mongo snapshot!
    await AppUsageDaily.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      userId: "luciauser000001",
      day: openDay,
      opens: 5,
      activeSeconds: 60,
      sources: { app: 5 },
      firstAt: new Date("2026-11-27T10:00:00.000Z"),
      lastAt: new Date("2026-11-27T13:00:00.000Z"),
    });
    for (let i = 0; i < 5; i++) {
      await pgRepo.bumpAppUsageDaily({
        workspaceId: wsId,
        appId,
        userId: user1Uuid,
        day: openDay,
        kind: "open",
        source: "app",
        at: new Date("2026-11-27T13:30:00.000Z"),
      });
    }

    await replayUsageStatsWriteToPg(
      {
        target: "pg",
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpAppUsageDaily",
        workspaceId: wsId,
        entityId: `${wsId}:${appId}:${openDay}`,
        payload: {
          table: "app_usage_daily",
          workspaceId: wsId,
          appId,
          userId: "luciauser000001",
          anonId: null,
          day: openDay,
          kind: "open",
          source: "app",
          at: new Date("2026-11-27T13:00:00.000Z").toISOString(),
        },
        failedAt: now.toISOString(),
        errorMessage: "simulated pg blip",
      },
      db,
      now,
    );
    const pgDailyAfterDelta = await db
      .select()
      .from(pgSchema.appUsageDaily)
      .where(
        and(
          eq(pgSchema.appUsageDaily.appId, objectIdToUuid(appId)),
          eq(pgSchema.appUsageDaily.day, openDay),
        ),
      );
    expect(pgDailyAfterDelta[0].opens).toBe(6);

    // Legacy open-day payload WITHOUT delta fields uses GREATEST(...) and NEVER regresses PG (6 -> 5)!
    await replayUsageStatsWriteToPg(
      {
        target: "pg",
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpAppUsageDaily",
        workspaceId: wsId,
        entityId: `${wsId}:${appId}:${openDay}`,
        payload: {
          table: "app_usage_daily",
          workspaceId: wsId,
          appId,
          userId: "luciauser000001",
          day: openDay,
        },
        failedAt: now.toISOString(),
        errorMessage: "simulated legacy payload",
      },
      db,
      now,
    );
    const pgDailyAfterLegacy = await db
      .select()
      .from(pgSchema.appUsageDaily)
      .where(
        and(
          eq(pgSchema.appUsageDaily.appId, objectIdToUuid(appId)),
          eq(pgSchema.appUsageDaily.day, openDay),
        ),
      );
    expect(pgDailyAfterLegacy[0].opens).toBe(6);

    // Scenario B (skill_usage_daily PG replay on open day):
    await SkillUsageDaily.create({
      workspaceId: new Types.ObjectId(wsId),
      scope: "workspace",
      skill: "open-day-skill",
      source: "agent",
      day: openDay,
      loads: 3,
      resourceReads: 0,
      relevantHits: 0,
      firstAt: new Date("2026-11-27T10:00:00.000Z"),
      lastAt: new Date("2026-11-27T13:00:00.000Z"),
    });
    for (let i = 0; i < 3; i++) {
      await pgRepo.bumpSkillUsageDaily(
        wsId,
        [{ scope: "workspace", skill: "open-day-skill" }],
        "load",
        "agent",
        new Date("2026-11-27T13:30:00.000Z"),
      );
    }

    await replayUsageStatsWriteToPg(
      {
        target: "pg",
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpSkillUsageDaily",
        workspaceId: wsId,
        entityId: `${wsId}:${openDay}`,
        payload: {
          table: "skill_usage_daily",
          workspaceId: wsId,
          day: openDay,
          kind: "load",
          source: "agent",
          at: new Date("2026-11-27T13:00:00.000Z").toISOString(),
          targets: [{ scope: "workspace", skill: "open-day-skill" }],
        },
        failedAt: now.toISOString(),
        errorMessage: "simulated pg blip",
      },
      db,
      now,
    );
    const pgSkillAfterDelta = await db
      .select()
      .from(pgSchema.skillUsageDaily)
      .where(
        and(
          eq(pgSchema.skillUsageDaily.skill, "open-day-skill"),
          eq(pgSchema.skillUsageDaily.day, openDay),
        ),
      );
    expect(pgSkillAfterDelta[0].loads).toBe(4);

    // Scenario C (Mongo reverse-replay on open day with delta preserves live increments):
    await replayUsageStatsWriteToMongo(
      {
        target: "mongo",
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpAppUsageDaily",
        workspaceId: wsId,
        entityId: `${wsId}:${appId}:${openDay}`,
        payload: {
          table: "app_usage_daily",
          workspaceId: wsId,
          appId,
          userId: user1Uuid,
          anonId: null,
          day: openDay,
          kind: "open",
          source: "app",
          at: new Date("2026-11-27T13:45:00.000Z").toISOString(),
        },
        failedAt: now.toISOString(),
        errorMessage: "simulated mongo blip",
      },
      db,
      now,
    );
    const mongoDailyAfterDelta = await AppUsageDaily.findOne({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      userId: "luciauser000001",
      day: openDay,
    }).lean();
    expect(mongoDailyAfterDelta?.opens).toBe(6);

    // Also verify DualUsageStatsRepository fails closed on transient PG override query error
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    await router.setDomainState({
      domain: USAGE_STATS_DOMAIN,
      workspaceId: null,
      mode: "dual_write_mongo_read",
    });
    const failingDual = new DualUsageStatsRepository({
      router,
      getDb: () => {
        throw new Error("simulated usage_stats PG blip");
      },
    });
    await expect(failingDual.getHotWorkspaceUsageSince(now)).rejects.toThrow(
      /simulated usage_stats PG blip/,
    );
  });
});
