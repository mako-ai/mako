/**
 * Phase 2A-2 (`consoles_charts` domain — 7 tables) repository contract,
 * 5-stage dual-run + rollback parity, pgvector + tsvector + trigram search,
 * UUIDv7/Lucia/sentinel user mapping, 10-stage 2-pass self-FK backfill,
 * legacy `"dashboard"` + orphan quarantine, parity verifier (`--repair`),
 * tombstone protection, sync-retry, sparse 90d TTL reaper, and post-backfill
 * `consoles-connection-fk` test suite.
 */
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
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
  vi,
} from "vitest";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  legacyUserIdToUuidv7,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import { runPostBackfillStep } from "../../database/pg/post-backfill";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import { User } from "../../database/schema";
import {
  ConsoleFolder,
  EntityVersion,
  Favourite,
  NotebookFolder,
  NotebookIndex,
  SavedConsole,
  ScheduledQueryRun,
  Workspace,
  WorkspaceMember,
} from "../../database/workspace-schema";
import { createRouter } from "../../openapi/core";
import { consoleSharingRoutes } from "../../routes/consoles/sharing";
import {
  clearBackfillRegistryForTests,
  listBackfillDomains,
  runBackfill,
} from "../../migration/backfill";
import { registerMigrationDomains } from "../../migration/domains";
import {
  SCHEDULED_QUERY_RUNS_TTL_MS,
  replaySyncToMongo,
  replaySyncToPg,
} from "../../migration/domains/consoles-charts.backfill";
import {
  MigrationRouter,
  recordMigrationTombstone,
} from "../../migration/router";
import {
  ShadowCompareRunner,
  type ShadowCompareEvent,
} from "../../migration/shadow-compare";
import {
  clearTtlRegistryForTests,
  listTtlRules,
  reapAllRegisteredTables,
} from "../../migration/ttl-reaper";
import type {
  MigrationMode,
  SecondaryWriteFailureContext,
} from "../../migration/types";
import {
  clearVerifierRegistryForTests,
  listVerifierDomains,
  runParityVerification,
} from "../../migration/verifier";
import { PgAuthRepository } from "../auth/pg.repo";
import {
  CONSOLES_CHARTS_DOMAIN,
  DualConsolesChartsRepository,
  MongoConsolesChartsRepository,
  PgConsolesChartsRepository,
  consolesChartsRepo,
  type ConsolesChartsRepository,
} from "./index";

/** Build a deterministic normalized 1536-dim embedding vector. */
function makeUnitVector(primaryAxis: number, secondaryAxis = 1): number[] {
  const vec = new Array<number>(1536).fill(0);
  vec[primaryAxis] = 0.9;
  vec[secondaryAxis] = 0.1;
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return vec.map(v => v / norm);
}

/** Generate a deterministic 24-hex ObjectId with an explicit 4-byte timestamp prefix. */
function makeOrderedOid(tsSeconds: number, suffixHex: string): string {
  const ts = tsSeconds.toString(16).padStart(8, "0");
  return `${ts}${suffixHex.padStart(16, "0").slice(0, 16)}`;
}

