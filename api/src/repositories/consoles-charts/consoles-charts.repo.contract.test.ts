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
import { PgAuthRepository } from "../auth/pg.repo";
import {
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

  // ── 4. 10-Stage Backfill (2-Pass Self-FK + Quarantine), Verifier & TTL ───

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
      const ownerId = generateUuidv7();
      const adminId = generateUuidv7();
      const collabA = generateUuidv7();
      const collabB = generateUuidv7();

      await db.insert(pgSchema.users).values([
        { id: ownerId, email: "owner@example.com", emailVerified: true },
        { id: adminId, email: "admin@example.com", emailVerified: true },
        { id: collabA, email: "collaba@example.com", emailVerified: true },
        { id: collabB, email: "collabb@example.com", emailVerified: true },
      ]);
      await db.insert(pgSchema.workspaceMembers).values([
        {
          id: generateUuidv7(),
          workspaceId: wsUuid,
          userId: ownerId,
          role: "owner",
        },
        {
          id: generateUuidv7(),
          workspaceId: wsUuid,
          userId: adminId,
          role: "admin",
        },
        {
          id: generateUuidv7(),
          workspaceId: wsUuid,
          userId: collabA,
          role: "member",
        },
        {
          id: generateUuidv7(),
          workspaceId: wsUuid,
          userId: collabB,
          role: "member",
        },
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
          await db
            .delete(pgSchema.savedConsoles)
            .where(
              eq(pgSchema.savedConsoles.id, objectIdToUuid(consoleDoc.id)),
            );
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