describe("Phase 2A-2 ConsolesChartsRepository contract & migration lifecycle", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  let wsId: string;
  let wsUuid: string;
  let ws2Id: string;
  let ws2Uuid: string;

  let userLuciaId: string;
  let userLuciaUuid: string;
  let userV7Id: string;
  let userV4Id: string;
  let userV4Uuid: string;

  let userLookupMap: Map<string, string>;
  let resolveUserUuid: (id: string) => Promise<string | null>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      User.syncIndexes(),
      Workspace.syncIndexes(),
      ConsoleFolder.syncIndexes(),
      SavedConsole.syncIndexes(),
      EntityVersion.syncIndexes(),
      NotebookFolder.syncIndexes(),
      NotebookIndex.syncIndexes(),
      Favourite.syncIndexes(),
      ScheduledQueryRun.syncIndexes(),
    ]);

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  }, 120_000);

  async function seedBaseFixtures(): Promise<void> {
    const createdAt = new Date("2026-11-01T10:00:00.000Z");

    userLuciaId = "lucia0123456789";
    userLuciaUuid = legacyUserIdToUuidv7(userLuciaId, createdAt);
    userV7Id = generateUuidv7();
    userV4Id = randomUUID();
    userV4Uuid = legacyUserIdToUuidv7(userV4Id, createdAt);

    userLookupMap = new Map<string, string>([
      [userLuciaId, userLuciaUuid],
      [userLuciaUuid, userLuciaUuid],
      [userV7Id, userV7Id],
      [userV4Id, userV4Uuid],
      [userV4Uuid, userV4Uuid],
    ]);
    resolveUserUuid = async (raw: string) => userLookupMap.get(raw) ?? null;

    const pgAuth = new PgAuthRepository({ getDb: () => db });
    await pgAuth.createUser({
      id: userLuciaId,
      email: "lucia@example.com",
      name: "Lucia User",
      createdAt,
    });
    await pgAuth.createUser({
      id: userV7Id,
      email: "v7@example.com",
      name: "UUIDv7 User",
      createdAt,
    });
    await pgAuth.createUser({
      id: userV4Id,
      email: "v4@example.com",
      name: "Legacy V4 User",
      createdAt,
    });

    wsId = new Types.ObjectId().toString();
    wsUuid = objectIdToUuid(wsId);
    ws2Id = new Types.ObjectId().toString();
    ws2Uuid = objectIdToUuid(ws2Id);

    await db.insert(pgSchema.workspaces).values([
      {
        id: wsUuid,
        name: "Primary Workspace",
        slug: `ws-${wsId.slice(-8)}`,
        createdBy: userV7Id,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: ws2Uuid,
        name: "Secondary Workspace",
        slug: `ws-${ws2Id.slice(-8)}`,
        createdBy: userV7Id,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
  }

  async function cleanAllStores(): Promise<void> {
    await Promise.all([
      User.deleteMany({}),
      Workspace.deleteMany({}),
      WorkspaceMember.deleteMany({}),
      ConsoleFolder.deleteMany({}),
      SavedConsole.deleteMany({}),
      EntityVersion.deleteMany({}),
      NotebookFolder.deleteMany({}),
      NotebookIndex.deleteMany({}),
      Favourite.deleteMany({}),
      ScheduledQueryRun.deleteMany({}),
    ]);
    await pg.exec(`
      DELETE FROM scheduled_query_runs;
      DELETE FROM favourites;
      DELETE FROM notebook_indexes;
      DELETE FROM notebook_folders;
      DELETE FROM entity_versions;
      DELETE FROM saved_consoles;
      DELETE FROM console_folders;
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

  // ── 1. Shared Repository Contract (Mongo AND Postgres) ───────────────────

  const implementations: Array<{
    name: string;
    isPg: boolean;
    create: () => ConsolesChartsRepository;
  }> = [
    {
      name: "MongoConsolesChartsRepository",
      isPg: false,
      create: () => new MongoConsolesChartsRepository(),
    },
    {
      name: "PgConsolesChartsRepository",
      isPg: true,
      create: () =>
        new PgConsolesChartsRepository({
          getDb: () => db,
          resolveUserUuid,
        }),
    },
  ];

  for (const impl of implementations) {
    describe(`ConsolesChartsRepository contract: ${impl.name}`, () => {
      it("covers console_folders CRUD, hierarchy, and cycle detection", async () => {
        const repo = impl.create();

        const root = await repo.createConsoleFolder({
          workspaceId: wsId,
          name: "Analytics",
          ownerId: userLuciaId,
          access: "workspace",
          isPrivate: false,
        });
        expect(root.name).toBe("Analytics");
        expect(root.parentId).toBeUndefined();
        expect(root.ownerId).toBe(impl.isPg ? userLuciaUuid : userLuciaId);

        const child = await repo.createConsoleFolder({
          workspaceId: wsId,
          name: "Revenue",
          parentId: root.id,
          ownerId: userV7Id,
          access: "private",
          isPrivate: true,
        });
        expect(child.parentId).toBe(root.id);

        const fetched = await repo.findConsoleFolderById(wsId, child.id);
        expect(fetched?.name).toBe("Revenue");

        const byIds = await repo.findConsoleFoldersByIds(wsId, [
          root.id,
          child.id,
        ]);
        expect(byIds).toHaveLength(2);

        const byName = await repo.findConsoleFolderByNameAndParent(
          wsId,
          "Revenue",
          root.id,
        );
        expect(byName?.id).toBe(child.id);

        const children = await repo.listChildConsoleFolders(wsId, root.id);
        expect(children.map(c => c.id)).toEqual([child.id]);

        expect(
          await repo.wouldCreateConsoleFolderCycle(wsId, root.id, child.id),
        ).toBe(true);
        expect(
          await repo.wouldCreateConsoleFolderCycle(wsId, root.id, root.id),
        ).toBe(true);
        expect(
          await repo.wouldCreateConsoleFolderCycle(wsId, child.id, root.id),
        ).toBe(false);

        const renamed = await repo.updateConsoleFolder(wsId, child.id, {
          name: "MRR",
          parentId: null,
        });
        expect(renamed?.name).toBe("MRR");
        expect(renamed?.parentId).toBeUndefined();

        expect(await repo.deleteConsoleFolder(wsId, child.id)).toBe(true);
        expect(await repo.findConsoleFolderById(wsId, child.id)).toBeNull();
      });

      it("covers saved_consoles CRUD, chartSpec, optimistic concurrency, schedules, and sentinels", async () => {
        const repo = impl.create();
        const folder = await repo.createConsoleFolder({
          workspaceId: wsId,
          name: "Reports",
          ownerId: userV7Id,
        });

        const connId = new Types.ObjectId().toString();
        const chartSpec = {
          type: "bar",
          xAxis: "month",
          yAxis: ["revenue"],
        };
        const created = await repo.createConsole({
          workspaceId: wsId,
          folderId: folder.id,
          connectionId: connId,
          databaseName: "analytics",
          name: "Monthly Revenue",
          description: "Monthly revenue rollup by region",
          code: "SELECT month, SUM(revenue) FROM invoices GROUP BY 1",
          language: "sql",
          chartSpec,
          resultsViewMode: "chart",
          createdBy: userLuciaId,
          owner_id: userV4Id,
          access: "workspace",
          isPrivate: false,
          isSaved: true,
          workspaceRole: "editor",
          sharedWith: [
            {
              userId: userV7Id,
              role: "viewer",
              addedAt: new Date("2026-11-02T00:00:00.000Z"),
              addedBy: userLuciaId,
            },
          ],
          path: "consoles/Reports/Monthly Revenue.sql",
          sourceBlobSha: "sha-001",
        });

        expect(created.chartSpec).toEqual(chartSpec);
        expect(created.resultsViewMode).toBe("chart");
        expect(created.connectionId).toBe(connId);
        expect(created.createdBy).toBe(impl.isPg ? userLuciaUuid : userLuciaId);
        expect(created.owner_id).toBe(impl.isPg ? userV4Uuid : userV4Id);
        expect(created.sharedWith[0].userId).toBe(userV7Id);
        expect(created.sharedWith[0].addedBy).toBe(
          impl.isPg ? userLuciaUuid : userLuciaId,
        );

        // Non-user sentinels ("git", "system", "agent") persist cleanly without FK errors.
        const sentinelConsole = await repo.createConsole({
          workspaceId: wsId,
          name: "Git Synced",
          code: "SELECT 1",
          language: "sql",
          createdBy: "git",
          owner_id: "unowned:ghost",
          isSaved: true,
        });
        expect(sentinelConsole.createdBy).toBe(impl.isPg ? "" : "git");
        expect(sentinelConsole.owner_id).toBe(
          impl.isPg ? undefined : "unowned:ghost",
        );

        // Lookup helpers
        expect((await repo.findConsoleByIdGlobal(created.id))?.id).toBe(
          created.id,
        );
        expect(
          (
            await repo.findConsoleByPath(
              wsId,
              "consoles/Reports/Monthly Revenue.sql",
              { isSavedOnly: true },
            )
          )?.id,
        ).toBe(created.id);
        expect(
          (
            await repo.findConsoleByNameAndFolder(
              wsId,
              "Monthly Revenue",
              folder.id,
              { isSavedOnly: true },
            )
          )?.id,
        ).toBe(created.id);

        // Optimistic concurrency via guardedSaveConsole
        const savedOk = await repo.guardedSaveConsole({
          workspaceId: wsId,
          consoleId: created.id,
          expectedVersion: 1,
          expectedDraftRevision: 1,
          upsert: false,
          set: { code: "SELECT 42", updatedAt: new Date() },
          incVersion: 1,
          incDraftRevision: 1,
        });
        expect(savedOk?.version).toBe(2);
        expect(savedOk?.draftRevision).toBe(2);

        // Stale version fails atomically (returns null)
        const conflict = await repo.guardedSaveConsole({
          workspaceId: wsId,
          consoleId: created.id,
          expectedVersion: 1,
          expectedDraftRevision: 2,
          upsert: false,
          set: { code: "SELECT 999" },
          incVersion: 1,
          incDraftRevision: 1,
        });
        expect(conflict).toBeNull();

        // Upsert on brand-new consoleId when no guard is active
        const draftId = new Types.ObjectId().toString();
        const upserted = await repo.guardedSaveConsole({
          workspaceId: wsId,
          consoleId: draftId,
          upsert: true,
          set: { code: "SELECT 'draft'", lastDraftOrigin: "user" },
          incDraftRevision: 1,
          setOnInsert: {
            name: "Untitled",
            createdBy: userV7Id,
            owner_id: userV7Id,
            isSaved: false,
          },
        });
        expect(upserted?.id).toBe(draftId);
        expect(upserted?.isSaved).toBe(false);

        // Execution + external use telemetry
        const execAt = new Date("2026-11-03T12:00:00.000Z");
        expect(
          await repo.recordConsoleExecution(wsId, created.id, {
            lastExecutedAt: execAt,
            bumpDraftRevision: true,
            lastRun: {
              at: execAt,
              status: "success",
              rowCount: 10,
              durationMs: 42,
              runBy: userLuciaId,
              source: "agent",
              executionId: "exec-1",
            },
          }),
        ).toBe(true);
        const afterExec = await repo.findConsoleById(wsId, created.id);
        expect(afterExec?.executionCount).toBe(1);
        expect(afterExec?.draftRevision).toBe(3);
        expect(afterExec?.lastRun?.runBy).toBe(
          impl.isPg ? userLuciaUuid : userLuciaId,
        );

        const t1 = new Date("2026-11-03T12:01:00.000Z");
        expect(
          await repo.recordConsoleExternalUse(
            wsId,
            created.id,
            "mcp",
            "access",
            t1,
          ),
        ).toBe(true);
        // Second access within 60s is throttled (no write)
        expect(
          await repo.recordConsoleExternalUse(
            wsId,
            created.id,
            "mcp",
            "access",
            new Date(t1.getTime() + 10_000),
          ),
        ).toBe(false);
        expect(
          await repo.recordConsoleExternalUse(
            wsId,
            created.id,
            "api",
            "execute",
            new Date(t1.getTime() + 20_000),
          ),
        ).toBe(true);
        expect(
          (await repo.findConsoleById(wsId, created.id))?.externalUseCount,
        ).toBe(1);

        // Guarded description update
        expect(
          await repo.guardedUpdateConsoleDescription(
            wsId,
            created.id,
            "wrong-sha",
            { description: "nope" },
          ),
        ).toBe(false);
        expect(
          await repo.guardedUpdateConsoleDescription(
            wsId,
            created.id,
            "sha-001",
            {
              description: "Derived summary",
              descriptionSource: "generated",
              descriptionSourceSha: "sha-001",
            },
          ),
        ).toBe(true);

        // Schedule due + claim CAS + outcome + clear
        const pastDue = new Date("2026-11-01T00:00:00.000Z");
        const nextSlot = new Date("2026-11-02T00:00:00.000Z");
        await repo.updateConsole(wsId, created.id, {
          schedule: { cron: "0 0 * * *", timezone: "UTC" },
          scheduledRun: {
            nextAt: pastDue,
            runCount: 0,
            consecutiveFailures: 0,
          },
        });
        const due = await repo.findDueScheduledConsoles(
          new Date("2026-11-01T01:00:00.000Z"),
        );
        expect(due.map(d => d.id)).toContain(created.id);
        const claim1 = await repo.claimScheduledConsole(due[0], nextSlot);
        expect(claim1.modifiedCount).toBe(1);
        const claim2 = await repo.claimScheduledConsole(due[0], nextSlot);
        expect(claim2.modifiedCount).toBe(0);

        await repo.updateConsoleScheduleOutcome({
          workspaceId: wsId,
          consoleId: created.id,
          isError: true,
          lastAt: new Date("2026-11-01T01:05:00.000Z"),
          lastError: "permission denied",
          permanentFailures: 3,
          pausedAt: new Date("2026-11-01T01:05:00.000Z"),
          pausedReason: "Paused after 3 failures",
          clearNextAt: true,
        });
        const paused = await repo.findConsoleById(wsId, created.id);
        expect(paused?.scheduledRun?.pausedReason).toBe(
          "Paused after 3 failures",
        );
        expect(paused?.scheduledRun?.nextAt).toBeUndefined();

        await repo.clearConsoleSchedule(wsId, created.id);
        expect(
          (await repo.findConsoleById(wsId, created.id))?.schedule,
        ).toBeUndefined();

        // Soft delete + restore
        expect(await repo.softDeleteConsole(wsId, created.id)).toBe(true);
        expect(
          await repo.findConsoleById(wsId, created.id, {
            excludeDeleted: true,
          }),
        ).toBeNull();
        expect(await repo.restoreConsole(wsId, created.id)).toBe(true);
        expect(
          (
            await repo.findConsoleById(wsId, created.id, {
              excludeDeleted: true,
            })
          )?.is_deleted,
        ).toBe(false);
      });

      it("covers entity_versions, notebook_folders, notebook_indexes, favourites, and scheduled_query_runs", async () => {
        const repo = impl.create();
        const consoleRec = await repo.createConsole({
          workspaceId: wsId,
          name: "Versioned",
          code: "SELECT 1",
          language: "sql",
          createdBy: userV7Id,
          isSaved: true,
        });

        // Entity versions
        const v1 = await repo.createEntityVersion({
          workspaceId: wsId,
          entityType: "console",
          entityId: consoleRec.id,
          snapshot: { code: "SELECT 1" },
          savedBy: userLuciaId,
          savedByName: "Lucia",
          comment: "Initial",
        });
        const v2 = await repo.createEntityVersion({
          workspaceId: wsId,
          entityType: "console",
          entityId: consoleRec.id,
          snapshot: { code: "SELECT 2" },
          savedBy: "system",
          savedByName: "System",
          comment: "Updated",
          restoredFrom: 1,
        });
        expect(v1.version).toBe(1);
        expect(v2.version).toBe(2);
        expect(
          await repo.getLatestEntityVersionNumber(
            consoleRec.id,
            "console",
            wsId,
          ),
        ).toBe(2);
        const listedVersions = await repo.listEntityVersions(
          consoleRec.id,
          "console",
          { workspaceId: wsId, limit: 10, offset: 0 },
        );
        expect(listedVersions.total).toBe(2);
        expect(listedVersions.versions.map(v => v.version)).toEqual([2, 1]);
        expect(
          (await repo.getEntityVersion(consoleRec.id, "console", 1, wsId))
            ?.snapshot,
        ).toEqual({ code: "SELECT 1" });
        expect(
          await repo.countEntityVersions(wsId, "console", [consoleRec.id]),
        ).toBe(2);

        // Notebook folders + subtree delete unlinks indexes
        const nbParent = await repo.createNotebookFolder({
          workspaceId: wsId,
          name: "Notebooks Root",
          ownerId: userV7Id,
          access: "workspace",
        });
        const nbChild = await repo.createNotebookFolder({
          workspaceId: wsId,
          name: "Sub",
          parentId: nbParent.id,
          ownerId: userV7Id,
        });
        expect(
          await repo.wouldCreateNotebookFolderCycle(
            wsId,
            nbParent.id,
            nbChild.id,
          ),
        ).toBe(true);

        const nbIdx = await repo.createNotebookIndex({
          workspaceId: wsId,
          notebookId: "nb-001",
          name: "KPI Deepdive",
          folderId: nbChild.id,
          ownerId: userLuciaId,
          access: "private",
          path: "users/lucia/kpi.deepnote",
          sharedWith: [
            {
              userId: userV7Id,
              role: "editor",
              addedAt: new Date("2026-11-02T00:00:00.000Z"),
              addedBy: userLuciaId,
            },
          ],
        });
        expect(nbIdx.folderId).toBe(nbChild.id);
        expect(
          (
            await repo.listNotebookIndexes(wsId, {
              visibleForUserId: userV7Id,
            })
          ).map(n => n.notebookId),
        ).toEqual(["nb-001"]);
        expect(
          await repo.findNotebookIndexByPath(wsId, "users/lucia/kpi.deepnote", {
            excludeNotebookId: "nb-001",
          }),
        ).toBeNull();

        // Deleting parent folder deletes child folder AND unlinks nbIdx (sets folderId -> undefined)
        expect(await repo.deleteNotebookFolderSubtree(wsId, nbParent.id)).toBe(
          true,
        );
        expect(await repo.findNotebookFolderById(wsId, nbChild.id)).toBeNull();
        expect(
          (await repo.findNotebookIndex(wsId, "nb-001"))?.folderId,
        ).toBeUndefined();

        // Favourites: folder + child item + reorder + recursive subtree delete
        const favFolder = await repo.createFavourite({
          workspaceId: wsId,
          userId: userLuciaId,
          parentId: null,
          type: "folder",
          title: "Pinned",
          position: 0,
        });
        const favItem = await repo.createFavourite({
          workspaceId: wsId,
          userId: userLuciaId,
          parentId: favFolder.id,
          type: "item",
          kind: "console",
          refId: consoleRec.id,
          position: 0,
        });
        const favRoot = await repo.createFavourite({
          workspaceId: wsId,
          userId: userLuciaId,
          parentId: null,
          type: "item",
          kind: "notebook",
          refId: "nb-001",
          position: 1,
        });
        expect(await repo.countFavourites(wsId, userLuciaId)).toBe(3);
        expect(
          (
            await repo.findFavouriteByRef(
              wsId,
              userLuciaId,
              "console",
              consoleRec.id,
            )
          )?.id,
        ).toBe(favItem.id);
        expect(
          await repo.getNextFavouritePosition(wsId, userLuciaId, null),
        ).toBe(2);

        await repo.reorderFavourites(wsId, userLuciaId, [
          { id: favRoot.id, position: 0, parentId: null },
          { id: favFolder.id, position: 1, parentId: null, title: "Top" },
        ]);
        expect(
          (await repo.findFavouriteById(wsId, userLuciaId, favFolder.id))
            ?.title,
        ).toBe("Top");

        // Subtree delete removes favFolder AND nested favItem
        expect(
          await repo.deleteFavouriteSubtree(wsId, userLuciaId, favFolder.id),
        ).toBe(2);
        expect(await repo.countFavourites(wsId, userLuciaId)).toBe(1);
        expect(
          await repo.deleteFavouriteByRef(
            wsId,
            userLuciaId,
            "notebook",
            "nb-001",
          ),
        ).toBe(true);
        expect(await repo.countFavourites(wsId, userLuciaId)).toBe(0);

        // Scheduled query runs
        const run1 = await repo.createScheduledQueryRun({
          workspaceId: wsId,
          consoleId: consoleRec.id,
          triggeredAt: new Date("2026-11-01T10:00:00.000Z"),
          status: "queued",
          triggerType: "schedule",
          triggeredBy: userLuciaId,
          inngestRunId: "ing-1",
        });
        expect(
          await repo.updateScheduledQueryRun(wsId, run1.id, {
            status: "success",
            startedAt: new Date("2026-11-01T10:00:01.000Z"),
            completedAt: new Date("2026-11-01T10:00:03.000Z"),
            durationMs: 2000,
            rowCount: 15,
          }),
        ).toBe(true);
        const foundRun = await repo.findScheduledQueryRunById(run1.id, wsId);
        expect(foundRun?.status).toBe("success");
        expect(foundRun?.rowCount).toBe(15);
        expect(
          (await repo.listScheduledQueryRuns(wsId, consoleRec.id, 5)).map(
            r => r.id,
          ),
        ).toEqual([run1.id]);
      });
    });
  }

  // ── 2. Postgres Search (pgvector + tsvector FTS + trigram ILIKE) ─────────

  describe("Postgres pgvector, tsvector FTS, and trigram name search", () => {
    it("ranks saved consoles by cosine distance, websearch_to_tsquery, and ILIKE while excluding drafts & deleted", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      expect(await pgRepo.isPgVectorAvailable()).toBe(true);

      const vecSales = makeUnitVector(0, 1);
      const vecChurn = makeUnitVector(10, 11);

      const cSales = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "France Sales Leaderboard",
        description: "Ranks French enterprise sales reps by ARR",
        descriptionEmbedding: vecSales,
        embeddingModel: "text-embedding-3-small",
        code: "SELECT rep, SUM(arr) FROM sales WHERE country = 'FR' GROUP BY 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const cChurn = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Monthly Churn Cohort",
        description: "Customer retention and churn cohorts",
        descriptionEmbedding: vecChurn,
        embeddingModel: "text-embedding-3-small",
        code: "SELECT cohort_month, churn_rate FROM retention",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      // Draft + soft-deleted rows must NEVER appear in search results
      await pgRepo.createConsole({
        workspaceId: wsId,
        name: "France Sales Draft",
        description: "France sales draft",
        descriptionEmbedding: vecSales,
        embeddingModel: "text-embedding-3-small",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: false,
      });
      await pgRepo.createConsole({
        workspaceId: wsId,
        name: "France Sales Deleted",
        description: "France sales deleted",
        descriptionEmbedding: vecSales,
        embeddingModel: "text-embedding-3-small",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        is_deleted: true,
      });

      // Vector search
      const vecHits = await pgRepo.searchConsolesVector(wsId, vecSales, {
        limit: 5,
        embeddingModel: "text-embedding-3-small",
      });
      expect(vecHits.map(h => h.id)).toEqual([cSales.id, cChurn.id]);
      expect(vecHits[0].score).toBeGreaterThan(vecHits[1].score);

      // FTS (tsvector generated column)
      const ftsHits = await pgRepo.searchConsolesText(
        wsId,
        "french enterprise sales",
        { limit: 5 },
      );
      expect(ftsHits.map(h => h.id)).toEqual([cSales.id]);

      // Trigram ILIKE fallback
      const nameHits = await pgRepo.searchConsolesName(wsId, "leaderboard", {
        limit: 5,
      });
      expect(nameHits.map(h => h.id)).toEqual([cSales.id]);
    });

    it("escapes _ % and \\ literals cleanly in ILIKE name search (#4717302820)", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const target = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "rev_ops_100%",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await pgRepo.createConsole({
        workspaceId: wsId,
        name: "revXopsX10099",
        code: "SELECT 2",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const backslashTarget = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "team\\rev_ops",
        code: "SELECT 3",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      const exactLikeHits = await pgRepo.searchConsolesName(
        wsId,
        "rev_ops_100%",
        { limit: 5 },
      );
      expect(exactLikeHits.map(h => h.id)).toEqual([target.id]);

      const backslashHits = await pgRepo.searchConsolesName(
        wsId,
        "team\\rev_ops",
        { limit: 5 },
      );
      expect(backslashHits.map(h => h.id)).toEqual([backslashTarget.id]);
    });

    it("aligns Postgres FTS with Mongo $text OR-semantics, phrases, negations, and score scale (#4717305431)", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const cFull = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Monthly Revenue by Region",
        description: "Monthly revenue rollup by region",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const cPartial = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Revenue by Region",
        description: "Quarterly breakdown of revenue by region",
        code: "SELECT 2",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const cDraftWord = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Draft Revenue Report",
        description: "Temporary draft revenue scratchpad",
        code: "SELECT 3",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Customer Churn",
        description: "Tracks churn rate over time",
        code: "SELECT 4",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      // Multi-word OR recall: "monthly revenue by region" must match "Revenue by Region" too
      const orHits = await pgRepo.searchConsolesText(
        wsId,
        "monthly revenue by region",
        { limit: 5 },
      );
      expect(orHits.map(h => h.id)).toEqual([
        cFull.id,
        cPartial.id,
        cDraftWord.id,
      ]);
      expect(orHits[0].score).toBeGreaterThan(orHits[1].score);
      // Score sits in Mongo textScore range (above 0.5 ILIKE name fallback)
      expect(orHits[1].score).toBeGreaterThanOrEqual(0.6);

      // Negation still excludes negated term
      const negHits = await pgRepo.searchConsolesText(wsId, "revenue -draft", {
        limit: 5,
      });
      expect(negHits.map(h => h.id).sort()).toEqual(
        [cFull.id, cPartial.id].sort(),
      );

      // Quoted phrase + OR term parses and matches safely
      const phraseHits = await pgRepo.searchConsolesText(
        wsId,
        '"revenue by region" monthly',
        { limit: 5 },
      );
      expect(phraseHits.map(h => h.id)).toContain(cFull.id);
      expect(phraseHits.map(h => h.id)).toContain(cPartial.id);

      // Stopword-only and negation-only queries return [] cleanly without SQL errors
      expect(
        await pgRepo.searchConsolesText(wsId, "the and of", { limit: 5 }),
      ).toEqual([]);
      expect(
        await pgRepo.searchConsolesText(wsId, "-draft", { limit: 5 }),
      ).toEqual([]);
    });

    it("prevents multi-tenant HNSW ef_search starvation for small workspaces (#4717305914)", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const queryVec = makeUnitVector(20, 21);
      const wsCloserVec = makeUnitVector(20, 22);
      const wsFartherVec = makeUnitVector(25, 26);

      // Seed 50 consoles in ws2Id (> default hnsw.ef_search=40) with identical vector to queryVec
      for (let i = 0; i < 50; i++) {
        await pgRepo.createConsole({
          workspaceId: ws2Id,
          name: `Other Tenant Console ${i}`,
          description: "Distractor in another tenant",
          descriptionEmbedding: queryVec,
          embeddingModel: "text-embedding-3-small",
          code: "SELECT 1",
          language: "sql",
          createdBy: userV7Id,
          isSaved: true,
        });
      }

      const cClose = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Small WS Closer",
        description: "Closer match in small workspace",
        descriptionEmbedding: wsCloserVec,
        embeddingModel: "text-embedding-3-small",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const cFar = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Small WS Farther",
        description: "Farther match in small workspace",
        descriptionEmbedding: wsFartherVec,
        embeddingModel: "text-embedding-3-small",
        code: "SELECT 2",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      await db.execute(sql`ANALYZE saved_consoles`);
      await db.execute(sql`SET enable_seqscan = off`);
      try {
        const hits = await pgRepo.searchConsolesVector(wsId, queryVec, {
          limit: 5,
          embeddingModel: "text-embedding-3-small",
        });
        expect(hits.map(h => h.id)).toEqual([cClose.id, cFar.id]);
        expect(hits[0].score).toBeGreaterThan(hits[1].score);
      } finally {
        await db.execute(sql`SET enable_seqscan = on`);
      }
    });
  });

  // ── 3. 5-Stage Dual-Run, Hot-Path Safety, Rollback Parity & Sync-Retry ───

  describe("DualConsolesChartsRepository 5-stage rollout, rollback & shadow compare", () => {
    async function makeDualHarness(
      initialMode: MigrationMode,
      opts?: {
        hasPg?: () => boolean;
        shadowSampleRate?: number;
        rng?: () => number;
        workspaceModes?: Record<string, MigrationMode>;
        onShadowEvent?: (e: ShadowCompareEvent) => void;
        onSecondaryFailure?: (ctx: SecondaryWriteFailureContext) => void;
      },
    ) {
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const shadowRunner = new ShadowCompareRunner({
        onEvent: opts?.onShadowEvent,
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: opts?.hasPg ?? (() => true),
        enablePubSub: false,
        shadowRunner,
        rng: opts?.rng,
        onSecondaryFailure: async ctx => {
          opts?.onSecondaryFailure?.(ctx);
        },
      });
      if (opts?.hasPg === undefined || opts.hasPg()) {
        await router.setDomainState({
          domain: CONSOLES_CHARTS_DOMAIN,
          mode: initialMode,
          shadowSampleRate: opts?.shadowSampleRate ?? 1.0,
        });
        for (const [workspaceId, mode] of Object.entries(
          opts?.workspaceModes ?? {},
        )) {
          await router.setDomainState({
            domain: CONSOLES_CHARTS_DOMAIN,
            workspaceId,
            mode,
            shadowSampleRate: opts?.shadowSampleRate ?? 1.0,
          });
        }
      }
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });
      return {
        dual,
        mongoRepo,
        pgRepo,
        shadowRunner,
        router,
        setMode: async (mode: MigrationMode, shadowSampleRate = 1.0) => {
          await router.setDomainState({
            domain: CONSOLES_CHARTS_DOMAIN,
            mode,
            shadowSampleRate,
          });
        },
        setWorkspaceMode: async (
          workspaceId: string,
          mode: MigrationMode,
          shadowSampleRate = 1.0,
        ) => {
          await router.setDomainState({
            domain: CONSOLES_CHARTS_DOMAIN,
            workspaceId,
            mode,
            shadowSampleRate,
          });
        },
      };
    }

    it("Stage 1 (mongo_only) never touches Postgres even with POSTGRES_URL unset", async () => {
      const prevUrl = process.env.POSTGRES_URL;
      delete process.env.POSTGRES_URL;
      resetPgTestDb();
      try {
        const harness = await makeDualHarness("mongo_only", {
          hasPg: () => false,
        });
        const pgCreateSpy = vi.spyOn(harness.pgRepo, "createConsole");
        const pgFindSpy = vi.spyOn(harness.pgRepo, "findConsoleById");

        const created = await harness.dual.createConsole({
          workspaceId: wsId,
          name: "Mongo Only Query",
          code: "SELECT 1",
          language: "sql",
          createdBy: userV7Id,
          isSaved: true,
        });
        const fetched = await harness.dual.findConsoleById(wsId, created.id);
        expect(fetched?.name).toBe("Mongo Only Query");
        expect(pgCreateSpy).not.toHaveBeenCalled();
        expect(pgFindSpy).not.toHaveBeenCalled();
      } finally {
        if (prevUrl !== undefined) process.env.POSTGRES_URL = prevUrl;
        setPgTestDb(db);
      }
    });

    it("Stage 3 (dual_write_shadow_compare) runs zero PG queries when unsampled, and compares search top-K ID overlap when sampled", async () => {
      const events: ShadowCompareEvent[] = [];
      const harness = await makeDualHarness("dual_write_shadow_compare", {
        shadowSampleRate: 0.5,
        rng: () => 0.99,
        onShadowEvent: e => events.push(e),
      });

      const c1 = await harness.dual.createConsole({
        workspaceId: wsId,
        name: "Sales Summary",
        description: "Sales summary query",
        code: "SELECT * FROM sales",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      const pgReadSpy = vi.spyOn(harness.pgRepo, "findConsoleById");
      const got = await harness.dual.findConsoleById(wsId, c1.id);
      expect(got?.name).toBe("Sales Summary");
      expect(pgReadSpy).not.toHaveBeenCalled();

      // Now test Stage 3 search shadow-compare with sampleRate=1.0
      const searchEvents: ShadowCompareEvent[] = [];
      const sampled = await makeDualHarness("dual_write_shadow_compare", {
        shadowSampleRate: 1.0,
        onShadowEvent: e => searchEvents.push(e),
      });
      const hits = await sampled.dual.searchConsolesName(wsId, "Sales", {
        limit: 5,
      });
      expect(hits.map(h => h.id)).toEqual([c1.id]);
      await sampled.shadowRunner.flush();
      expect(searchEvents).toHaveLength(1);
      // Both Mongo and PG returned identical top-K ID set -> matched!
      expect(searchEvents[0].result).toBe("match");

      // Legacy 15-char Lucia-owned console + folder + favourite shadow-compare must MATCH (not mismatch!)
      const legacyEvents: ShadowCompareEvent[] = [];
      const legacyHarness = await makeDualHarness("dual_write_shadow_compare", {
        shadowSampleRate: 1.0,
        onShadowEvent: e => legacyEvents.push(e),
      });
      const luciaFolder = await legacyHarness.dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Lucia Folder",
        ownerId: userLuciaId,
      });
      const luciaConsole = await legacyHarness.dual.createConsole({
        workspaceId: wsId,
        folderId: luciaFolder.id,
        name: "Lucia Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userLuciaId,
        owner_id: userLuciaId,
        isSaved: true,
        sharedWith: [
          {
            userId: userV7Id,
            role: "viewer",
            addedAt: new Date("2026-11-02T00:00:00.000Z"),
            addedBy: userLuciaId,
          },
        ],
      });
      const luciaFav = await legacyHarness.dual.createFavourite({
        workspaceId: wsId,
        userId: userLuciaId,
        parentId: null,
        type: "item",
        kind: "console",
        refId: luciaConsole.id,
        position: 0,
      });

      await legacyHarness.dual.findConsoleFolderById(wsId, luciaFolder.id);
      await legacyHarness.dual.findConsoleById(wsId, luciaConsole.id);
      await legacyHarness.dual.findFavouriteById(
        wsId,
        userLuciaId,
        luciaFav.id,
      );
      await legacyHarness.shadowRunner.flush();

      expect(legacyEvents).toHaveLength(3);
      expect(legacyEvents.every(e => e.result === "match")).toBe(true);
    });

    it("never records tombstones on unauthorized / no-op deletes in Stage 2, accepts UUIDv8 in Mongo repo, and remaps UUIDv7 -> legacy_id on Stage 4 replaySyncToMongo", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const harness = await makeDualHarness("dual_write_mongo_read", {
        onSecondaryFailure: ctx => failures.push(ctx),
      });

      // Create a favourite owned by userLuciaId
      const fav = await harness.dual.createFavourite({
        workspaceId: wsId,
        userId: userLuciaId,
        parentId: null,
        type: "folder",
        title: "Lucia Private Fav",
        position: 0,
      });
      // Wrong user (userV7Id) tries to delete Lucia's favourite -> 0 deleted, 0 tombstones!
      expect(
        await harness.dual.deleteFavouriteSubtree(wsId, userV7Id, fav.id),
      ).toBe(0);
      expect(
        await harness.dual.deleteConsoleFolder(
          wsId,
          new Types.ObjectId().toString(),
        ),
      ).toBe(false);
      const tombstones = await db.select().from(pgSchema.migrationTombstones);
      expect(tombstones).toHaveLength(0);

      // Mongo repo accepts 36-char UUIDv8 symmetrically with PG repo
      const favUuid = objectIdToUuid(fav.id);
      expect(
        (await harness.mongoRepo.findFavouriteById(wsId, userLuciaId, favUuid))
          ?.id,
      ).toBe(fav.id);

      // Stage 4 PG-primary write owned by legacy Lucia user where Mongo write fails ->
      // replaySyncToMongo must remap PG UUIDv7 back to `userLuciaId` in Mongo!
      await harness.setMode("dual_write_pg_read");
      const mongoCreateSpy = vi
        .spyOn(harness.mongoRepo, "createConsole")
        .mockRejectedValueOnce(new Error("mongo blip"));
      const stage4LuciaConsole = await harness.dual.createConsole({
        workspaceId: wsId,
        name: "Stage 4 Lucia Console",
        code: "SELECT 'lucia'",
        language: "sql",
        createdBy: userLuciaId,
        owner_id: userLuciaId,
        isSaved: true,
      });
      mongoCreateSpy.mockRestore();
      expect(failures).toHaveLength(1);
      expect(
        await harness.mongoRepo.findConsoleById(wsId, stage4LuciaConsole.id),
      ).toBeNull();

      await replaySyncToMongo(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "mongo",
          operation: failures[0].operation,
          entityId: failures[0].entityId ?? stage4LuciaConsole.id,
          workspaceId: failures[0].workspaceId,
          payload: failures[0].payload,
          errorMessage: "mongo blip",
          failedAt: new Date().toISOString(),
        },
        db,
      );
      const replayedMongo = await harness.mongoRepo.findConsoleById(
        wsId,
        stage4LuciaConsole.id,
      );
      expect(replayedMongo?.createdBy).toBe(userLuciaId);
      expect(replayedMongo?.owner_id).toBe(userLuciaId);
    });

    it("walks Stages 2 -> 3 -> 4 -> rollback to Stage 2 -> Stage 5 cleanly and heals secondary write failures via sync-retry", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const harness = await makeDualHarness("dual_write_mongo_read", {
        onSecondaryFailure: ctx => failures.push(ctx),
      });

      // Stage 2: write lands in BOTH Mongo and PG
      const folder = await harness.dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Dual Folder",
        ownerId: userV7Id,
      });
      expect(
        await harness.mongoRepo.findConsoleFolderById(wsId, folder.id),
      ).not.toBeNull();
      expect(
        await harness.pgRepo.findConsoleFolderById(wsId, folder.id),
      ).not.toBeNull();

      // Stage 4: PG is primary, Mongo receives dual-write mirror
      await harness.setMode("dual_write_pg_read");
      const stage4Console = await harness.dual.createConsole({
        workspaceId: wsId,
        folderId: folder.id,
        name: "Created In Stage 4",
        code: "SELECT 4",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      expect(
        (await harness.dual.findConsoleById(wsId, stage4Console.id))?.name,
      ).toBe("Created In Stage 4");

      // Emergency rollback Stage 4 -> Stage 2: Mongo ALREADY has Stage 4's writes!
      await harness.setMode("dual_write_mongo_read");
      expect(
        (await harness.dual.findConsoleById(wsId, stage4Console.id))?.name,
      ).toBe("Created In Stage 4");

      // Simulate secondary write failure to PG in Stage 2, then heal with replaySyncToPg
      const pgCreateSpy = vi
        .spyOn(harness.pgRepo, "createConsole")
        .mockRejectedValueOnce(new Error("transient pg outage"));
      const drifted = await harness.dual.createConsole({
        workspaceId: wsId,
        name: "Drifted Console",
        code: "SELECT 'drift'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      pgCreateSpy.mockRestore();
      expect(failures).toHaveLength(1);
      expect(await harness.pgRepo.findConsoleById(wsId, drifted.id)).toBeNull();

      await replaySyncToPg(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "pg",
          operation: failures[0].operation,
          entityId: failures[0].entityId ?? drifted.id,
          workspaceId: failures[0].workspaceId,
          payload: failures[0].payload,
          errorMessage: "transient pg outage",
          failedAt: new Date().toISOString(),
        },
        db,
      );
      expect(
        (await harness.pgRepo.findConsoleById(wsId, drifted.id))?.name,
      ).toBe("Drifted Console");

      // Simulate secondary write failure to Mongo in Stage 4, then heal with replaySyncToMongo
      failures.length = 0;
      await harness.setMode("dual_write_pg_read");
      const mongoCreateSpy = vi
        .spyOn(harness.mongoRepo, "createConsole")
        .mockRejectedValueOnce(new Error("transient mongo outage"));
      const pgLed = await harness.dual.createConsole({
        workspaceId: wsId,
        name: "PG Authoritative Console",
        code: "SELECT 'pg'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      mongoCreateSpy.mockRestore();
      expect(failures).toHaveLength(1);
      expect(
        await harness.mongoRepo.findConsoleById(wsId, pgLed.id),
      ).toBeNull();

      await replaySyncToMongo(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "mongo",
          operation: failures[0].operation,
          entityId: failures[0].entityId ?? pgLed.id,
          workspaceId: failures[0].workspaceId,
          payload: failures[0].payload,
          errorMessage: "transient mongo outage",
          failedAt: new Date().toISOString(),
        },
        db,
      );
      expect(
        (await harness.mongoRepo.findConsoleById(wsId, pgLed.id))?.name,
      ).toBe("PG Authoritative Console");

      // Stage 5: pg_only reads/writes only PG
      await harness.setMode("pg_only");
      const pgOnly = await harness.dual.createConsole({
        workspaceId: wsId,
        name: "PG Only Console",
        code: "SELECT 5",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      expect(
        await harness.pgRepo.findConsoleById(wsId, pgOnly.id),
      ).not.toBeNull();
      expect(
        await harness.mongoRepo.findConsoleById(wsId, pgOnly.id),
      ).toBeNull();
    });

    it("merges mixed-stage workspaces in findDueScheduledConsoles", async () => {
      const harness = await makeDualHarness("mongo_only", {
        workspaceModes: {
          [wsId]: "mongo_only",
          [ws2Id]: "pg_only",
        },
      });
      const dueAt = new Date("2026-11-01T00:00:00.000Z");

      const cMongo = await harness.mongoRepo.createConsole({
        workspaceId: wsId,
        name: "Mongo Due",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        sourceBlobSha: "sha-stage5",
        schedule: { cron: "0 * * * *", timezone: "UTC" },
        scheduledRun: { nextAt: dueAt, runCount: 0, consecutiveFailures: 0 },
      });
      const cPg = await harness.pgRepo.createConsole({
        workspaceId: ws2Id,
        name: "PG Due",
        code: "SELECT 2",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        sourceBlobSha: "sha-stage5",
        schedule: { cron: "0 * * * *", timezone: "UTC" },
        scheduledRun: { nextAt: dueAt, runCount: 0, consecutiveFailures: 0 },
      });

      const due = await harness.dual.findDueScheduledConsoles(
        new Date("2026-11-01T01:00:00.000Z"),
      );
      expect(due.map(d => d.id).sort()).toEqual([cMongo.id, cPg.id].sort());

      // Workspace-less lookup resolves both mongo_only (wsId) and pg_only (ws2Id) canary consoles
      expect((await harness.dual.findConsoleByIdGlobal(cMongo.id))?.name).toBe(
        "Mongo Due",
      );
      expect((await harness.dual.findConsoleByIdGlobal(cPg.id))?.name).toBe(
        "PG Due",
      );
    });

    it("triggers sync-retry when guarded or relative secondary writes match 0 rows after primary succeeds (#4717304970)", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const harness = await makeDualHarness("dual_write_mongo_read", {
        onSecondaryFailure: ctx => failures.push(ctx),
      });

      const dueAt = new Date("2026-11-01T00:00:00.000Z");
      const nextSlot = new Date("2026-11-02T00:00:00.000Z");
      const created = await harness.dual.createConsole({
        workspaceId: wsId,
        name: "Guarded Drift Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        schedule: { cron: "0 0 * * *", timezone: "UTC" },
        scheduledRun: { nextAt: dueAt, runCount: 0, consecutiveFailures: 0 },
      });

      // 1. Simulate PG draftRevision ahead by +1 (e.g. late commit after timeout):
      // guardedSaveConsole succeeds in Mongo (expectedDraftRevision: 1 -> 2), misses 0 rows in PG ->
      // MUST emit secondary failure instead of returning silently, and replaySyncToPg heals PG!
      await db
        .update(pgSchema.savedConsoles)
        .set({ draftRevision: 2 })
        .where(eq(pgSchema.savedConsoles.id, objectIdToUuid(created.id)));

      const saved = await harness.dual.guardedSaveConsole({
        workspaceId: wsId,
        consoleId: created.id,
        expectedDraftRevision: 1,
        upsert: false,
        set: { code: "SELECT 'updated'", updatedAt: new Date() },
        incDraftRevision: 1,
      });
      expect(saved?.draftRevision).toBe(2);
      expect(saved?.code).toBe("SELECT 'updated'");
      expect(failures).toHaveLength(1);
      expect(failures[0].target).toBe("pg");
      expect(failures[0].operation).toBe("guardedSaveConsole");

      await replaySyncToPg(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "pg",
          operation: failures[0].operation,
          entityId: failures[0].entityId ?? created.id,
          workspaceId: wsId,
          payload: failures[0].payload,
          errorMessage: "secondary matched 0 rows",
          failedAt: new Date().toISOString(),
        },
        db,
      );
      const healed = await harness.pgRepo.findConsoleById(wsId, created.id);
      expect(healed?.code).toBe("SELECT 'updated'");
      expect(healed?.draftRevision).toBe(2);

      // 2. When primary itself fails the guard (409 conflict), NO secondary failure is recorded.
      failures.length = 0;
      const conflict = await harness.dual.guardedSaveConsole({
        workspaceId: wsId,
        consoleId: created.id,
        expectedDraftRevision: 1,
        upsert: false,
        set: { code: "SELECT 'stale'" },
        incDraftRevision: 1,
      });
      expect(conflict).toBeNull();
      expect(failures).toHaveLength(0);

      // 3. bumpConsoleDraftRevision writes primary's exact draftRevision (heals +1 drift inline!)
      await db
        .update(pgSchema.savedConsoles)
        .set({ draftRevision: 9 })
        .where(eq(pgSchema.savedConsoles.id, objectIdToUuid(created.id)));
      const bumped = await harness.dual.bumpConsoleDraftRevision(
        wsId,
        created.id,
      );
      expect(bumped?.draftRevision).toBe(3);
      expect(
        (await harness.pgRepo.findConsoleById(wsId, created.id))?.draftRevision,
      ).toBe(3);
      expect(failures).toHaveLength(0);

      // 4. claimScheduledConsole when PG nextAt drifted (0 rows matched in PG) -> emits secondary failure
      await db
        .update(pgSchema.savedConsoles)
        .set({ scheduledRunNextAt: new Date("2026-10-01T00:00:00.000Z") })
        .where(eq(pgSchema.savedConsoles.id, objectIdToUuid(created.id)));
      const claimed = await harness.dual.claimScheduledConsole(
        {
          id: created.id,
          workspaceId: wsId,
          nextAt: dueAt,
          schedule: { cron: "0 0 * * *", timezone: "UTC" },
        },
        nextSlot,
      );
      expect(claimed.modifiedCount).toBe(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].operation).toBe("claimScheduledConsole");

      // 5. Missing row in PG: bumpConsoleDraftRevision & recordConsoleExecution both emit secondary failure
      failures.length = 0;
      await db
        .delete(pgSchema.savedConsoles)
        .where(eq(pgSchema.savedConsoles.id, objectIdToUuid(created.id)));

      expect(
        (await harness.dual.bumpConsoleDraftRevision(wsId, created.id))
          ?.draftRevision,
      ).toBe(4);
      expect(
        await harness.dual.recordConsoleExecution(wsId, created.id, {
          lastExecutedAt: new Date(),
          bumpDraftRevision: true,
        }),
      ).toBe(true);
      expect(failures.map(f => f.operation)).toEqual([
        "bumpConsoleDraftRevision",
        "recordConsoleExecution",
      ]);

      // 6. Stage 4 symmetry: PG primary succeeds, Mongo secondary matches 0 rows -> emits mongo retry
      failures.length = 0;
      await harness.setMode("dual_write_pg_read");
      const pgOnlyRow = await harness.pgRepo.createConsole({
        workspaceId: wsId,
        name: "Stage4 Missing In Mongo",
        code: "SELECT 'pg'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      expect(
        await harness.dual.recordConsoleExecution(wsId, pgOnlyRow.id, {
          lastExecutedAt: new Date(),
        }),
      ).toBe(true);
      expect(failures).toHaveLength(1);
      expect(failures[0].target).toBe("mongo");
      expect(failures[0].operation).toBe("recordConsoleExecution");
    });

    it("preserves stale-cached routing flags on transient PG error and propagates when cold (#4717306376)", async () => {
      const harness = await makeDualHarness("mongo_only", {
        workspaceModes: {
          [ws2Id]: "pg_only",
        },
      });

      const pgConsole = await harness.pgRepo.createConsole({
        workspaceId: ws2Id,
        name: "Fresh PG Console",
        code: "SELECT 'fresh'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await harness.mongoRepo.createConsole({
        id: pgConsole.id,
        workspaceId: ws2Id,
        name: "Frozen Stale Mongo Console",
        code: "SELECT 'stale'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      // Warm cache: hasAnyPgReadWorkspace = true
      expect(
        (await harness.dual.findConsoleByIdGlobal(pgConsole.id))?.name,
      ).toBe("Fresh PG Console");

      // Inject transient PG error on migration_domain_state query for warm Dual repo:
      // must keep stale-cached `true` and still serve Fresh PG Console (never frozen Mongo!).
      let failDomainStateQuery = true;
      const flakyDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "select" && failDomainStateQuery) {
            return (...args: unknown[]) => {
              const chain = (
                target.select as (...a: unknown[]) => {
                  from: (t: unknown) => unknown;
                }
              )(...args);
              return new Proxy(chain, {
                get(cTarget, cProp, cReceiver) {
                  if (cProp === "from") {
                    return (table: unknown) => {
                      if (table === pgSchema.migrationDomainState) {
                        throw new Error("transient pg blip");
                      }
                      return cTarget.from(table);
                    };
                  }
                  return Reflect.get(cTarget, cProp, cReceiver);
                },
              });
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as MakoPgDb;

      // Warm a Dual repo backed by flakyDb while healthy, then flip failure on
      failDomainStateQuery = false;
      const warmDual = new DualConsolesChartsRepository({
        mongo: harness.mongoRepo,
        pg: harness.pgRepo,
        router: harness.router,
        getDb: () => flakyDb,
        resolveUserUuid,
      });
      expect((await warmDual.findConsoleByIdGlobal(pgConsole.id))?.name).toBe(
        "Fresh PG Console",
      );

      failDomainStateQuery = true;
      expect((await warmDual.findConsoleByIdGlobal(pgConsole.id))?.name).toBe(
        "Fresh PG Console",
      );

      // Cold Dual repo (unknown flag): MUST propagate error instead of returning false -> frozen Mongo!
      const coldDual = new DualConsolesChartsRepository({
        mongo: harness.mongoRepo,
        pg: harness.pgRepo,
        router: harness.router,
        getDb: () => flakyDb,
        resolveUserUuid,
      });
      await expect(
        coldDual.findConsoleByIdGlobal(pgConsole.id),
      ).rejects.toThrow("transient pg blip");

      // Global Stage 5 (pg_only): warm cache preserves isGlobalPgOnly = true on transient error
      // and never touches Mongo; cold instance propagates the error.
      failDomainStateQuery = false;
      await db.delete(pgSchema.migrationDomainState);
      await harness.setMode("pg_only");
      const mongoGlobalSpy = vi.spyOn(
        harness.mongoRepo,
        "findConsoleByIdGlobal",
      );
      expect((await warmDual.findConsoleByIdGlobal(pgConsole.id))?.name).toBe(
        "Fresh PG Console",
      );
      failDomainStateQuery = true;
      expect((await warmDual.findConsoleByIdGlobal(pgConsole.id))?.name).toBe(
        "Fresh PG Console",
      );
      expect(mongoGlobalSpy).not.toHaveBeenCalled();

      const coldGlobalDual = new DualConsolesChartsRepository({
        mongo: harness.mongoRepo,
        pg: harness.pgRepo,
        router: harness.router,
        getDb: () => flakyDb,
        resolveUserUuid,
      });
      await expect(
        coldGlobalDual.findConsoleByIdGlobal(pgConsole.id),
      ).rejects.toThrow("transient pg blip");
      expect(mongoGlobalSpy).not.toHaveBeenCalled();
      mongoGlobalSpy.mockRestore();
    });
  });

  // ── 4. 10-Stage Backfill (2-Pass Self-FK + Quarantine), Verifier & TTL ───

  describe("10-stage backfill, quarantine, parity verifier (--repair), tombstones & TTL reaper", () => {
    beforeEach(() => {
      clearBackfillRegistryForTests();
      clearVerifierRegistryForTests();
      clearTtlRegistryForTests();
      registerMigrationDomains({ force: true });
    });

    it("backfills all 7 tables including out-of-order self-FKs, quarantines legacy dashboard & orphan rows, verifies parity, heals via --repair, and honors tombstones", async () => {
      expect(listBackfillDomains()).toContain(CONSOLES_CHARTS_DOMAIN);
      expect(listVerifierDomains()).toContain(CONSOLES_CHARTS_DOMAIN);

      const wsOid = new Types.ObjectId(wsId);

      // 2-pass self-FK ordering test: child _id < parent _id in ObjectId order!
      const cfChildOid = new Types.ObjectId(
        makeOrderedOid(1_700_000_001, "0001"),
      );
      const cfParentOid = new Types.ObjectId(
        makeOrderedOid(1_700_000_100, "0002"),
      );
      await ConsoleFolder.create([
        {
          _id: cfChildOid,
          workspaceId: wsOid,
          name: "Child Folder",
          parentId: cfParentOid,
          ownerId: userLuciaId,
          access: "private",
          isPrivate: true,
        },
        {
          _id: cfParentOid,
          workspaceId: wsOid,
          name: "Parent Folder",
          ownerId: userV7Id,
          access: "workspace",
          isPrivate: false,
        },
      ]);

      const consoleDoc = await SavedConsole.create({
        workspaceId: wsOid,
        folderId: cfChildOid,
        name: "Backfilled Console",
        description: "Backfilled description",
        descriptionEmbedding: makeUnitVector(3, 4),
        embeddingModel: "text-embedding-3-small",
        code: "SELECT * FROM orders",
        language: "sql",
        chartSpec: { type: "line", xAxis: "day" },
        resultsViewMode: "chart",
        createdBy: userLuciaId,
        owner_id: userV4Id,
        access: "workspace",
        isPrivate: false,
        isSaved: true,
        sharedWith: [
          {
            userId: userV7Id,
            role: "editor",
            addedAt: new Date("2026-11-01T12:00:00.000Z"),
            addedBy: userLuciaId,
          },
        ],
        lastRun: {
          at: new Date("2026-11-01T13:00:00.000Z"),
          status: "success",
          durationMs: 120,
          rowCount: 7,
          runBy: userLuciaId,
          source: "agent",
        },
      });

      // Tombstoned console must NOT be resurrected by backfill
      const tombstonedConsole = await SavedConsole.create({
        workspaceId: wsOid,
        name: "Deleted Tombstoned Console",
        code: "SELECT 0",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await recordMigrationTombstone(
        "saved_consoles",
        objectIdToUuid(tombstonedConsole._id.toString()),
        db,
      );

      // Entity versions: 1 valid console version + 1 legacy "dashboard" version
      await EntityVersion.create({
        workspaceId: wsOid,
        entityType: "console",
        entityId: consoleDoc._id,
        version: 1,
        snapshot: { code: "SELECT * FROM orders" },
        savedBy: userLuciaId,
        savedByName: "Lucia",
        comment: "v1",
      });
      await EntityVersion.collection.insertOne({
        _id: new Types.ObjectId(),
        workspaceId: wsOid,
        entityType: "dashboard",
        entityId: new Types.ObjectId(),
        version: 1,
        snapshot: { widgets: [] },
        savedBy: userV7Id,
        savedByName: "Legacy",
        comment: "legacy dashboard snapshot",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
      });

      // Notebook folders: child _id < parent _id
      const nfChildOid = new Types.ObjectId(
        makeOrderedOid(1_700_000_002, "0003"),
      );
      const nfParentOid = new Types.ObjectId(
        makeOrderedOid(1_700_000_200, "0004"),
      );
      await NotebookFolder.create([
        {
          _id: nfChildOid,
          workspaceId: wsOid,
          name: "NB Child",
          parentId: nfParentOid,
          ownerId: userV7Id,
          access: "private",
        },
        {
          _id: nfParentOid,
          workspaceId: wsOid,
          name: "NB Parent",
          ownerId: userV7Id,
          access: "workspace",
        },
      ]);

      await NotebookIndex.create({
        workspaceId: wsOid,
        notebookId: "nb-bf-1",
        name: "Backfilled Notebook",
        folderId: nfChildOid,
        ownerId: userLuciaId,
        access: "workspace",
      });

      // Favourites: child _id < parent _id + 1 legacy kind="dashboard" row
      const favChildOid = new Types.ObjectId(
        makeOrderedOid(1_700_000_003, "0005"),
      );
      const favParentOid = new Types.ObjectId(
        makeOrderedOid(1_700_000_300, "0006"),
      );
      await Favourite.create({
        _id: favChildOid,
        workspaceId: wsOid,
        userId: userLuciaId,
        parentId: favParentOid.toString(),
        type: "item",
        kind: "console",
        refId: consoleDoc._id.toString(),
        position: 0,
      });
      await Favourite.create({
        _id: favParentOid,
        workspaceId: wsOid,
        userId: userLuciaId,
        parentId: null,
        type: "folder",
        title: "Fav Parent",
        position: 0,
      });
      await Favourite.collection.insertOne({
        _id: new Types.ObjectId(),
        workspaceId: wsOid,
        userId: userLuciaId,
        parentId: null,
        type: "item",
        kind: "dashboard",
        refId: new Types.ObjectId().toString(),
        position: 9,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      });

      // Scheduled query runs: 1 valid + 1 run referencing a disconnected/missing console
      // (soft ref on `console_id` preserves historical runs across repo disconnect/reconnect).
      await ScheduledQueryRun.create({
        workspaceId: wsOid,
        consoleId: consoleDoc._id,
        triggeredAt: new Date("2026-11-01T14:00:00.000Z"),
        completedAt: new Date("2026-11-01T14:00:05.000Z"),
        status: "success",
        triggerType: "schedule",
        triggeredBy: userLuciaId,
        durationMs: 5000,
        rowCount: 10,
      });
      const disconnectedConsoleRun = await ScheduledQueryRun.create({
        workspaceId: wsOid,
        consoleId: new Types.ObjectId(),
        triggeredAt: new Date("2026-11-01T15:00:00.000Z"),
        status: "error",
        triggerType: "schedule",
        error: { message: "console disconnected" },
      });

      // Run 10-stage backfill (with POSTGRES_URL unset to prove injected `db` works)
      const prevUrl = process.env.POSTGRES_URL;
      delete process.env.POSTGRES_URL;
      try {
        const bf = await runBackfill({
          domain: CONSOLES_CHARTS_DOMAIN,
          batchSize: 2,
          db,
        });
        expect(bf.status).toBe("completed");
        // 2 quarantined rows: legacy entity_versions dashboard, legacy favourites dashboard
        // (`scheduled_query_runs.console_id` is a soft ref so runs for disconnected consoles survive).
        expect(bf.rowsQuarantined).toBe(2);

        const quarantineRows = await db
          .select()
          .from(pgSchema.migrationQuarantine);
        expect(quarantineRows).toHaveLength(2);
        const reasons = quarantineRows.map(r => r.reason).sort();
        expect(reasons).toEqual([
          "legacy_dashboard_entity_version",
          "legacy_dashboard_favourite",
        ]);

        // Verify all 3 self-FK children got their parent_id wired in Pass 2!
        const pgRepo = new PgConsolesChartsRepository({
          getDb: () => db,
          resolveUserUuid,
        });
        expect(
          (await pgRepo.findConsoleFolderById(wsId, cfChildOid.toString()))
            ?.parentId,
        ).toBe(cfParentOid.toString());
        expect(
          (await pgRepo.findNotebookFolderById(wsId, nfChildOid.toString()))
            ?.parentId,
        ).toBe(nfParentOid.toString());
        expect(
          (
            await pgRepo.findFavouriteById(
              wsId,
              userLuciaId,
              favChildOid.toString(),
            )
          )?.parentId,
        ).toBe(favParentOid.toString());

        // Tombstoned console was NOT resurrected
        expect(
          await pgRepo.findConsoleById(wsId, tombstonedConsole._id.toString()),
        ).toBeNull();
        // Run for disconnected console WAS backfilled (soft ref parity with Mongo)
        expect(
          await pgRepo.findScheduledQueryRunById(
            disconnectedConsoleRun._id.toString(),
            wsId,
          ),
        ).not.toBeNull();

        // Verify full parity across all 7 tables with POSTGRES_URL unset
        const verify1 = await runParityVerification({
          domain: CONSOLES_CHARTS_DOMAIN,
          batchSize: 2,
          db,
        });
        expect(verify1.ok).toBe(true);
        expect(verify1.missingInPg).toBe(0);
        expect(verify1.mismatched).toBe(0);
        expect(verify1.extraInPg).toBe(0);

        // Induce drift (mutate console name + delete favourite in PG) -> verifier catches + --repair heals
        await db
          .update(pgSchema.savedConsoles)
          .set({ name: "Drifted Name" })
          .where(
            eq(
              pgSchema.savedConsoles.id,
              objectIdToUuid(consoleDoc._id.toString()),
            ),
          );
        await db
          .delete(pgSchema.favourites)
          .where(
            eq(pgSchema.favourites.id, objectIdToUuid(favChildOid.toString())),
          );

        const verifyDrift = await runParityVerification({
          domain: CONSOLES_CHARTS_DOMAIN,
          batchSize: 5,
          db,
        });
        expect(verifyDrift.ok).toBe(false);
        expect(verifyDrift.mismatched).toBe(1);
        expect(verifyDrift.missingInPg).toBe(1);

        const verifyRepair = await runParityVerification({
          domain: CONSOLES_CHARTS_DOMAIN,
          batchSize: 5,
          repair: true,
          db,
        });
        expect(verifyRepair.repaired).toBe(2);

        const verifyHealed = await runParityVerification({
          domain: CONSOLES_CHARTS_DOMAIN,
          batchSize: 5,
          db,
        });
        expect(verifyHealed.ok).toBe(true);
      } finally {
        if (prevUrl !== undefined) process.env.POSTGRES_URL = prevUrl;
      }
    });

    it("reaps completed scheduled_query_runs older than 90d while preserving recent and in-progress (completed_at IS NULL) rows", async () => {
      const rules = listTtlRules();
      expect(rules).toContainEqual({
        tableName: "scheduled_query_runs",
        timestampColumn: "completed_at",
        olderThanMs: SCHEDULED_QUERY_RUNS_TTL_MS,
      });

      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const consoleRec = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "TTL Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      const now = new Date("2026-11-26T00:00:00.000Z");
      const oldCompleted = await pgRepo.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: consoleRec.id,
        triggeredAt: new Date(now.getTime() - 100 * 86_400_000),
        completedAt: new Date(now.getTime() - 95 * 86_400_000),
        status: "success",
        triggerType: "schedule",
      });
      const recentCompleted = await pgRepo.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: consoleRec.id,
        triggeredAt: new Date(now.getTime() - 10 * 86_400_000),
        completedAt: new Date(now.getTime() - 10 * 86_400_000),
        status: "success",
        triggerType: "schedule",
      });
      // Queued/running row with NULL completed_at (even if triggered >90d ago) MUST survive!
      const inProgress = await pgRepo.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: consoleRec.id,
        triggeredAt: new Date(now.getTime() - 120 * 86_400_000),
        status: "running",
        triggerType: "manual",
      });

      const { results } = await reapAllRegisteredTables({ now, db });
      const runResult = results.find(
        r => r.tableName === "scheduled_query_runs",
      );
      expect(runResult?.deleted).toBe(1);

      expect(
        await pgRepo.findScheduledQueryRunById(oldCompleted.id, wsId),
      ).toBeNull();
      expect(
        await pgRepo.findScheduledQueryRunById(recentCompleted.id, wsId),
      ).not.toBeNull();
      expect(
        await pgRepo.findScheduledQueryRunById(inProgress.id, wsId),
      ).not.toBeNull();
    });

    it("protects live Stage 2 rows from stale backfill overwrites (scheduled_query_runs, console_folders, favourites)", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const parentFolder = await pgRepo.createConsoleFolder({
        workspaceId: wsId,
        name: "Parent Live",
        ownerId: userV7Id,
      });
      const liveFolder = await pgRepo.createConsoleFolder({
        workspaceId: wsId,
        name: "Live Renamed Folder",
        parentId: parentFolder.id,
        ownerId: userV7Id,
        access: "workspace",
      });
      // Stale backfill snapshot in Mongo has old name & no parent
      await ConsoleFolder.create({
        _id: new Types.ObjectId(parentFolder.id),
        workspaceId: new Types.ObjectId(wsId),
        name: "Parent Stale",
        ownerId: userV7Id,
      });
      await ConsoleFolder.create({
        _id: new Types.ObjectId(liveFolder.id),
        workspaceId: new Types.ObjectId(wsId),
        name: "Stale Name",
        ownerId: userV7Id,
        access: "private",
      });

      const liveConsole = await pgRepo.createConsole({
        workspaceId: wsId,
        folderId: liveFolder.id,
        name: "Run Host",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await SavedConsole.create({
        _id: new Types.ObjectId(liveConsole.id),
        workspaceId: new Types.ObjectId(wsId),
        name: "Run Host",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      });

      // Live Stage 2 completed run in PG vs stale running snapshot in Mongo
      const tTrigger = new Date("2026-11-20T00:00:00.000Z");
      const tStart = new Date("2026-11-20T00:00:01.000Z");
      const tDone = new Date("2026-11-20T00:00:05.000Z");
      const liveRun = await pgRepo.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: liveConsole.id,
        triggeredAt: tTrigger,
        startedAt: tStart,
        completedAt: tDone,
        status: "success",
        triggerType: "schedule",
        durationMs: 4000,
        rowCount: 10,
      });
      await ScheduledQueryRun.create({
        _id: new Types.ObjectId(liveRun.id),
        workspaceId: new Types.ObjectId(wsId),
        consoleId: new Types.ObjectId(liveConsole.id),
        triggeredAt: tTrigger,
        startedAt: tStart,
        status: "running",
        triggerType: "schedule",
      });

      // Live Stage 2 favourite moved to root (parentId: null) at T2 vs stale Mongo doc with old parentId at T1
      const favFolder = await pgRepo.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Fav Group",
        position: 0,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        updatedAt: new Date("2026-11-01T00:00:00.000Z"),
      });
      const liveFav = await pgRepo.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "item",
        kind: "console",
        refId: liveConsole.id,
        position: 1,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        updatedAt: new Date("2026-11-20T12:00:00.000Z"),
      });
      await Favourite.create({
        _id: new Types.ObjectId(favFolder.id),
        workspaceId: new Types.ObjectId(wsId),
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Fav Group",
        position: 0,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        updatedAt: new Date("2026-11-01T00:00:00.000Z"),
      });
      await Favourite.create({
        _id: new Types.ObjectId(liveFav.id),
        workspaceId: new Types.ObjectId(wsId),
        userId: userV7Id,
        parentId: favFolder.id,
        type: "item",
        kind: "console",
        refId: liveConsole.id,
        position: 0,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
        updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      });

      await runBackfill({
        domain: CONSOLES_CHARTS_DOMAIN,
        db,
        workspaceId: wsId,
        batchSize: 100,
      });

      // Live folder name, access, and parentId survived stale Pass 1 + Pass 2
      const afterFolder = await pgRepo.findConsoleFolderById(
        wsId,
        liveFolder.id,
      );
      expect(afterFolder?.name).toBe("Live Renamed Folder");
      expect(afterFolder?.access).toBe("workspace");
      expect(afterFolder?.parentId).toBe(parentFolder.id);

      // Completed scheduled query run was NOT reverted to 'running'
      const afterRun = await pgRepo.findScheduledQueryRunById(liveRun.id, wsId);
      expect(afterRun?.status).toBe("success");
      expect(afterRun?.completedAt?.toISOString()).toBe(tDone.toISOString());
      expect(afterRun?.rowCount).toBe(10);

      // Live moved-to-root favourite was NOT reverted to favFolder by stale Pass 2
      const afterFav = await pgRepo.findFavouriteById(
        wsId,
        userV7Id,
        liveFav.id,
      );
      expect(afterFav?.parentId).toBeNull();
      expect(afterFav?.position).toBe(1);
    });

    it("maintains exact updatedAt millisecond parity and 60s external-use throttle parity across Stage 3/4 updates", async () => {
      const events: ShadowCompareEvent[] = [];
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const shadowRunner = new ShadowCompareRunner({
        onEvent: e => events.push(e),
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        shadowRunner,
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_shadow_compare",
        shadowSampleRate: 1.0,
      });
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });

      const c = await dual.createConsole({
        workspaceId: wsId,
        name: "Parity Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await dual.bumpConsoleDraftRevision(wsId, c.id);
      const t1 = new Date("2026-11-25T10:00:00.123Z");
      expect(
        await dual.recordConsoleExternalUse(wsId, c.id, "mcp", "access", t1),
      ).toBe(true);
      // 10s later -> throttled (returns false, leaves timestamps unchanged)
      const t2 = new Date("2026-11-25T10:00:10.456Z");
      expect(
        await dual.recordConsoleExternalUse(wsId, c.id, "mcp", "access", t2),
      ).toBe(false);
      await dual.softDeleteConsole(
        wsId,
        c.id,
        new Date("2026-11-25T10:05:00.789Z"),
      );
      await dual.restoreConsole(wsId, c.id);

      const fav = await dual.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Fav Parity",
        position: 0,
      });
      await dual.updateFavouriteSimple(wsId, userV7Id, fav.id, {
        title: "Fav Renamed",
      });
      await dual.reorderFavourites(wsId, userV7Id, [
        { id: fav.id, parentId: null, position: 3 },
      ]);

      await dual.findConsoleById(wsId, c.id);
      await dual.findFavouriteById(wsId, userV7Id, fav.id);
      await shadowRunner.flush();

      expect(events).toHaveLength(2);
      expect(events.every(e => e.result === "match")).toBe(true);

      const verifyReport = await runParityVerification({
        domain: CONSOLES_CHARTS_DOMAIN,
        db,
        workspaceId: wsId,
        batchSize: 100,
      });
      expect(verifyReport.ok).toBe(true);
      expect(verifyReport.mismatched).toBe(0);
    });

    it("gates secondary writes and tombstones on throttle hits, concurrency conflicts, and unauthorized/no-op deletes", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });

      const folder = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Protected Folder",
        ownerId: userV7Id,
      });
      const nbIdx = await dual.createNotebookIndex({
        workspaceId: wsId,
        notebookId: "nb-protected",
        name: "Protected Notebook",
        ownerId: userV7Id,
      });
      const fav = await dual.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "item",
        kind: "notebook",
        refId: nbIdx.notebookId,
        position: 0,
      });

      // guardedSaveConsole upsert has exact createdAt & updatedAt ms parity
      const draftId = new Types.ObjectId().toString();
      const upserted = await dual.guardedSaveConsole({
        workspaceId: wsId,
        consoleId: draftId,
        upsert: true,
        set: { code: "SELECT 'upsert-parity'", name: "Draft Parity" },
        incDraftRevision: 1,
        setOnInsert: {
          name: "Draft Parity",
          createdBy: userV7Id,
          owner_id: userV7Id,
          isSaved: false,
        },
      });
      expect(upserted).not.toBeNull();
      const mongoDraft = await mongoRepo.findConsoleById(wsId, draftId);
      const pgDraft = await pgRepo.findConsoleById(wsId, draftId);
      expect(mongoDraft?.createdAt.getTime()).toBe(
        pgDraft?.createdAt.getTime(),
      );
      expect(mongoDraft?.updatedAt.getTime()).toBe(
        pgDraft?.updatedAt.getTime(),
      );

      // guardedSaveConsole conflict executes 0 secondary PG calls
      const pgGuardedSpy = vi.spyOn(pgRepo, "guardedSaveConsole");
      const conflict = await dual.guardedSaveConsole({
        workspaceId: wsId,
        consoleId: draftId,
        expectedVersion: 99,
        upsert: false,
        set: { code: "SELECT 'stale'" },
        incVersion: 1,
      });
      expect(conflict).toBeNull();
      expect(pgGuardedSpy).toHaveBeenCalledTimes(0);
      pgGuardedSpy.mockRestore();

      // Stage 2 60s external-use throttle executes 0 secondary PG calls
      const t1 = new Date("2026-11-26T10:00:00.000Z");
      expect(
        await dual.recordConsoleExternalUse(wsId, draftId, "mcp", "access", t1),
      ).toBe(true);
      const pgExtSpy = vi.spyOn(pgRepo, "recordConsoleExternalUse");
      expect(
        await dual.recordConsoleExternalUse(
          wsId,
          draftId,
          "mcp",
          "access",
          new Date(t1.getTime() + 15_000),
        ),
      ).toBe(false);
      expect(pgExtSpy).toHaveBeenCalledTimes(0);
      pgExtSpy.mockRestore();

      // Stage 4 60s external-use throttle executes 0 secondary Mongo calls
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_pg_read",
      });
      const mongoExtSpy = vi.spyOn(mongoRepo, "recordConsoleExternalUse");
      expect(
        await dual.recordConsoleExternalUse(
          wsId,
          draftId,
          "mcp",
          "access",
          new Date(t1.getTime() + 30_000),
        ),
      ).toBe(false);
      expect(mongoExtSpy).toHaveBeenCalledTimes(0);
      mongoExtSpy.mockRestore();

      // Stage 2 wrong-workspace deletes execute 0 secondary calls and write 0 tombstones
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const pgDelFolderSpy = vi.spyOn(pgRepo, "deleteConsoleFolder");
      const pgDelNbSpy = vi.spyOn(pgRepo, "deleteNotebookIndex");
      const pgDelFavSpy = vi.spyOn(pgRepo, "deleteFavouriteByRef");

      expect(await dual.deleteConsoleFolder(ws2Id, folder.id)).toBe(false);
      expect(await dual.deleteNotebookIndex(ws2Id, nbIdx.notebookId)).toBe(
        false,
      );
      expect(
        await dual.deleteFavouriteByRef(
          ws2Id,
          userV7Id,
          "notebook",
          nbIdx.notebookId,
        ),
      ).toBe(false);

      expect(pgDelFolderSpy).toHaveBeenCalledTimes(0);
      expect(pgDelNbSpy).toHaveBeenCalledTimes(0);
      expect(pgDelFavSpy).toHaveBeenCalledTimes(0);
      pgDelFolderSpy.mockRestore();
      pgDelNbSpy.mockRestore();
      pgDelFavSpy.mockRestore();

      // Direct wrong-workspace replaySyncToPg delete leaves real folder intact and writes 0 tombstones
      await replaySyncToPg(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "pg",
          operation: "deleteConsoleFolder",
          entityId: folder.id,
          workspaceId: ws2Id,
          payload: {
            table: "console_folders",
            action: "delete",
            id: folder.id,
            workspaceId: ws2Id,
          },
          errorMessage: "unauthorized replay",
          failedAt: new Date().toISOString(),
        },
        db,
      );

      expect(
        await pgRepo.findConsoleFolderById(wsId, folder.id),
      ).not.toBeNull();
      expect(
        await pgRepo.findNotebookIndex(wsId, nbIdx.notebookId),
      ).not.toBeNull();
      expect(
        await pgRepo.findFavouriteById(wsId, userV7Id, fav.id),
      ).not.toBeNull();
      expect(await db.select().from(pgSchema.migrationTombstones)).toHaveLength(
        0,
      );
      expect(failures).toHaveLength(0);
    });

    it("survives transient PG failure during Stage 2 delete and records tombstones on replaySyncToPg", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      // Inject a failing getDb to simulate PG unreachable during delete + tombstone write
      let pgUnreachable = false;
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => {
          if (pgUnreachable) throw new Error("pg connection refused");
          return db;
        },
        resolveUserUuid,
      });

      const folder = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Outage Folder",
        ownerId: userV7Id,
      });
      // Also create a Mongo-only folder that was never backfilled to PG yet
      const mongoOnlyFolder = await mongoRepo.createConsoleFolder({
        workspaceId: wsId,
        name: "Mongo Only Folder",
        ownerId: userV7Id,
      });

      pgUnreachable = true;
      const pgDelSpy = vi
        .spyOn(pgRepo, "deleteConsoleFolder")
        .mockRejectedValue(new Error("pg connection refused"));
      expect(await dual.deleteConsoleFolder(wsId, folder.id)).toBe(true);
      expect(await dual.deleteConsoleFolder(wsId, mongoOnlyFolder.id)).toBe(
        true,
      );
      pgDelSpy.mockRestore();
      pgUnreachable = false;

      // Both deletes succeeded on Mongo without throwing despite PG outage
      expect(failures).toHaveLength(2);
      expect(
        await pgRepo.findConsoleFolderById(wsId, folder.id),
      ).not.toBeNull();
      expect(await db.select().from(pgSchema.migrationTombstones)).toHaveLength(
        0,
      );

      // Replaying both deletes removes the PG row AND writes tombstones for BOTH (including the un-backfilled one)
      for (const f of failures) {
        await replaySyncToPg(
          {
            domain: CONSOLES_CHARTS_DOMAIN,
            target: "pg",
            operation: f.operation,
            entityId: f.entityId ?? "",
            workspaceId: f.workspaceId,
            payload: f.payload,
            errorMessage: "pg connection refused",
            failedAt: new Date().toISOString(),
          },
          db,
        );
      }

      expect(await pgRepo.findConsoleFolderById(wsId, folder.id)).toBeNull();
      const tombstones = await db.select().from(pgSchema.migrationTombstones);
      const tombIds = tombstones.map(t => t.entityId).sort();
      expect(tombIds).toEqual(
        [objectIdToUuid(folder.id), objectIdToUuid(mongoOnlyFolder.id)].sort(),
      );
    });

    it("protects strictly newer live PG rows during --repair and reconciles PK drift on unique indexes", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const tOld = new Date("2026-11-10T00:00:00.000Z");
      const tNew = new Date("2026-11-20T00:00:00.000Z");
      const tNewest = new Date("2026-11-25T00:00:00.000Z");

      // 1. SavedConsole: PG has newer updatedAt (tNew) vs stale Mongo (tOld)
      const consoleRec = await pgRepo.createConsole({
        workspaceId: wsId,
        name: "Live PG Console",
        code: "SELECT 'live'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        createdAt: tOld,
        updatedAt: tNew,
      });
      await SavedConsole.collection.insertOne({
        _id: new Types.ObjectId(consoleRec.id),
        workspaceId: new Types.ObjectId(wsId),
        name: "Stale Mongo Console",
        code: "SELECT 'stale'",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        isPrivate: true,
        access: "private",
        workspaceRole: "editor",
        sharedWith: [],
        version: 1,
        draftRevision: 1,
        executionCount: 0,
        externalUseCount: 0,
        is_deleted: false,
        createdAt: tOld,
        updatedAt: tOld,
      });

      // 2. NotebookIndex: PG has newer updatedAt (tNew) vs stale Mongo (tOld)
      const nbLive = await pgRepo.createNotebookIndex({
        workspaceId: wsId,
        notebookId: "nb-live",
        name: "Live PG Notebook",
        ownerId: userV7Id,
        updatedAt: tNew,
      });
      await NotebookIndex.collection.insertOne({
        _id: new Types.ObjectId(nbLive.id),
        workspaceId: new Types.ObjectId(wsId),
        notebookId: "nb-live",
        name: "Stale Mongo Notebook",
        ownerId: userV7Id,
        access: "private",
        workspaceRole: "editor",
        sharedWith: [],
        updatedAt: tOld,
      });

      // 3. Favourite: PG moved to root at tNew vs stale Mongo under favFolder at tOld
      const favFolder = await pgRepo.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Repair Folder",
        position: 0,
        createdAt: tOld,
        updatedAt: tOld,
      });
      await Favourite.collection.insertOne({
        _id: new Types.ObjectId(favFolder.id),
        workspaceId: new Types.ObjectId(wsId),
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Repair Folder",
        position: 0,
        createdAt: tOld,
        updatedAt: tOld,
      });
      const favLive = await pgRepo.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "item",
        kind: "console",
        refId: consoleRec.id,
        position: 2,
        createdAt: tOld,
        updatedAt: tNew,
      });
      await Favourite.collection.insertOne({
        _id: new Types.ObjectId(favLive.id),
        workspaceId: new Types.ObjectId(wsId),
        userId: userV7Id,
        parentId: favFolder.id,
        type: "item",
        kind: "console",
        refId: consoleRec.id,
        position: 0,
        createdAt: tOld,
        updatedAt: tOld,
      });

      // 4. ScheduledQueryRun: PG completed at tNew vs stale Mongo running
      const runLive = await pgRepo.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: consoleRec.id,
        triggeredAt: tOld,
        startedAt: tOld,
        completedAt: tNew,
        status: "success",
        triggerType: "schedule",
        durationMs: 1200,
        rowCount: 42,
      });
      await ScheduledQueryRun.collection.insertOne({
        _id: new Types.ObjectId(runLive.id),
        workspaceId: new Types.ObjectId(wsId),
        consoleId: new Types.ObjectId(consoleRec.id),
        triggeredAt: tOld,
        startedAt: tOld,
        status: "running",
        triggerType: "schedule",
      });

      // 5. Unique-index PK reconciliation (delete+recreate with newer PK in Mongo)
      const oldNb = await pgRepo.createNotebookIndex({
        workspaceId: wsId,
        notebookId: "nb-recreated",
        name: "Old Recreated",
        ownerId: userV7Id,
        updatedAt: tOld,
      });
      const newNbId = new Types.ObjectId();
      await NotebookIndex.collection.insertOne({
        _id: newNbId,
        workspaceId: new Types.ObjectId(wsId),
        notebookId: "nb-recreated",
        name: "New Recreated",
        ownerId: userV7Id,
        access: "workspace",
        workspaceRole: "editor",
        sharedWith: [],
        updatedAt: tNewest,
      });

      const oldFav = await pgRepo.createFavourite({
        workspaceId: wsId,
        userId: userV7Id,
        parentId: null,
        type: "item",
        kind: "notebook",
        refId: "nb-recreated",
        position: 3,
        createdAt: tOld,
        updatedAt: tOld,
      });
      const newFavId = new Types.ObjectId();
      await Favourite.collection.insertOne({
        _id: newFavId,
        workspaceId: new Types.ObjectId(wsId),
        userId: userV7Id,
        parentId: null,
        type: "item",
        kind: "notebook",
        refId: "nb-recreated",
        position: 4,
        createdAt: tNewest,
        updatedAt: tNewest,
      });

      // Run --repair across all tables
      await runParityVerification({
        domain: CONSOLES_CHARTS_DOMAIN,
        db,
        workspaceId: wsId,
        repair: true,
        batchSize: 50,
      });

      // All 4 strictly newer live PG rows survived untouched
      expect((await pgRepo.findConsoleById(wsId, consoleRec.id))?.name).toBe(
        "Live PG Console",
      );
      expect((await pgRepo.findNotebookIndex(wsId, "nb-live"))?.name).toBe(
        "Live PG Notebook",
      );
      const afterFavLive = await pgRepo.findFavouriteById(
        wsId,
        userV7Id,
        favLive.id,
      );
      expect(afterFavLive?.parentId).toBeNull();
      expect(afterFavLive?.position).toBe(2);
      const afterRunLive = await pgRepo.findScheduledQueryRunById(
        runLive.id,
        wsId,
      );
      expect(afterRunLive?.status).toBe("success");
      expect(afterRunLive?.completedAt?.toISOString()).toBe(tNew.toISOString());

      // Both delete+recreate unique-index rows reconciled their PK without 23505
      const reconciledNb = await pgRepo.findNotebookIndex(wsId, "nb-recreated");
      expect(reconciledNb?.id).toBe(newNbId.toString());
      expect(reconciledNb?.id).not.toBe(oldNb.id);
      expect(reconciledNb?.name).toBe("New Recreated");

      const reconciledFav = await pgRepo.findFavouriteByRef(
        wsId,
        userV7Id,
        "notebook",
        "nb-recreated",
      );
      expect(reconciledFav?.id).toBe(newFavId.toString());
      expect(reconciledFav?.id).not.toBe(oldFav.id);
      expect(reconciledFav?.position).toBe(4);
    });

    it("never touches Mongo in global Stage 5 (pg_only) for workspace-less reads", async () => {
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "pg_only",
      });
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });

      const dueAt = new Date("2026-11-01T00:00:00.000Z");
      const c = await dual.createConsole({
        workspaceId: wsId,
        name: "Stage 5 Console",
        code: "SELECT 5",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        sourceBlobSha: "sha-stage5",
        schedule: { cron: "0 * * * *", timezone: "UTC" },
        scheduledRun: { nextAt: dueAt, runCount: 0, consecutiveFailures: 0 },
      });
      const run = await dual.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: c.id,
        triggeredAt: dueAt,
        status: "running",
        triggerType: "schedule",
      });

      const sGlobal = vi.spyOn(mongoRepo, "findConsoleByIdGlobal");
      const sDue = vi.spyOn(mongoRepo, "findDueScheduledConsoles");
      const sDesc = vi.spyOn(mongoRepo, "listConsolesNeedingDescription");
      const sRun = vi.spyOn(mongoRepo, "findScheduledQueryRunById");

      expect((await dual.findConsoleByIdGlobal(c.id))?.id).toBe(c.id);
      expect(
        (
          await dual.findDueScheduledConsoles(
            new Date("2026-11-01T01:00:00.000Z"),
          )
        ).map(d => d.id),
      ).toContain(c.id);
      expect(
        (await dual.listConsolesNeedingDescription()).map(d => d.id),
      ).toContain(c.id);
      expect((await dual.findScheduledQueryRunById(run.id))?.id).toBe(run.id);

      expect(sGlobal).toHaveBeenCalledTimes(0);
      expect(sDue).toHaveBeenCalledTimes(0);
      expect(sDesc).toHaveBeenCalledTimes(0);
      expect(sRun).toHaveBeenCalledTimes(0);

      sGlobal.mockRestore();
      sDue.mockRestore();
      sDesc.mockRestore();
      sRun.mockRestore();
    });

    it("supports UUIDv8 symmetry, ID-only sync-retry payloads, injected getDb with POSTGRES_URL unset, and quarantines invalid embeddings", async () => {
      const prevUrl = process.env.POSTGRES_URL;
      delete process.env.POSTGRES_URL;
      resetPgTestDb();

      try {
        const failures: SecondaryWriteFailureContext[] = [];
        const mongoRepo = new MongoConsolesChartsRepository();
        const pgRepo = new PgConsolesChartsRepository({
          getDb: () => db,
          resolveUserUuid,
        });
        const router = new MigrationRouter({
          getDb: () => db,
          hasPg: () => true,
          enablePubSub: false,
          onSecondaryFailure: async ctx => {
            failures.push(ctx);
          },
        });
        await router.setDomainState({
          domain: CONSOLES_CHARTS_DOMAIN,
          mode: "dual_write_mongo_read",
        });
        // Intentionally omit `hasPg` on DualConsolesChartsRepository to verify `getDb` implies PG availability
        const dual = new DualConsolesChartsRepository({
          mongo: mongoRepo,
          pg: pgRepo,
          router,
          getDb: () => db,
          resolveUserUuid,
        });

        // UUIDv8 parentId symmetry on Mongo favourites
        const favFolder = await dual.createFavourite({
          workspaceId: wsId,
          userId: userLuciaId,
          parentId: null,
          type: "folder",
          title: "UUIDv8 Folder",
          position: 0,
        });
        const favFolderUuid = objectIdToUuid(favFolder.id);
        const favChild = await dual.createFavourite({
          workspaceId: wsId,
          userId: userLuciaId,
          parentId: favFolderUuid,
          type: "item",
          kind: "notebook",
          refId: "nb-uuidv8",
          position: 0,
        });
        expect(favChild.parentId).toBe(favFolder.id);
        const mongoSiblings = await mongoRepo.listFavouriteSiblings(
          wsId,
          userLuciaId,
          favFolderUuid,
        );
        expect(mongoSiblings.map(s => s.id)).toEqual([favChild.id]);

        // Stage 2 ID-only retry payload for reorderFavourites & updateConsolesInFolder
        const cFolder = await dual.createConsoleFolder({
          workspaceId: wsId,
          name: "Access Folder",
          ownerId: userLuciaId,
          access: "private",
          isPrivate: true,
        });
        const cInFolder = await dual.createConsole({
          workspaceId: wsId,
          folderId: cFolder.id,
          name: "Folder Console",
          code: "SELECT 1",
          language: "sql",
          createdBy: userLuciaId,
          access: "private",
          isPrivate: true,
          isSaved: true,
        });

        const pgReorderSpy = vi
          .spyOn(pgRepo, "reorderFavourites")
          .mockRejectedValueOnce(new Error("pg timeout"));
        const pgFolderAccessSpy = vi
          .spyOn(pgRepo, "updateConsolesInFolder")
          .mockRejectedValueOnce(new Error("pg timeout"));

        const reorderAt = new Date(Date.now() + 60_000);
        await dual.reorderFavourites(
          wsId,
          userLuciaId,
          [{ id: favChild.id, parentId: null, position: 5 }],
          reorderAt,
        );
        await dual.updateConsolesInFolder(wsId, cFolder.id, {
          access: "workspace",
          isPrivate: false,
        });
        pgReorderSpy.mockRestore();
        pgFolderAccessSpy.mockRestore();

        expect(failures).toHaveLength(2);
        // Payloads must be strictly ID-only (no `updates`, `title`, or `patch`)
        expect(failures[0].payload).not.toHaveProperty("updates");
        expect(failures[0].payload).toHaveProperty("ids", [favChild.id]);
        expect(failures[1].payload).not.toHaveProperty("patch");
        expect(failures[1].payload).toHaveProperty("folderId", cFolder.id);

        for (const f of failures) {
          await replaySyncToPg(
            {
              domain: CONSOLES_CHARTS_DOMAIN,
              target: "pg",
              operation: f.operation,
              entityId: f.entityId ?? "",
              workspaceId: f.workspaceId,
              payload: f.payload,
              errorMessage: "pg timeout",
              failedAt: new Date().toISOString(),
            },
            db,
          );
        }
        const pgFavAfter = await pgRepo.findFavouriteById(
          wsId,
          userLuciaId,
          favChild.id,
        );
        expect(pgFavAfter?.parentId).toBeNull();
        expect(pgFavAfter?.position).toBe(5);
        expect(pgFavAfter?.updatedAt.getTime()).toBe(reorderAt.getTime());
        expect((await pgRepo.findConsoleById(wsId, cInFolder.id))?.access).toBe(
          "workspace",
        );

        // Stage 4 ID-only replaySyncToMongo + UUIDv8 entityId replay for favourites & entity_versions
        failures.length = 0;
        await router.setDomainState({
          domain: CONSOLES_CHARTS_DOMAIN,
          mode: "dual_write_pg_read",
        });

        const mongoReorderSpy = vi
          .spyOn(mongoRepo, "reorderFavourites")
          .mockRejectedValueOnce(new Error("mongo timeout"));
        const mongoFolderAccessSpy = vi
          .spyOn(mongoRepo, "updateConsolesInFolder")
          .mockRejectedValueOnce(new Error("mongo timeout"));

        const reorderAt2 = new Date(Date.now() + 120_000);
        await dual.reorderFavourites(
          wsId,
          userLuciaId,
          [{ id: favChild.id, parentId: favFolder.id, position: 1 }],
          reorderAt2,
        );
        await dual.updateConsolesInFolder(wsId, cFolder.id, {
          access: "private",
          isPrivate: true,
        });
        mongoReorderSpy.mockRestore();
        mongoFolderAccessSpy.mockRestore();

        expect(failures).toHaveLength(2);
        for (const f of failures) {
          await replaySyncToMongo(
            {
              domain: CONSOLES_CHARTS_DOMAIN,
              target: "mongo",
              operation: f.operation,
              entityId: f.entityId ?? "",
              workspaceId: f.workspaceId,
              payload: f.payload,
              errorMessage: "mongo timeout",
              failedAt: new Date().toISOString(),
            },
            db,
          );
        }
        const mongoFavAfter = await mongoRepo.findFavouriteById(
          wsId,
          userLuciaId,
          favChild.id,
        );
        expect(mongoFavAfter?.parentId).toBe(favFolder.id);
        expect(mongoFavAfter?.position).toBe(1);
        expect(mongoFavAfter?.userId).toBe(userLuciaId);
        expect(
          (await mongoRepo.findConsoleById(wsId, cInFolder.id))?.access,
        ).toBe("private");

        // Stage 4 UUIDv8 entityId replay for favourites & entity_versions (with Lucia legacy user remapping)
        const pgOnlyFav = await pgRepo.createFavourite({
          workspaceId: wsId,
          userId: userLuciaId,
          parentId: null,
          type: "item",
          kind: "app",
          refId: "app-uuidv8-replay",
          position: 9,
        });
        const pgOnlyVer = await pgRepo.createEntityVersion({
          workspaceId: wsId,
          entityType: "console",
          entityId: cInFolder.id,
          snapshot: { code: "SELECT 'ver'" },
          savedBy: userLuciaId,
          savedByName: "Lucia",
          comment: "uuidv8 replay",
        });

        await replaySyncToMongo(
          {
            domain: CONSOLES_CHARTS_DOMAIN,
            target: "mongo",
            operation: "createFavourite",
            entityId: objectIdToUuid(pgOnlyFav.id),
            workspaceId: wsId,
            payload: {
              table: "favourites",
              action: "upsert",
              id: objectIdToUuid(pgOnlyFav.id),
              workspaceId: wsId,
            },
            errorMessage: "mongo outage",
            failedAt: new Date().toISOString(),
          },
          db,
        );
        await replaySyncToMongo(
          {
            domain: CONSOLES_CHARTS_DOMAIN,
            target: "mongo",
            operation: "createEntityVersion",
            entityId: objectIdToUuid(pgOnlyVer.id),
            workspaceId: wsId,
            payload: {
              table: "entity_versions",
              action: "upsert",
              id: objectIdToUuid(pgOnlyVer.id),
              workspaceId: wsId,
            },
            errorMessage: "mongo outage",
            failedAt: new Date().toISOString(),
          },
          db,
        );
        const replayedFav = await mongoRepo.findFavouriteById(
          wsId,
          userLuciaId,
          pgOnlyFav.id,
        );
        expect(replayedFav?.userId).toBe(userLuciaId);
        const replayedVer = await mongoRepo.getEntityVersion(
          cInFolder.id,
          "console",
          pgOnlyVer.version,
          wsId,
        );
        expect(replayedVer?.savedBy).toBe(userLuciaId);

        // Corrupt non-1536 descriptionEmbedding is quarantined cleanly during backfill
        const badConsoleId = new Types.ObjectId();
        await SavedConsole.collection.insertOne({
          _id: badConsoleId,
          workspaceId: new Types.ObjectId(wsId),
          name: "Corrupt Embedding Console",
          code: "SELECT 'bad'",
          language: "sql",
          descriptionEmbedding: [0.1, 0.2, 0.3],
          createdBy: userV7Id,
          isSaved: true,
          isPrivate: true,
          access: "private",
          workspaceRole: "editor",
          sharedWith: [],
          version: 1,
          draftRevision: 1,
          executionCount: 0,
          externalUseCount: 0,
          is_deleted: false,
          createdAt: new Date("2026-11-26T00:00:00.000Z"),
          updatedAt: new Date("2026-11-26T00:00:00.000Z"),
        });

        const bf = await runBackfill({
          domain: `${CONSOLES_CHARTS_DOMAIN}:saved_consoles`,
          workspaceId: wsId,
          db,
          batchSize: 50,
        });
        expect(bf.status).toBe("completed");
        const qRows = await db
          .select()
          .from(pgSchema.migrationQuarantine)
          .where(
            eq(
              pgSchema.migrationQuarantine.reason,
              "invalid_embedding_dimensions",
            ),
          );
        expect(qRows).toHaveLength(1);
        expect(qRows[0].collectionName).toBe("savedconsoles");
        expect(
          await pgRepo.findConsoleById(wsId, badConsoleId.toString()),
        ).toBeNull();

        const verifyAfter = await runParityVerification({
          domain: `${CONSOLES_CHARTS_DOMAIN}:saved_consoles`,
          workspaceId: wsId,
          db,
          batchSize: 50,
        });
        expect(verifyAfter.ok).toBe(true);
      } finally {
        if (prevUrl !== undefined) process.env.POSTGRES_URL = prevUrl;
      }
    });

    it("unsets cleared nullable fields in Mongo during Stage 4 replaySyncToMongo (#90-1)", async () => {
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const folder = await pgRepo.createConsoleFolder({
        workspaceId: wsId,
        name: "Temp Folder",
        ownerId: userV7Id,
      });
      await mongoRepo.upsertConsoleFolder(folder);

      const connId = new Types.ObjectId().toString();
      const consoleRec = await pgRepo.createConsole({
        workspaceId: wsId,
        folderId: folder.id,
        connectionId: connId,
        databaseName: "analytics",
        name: "Clearable Console",
        description: "Initial description",
        code: "SELECT 1",
        language: "sql",
        chartSpec: { type: "bar", xAxis: "day" },
        resultsViewMode: "chart",
        createdBy: userV7Id,
        owner_id: userV7Id,
        isSaved: true,
        schedule: { cron: "0 * * * *", timezone: "UTC" },
        scheduledRun: {
          nextAt: new Date("2026-12-01T00:00:00.000Z"),
          runCount: 2,
          consecutiveFailures: 0,
        },
        is_deleted: true,
        deletedAt: new Date("2026-11-20T00:00:00.000Z"),
      });
      await mongoRepo.upsertConsole(consoleRec);

      // Clear nullable fields on PG primary (simulating Stage 4 mutations whose Mongo mirror failed)
      await pgRepo.clearConsoleSchedule(wsId, consoleRec.id);
      await pgRepo.restoreConsole(wsId, consoleRec.id);
      await pgRepo.updateConsole(wsId, consoleRec.id, {
        folderId: null,
        connectionId: null,
        chartSpec: null,
        description: null,
        databaseName: null,
        scheduledRun: null,
      });

      await replaySyncToMongo(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "mongo",
          operation: "updateConsole",
          entityId: consoleRec.id,
          workspaceId: wsId,
          payload: {
            table: "saved_consoles",
            action: "upsert",
            id: consoleRec.id,
            workspaceId: wsId,
          },
          errorMessage: "mongo transient",
          failedAt: new Date().toISOString(),
        },
        db,
      );

      const rawMongo = await SavedConsole.collection.findOne({
        _id: new Types.ObjectId(consoleRec.id),
      });
      expect(rawMongo).not.toBeNull();
      expect(rawMongo?.schedule).toBeUndefined();
      expect(rawMongo?.scheduledRun).toBeUndefined();
      expect(rawMongo?.folderId).toBeUndefined();
      expect(rawMongo?.connectionId).toBeUndefined();
      expect(rawMongo?.chartSpec).toBeUndefined();
      expect(rawMongo?.description).toBeUndefined();
      expect(rawMongo?.databaseName).toBeUndefined();
      expect(rawMongo?.deletedAt).toBeUndefined();
      expect(rawMongo?.is_deleted).toBe(false);

      const mongoAfter = await mongoRepo.findConsoleById(wsId, consoleRec.id);
      expect(mongoAfter?.schedule).toBeUndefined();
      expect(mongoAfter?.scheduledRun).toBeUndefined();
      expect(mongoAfter?.folderId).toBeUndefined();
      expect(mongoAfter?.connectionId).toBeUndefined();
      expect(mongoAfter?.chartSpec).toBeUndefined();
      expect(mongoAfter?.description).toBeUndefined();
      expect(mongoAfter?.deletedAt).toBeUndefined();
    });

    it("fails closed on malformed workspaceId across all 7 scoped methods in both Mongo and PG repos (#90-2)", async () => {
      for (const impl of implementations) {
        const repo = impl.create();
        const c = await repo.createConsole({
          workspaceId: wsId,
          name: "Scoped Console",
          code: "SELECT 1",
          language: "sql",
          createdBy: userV7Id,
          isSaved: true,
          sourceBlobSha: "sha-malformed-ws-test",
        });
        await repo.createEntityVersion({
          workspaceId: wsId,
          entityType: "console",
          entityId: c.id,
          snapshot: { code: "SELECT 1" },
          savedBy: userV7Id,
          savedByName: "V7",
          comment: "v1",
        });
        const run = await repo.createScheduledQueryRun({
          workspaceId: wsId,
          consoleId: c.id,
          triggeredAt: new Date("2026-11-26T00:00:00.000Z"),
          status: "running",
          triggerType: "schedule",
        });

        for (const badWs of ["not-a-valid-id", ""]) {
          expect(
            await repo.listConsolesNeedingDescription({ workspaceId: badWs }),
          ).toEqual([]);
          expect(
            await repo.getLatestEntityVersionNumber(c.id, "console", badWs),
          ).toBe(0);
          expect(
            await repo.listEntityVersions(c.id, "console", {
              workspaceId: badWs,
            }),
          ).toEqual({ versions: [], total: 0 });
          expect(
            await repo.listEntityVersionsAscending(badWs, c.id, "console"),
          ).toEqual([]);
          expect(
            await repo.getEntityVersion(c.id, "console", 1, badWs),
          ).toBeNull();
          expect(
            await repo.findScheduledQueryRunById(run.id, badWs),
          ).toBeNull();
          expect(
            await repo.updateScheduledQueryRun(badWs, run.id, {
              status: "error",
            }),
          ).toBe(false);
        }

        // Verify the real workspace's run was NOT mutated
        const intactRun = await repo.findScheduledQueryRunById(run.id, wsId);
        expect(intactRun?.status).toBe("running");
      }

      // Also verify DualConsolesChartsRepository fails closed on `""` and invalid workspaceId
      // in mixed-stage canary and Stage 5 `pg_only` modes (never falling through to workspace-less lookup).
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
      });
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "pg_only",
      });
      const dualC = await dual.createConsole({
        workspaceId: wsId,
        name: "Dual Scoped Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
        sourceBlobSha: "sha-dual-malformed-ws",
      });
      await dual.createEntityVersion({
        workspaceId: wsId,
        entityType: "console",
        entityId: dualC.id,
        snapshot: { code: "SELECT 1" },
        savedBy: userV7Id,
        savedByName: "V7",
      });
      const dualRun = await dual.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: dualC.id,
        triggeredAt: new Date("2026-11-26T00:00:00.000Z"),
        status: "running",
        triggerType: "schedule",
      });
      for (const badWs of ["not-a-valid-id", ""]) {
        expect(
          await dual.listConsolesNeedingDescription({ workspaceId: badWs }),
        ).toEqual([]);
        expect(
          await dual.getLatestEntityVersionNumber(dualC.id, "console", badWs),
        ).toBe(0);
        expect(
          await dual.listEntityVersions(dualC.id, "console", {
            workspaceId: badWs,
          }),
        ).toEqual({ versions: [], total: 0 });
        expect(
          await dual.listEntityVersionsAscending(badWs, dualC.id, "console"),
        ).toEqual([]);
        expect(
          await dual.getEntityVersion(dualC.id, "console", 1, badWs),
        ).toBeNull();
        expect(
          await dual.findScheduledQueryRunById(dualRun.id, badWs),
        ).toBeNull();
        expect(
          await dual.updateScheduledQueryRun(badWs, dualRun.id, {
            status: "error",
          }),
        ).toBe(false);
      }
    });

    it("reverse-maps legacy Lucia PG UUIDv7 -> legacy_id on Stage 4 live writes and reverse shadow-compare (#90-3)", async () => {
      const events: ShadowCompareEvent[] = [];
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const shadowRunner = new ShadowCompareRunner({
        onEvent: e => events.push(e),
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        shadowRunner,
      });
      // Seed legacy data in Stage 2 (Mongo holds legacy Lucia IDs; PG holds PG UUIDv7)
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });

      const legacyFavFolder = await dual.createFavourite({
        workspaceId: wsId,
        userId: userLuciaId,
        parentId: null,
        type: "folder",
        title: "Legacy Pinned",
        position: 0,
      });
      const legacyFavItem = await dual.createFavourite({
        workspaceId: wsId,
        userId: userLuciaId,
        parentId: legacyFavFolder.id,
        type: "item",
        kind: "notebook",
        refId: "nb-legacy-fav",
        position: 0,
      });

      // Verify Stages 1–3 make zero extra PG `users` reverse-lookup queries before Mongo writes/reads
      const stage1Router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => false,
        enablePubSub: false,
      });
      const stage1GetDb = vi.fn(() => {
        throw new Error("getDb must not be called in Stage 1 mongo_only");
      });
      const stage1Dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router: stage1Router,
        getDb: stage1GetDb,
        hasPg: () => false,
        resolveUserUuid,
      });
      await stage1Dual.listFavourites(wsId, userLuciaUuid);
      await stage1Dual.listNotebookIndexes(wsId, {
        visibleForUserId: userLuciaUuid,
      });
      expect(stage1GetDb).not.toHaveBeenCalled();

      // Advance to Stage 4 (`dual_write_pg_read`, shadowSampleRate: 1.0).
      // Post-Wave-1 auth sessions pass the legacy user's PG UUIDv7 (`userLuciaUuid`).
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_pg_read",
        shadowSampleRate: 1.0,
      });

      // Stage 4 live writes passing PG UUIDv7s must write legacy_id into Mongo
      const cf = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Stage4 Folder",
        ownerId: userLuciaUuid,
      });
      const c = await dual.createConsole({
        workspaceId: wsId,
        folderId: cf.id,
        name: "Stage4 Lucia Console",
        code: "SELECT 'stage4'",
        language: "sql",
        createdBy: userLuciaUuid,
        owner_id: userLuciaUuid,
        isSaved: true,
        sharedWith: [
          {
            userId: userV4Uuid,
            role: "editor",
            addedAt: new Date("2026-11-26T00:00:00.000Z"),
            addedBy: userLuciaUuid,
          },
        ],
      });
      await dual.updateConsole(wsId, c.id, {
        owner_id: userV4Uuid,
        lastRun: {
          at: new Date("2026-11-26T01:00:00.000Z"),
          status: "success",
          durationMs: 15,
          rowCount: 3,
          runBy: userLuciaUuid,
          source: "ui",
        },
      });
      await dual.recordConsoleExecution(wsId, c.id, {
        lastExecutedAt: new Date("2026-11-26T01:05:00.000Z"),
        lastRun: {
          at: new Date("2026-11-26T01:05:00.000Z"),
          status: "success",
          durationMs: 18,
          rowCount: 4,
          runBy: userLuciaUuid,
          source: "ui",
        },
      });
      const guardedId = new Types.ObjectId().toString();
      await dual.guardedSaveConsole({
        workspaceId: wsId,
        consoleId: guardedId,
        upsert: true,
        set: {
          name: "Stage4 Guarded Console",
          code: "SELECT 42",
          language: "sql",
          owner_id: userLuciaUuid,
        },
        setOnInsert: {
          createdBy: userLuciaUuid,
          isSaved: true,
        },
      });
      const mongoGuarded = await mongoRepo.findConsoleById(wsId, guardedId);
      expect(mongoGuarded?.createdBy).toBe(userLuciaId);
      expect(mongoGuarded?.owner_id).toBe(userLuciaId);
      await dual.createEntityVersion({
        workspaceId: wsId,
        entityType: "console",
        entityId: c.id,
        snapshot: { code: "SELECT 'stage4'" },
        savedBy: userLuciaUuid,
        savedByName: "Lucia",
        comment: "stage4 save",
      });
      const nbIdx = await dual.createNotebookIndex({
        workspaceId: wsId,
        notebookId: "nb-stage4-lucia",
        name: "Lucia Private NB",
        ownerId: userLuciaUuid,
        access: "private",
      });
      const run = await dual.createScheduledQueryRun({
        workspaceId: wsId,
        consoleId: c.id,
        triggeredAt: new Date("2026-11-26T02:00:00.000Z"),
        status: "running",
        triggerType: "manual",
        triggeredBy: userLuciaUuid,
      });

      // Verify Mongo stores legacy_id (never PG UUIDv7) across all user-bearing tables
      const mongoCf = await mongoRepo.findConsoleFolderById(wsId, cf.id);
      expect(mongoCf?.ownerId).toBe(userLuciaId);
      const mongoC = await mongoRepo.findConsoleById(wsId, c.id);
      expect(mongoC?.createdBy).toBe(userLuciaId);
      expect(mongoC?.owner_id).toBe(userV4Id);
      expect(mongoC?.sharedWith[0].userId).toBe(userV4Id);
      expect(mongoC?.sharedWith[0].addedBy).toBe(userLuciaId);
      expect(mongoC?.lastRun?.runBy).toBe(userLuciaId);
      const mongoVer = await mongoRepo.getEntityVersion(
        c.id,
        "console",
        1,
        wsId,
      );
      expect(mongoVer?.savedBy).toBe(userLuciaId);
      const mongoNb = await mongoRepo.findNotebookIndex(wsId, nbIdx.notebookId);
      expect(mongoNb?.ownerId).toBe(userLuciaId);
      const mongoRun = await mongoRepo.findScheduledQueryRunById(run.id, wsId);
      expect(mongoRun?.triggeredBy).toBe(userLuciaId);

      // Stage 4 favourites CRUD, reorder, and delete using userLuciaUuid MUST hit legacy Mongo docs
      const stage4Fav = await dual.createFavourite({
        workspaceId: wsId,
        userId: userLuciaUuid,
        parentId: null,
        type: "item",
        kind: "console",
        refId: c.id,
        position: 1,
      });
      expect(
        (await mongoRepo.findFavouriteById(wsId, userLuciaId, stage4Fav.id))
          ?.userId,
      ).toBe(userLuciaId);

      await dual.updateFavouriteSimple(
        wsId,
        userLuciaUuid,
        legacyFavFolder.id,
        {
          title: "Renamed In Stage 4",
        },
      );
      expect(
        (
          await mongoRepo.findFavouriteById(
            wsId,
            userLuciaId,
            legacyFavFolder.id,
          )
        )?.title,
      ).toBe("Renamed In Stage 4");

      await dual.reorderFavourites(wsId, userLuciaUuid, [
        { id: stage4Fav.id, parentId: null, position: 0 },
        { id: legacyFavFolder.id, parentId: null, position: 1 },
      ]);
      expect(
        (
          await mongoRepo.findFavouriteById(
            wsId,
            userLuciaId,
            legacyFavFolder.id,
          )
        )?.position,
      ).toBe(1);

      // Stage 4 reverse shadow-compare reads with userLuciaUuid MUST all match 100%
      events.length = 0;
      await dual.listFavourites(wsId, userLuciaUuid);
      await dual.countFavourites(wsId, userLuciaUuid);
      await dual.findFavouriteById(wsId, userLuciaUuid, stage4Fav.id);
      await dual.findFavouriteByRef(wsId, userLuciaUuid, "console", c.id);
      await dual.listFavouriteSiblings(wsId, userLuciaUuid, null);
      await dual.getNextFavouritePosition(wsId, userLuciaUuid, null);
      await dual.listNotebookIndexes(wsId, { visibleForUserId: userLuciaUuid });
      await dual.findConsoleById(wsId, c.id);
      await shadowRunner.flush();

      expect(events).toHaveLength(8);
      expect(events.filter(e => e.result !== "match")).toEqual([]);

      // Stage 4 deletes using userLuciaUuid must remove the legacy Mongo docs (not 0-match silently)
      expect(
        await dual.deleteFavouriteByRef(wsId, userLuciaUuid, "console", c.id),
      ).toBe(true);
      expect(
        await mongoRepo.findFavouriteById(wsId, userLuciaId, stage4Fav.id),
      ).toBeNull();

      expect(
        await dual.deleteFavouriteSubtree(
          wsId,
          userLuciaUuid,
          legacyFavFolder.id,
        ),
      ).toBe(2);
      expect(
        await mongoRepo.findFavouriteById(
          wsId,
          userLuciaId,
          legacyFavFolder.id,
        ),
      ).toBeNull();
      expect(
        await mongoRepo.findFavouriteById(wsId, userLuciaId, legacyFavItem.id),
      ).toBeNull();
    });

    it("skips orphan_workspace_id and normalizes dangling folderId/parentId in verifier, and repairs nested parent_id atomically (#90-4)", async () => {
      const wsOid = new Types.ObjectId(wsId);
      const orphanWsOid = new Types.ObjectId(); // Not in PG `workspaces`
      const missingFolderOid = new Types.ObjectId();
      const missingParentOid = new Types.ObjectId();

      // Seed contiguous orphan-workspace rows BEFORE valid rows (early ObjectIds) to also test cursor progression with batchSize=2
      await ConsoleFolder.create([
        {
          _id: new Types.ObjectId(makeOrderedOid(1_600_000_001, "aa01")),
          workspaceId: orphanWsOid,
          name: "Orphan WS Folder 1",
          ownerId: userV7Id,
        },
        {
          _id: new Types.ObjectId(makeOrderedOid(1_600_000_002, "aa02")),
          workspaceId: orphanWsOid,
          name: "Orphan WS Folder 2",
          ownerId: userV7Id,
        },
      ]);
      await SavedConsole.create({
        _id: new Types.ObjectId(makeOrderedOid(1_600_000_003, "aa03")),
        workspaceId: orphanWsOid,
        name: "Orphan WS Console",
        code: "SELECT 0",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      // Valid workspace docs with dangling folderId / parentId
      const danglingCf = await ConsoleFolder.create({
        workspaceId: wsOid,
        name: "Dangling Parent Folder",
        parentId: missingParentOid,
        ownerId: userV7Id,
      });
      const danglingConsole = await SavedConsole.create({
        workspaceId: wsOid,
        folderId: missingFolderOid,
        name: "Dangling Folder Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const danglingNf = await NotebookFolder.create({
        workspaceId: wsOid,
        name: "Dangling NB Folder",
        parentId: missingParentOid,
        ownerId: userV7Id,
      });
      const danglingNb = await NotebookIndex.create({
        workspaceId: wsOid,
        notebookId: "nb-dangling-folder",
        name: "Dangling NB",
        folderId: missingFolderOid,
        ownerId: userV7Id,
      });
      const danglingFav = await Favourite.create({
        workspaceId: wsOid,
        userId: userV7Id,
        parentId: missingParentOid.toString(),
        type: "item",
        kind: "console",
        refId: danglingConsole._id.toString(),
        position: 0,
      });

      // Valid nested console folder + nested favourite for atomic --repair check
      const cfParent = await ConsoleFolder.create({
        workspaceId: wsOid,
        name: "Atomic Parent",
        ownerId: userV7Id,
      });
      const cfChild = await ConsoleFolder.create({
        workspaceId: wsOid,
        name: "Atomic Child",
        parentId: cfParent._id,
        ownerId: userV7Id,
      });
      const favParent = await Favourite.create({
        workspaceId: wsOid,
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Atomic Fav Parent",
        position: 1,
      });
      const favChild = await Favourite.create({
        workspaceId: wsOid,
        userId: userV7Id,
        parentId: favParent._id.toString(),
        type: "item",
        kind: "notebook",
        refId: danglingNb.notebookId,
        position: 0,
      });

      const bf = await runBackfill({
        domain: CONSOLES_CHARTS_DOMAIN,
        batchSize: 2,
        db,
      });
      expect(bf.status).toBe("completed");

      // Full verifier across ALL workspaces (no workspaceId filter) with batchSize=2 must pass 100%
      const v1 = await runParityVerification({
        domain: CONSOLES_CHARTS_DOMAIN,
        batchSize: 2,
        db,
      });
      expect(v1.ok).toBe(true);
      expect(v1.missingInPg).toBe(0);
      expect(v1.mismatched).toBe(0);
      expect(v1.extraInPg).toBe(0);

      // Confirm dangling refs were nulled in PG cleanly
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      expect(
        (await pgRepo.findConsoleFolderById(wsId, danglingCf._id.toString()))
          ?.parentId,
      ).toBeUndefined();
      expect(
        (await pgRepo.findConsoleById(wsId, danglingConsole._id.toString()))
          ?.folderId,
      ).toBeUndefined();
      expect(
        (await pgRepo.findNotebookFolderById(wsId, danglingNf._id.toString()))
          ?.parentId,
      ).toBeUndefined();
      expect(
        (await pgRepo.findNotebookIndex(wsId, danglingNb.notebookId))?.folderId,
      ).toBeUndefined();
      expect(
        (
          await pgRepo.findFavouriteById(
            wsId,
            userV7Id,
            danglingFav._id.toString(),
          )
        )?.parentId,
      ).toBeNull();

      // Induce drift on nested cfChild & favChild and verify atomic transactional --repair
      await db
        .update(pgSchema.consoleFolders)
        .set({ name: "Drifted Child" })
        .where(
          eq(
            pgSchema.consoleFolders.id,
            objectIdToUuid(cfChild._id.toString()),
          ),
        );
      await db
        .update(pgSchema.favourites)
        .set({ position: 99 })
        .where(
          eq(pgSchema.favourites.id, objectIdToUuid(favChild._id.toString())),
        );

      const txSpy = vi.spyOn(db, "transaction");
      const vRepair = await runParityVerification({
        domain: CONSOLES_CHARTS_DOMAIN,
        batchSize: 10,
        repair: true,
        db,
      });
      expect(vRepair.repaired).toBe(2);
      expect(txSpy).toHaveBeenCalledTimes(2);
      txSpy.mockRestore();

      const healedCf = await pgRepo.findConsoleFolderById(
        wsId,
        cfChild._id.toString(),
      );
      expect(healedCf?.name).toBe("Atomic Child");
      expect(healedCf?.parentId).toBe(cfParent._id.toString());

      const healedFav = await pgRepo.findFavouriteById(
        wsId,
        userV7Id,
        favChild._id.toString(),
      );
      expect(healedFav?.position).toBe(0);
      expect(healedFav?.parentId).toBe(favParent._id.toString());

      const v2 = await runParityVerification({
        domain: CONSOLES_CHARTS_DOMAIN,
        batchSize: 10,
        db,
      });
      expect(v2.ok).toBe(true);
    });

    it("cascades & tombstones console_folders subtrees consistently and routes workspace-less entity_versions for Stage 4/5 canaries (#90-5)", async () => {
      const failures: SecondaryWriteFailureContext[] = [];
      const mongoRepo = new MongoConsolesChartsRepository();
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      const router = new MigrationRouter({
        getDb: () => db,
        hasPg: () => true,
        enablePubSub: false,
        onSecondaryFailure: async ctx => {
          failures.push(ctx);
        },
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "dual_write_mongo_read",
      });
      const dual = new DualConsolesChartsRepository({
        mongo: mongoRepo,
        pg: pgRepo,
        router,
        getDb: () => db,
        resolveUserUuid,
      });

      // Build 3-level console_folders tree + console inside grandchild
      const rootF = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Root",
        ownerId: userV7Id,
      });
      const childF = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Child",
        parentId: rootF.id,
        ownerId: userV7Id,
      });
      const grandF = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Grandchild",
        parentId: childF.id,
        ownerId: userV7Id,
      });
      const nestedConsole = await dual.createConsole({
        workspaceId: wsId,
        folderId: grandF.id,
        name: "Nested Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const updatedBefore = nestedConsole.updatedAt.getTime();

      expect(await dual.deleteConsoleFolder(wsId, rootF.id)).toBe(true);

      // All 3 folders deleted in BOTH Mongo & PG, console unlinked in both without bumping updatedAt
      for (const id of [rootF.id, childF.id, grandF.id]) {
        expect(await mongoRepo.findConsoleFolderById(wsId, id)).toBeNull();
        expect(await pgRepo.findConsoleFolderById(wsId, id)).toBeNull();
      }
      const mongoConsoleAfter = await mongoRepo.findConsoleById(
        wsId,
        nestedConsole.id,
      );
      const pgConsoleAfter = await pgRepo.findConsoleById(
        wsId,
        nestedConsole.id,
      );
      expect(mongoConsoleAfter?.folderId).toBeUndefined();
      expect(pgConsoleAfter?.folderId).toBeUndefined();
      expect(mongoConsoleAfter?.updatedAt.getTime()).toBe(updatedBefore);

      // All 3 folder UUIDs tombstoned!
      const tombRows = await db.select().from(pgSchema.migrationTombstones);
      expect(tombRows.map(t => t.entityId).sort()).toEqual(
        [
          objectIdToUuid(rootF.id),
          objectIdToUuid(childF.id),
          objectIdToUuid(grandF.id),
        ].sort(),
      );

      // Replay cascade delete after transient PG outage tombstones full subtree too
      await db.delete(pgSchema.migrationTombstones);
      const r2 = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Outage Root",
        ownerId: userV7Id,
      });
      const c2 = await dual.createConsoleFolder({
        workspaceId: wsId,
        name: "Outage Child",
        parentId: r2.id,
        ownerId: userV7Id,
      });
      const pgDelSpy = vi
        .spyOn(pgRepo, "deleteConsoleFolder")
        .mockRejectedValueOnce(new Error("pg down"));
      expect(await dual.deleteConsoleFolder(wsId, r2.id)).toBe(true);
      pgDelSpy.mockRestore();
      expect(failures).toHaveLength(1);
      await db.delete(pgSchema.migrationTombstones);
      await replaySyncToPg(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          target: "pg",
          operation: failures[0].operation,
          entityId: failures[0].entityId ?? r2.id,
          workspaceId: wsId,
          payload: failures[0].payload,
          errorMessage: "pg down",
          failedAt: new Date().toISOString(),
        },
        db,
      );
      expect(await pgRepo.findConsoleFolderById(wsId, r2.id)).toBeNull();
      expect(await pgRepo.findConsoleFolderById(wsId, c2.id)).toBeNull();
      const replayTombs = await db.select().from(pgSchema.migrationTombstones);
      expect(replayTombs.map(t => t.entityId).sort()).toEqual(
        [objectIdToUuid(r2.id), objectIdToUuid(c2.id)].sort(),
      );

      // Workspace-less entity_versions canary routing (mixed-stage: wsId=mongo_only, ws2Id=pg_only)
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "mongo_only",
      });
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: ws2Id,
        mode: "pg_only",
      });

      const mongoC = await mongoRepo.createConsole({
        workspaceId: wsId,
        name: "Mongo Versioned",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      await mongoRepo.createEntityVersion({
        workspaceId: wsId,
        entityType: "console",
        entityId: mongoC.id,
        snapshot: { code: "SELECT 1" },
        savedBy: userV7Id,
        savedByName: "V7",
      });
      await mongoRepo.createEntityVersion({
        workspaceId: wsId,
        entityType: "console",
        entityId: mongoC.id,
        snapshot: { code: "SELECT 2" },
        savedBy: userV7Id,
        savedByName: "V7",
      });

      const pgC = await pgRepo.createConsole({
        workspaceId: ws2Id,
        name: "PG Canary Versioned",
        code: "SELECT 10",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      for (const n of [1, 2, 3]) {
        await pgRepo.createEntityVersion({
          workspaceId: ws2Id,
          entityType: "console",
          entityId: pgC.id,
          snapshot: { code: `SELECT ${n}` },
          savedBy: userV7Id,
          savedByName: "V7",
        });
      }

      // Without workspaceId, both mongo_only (wsId) and pg_only canary (ws2Id) resolve accurately
      expect(
        await dual.getLatestEntityVersionNumber(mongoC.id, "console"),
      ).toBe(2);
      expect(await dual.getLatestEntityVersionNumber(pgC.id, "console")).toBe(
        3,
      );
      expect((await dual.listEntityVersions(mongoC.id, "console")).total).toBe(
        2,
      );
      expect((await dual.listEntityVersions(pgC.id, "console")).total).toBe(3);
      expect(
        (await dual.getEntityVersion(mongoC.id, "console", 2))?.snapshot,
      ).toEqual({ code: "SELECT 2" });
      expect(
        (await dual.getEntityVersion(pgC.id, "console", 3))?.snapshot,
      ).toEqual({ code: "SELECT 3" });

      // Global Stage 5 (pg_only, no overrides): workspace-less entity_versions NEVER touch Mongo
      await db.delete(pgSchema.migrationDomainState);
      await router.setDomainState({
        domain: CONSOLES_CHARTS_DOMAIN,
        mode: "pg_only",
      });
      const mLatest = vi.spyOn(mongoRepo, "getLatestEntityVersionNumber");
      const mList = vi.spyOn(mongoRepo, "listEntityVersions");
      const mGet = vi.spyOn(mongoRepo, "getEntityVersion");
      const mWs = vi.spyOn(mongoRepo, "findEntityVersionWorkspaceId");

      expect(await dual.getLatestEntityVersionNumber(pgC.id, "console")).toBe(
        3,
      );
      expect((await dual.listEntityVersions(pgC.id, "console")).total).toBe(3);
      expect(
        (await dual.getEntityVersion(pgC.id, "console", 3))?.snapshot,
      ).toEqual({ code: "SELECT 3" });
      expect(mLatest).toHaveBeenCalledTimes(0);
      expect(mList).toHaveBeenCalledTimes(0);
      expect(mGet).toHaveBeenCalledTimes(0);
      expect(mWs).toHaveBeenCalledTimes(0);

      mLatest.mockRestore();
      mList.mockRestore();
      mGet.mockRestore();
      mWs.mockRestore();
    });

    it("does not truncate favourites_parents backfill when pages contain empty-string parentId (#4717304375)", async () => {
      const wsOid = new Types.ObjectId(wsId);
      const favFolderOid = new Types.ObjectId(
        makeOrderedOid(1_710_000_500, "f000"),
      );
      await Favourite.create({
        _id: favFolderOid,
        workspaceId: wsOid,
        userId: userV7Id,
        parentId: null,
        type: "folder",
        title: "Pinned Folder",
        position: 0,
      });

      // Seed 3 favourites with parentId: "" (early ObjectIds) BEFORE 3 nested favourites
      for (let i = 1; i <= 3; i++) {
        await Favourite.collection.insertOne({
          _id: new Types.ObjectId(makeOrderedOid(1_710_000_000 + i, `e00${i}`)),
          workspaceId: wsOid,
          userId: userV7Id,
          parentId: "",
          type: "item",
          kind: "notebook",
          refId: `nb-empty-parent-${i}`,
          position: i,
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
          updatedAt: new Date("2026-11-01T00:00:00.000Z"),
        });
      }

      const nestedIds: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const oid = new Types.ObjectId(
          makeOrderedOid(1_710_000_100 + i, `c00${i}`),
        );
        nestedIds.push(oid.toString());
        await Favourite.create({
          _id: oid,
          workspaceId: wsOid,
          userId: userV7Id,
          parentId: favFolderOid.toString(),
          type: "item",
          kind: "notebook",
          refId: `nb-nested-${i}`,
          position: i,
        });
      }

      // batchSize=2 forces multi-page pagination through stage 9 (`favourites_parents`)
      const bf = await runBackfill({
        domain: CONSOLES_CHARTS_DOMAIN,
        batchSize: 2,
        db,
      });
      expect(bf.status).toBe("completed");

      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });
      for (const nestedId of nestedIds) {
        const row = await pgRepo.findFavouriteById(wsId, userV7Id, nestedId);
        expect(row?.parentId).toBe(favFolderOid.toString());
      }

      const verification = await runParityVerification({
        domain: CONSOLES_CHARTS_DOMAIN,
        batchSize: 2,
        db,
      });
      expect(verification.ok).toBe(true);
      expect(verification.mismatched).toBe(0);
    });
  });

  // ── 5. Post-Backfill Step (`consoles-connection-fk`) ─────────────────────

  describe("Post-backfill 0005a_consoles_connection_fk.sql", () => {
    it("nulls dangling connection_ids, attaches validated ON DELETE SET NULL FK, and is idempotent", async () => {
      const pgRepo = new PgConsolesChartsRepository({
        getDb: () => db,
        resolveUserUuid,
      });

      const validConnId = new Types.ObjectId().toString();
      const validConnUuid = objectIdToUuid(validConnId);
      const danglingConnId = new Types.ObjectId().toString();

      await db.execute(
        sql`INSERT INTO "database_connections" ("id", "workspace_id", "name", "type", "connection_encrypted", "created_by")
            VALUES (${validConnUuid}::uuid, ${objectIdToUuid(wsId)}::uuid, 'PostBackfill DB', 'postgresql', '{}'::jsonb, ${userV7Id}::uuid)`,
      );

      const cValid = await pgRepo.createConsole({
        workspaceId: wsId,
        connectionId: validConnId,
        name: "Valid Conn Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });
      const cDangling = await pgRepo.createConsole({
        workspaceId: wsId,
        connectionId: danglingConnId,
        name: "Dangling Conn Console",
        code: "SELECT 2",
        language: "sql",
        createdBy: userV7Id,
        isSaved: true,
      });

      try {
        const res1 = await runPostBackfillStep(db, "consoles-connection-fk");
        expect(res1.statements).toBe(3);

        // Idempotent second run must succeed cleanly
        const res2 = await runPostBackfillStep(db, "consoles-connection-fk");
        expect(res2.statements).toBe(3);

        expect(
          (await pgRepo.findConsoleById(wsId, cValid.id))?.connectionId,
        ).toBe(validConnId);
        expect(
          (await pgRepo.findConsoleById(wsId, cDangling.id))?.connectionId,
        ).toBeUndefined();

        // Constraint exists and is validated
        const conRows = await db.execute(sql`
          SELECT conname, convalidated
          FROM pg_constraint
          WHERE conname = 'saved_consoles_connection_id_fk'
        `);
        const rows = (
          conRows as unknown as {
            rows: Array<{ conname: string; convalidated: boolean }>;
          }
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].convalidated).toBe(true);

        // Deleting referenced connection triggers ON DELETE SET NULL
        await db.execute(
          sql`DELETE FROM "database_connections" WHERE "id" = ${validConnUuid}::uuid`,
        );
        expect(
          (await pgRepo.findConsoleById(wsId, cValid.id))?.connectionId,
        ).toBeUndefined();

        // After 0005a attaches the FK, live PG writes, dual-writes, sync-retry replay,
        // verifier, and --repair must map dangling connectionIds to NULL cleanly (never 23503) (#4717303833).
        const deletedConnId = new Types.ObjectId().toString();
        const createdWithDangling = await pgRepo.createConsole({
          workspaceId: wsId,
          connectionId: deletedConnId,
          name: "Created After FK With Deleted Conn",
          code: "SELECT 10",
          language: "sql",
          createdBy: userV7Id,
          isSaved: true,
        });
        expect(createdWithDangling.connectionId).toBeUndefined();

        const updatedWithDangling = await pgRepo.updateConsole(
          wsId,
          createdWithDangling.id,
          { connectionId: deletedConnId, code: "SELECT 11" },
        );
        expect(updatedWithDangling?.code).toBe("SELECT 11");
        expect(updatedWithDangling?.connectionId).toBeUndefined();

        const guardedWithDangling = await pgRepo.guardedSaveConsole({
          workspaceId: wsId,
          consoleId: createdWithDangling.id,
          expectedVersion: 1,
          upsert: false,
          set: { connectionId: deletedConnId, code: "SELECT 12" },
          incVersion: 1,
        });
        expect(guardedWithDangling?.code).toBe("SELECT 12");
        expect(guardedWithDangling?.connectionId).toBeUndefined();

        const guardedUpsertId = new Types.ObjectId().toString();
        const guardedUpserted = await pgRepo.guardedSaveConsole({
          workspaceId: wsId,
          consoleId: guardedUpsertId,
          upsert: true,
          set: {
            name: "Guarded Upsert Dangling",
            connectionId: deletedConnId,
            code: "SELECT 13",
            language: "sql",
          },
          setOnInsert: { createdBy: userV7Id, isSaved: true },
        });
        expect(guardedUpserted?.connectionId).toBeUndefined();

        await pgRepo.upsertConsole({
          ...createdWithDangling,
          connectionId: deletedConnId,
          code: "SELECT 14",
          updatedAt: new Date(Date.now() + 5_000),
        });
        expect(
          (await pgRepo.findConsoleById(wsId, createdWithDangling.id))?.code,
        ).toBe("SELECT 14");
        expect(
          (await pgRepo.findConsoleById(wsId, createdWithDangling.id))
            ?.connectionId,
        ).toBeUndefined();

        // Dual-write + replay + verifier + --repair with Mongo holding dangling connectionId
        const mongoRepo = new MongoConsolesChartsRepository();
        const failures: SecondaryWriteFailureContext[] = [];
        const router = new MigrationRouter({
          getDb: () => db,
          hasPg: () => true,
          enablePubSub: false,
          onSecondaryFailure: async ctx => {
            failures.push(ctx);
          },
        });
        await router.setDomainState({
          domain: CONSOLES_CHARTS_DOMAIN,
          mode: "dual_write_mongo_read",
        });
        const dual = new DualConsolesChartsRepository({
          mongo: mongoRepo,
          pg: pgRepo,
          router,
          getDb: () => db,
          resolveUserUuid,
        });

        // Clean unrelated PG consoles so verifier focuses on the dual-written console
        await db.delete(pgSchema.savedConsoles);
        const dualConsole = await dual.createConsole({
          workspaceId: wsId,
          connectionId: deletedConnId,
          name: "Dual Dangling Conn Console",
          code: "SELECT 20",
          language: "sql",
          createdBy: userV7Id,
          isSaved: true,
        });
        expect(failures).toHaveLength(0);
        expect(
          (await pgRepo.findConsoleById(wsId, dualConsole.id))?.connectionId,
        ).toBeUndefined();

        await dual.updateConsole(wsId, dualConsole.id, {
          connectionId: deletedConnId,
          code: "SELECT 21",
        });
        expect(failures).toHaveLength(0);
        expect((await pgRepo.findConsoleById(wsId, dualConsole.id))?.code).toBe(
          "SELECT 21",
        );

        // Verifier reports 0 drift when Mongo has dangling connectionId and PG has NULL
        clearVerifierRegistryForTests();
        registerMigrationDomains({ force: true });
        const verifyOk = await runParityVerification({
          domain: `${CONSOLES_CHARTS_DOMAIN}:saved_consoles`,
          workspaceId: wsId,
          batchSize: 10,
          db,
        });
        expect(verifyOk.ok).toBe(true);
        expect(verifyOk.mismatched).toBe(0);

        // Induce drift in PG and verify both --repair and replaySyncToPg succeed without 23503
        await db
          .update(pgSchema.savedConsoles)
          .set({ code: "SELECT 'drifted'" })
          .where(eq(pgSchema.savedConsoles.id, objectIdToUuid(dualConsole.id)));

        const repairRes = await runParityVerification({
          domain: `${CONSOLES_CHARTS_DOMAIN}:saved_consoles`,
          workspaceId: wsId,
          batchSize: 10,
          repair: true,
          db,
        });
        expect(repairRes.repaired).toBe(1);
        expect((await pgRepo.findConsoleById(wsId, dualConsole.id))?.code).toBe(
          "SELECT 21",
        );

        await db
          .delete(pgSchema.savedConsoles)
          .where(eq(pgSchema.savedConsoles.id, objectIdToUuid(dualConsole.id)));
        await replaySyncToPg(
          {
            domain: CONSOLES_CHARTS_DOMAIN,
            target: "pg",
            operation: "updateConsole",
            entityId: dualConsole.id,
            workspaceId: wsId,
            payload: {
              table: "saved_consoles",
              action: "upsert",
              id: dualConsole.id,
              workspaceId: wsId,
            },
            errorMessage: "replay dangling conn",
            failedAt: new Date().toISOString(),
          },
          db,
        );
        expect((await pgRepo.findConsoleById(wsId, dualConsole.id))?.code).toBe(
          "SELECT 21",
        );
        expect(
          (await pgRepo.findConsoleById(wsId, dualConsole.id))?.connectionId,
        ).toBeUndefined();
      } finally {
        await pg.exec(`
          ALTER TABLE "saved_consoles" DROP CONSTRAINT IF EXISTS "saved_consoles_connection_id_fk";
          DELETE FROM "database_connections" WHERE "id" = '${validConnUuid}'::uuid;
        `);
      }
    });
  });

  // ── 6. Console Sharing Adapter Partial-Patch & Deletion Safety ───────────

  describe("Console sharing route adapter (#4717303304)", () => {
    it("patches only mutated sharing fields so stale snapshots never resurrect removed collaborators or undo access changes, and fails when concurrently deleted", async () => {
      const wsOid = new Types.ObjectId(wsId);
      const ownerId = "share-owner-1";
      const adminId = "share-admin-1";
      const collabA = "share-collab-a";
      const collabB = "share-collab-b";

      await User.create([
        { _id: ownerId, email: "owner@example.com" },
        { _id: adminId, email: "admin@example.com" },
        { _id: collabA, email: "collaba@example.com" },
        { _id: collabB, email: "collabb@example.com" },
      ]);
      await WorkspaceMember.deleteMany({});
      await WorkspaceMember.create([
        { workspaceId: wsOid, userId: ownerId, role: "owner" },
        { workspaceId: wsOid, userId: adminId, role: "admin" },
        { workspaceId: wsOid, userId: collabA, role: "member" },
        { workspaceId: wsOid, userId: collabB, role: "member" },
      ]);

      let actor = { id: adminId, role: "admin" as "owner" | "admin" };
      const sharingApp = createRouter();
      sharingApp.use(
        "/api/workspaces/:workspaceId/consoles/*",
        async (c, next) => {
          c.set("user", { id: actor.id, email: `${actor.id}@example.com` });
          c.set("memberRole", actor.role);
          await next();
        },
      );
      sharingApp.route(
        "/api/workspaces/:workspaceId/consoles",
        consoleSharingRoutes,
      );

      const consoleDoc = await consolesChartsRepo.createConsole({
        workspaceId: wsId,
        name: "Shared Console",
        code: "SELECT 1",
        language: "sql",
        createdBy: ownerId,
        owner_id: ownerId,
        access: "workspace",
        isPrivate: false,
        workspaceRole: "viewer",
        isSaved: true,
        sharedWith: [
          {
            userId: collabA,
            role: "viewer",
            addedAt: new Date("2026-11-01T00:00:00.000Z"),
            addedBy: ownerId,
          },
        ],
      });

      // Scenario 1: Admin A loads console to PATCH /sharing, owner concurrently removes collabA ->
      // A's save must patch ONLY workspaceRole, never resurrecting collabA!
      const origFind =
        consolesChartsRepo.findConsoleById.bind(consolesChartsRepo);
      const findSpy = vi
        .spyOn(consolesChartsRepo, "findConsoleById")
        .mockImplementationOnce(async (...args) => {
          const loaded = await origFind(...args);
          // Simulate owner removing collabA while Admin A's request is in flight
          await consolesChartsRepo.updateConsole(wsId, consoleDoc.id, {
            sharedWith: [],
          });
          return loaded;
        });

      actor = { id: adminId, role: "admin" };
      const patchRes = await sharingApp.request(
        `/api/workspaces/${wsId}/consoles/${consoleDoc.id}/sharing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceRole: "editor" }),
        },
      );
      findSpy.mockRestore();
      expect(patchRes.status).toBe(200);
      const afterPatch = await consolesChartsRepo.findConsoleById(
        wsId,
        consoleDoc.id,
      );
      expect(afterPatch?.workspaceRole).toBe("editor");
      expect(afterPatch?.sharedWith).toEqual([]);

      // Scenario 2: Owner loads console to add collabB while Admin concurrently flips access to private ->
      // Owner's save must patch ONLY sharedWith, never reverting access/isPrivate!
      const findSpy2 = vi
        .spyOn(consolesChartsRepo, "findConsoleById")
        .mockImplementationOnce(async (...args) => {
          const loaded = await origFind(...args);
          await consolesChartsRepo.updateConsole(wsId, consoleDoc.id, {
            access: "private",
            isPrivate: true,
          });
          return loaded;
        });

      actor = { id: ownerId, role: "owner" };
      const addRes = await sharingApp.request(
        `/api/workspaces/${wsId}/consoles/${consoleDoc.id}/collaborators`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: collabB, role: "viewer" }),
        },
      );
      findSpy2.mockRestore();
      expect(addRes.status).toBe(200);
      const afterAdd = await consolesChartsRepo.findConsoleById(
        wsId,
        consoleDoc.id,
      );
      expect(afterAdd?.access).toBe("private");
      expect(afterAdd?.isPrivate).toBe(true);
      expect(afterAdd?.sharedWith.map(s => s.userId)).toEqual([collabB]);

      // Scenario 3: In-place role update (PATCH /collaborators/:userId via markModified)
      // must patch ONLY sharedWith, preserving concurrent workspaceRole change!
      const findSpy3 = vi
        .spyOn(consolesChartsRepo, "findConsoleById")
        .mockImplementationOnce(async (...args) => {
          const loaded = await origFind(...args);
          await consolesChartsRepo.updateConsole(wsId, consoleDoc.id, {
            workspaceRole: "viewer",
          });
          return loaded;
        });

      const roleRes = await sharingApp.request(
        `/api/workspaces/${wsId}/consoles/${consoleDoc.id}/collaborators/${collabB}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "editor" }),
        },
      );
      findSpy3.mockRestore();
      expect(roleRes.status).toBe(200);
      const afterRole = await consolesChartsRepo.findConsoleById(
        wsId,
        consoleDoc.id,
      );
      expect(afterRole?.workspaceRole).toBe("viewer");
      expect(afterRole?.sharedWith[0]?.role).toBe("editor");

      // Scenario 4: Console hard-deleted between load and save -> must fail (not return 200 success)
      const findSpy4 = vi
        .spyOn(consolesChartsRepo, "findConsoleById")
        .mockImplementationOnce(async (...args) => {
          const loaded = await origFind(...args);
          await SavedConsole.deleteOne({
            _id: new Types.ObjectId(consoleDoc.id),
          });
          return loaded;
        });

      const deletedRes = await sharingApp.request(
        `/api/workspaces/${wsId}/consoles/${consoleDoc.id}/sharing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access: "workspace" }),
        },
      );
      findSpy4.mockRestore();
      expect(deletedRes.status).toBeGreaterThanOrEqual(400);
      expect(((await deletedRes.json()) as { success: boolean }).success).toBe(
        false,
      );
    });
  });
});
