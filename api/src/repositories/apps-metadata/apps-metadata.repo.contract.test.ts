/**
 * Phase 2B (`apps_metadata` domain — 10 tables) repository contract,
 * 1536-dim pgvector parity, real-user + system-actor `app_worktrees`,
 * atomic CAS (`claimPublicBindingRefresh`, `casResolvePendingCommitStatus`),
 * blob-safe expiry (ZERO blind TTL rules for `app_binding_drafts` / `app_binding_jobs`),
 * 5-stage dual-run + Stage 4->2 rollback, secret redaction in `shadow-compare`,
 * backfill + tombstones + quarantine, parity verifier (`--repair`), and sync-retry tests.
 */
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  AppDeployCommitStatus,
  AppEmbedding,
  AppIndexEntry,
  AppIndexHead,
  AppLifecycleState,
  AppProject,
  AppWorktree,
} from "../../database/workspace-schema";
import {
  clearBackfillRegistryForTests,
  listBackfillDomains,
  runBackfill,
} from "../../migration/backfill";
import { registerMigrationDomains } from "../../migration/domains";
import {
  replayAppsMetadataWriteToMongo,
  replayAppsMetadataWriteToPg,
} from "../../migration/domains/apps-metadata.backfill";
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
} from "../../migration/ttl-reaper";
import {
  clearVerifierRegistryForTests,
  runParityVerification,
} from "../../migration/verifier";
import { APPS_METADATA_DOMAIN, DualAppsMetadataRepository } from "./dual.repo";
import { buildProjectSharingPatch, toAppProjectCompat } from "./mapper";
import {
  MongoAppsMetadataRepository,
  getMongoAppBindingDraftModel,
  getMongoAppBindingJobModel,
  getMongoAppBindingStateModel,
} from "./mongo.repo";
import { PgAppsMetadataRepository } from "./pg.repo";
import type { AppsMetadataRepository } from "./types";

function makeVector(seed: number, dims = 1536): number[] {
  const vec = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Number((((i + seed) % 19) * 0.01).toFixed(4));
  }
  return vec;
}

describe("Phase 2B AppsMetadataRepository contract & migration lifecycle", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  let wsId: string;
  let wsUuid: string;
  let ws2Id: string;
  let ws2Uuid: string;
  let user1Uuid: string;
  let user2Uuid: string;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      AppProject.syncIndexes(),
      AppIndexEntry.syncIndexes(),
      AppIndexHead.syncIndexes(),
      AppEmbedding.syncIndexes(),
      AppLifecycleState.syncIndexes(),
      AppDeployCommitStatus.syncIndexes(),
      AppWorktree.syncIndexes(),
      getMongoAppBindingStateModel().syncIndexes(),
      getMongoAppBindingDraftModel().syncIndexes(),
      getMongoAppBindingJobModel().syncIndexes(),
    ]);

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  async function seedBaseFixtures(): Promise<void> {
    const ws = newDualId();
    wsId = ws.oid;
    wsUuid = ws.uuid;
    const ws2 = newDualId();
    ws2Id = ws2.oid;
    ws2Uuid = ws2.uuid;
    user1Uuid = generateUuidv7();
    user2Uuid = generateUuidv7();

    await db.insert(pgSchema.users).values([
      {
        id: user1Uuid,
        legacyId: "luciaapps000001",
        email: "owner@example.com",
        emailVerified: true,
      },
      {
        id: user2Uuid,
        legacyId: "luciaapps000002",
        email: "editor@example.com",
        emailVerified: true,
      },
    ]);

    await db.insert(pgSchema.workspaces).values([
      {
        id: wsUuid,
        name: "Primary Apps WS",
        slug: `ws1-${wsId.slice(-6)}`,
        createdBy: user1Uuid,
      },
      {
        id: ws2Uuid,
        name: "Foreign Apps WS",
        slug: `ws2-${ws2Id.slice(-6)}`,
        createdBy: user2Uuid,
      },
    ]);
  }

  async function cleanAllStores(): Promise<void> {
    await Promise.all([
      AppProject.deleteMany({}),
      AppIndexEntry.deleteMany({}),
      AppIndexHead.deleteMany({}),
      AppEmbedding.deleteMany({}),
      AppLifecycleState.deleteMany({}),
      AppDeployCommitStatus.deleteMany({}),
      AppWorktree.deleteMany({}),
      getMongoAppBindingStateModel().deleteMany({}),
      getMongoAppBindingDraftModel().deleteMany({}),
      getMongoAppBindingJobModel().deleteMany({}),
    ]);
    await pg.exec(`
      DELETE FROM app_binding_jobs;
      DELETE FROM app_binding_drafts;
      DELETE FROM app_binding_state;
      DELETE FROM app_worktrees;
      DELETE FROM app_deploy_commit_statuses;
      DELETE FROM app_lifecycle;
      DELETE FROM app_embeddings;
      DELETE FROM app_index_heads;
      DELETE FROM app_index;
      DELETE FROM app_projects;
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

  // ── 1. Shared contract across Mongo AND Postgres for all 10 tables ───────

  const implementations: Array<{
    name: string;
    isPg: boolean;
    create: () => AppsMetadataRepository;
  }> = [
    {
      name: "MongoAppsMetadataRepository",
      isPg: false,
      create: () => new MongoAppsMetadataRepository(),
    },
    {
      name: "PgAppsMetadataRepository",
      isPg: true,
      create: () => new PgAppsMetadataRepository({ getDb: () => db }),
    },
  ];

  for (const impl of implementations) {
    describe(`AppsMetadataRepository contract: ${impl.name}`, () => {
      it("covers app_projects CRUD, sharing, opaque secrets, deploy progress, publishedSha CAS, and errors", async () => {
        const repo = impl.create();
        const now = new Date("2026-11-25T10:00:00.000Z");

        const created = await repo.createProject({
          workspaceId: wsId,
          title: "Sales Overview",
          slug: "sales-overview",
          path: "apps/sales-overview",
          access: "private",
          owner_id: user1Uuid,
          createdBy: user1Uuid,
        });
        expect(created.title).toBe("Sales Overview");
        expect(created.access).toBe("private");

        // Ownerless claim test
        const ownerless = await repo.createProject({
          workspaceId: wsId,
          title: "Imported App",
          slug: "imported",
          path: "apps/imported",
          access: "workspace",
        });
        expect(
          await repo.claimOwnerlessProjectRow(wsId, ownerless.id, user1Uuid),
        ).toBe(true);
        expect(
          await repo.claimOwnerlessProjectRow(wsId, ownerless.id, user2Uuid),
        ).toBe(false);

        // Sharing + opaque public share password + encrypted env
        await repo.updateProjectSharing(wsId, created.id, {
          access: "workspace",
          workspaceRole: "editor",
          sharedWith: [
            {
              userId: impl.isPg ? "luciaapps000002" : user2Uuid,
              role: "editor",
              addedAt: now,
              addedBy: impl.isPg ? "luciaapps000001" : user1Uuid,
            },
          ],
          publicShare: {
            enabled: true,
            token: "sales-share-token",
            passwordHash: "$2b$10$opaqueBcryptHash",
            passwordEncrypted: "iv:tag:opaqueCiphertext",
            createdAt: now,
            createdBy: user1Uuid,
            allowLiveQueries: true,
          },
          chatEnabled: true,
        });

        await repo.updateProjectEnv(wsId, created.id, [
          {
            key: "STRIPE_KEY",
            valueEncrypted: "enc:v1:superSecretValue",
            secret: true,
          },
        ]);

        const byToken = await repo.findProjectByShareToken("sales-share-token");
        expect(byToken?.id).toBe(created.id);
        expect(byToken?.publicShare?.passwordHash).toBe(
          "$2b$10$opaqueBcryptHash",
        );
        expect(byToken?.publicShare?.passwordEncrypted).toBe(
          "iv:tag:opaqueCiphertext",
        );
        expect(byToken?.env).toEqual([
          {
            key: "STRIPE_KEY",
            valueEncrypted: "enc:v1:superSecretValue",
            secret: true,
          },
        ]);
        // PG rewrote legacy Lucia ID in sharedWith to canonical UUID!
        expect(byToken?.sharedWith?.[0].userId).toBe(user2Uuid);
        expect(byToken?.sharedWith?.[0].addedBy).toBe(user1Uuid);

        expect(await repo.isShareTokenTaken("sales-share-token")).toBe(true);
        expect(
          await repo.isShareTokenTaken("sales-share-token", created.id),
        ).toBe(false);

        // Deploy progress + publishedSha CAS + errors
        const sha1 = "a".repeat(40);
        const sha2 = "b".repeat(40);
        await repo.setDeployProgressQueued(wsId, created.id, {
          sha: sha1,
          stage: "queued",
          startedAt: now,
          stageStartedAt: now,
          updatedAt: now,
        });
        await repo.advanceDeployProgressStage(
          wsId,
          created.id,
          sha1,
          "bindings",
          new Date(now.getTime() + 5000),
          new Date(now.getTime() - 60000),
        );
        await repo.updateDeployProgressBindings(
          wsId,
          created.id,
          sha1,
          { total: 3, prepared: 2, current: "orders" },
          new Date(now.getTime() + 6000),
        );
        expect(
          (await repo.findProjectById(created.id, wsId))?.deployProgress
            ?.bindings?.prepared,
        ).toBe(2);

        const pub1 = await repo.setPublishedSha(wsId, created.id, sha1, now);
        expect(pub1.matched).toBe(true);
        // CAS mismatch fails cleanly
        const pubOvertaken = await repo.setPublishedSha(
          wsId,
          created.id,
          sha2,
          now,
          "wrong-sha",
        );
        expect(pubOvertaken.matched).toBe(false);
        // CAS match succeeds
        const pub2 = await repo.setPublishedSha(
          wsId,
          created.id,
          sha2,
          now,
          sha1,
        );
        expect(pub2.matched).toBe(true);

        await repo.setLastDeployError(wsId, created.id, {
          sha: sha2,
          stage: "build",
          message: "vite failed",
          at: now,
        });
        await repo.clearLastDeployErrorIfSha(wsId, created.id, sha1);
        expect(
          (await repo.findProjectById(created.id, wsId))?.lastDeployError?.sha,
        ).toBe(sha2);
        await repo.clearLastDeployErrorIfSha(wsId, created.id, sha2);
        expect(
          (await repo.findProjectById(created.id, wsId))?.lastDeployError,
        ).toBeUndefined();

        await repo.setBindingRefreshError(wsId, created.id, "orders", {
          sha: sha2,
          message: "timeout",
          attempts: 1,
          at: now,
        });
        expect(
          (await repo.findProjectById(created.id, wsId))?.bindingRefreshErrors
            ?.orders?.attempts,
        ).toBe(1);
        await repo.clearBindingRefreshError(wsId, created.id, "orders");
        expect(
          (await repo.findProjectById(created.id, wsId))?.bindingRefreshErrors,
        ).toBeUndefined();

        await repo.clearDeployProgress(wsId, created.id, sha1);
        await repo.clearPublishedSha(wsId, created.id);
        expect(
          (await repo.findProjectById(created.id, wsId))?.publishedSha,
        ).toBeUndefined();

        // Location sync & foreign checks
        await repo.syncMovedProjects(wsId, [
          {
            appId: created.id,
            path: "apps/finance/sales",
            slug: "sales",
            title: "Sales Moved",
            access: "workspace",
          },
        ]);
        expect(
          (await repo.findProjectByPath(wsId, "apps/finance/sales"))?.id,
        ).toBe(created.id);
        expect(
          await repo.listForeignProjectIds(ws2Id, [created.id, ownerless.id]),
        ).toHaveLength(2);

        await repo.deleteProject(wsId, ownerless.id);
        expect(await repo.findProjectById(ownerless.id, wsId)).toBeNull();
      });

      it("covers app_index, app_index_heads, app_embeddings (1536-d pgvector), app_lifecycle, and commit status CAS", async () => {
        const repo = impl.create();
        const app1 = newDualId().oid;
        const app2 = newDualId().oid;
        const sha = "c".repeat(40);

        await repo.replaceWorkspaceIndexEntries(
          wsId,
          [],
          [
            {
              appId: app1,
              path: "apps/rev",
              slug: "rev",
              scope: "workspace",
              treeOid: "t1",
              title: "Revenue",
              hasManifestId: true,
              schedules: [{ binding: "daily", cron: "0 * * * *" }],
              tables: ["orders"],
              bindings: ["daily"],
              thumbnail: { file: "thumbnail.png", oid: "blob1" },
              indexedSha: sha,
            },
            {
              appId: app2,
              path: "users/alice/apps/notes",
              slug: "notes",
              scope: "private",
              ownerId: user1Uuid,
              treeOid: "t2",
              title: "Notes",
              hasManifestId: false,
              schedules: [],
              indexedSha: sha,
            },
          ],
        );
        await repo.upsertIndexHead(wsId, {
          sha,
          schemaVersion: 7,
          folders: ["apps/rev", "users/alice/apps"],
        });

        expect((await repo.findIndexHeadByWorkspace(wsId))?.folders).toEqual([
          "apps/rev",
          "users/alice/apps",
        ]);
        expect(await repo.listIndexEntriesByWorkspace(wsId)).toHaveLength(2);
        expect(await repo.indexEntryExistsByAppId(app1)).toBe(true);
        expect(await repo.listIndexEntriesWithSchedules()).toHaveLength(1);
        expect(await repo.listDistinctWorkspaceIdsWithThumbnails()).toEqual([
          wsId,
        ]);
        expect(await repo.listForeignIndexAppIds(ws2Id, [app1])).toEqual([
          app1,
        ]);

        // 1536-dim pgvector embeddings
        const vec = makeVector(3, 1536);
        await repo.upsertEmbeddingsBatch(
          wsId,
          [
            {
              appId: app1,
              path: "apps/rev",
              treeOid: "t1",
              docHash: "hash1",
              embeddingModel: "text-embedding-3-small",
              vector: vec,
              terms: ["revenue", "orders"],
            },
          ],
          [],
        );
        await repo.upsertEmbeddingsBatch(
          wsId,
          [],
          [{ appId: app1, path: "apps/rev-renamed", treeOid: "t1b" }],
        );
        const embMeta = await repo.listEmbeddingsMetaByWorkspace(wsId);
        expect(embMeta).toHaveLength(1);
        expect(embMeta[0].path).toBe("apps/rev-renamed");
        const embVecs = await repo.listEmbeddingsByWorkspaceAndModel(
          wsId,
          "text-embedding-3-small",
        );
        expect(embVecs[0].vector).toHaveLength(1536);
        expect(embVecs[0].vector[5]).toBeCloseTo(vec[5], 4);
        await repo.deleteEmbeddingsByAppIds(wsId, [app1]);
        expect(await repo.listEmbeddingsMetaByWorkspace(wsId)).toHaveLength(0);

        // Lifecycle
        const t = new Date("2026-11-25T10:00:00.000Z");
        await repo.upsertLifecyclePatch(wsId, app1, {
          set: {
            verifiedAt: t,
            verifiedBy: user1Uuid,
            staleSince: t,
            schedulesPausedAt: t,
            archivedAt: t,
            archivedFrom: "apps/rev",
            archivedTo: "archive/apps/rev",
          },
        });
        expect(await repo.listVerifiedAppIds(wsId)).toEqual([app1]);
        expect(await repo.listPausedScheduleAppIds()).toEqual([app1]);
        expect(
          await repo.listLifecycleByArchivedTo(wsId, ["archive/apps/rev"]),
        ).toEqual([
          { archivedTo: "archive/apps/rev", archivedFrom: "apps/rev" },
        ]);

        await repo.clearStaleAndPausedOnOpen(wsId, app1);
        expect(await repo.listPausedScheduleAppIds()).toEqual([]);

        await repo.markAppRestored(wsId, app1, t, user1Uuid);
        const lc = (await repo.listLifecycleByWorkspace(wsId))[0];
        expect(lc.restoredBy).toBe(user1Uuid);
        expect(lc.archivedAt).toBeUndefined();

        // Commit status CAS: only 1 winner!
        await repo.upsertCommitStatus(wsId, app1, sha, "pending");
        expect(
          await repo.listPendingCommitStatusesExcludingSha(
            wsId,
            app1,
            "d".repeat(40),
          ),
        ).toEqual([sha]);
        const [win1, win2] = await Promise.all([
          repo.casResolvePendingCommitStatus(wsId, app1, sha, "superseded"),
          repo.casResolvePendingCommitStatus(wsId, app1, sha, "success"),
        ]);
        expect([win1, win2].filter(Boolean)).toHaveLength(1);
      });

      it("covers app_worktrees (real users + system actors), atomic claimPublicBindingRefresh, drafts & jobs", async () => {
        const repo = impl.create();
        const now = new Date("2026-11-25T10:00:00.000Z");

        // Real user + system actors ("publish", "api-key")
        const userWt = await repo.ensureWorktreeRow(wsId, user1Uuid, "main");
        const pubWt = await repo.ensureWorktreeRow(wsId, "publish", "main");
        const keyWt = await repo.ensureWorktreeRow(wsId, "api-key", "main");
        expect(userWt.userId).toBe(user1Uuid);
        expect(pubWt.userId).toBe("publish");
        expect(keyWt.userId).toBe("api-key");

        await repo.updateWorktreeBranch(wsId, user1Uuid, "feat/charts");
        const beforeActivity = await repo.findWorktree(wsId, user1Uuid);
        expect(beforeActivity).not.toBeNull();
        if (!beforeActivity) {
          throw new Error("Expected worktree before activity");
        }
        expect(beforeActivity.branch).toBe("feat/charts");

        // Activity bump must preserve updatedAt and use GREATEST
        await repo.bumpWorktreeActivity(
          wsId,
          user1Uuid,
          now,
          new Date(now.getTime() + 60_000),
        );
        const afterActivity = await repo.findWorktree(wsId, user1Uuid);
        expect(afterActivity).not.toBeNull();
        if (!afterActivity) throw new Error("Expected worktree after activity");
        expect(afterActivity.updatedAt.getTime()).toBe(
          beforeActivity.updatedAt.getTime(),
        );
        expect(afterActivity.lastActivityAt?.toISOString()).toBe(
          now.toISOString(),
        );

        // Pause history capped to latest 5
        for (let i = 1; i <= 7; i++) {
          await repo.recordWorktreePause(
            wsId,
            user1Uuid,
            new Date(now.getTime() + i * 1000),
          );
        }
        const pauseHist = await repo.getWorktreePauseHistory(wsId, user1Uuid);
        expect(pauseHist.pausedAt).toHaveLength(5);

        await repo.holdWorktreePausing(
          wsId,
          user1Uuid,
          new Date(now.getTime() + 1_800_000),
          now,
        );
        expect(
          (await repo.getWorktreePauseHistory(wsId, user1Uuid)).holdUntil,
        ).not.toBeNull();

        const actList = await repo.listWorktreesActivity([
          { workspaceId: wsId, actorId: user1Uuid },
          { workspaceId: wsId, actorId: "publish" },
        ]);
        expect(actList).toHaveLength(2);

        // Binding state: history capped to 20 newest-first + atomic cooldown claim
        const projId = newDualId().oid;
        for (let i = 1; i <= 25; i++) {
          await repo.recordBindingRun(
            projId,
            "sales",
            {
              at: new Date(now.getTime() + i * 1000),
              status: "ready",
              rowCount: i,
              durationMs: 100,
              artifactKey: `apps/bindings/k${i}.parquet`,
            },
            wsId,
          );
        }
        const state = await repo.getBindingState(projId, "sales", wsId);
        expect(state?.lastRowCount).toBe(25);
        expect(state?.history).toHaveLength(20);
        expect(state?.history?.[0].rowCount).toBe(25);

        const summary = await repo.listBindingStatesByProjects(wsId, [projId]);
        expect(summary).toHaveLength(1);
        expect(summary[0].history).toHaveLength(1);

        const claim1 = await repo.claimPublicBindingRefresh(
          projId,
          "orders",
          300_000,
          now,
          wsId,
        );
        expect(claim1).toEqual({ claimed: true });
        const claim2 = await repo.claimPublicBindingRefresh(
          projId,
          "orders",
          300_000,
          new Date(now.getTime() + 60_000),
          wsId,
        );
        expect(claim2.claimed).toBe(false);
        if (!claim2.claimed) {
          expect(claim2.retryAfterMs).toBeGreaterThanOrEqual(200_000);
        }
        const claim3 = await repo.claimPublicBindingRefresh(
          projId,
          "orders",
          300_000,
          new Date(now.getTime() + 301_000),
          wsId,
        );
        expect(claim3).toEqual({ claimed: true });

        // Binding drafts (app-pruned)
        const draft = await repo.createDraftBuild(
          {
            projectId: projId,
            hash: "h1",
            name: "sales",
            key: `apps/drafts/${projId}/h1-1.parquet`,
            builtAt: now,
            rowCount: 10,
            byteSize: 512,
            expiresAt: new Date(now.getTime() + 600_000),
          },
          wsId,
        );
        expect(
          (await repo.findActiveDraftBuild(projId, "h1", now, wsId))?.id,
        ).toBe(draft.id);
        await repo.upsertDraftFailure(
          {
            projectId: projId,
            hash: "h2",
            name: "broken",
            failures: 2,
            until: new Date(now.getTime() + 120_000),
            error: "syntax error",
            expiresAt: new Date(now.getTime() + 600_000),
          },
          wsId,
        );
        expect(
          (await repo.findDraftFailure(projId, "h2", wsId))?.failures,
        ).toBe(2);
        const expiredDrafts = await repo.listExpiredDrafts(
          projId,
          new Date(now.getTime() + 700_000),
          100,
          wsId,
        );
        expect(expiredDrafts).toHaveLength(2);
        await repo.deleteDraftsByIds(
          projId,
          expiredDrafts.map(d => d.id),
          wsId,
        );
        expect(
          await repo.listExpiredDrafts(
            projId,
            new Date(now.getTime() + 700_000),
            100,
            wsId,
          ),
        ).toHaveLength(0);

        // Binding jobs (app-pruned + stale CAS)
        const job = await repo.createBindingJob({
          workspaceId: wsId,
          projectId: projId,
          name: "sales",
          kind: "materialize",
          actorId: user1Uuid,
          userId: user1Uuid,
          canWrite: true,
          request: { refresh: true },
          expiresAt: new Date(now.getTime() + 3_600_000),
        });
        await repo.markBindingJob(
          job.id,
          { status: "running" },
          new Date(now.getTime() + 3_600_000),
          now,
          wsId,
        );
        await repo.updateBindingJobProgress(
          job.id,
          { phase: "querying", rowsWritten: 100, at: now },
          wsId,
        );
        expect(
          (await repo.findBindingJobById(job.id, projId, wsId))?.progress
            ?.phase,
        ).toBe("querying");

        const staleList = await repo.listStaleRunningBindingJobs(
          new Date(now.getTime() + 60_000),
          100,
        );
        expect(staleList.map(j => j.id)).toContain(job.id);
        const failed = await repo.casFailStaleBindingJob(
          job.id,
          new Date(now.getTime() + 60_000),
          "worker died",
          502,
          new Date(now.getTime() + 100_000),
          wsId,
        );
        expect(failed?.status).toBe("error");

        const expJobs = await repo.listExpiredFinishedBindingJobs(
          projId,
          new Date(now.getTime() + 200_000),
          100,
          wsId,
        );
        expect(expJobs.map(j => j.id)).toEqual([job.id]);
        await repo.deleteBindingJobsByIds(projId, [job.id], wsId);
        expect(await repo.findBindingJobById(job.id, projId, wsId)).toBeNull();
      });
    });
  }

  // ── 2. PG app_worktrees ON DELETE CASCADE for real users, preserves system actors

  it("cascades personal app_worktrees on DELETE FROM users while keeping system actors intact", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
    await pgRepo.ensureWorktreeRow(wsId, user2Uuid, "main");
    await pgRepo.ensureWorktreeRow(wsId, "publish", "main");

    await db.delete(pgSchema.users).where(eq(pgSchema.users.id, user2Uuid));

    expect(await pgRepo.findWorktree(wsId, user2Uuid)).toBeNull();
    expect(await pgRepo.findWorktree(wsId, "publish")).not.toBeNull();
  });

  // ── 3. Blob-safe expiry invariant: ZERO TTL rules for binding drafts/jobs

  it("NEVER registers app_binding_drafts or app_binding_jobs in migration-pg-ttl-reaper", () => {
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });
    const ruleTables = listTtlRules().map(r => r.tableName);
    expect(ruleTables).not.toContain("app_binding_drafts");
    expect(ruleTables).not.toContain("app_binding_jobs");
  });

  // ── 4. 5-stage dual-run + Stage 4->2 rollback + secret redaction ─────────

  it("walks all 5 dual-run stages, Stage 4->2 rollback, and redacts app_projects secrets in shadow-compare", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      maxInflight: 8,
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
      shadowRunner,
      rng: () => 0.0,
    });
    const dual = new DualAppsMetadataRepository({
      router,
      getDb: () => db,
    });

    // Stage 2: dual write
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const proj = await dual.createProject({
      workspaceId: wsId,
      title: "Secret Vault App",
      slug: "vault",
      path: "apps/vault",
      owner_id: user1Uuid,
      createdBy: user1Uuid,
    });
    const SECRET_ENV_CIPHER = "enc:v1:SENSITIVE_ENV_VALUE_DO_NOT_LEAK";
    const SECRET_PW_HASH = "$2b$10$SENSITIVE_BCRYPT_HASH_DO_NOT_LEAK";
    const SECRET_PW_CIPHER = "iv:tag:SENSITIVE_PW_CIPHER_DO_NOT_LEAK";

    await dual.updateProjectEnv(wsId, proj.id, [
      { key: "API_SECRET", valueEncrypted: SECRET_ENV_CIPHER, secret: true },
    ]);

    // Wrong-workspace delete in Stage 2 MUST be a no-op and MUST NOT tombstone the live project!
    const foreignWsId = newDualId().oid;
    await dual.deleteProject(foreignWsId, proj.id);
    const wrongWsTombstones = await db
      .select()
      .from(pgSchema.migrationTombstones)
      .where(
        eq(pgSchema.migrationTombstones.entityId, objectIdToUuid(proj.id)),
      );
    expect(wrongWsTombstones).toHaveLength(0);
    expect(await dual.findProjectById(proj.id, wsId)).not.toBeNull();
    await dual.updateProjectSharing(wsId, proj.id, {
      publicShare: {
        enabled: true,
        token: "vault-token",
        passwordHash: SECRET_PW_HASH,
        passwordEncrypted: SECRET_PW_CIPHER,
        createdAt: new Date("2026-11-25T10:00:00.000Z"),
        createdBy: user1Uuid,
      },
    });

    // Stage 3: clean match first
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    await dual.findProjectById(proj.id, wsId);
    await shadowRunner.flush();
    expect(shadowEvents.at(-1)?.result).toBe("match");

    // Intentionally diverge encrypted secret in PG -> shadow-compare MUST redact and NEVER leak raw values!
    await db
      .update(pgSchema.appProjects)
      .set({
        env: [
          {
            key: "API_SECRET",
            valueEncrypted: "enc:v1:DIFFERENT_PG_SECRET_DO_NOT_LEAK",
            secret: true,
          },
        ],
        publicSharePasswordHash: "$2b$10$DIFFERENT_PG_HASH_DO_NOT_LEAK",
        publicSharePasswordEncrypted: "iv:tag:DIFFERENT_PG_PW_DO_NOT_LEAK",
      })
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(proj.id)));

    await dual.findProjectById(proj.id, wsId);
    await shadowRunner.flush();
    const diffEvent = shadowEvents.at(-1);
    expect(diffEvent).toBeDefined();
    if (!diffEvent) throw new Error("Expected shadow diff event");
    expect(diffEvent.result).toBe("mismatch");
    expect(diffEvent.diffs.length).toBeGreaterThan(0);
    expect(diffEvent.diffs.every(d => d.redacted === true)).toBe(true);
    const serialized = JSON.stringify(diffEvent);
    expect(serialized).not.toContain(SECRET_ENV_CIPHER);
    expect(serialized).not.toContain(SECRET_PW_HASH);
    expect(serialized).not.toContain(SECRET_PW_CIPHER);
    expect(serialized).not.toContain("DIFFERENT_PG_SECRET_DO_NOT_LEAK");
    expect(serialized).not.toContain("DIFFERENT_PG_HASH_DO_NOT_LEAK");
    expect(serialized).not.toContain("DIFFERENT_PG_PW_DO_NOT_LEAK");

    // Stage 4 -> rollback to Stage 2 -> Stage 5
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_pg_read",
    });
    await dual.updateProjectLocation(wsId, proj.id, { title: "Vault v2" });
    expect((await dual.findProjectById(proj.id, wsId))?.title).toBe("Vault v2");

    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    expect((await dual.findProjectById(proj.id, wsId))?.title).toBe("Vault v2");

    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });
    await dual.updateProjectLocation(wsId, proj.id, { title: "Vault PG Only" });
    expect((await dual.findProjectById(proj.id, wsId))?.title).toBe(
      "Vault PG Only",
    );
    expect((await dual.mongo.findProjectById(proj.id, wsId))?.title).toBe(
      "Vault v2",
    );
  });

  // ── 5. Backfill, tombstones, quarantine, parity verifier (--repair), sync-retry

  it("backfills all 10 tables with user UUID rewrite, honors tombstones, quarantines bad embedding dims, verifies & repairs, and replays sync-retry", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    expect(listBackfillDomains()).toContain("apps_metadata");
    expect(listBackfillDomains()).toContain("apps_metadata:app_projects");
    expect(listBackfillDomains()).toContain("apps_metadata:app_binding_jobs");

    const now = new Date("2026-11-25T10:00:00.000Z");
    const app1 = await AppProject.create({
      workspaceId: new Types.ObjectId(wsId),
      title: "Backfill App",
      slug: "backfill-app",
      path: "apps/backfill-app",
      access: "workspace",
      owner_id: "luciaapps000001",
      createdBy: "luciaapps000001",
      sharedWith: [
        {
          userId: "luciaapps000002",
          role: "editor",
          addedAt: now,
          addedBy: "luciaapps000001",
        },
      ],
      env: [{ key: "K", valueEncrypted: "enc:opaque", secret: true }],
    });
    const tombstoned = await AppProject.create({
      workspaceId: new Types.ObjectId(wsId),
      title: "Deleted App",
      slug: "deleted-app",
      path: "apps/deleted-app",
      access: "private",
      createdBy: "luciaapps000001",
    });
    await recordMigrationTombstone(
      "app_projects",
      objectIdToUuid(tombstoned._id.toString()),
      db,
    );

    const appIdHex = app1._id.toString();
    await AppIndexEntry.create({
      workspaceId: new Types.ObjectId(wsId),
      appId: appIdHex,
      path: "apps/backfill-app",
      slug: "backfill-app",
      scope: "workspace",
      treeOid: "t1",
      title: "Backfill App",
      hasManifestId: true,
      schedules: [],
      indexedSha: "a".repeat(40),
    });
    await AppIndexHead.create({
      workspaceId: new Types.ObjectId(wsId),
      sha: "a".repeat(40),
      schemaVersion: 7,
      folders: ["apps/backfill-app"],
    });
    await AppEmbedding.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        appId: appIdHex,
        path: "apps/backfill-app",
        treeOid: "t1",
        docHash: "dh1",
        embeddingModel: "text-embedding-3-small",
        vector: makeVector(1, 1536),
        terms: ["backfill"],
      },
      {
        workspaceId: new Types.ObjectId(wsId),
        appId: newDualId().oid,
        path: "apps/bad-vec",
        treeOid: "t2",
        docHash: "dh2",
        embeddingModel: "text-embedding-3-small",
        vector: [0.1, 0.2, 0.3], // Invalid dim -> quarantined!
      },
    ]);
    await AppLifecycleState.create({
      workspaceId: new Types.ObjectId(wsId),
      appId: appIdHex,
      verifiedAt: now,
      verifiedBy: "luciaapps000001",
    });
    await AppDeployCommitStatus.create({
      workspaceId: new Types.ObjectId(wsId),
      appId: appIdHex,
      sha: "a".repeat(40),
      state: "success",
    });
    await AppWorktree.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        userId: "luciaapps000001",
        branch: "main",
      },
      {
        workspaceId: new Types.ObjectId(wsId),
        userId: "publish",
        branch: "main",
      },
    ]);
    await getMongoAppBindingStateModel().create({
      projectId: app1._id,
      name: "orders",
      lastMaterializedAt: now,
      lastRowCount: 50,
    });
    await getMongoAppBindingDraftModel().create({
      projectId: app1._id,
      hash: "h1",
      kind: "build",
      name: "orders",
      key: `apps/drafts/${appIdHex}/h1-1.parquet`,
      builtAt: now,
      rowCount: 50,
      byteSize: 1024,
      expiresAt: new Date(now.getTime() + 1_800_000),
    });
    await getMongoAppBindingJobModel().create({
      workspaceId: wsId,
      projectId: appIdHex,
      name: "orders",
      kind: "materialize",
      actorId: "luciaapps000001",
      userId: "luciaapps000001",
      canWrite: true,
      request: {},
      status: "ready",
      expiresAt: new Date(now.getTime() + 3_600_000),
    });

    const bf = await runBackfill({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(bf.rowsQuarantined).toBe(1); // the 3-d embedding
    expect(bf.rowsSkippedTombstone).toBe(1); // tombstoned project

    const pgProj = await db.select().from(pgSchema.appProjects);
    expect(pgProj).toHaveLength(1);
    expect(pgProj[0].ownerId).toBe(user1Uuid);
    expect(pgProj[0].sharedWith?.[0].userId).toBe(user2Uuid);
    expect(pgProj[0].sharedWith?.[0].addedBy).toBe(user1Uuid);

    const pgWts = await db.select().from(pgSchema.appWorktrees);
    expect(pgWts).toHaveLength(2);
    expect(pgWts.find(w => w.actorId === "publish")?.userId).toBeNull();
    expect(pgWts.find(w => w.actorId === user1Uuid)?.userId).toBe(user1Uuid);

    const pgJobs = await db.select().from(pgSchema.appBindingJobs);
    expect(pgJobs[0].actorId).toBe("luciaapps000001");
    expect(pgJobs[0].userId).toBe(user1Uuid);

    // Stale backfill guard: a newer live PG update must NOT be overwritten by a re-run backfill of an older Mongo row!
    const futureTs = new Date(Date.now() + 600_000);
    await db
      .update(pgSchema.appProjects)
      .set({ title: "Newer Live Dual-Write", updatedAt: futureTs })
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appIdHex)));
    await runBackfill({
      domain: `${APPS_METADATA_DOMAIN}:app_projects`,
      workspaceId: wsId,
      resetCursor: true,
      db,
    });
    const pgProjAfterStaleBf = await db
      .select()
      .from(pgSchema.appProjects)
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appIdHex)));
    expect(pgProjAfterStaleBf[0].title).toBe("Newer Live Dual-Write");
    // Restore PG project to match Mongo before parity verification
    await db
      .update(pgSchema.appProjects)
      .set({ title: "Backfill App", updatedAt: app1.updatedAt })
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appIdHex)));

    // Clean the quarantined invalid-dim embedding in Mongo, then verify parity across all 10 tables!
    await AppEmbedding.deleteMany({ path: "apps/bad-vec" });
    const verifyClean = await runParityVerification({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verifyClean.mismatched).toBe(0);
    expect(verifyClean.missingInPg).toBe(0);

    // Corrupt PG project title -> verifier detects & repairs!
    await db
      .update(pgSchema.appProjects)
      .set({ title: "Corrupted Title" })
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appIdHex)));
    const verifyDrifted = await runParityVerification({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verifyDrifted.mismatched).toBe(1);
    const verifyRepaired = await runParityVerification({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      repair: true,
      db,
    });
    expect(verifyRepaired.repaired).toBe(1);

    // Sync-retry replay (PG & Mongo directions, fetching secrets from authoritative store)
    await AppProject.updateOne(
      { _id: app1._id },
      { $set: { title: "Replayed Title" } },
    );
    await replayAppsMetadataWriteToPg(
      {
        target: "pg",
        domain: APPS_METADATA_DOMAIN,
        operation: "updateProjectLocation",
        workspaceId: wsId,
        entityId: appIdHex,
        payload: { table: "app_projects", id: appIdHex, workspaceId: wsId },
        failedAt: new Date().toISOString(),
        errorMessage: "simulated secondary write error",
      },
      db,
    );
    const pgAfterReplay = await db
      .select()
      .from(pgSchema.appProjects)
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appIdHex)));
    expect(pgAfterReplay[0].title).toBe("Replayed Title");

    await db
      .update(pgSchema.appProjects)
      .set({ title: "PG Authoritative" })
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appIdHex)));
    await replayAppsMetadataWriteToMongo(
      {
        target: "mongo",
        domain: APPS_METADATA_DOMAIN,
        operation: "updateProjectLocation",
        workspaceId: wsId,
        entityId: appIdHex,
        payload: { table: "app_projects", id: appIdHex, workspaceId: wsId },
        failedAt: new Date().toISOString(),
        errorMessage: "simulated reverse write error",
      },
      db,
    );
    const mongoAfterReplay = await AppProject.findById(app1._id).lean();
    expect(mongoAfterReplay?.title).toBe("PG Authoritative");
  });

  // ── 6. Stage 3 legacy 15-char user-ID shadow-compare (0 mismatches & 0 critical-path PG calls)

  it("reconciles 15-char legacy user IDs in Stage 3 shadow-compare with 0 mismatches and 0 extra PG calls when unsampled", async () => {
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
    let rngValue = 0.0;
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
      shadowRunner,
      rng: () => rngValue,
    });
    const dual = new DualAppsMetadataRepository({
      router,
      getDb: countedGetDb,
    });

    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });

    const now = new Date("2026-11-25T10:00:00.000Z");
    const proj = await dual.createProject({
      workspaceId: wsId,
      title: "Legacy Lucia App",
      slug: "legacy-lucia",
      path: "apps/legacy-lucia",
      access: "workspace",
      owner_id: "luciaapps000001",
      createdBy: "luciaapps000001",
      sharedWith: [
        {
          userId: "luciaapps000002",
          role: "editor",
          addedAt: now,
          addedBy: "luciaapps000001",
        },
      ],
      publicShare: {
        enabled: true,
        token: "legacy-share-tok",
        createdAt: now,
        createdBy: "luciaapps000001",
      },
      publishedSha: "a".repeat(40),
      publishedAt: now,
    });
    await dual.replaceWorkspaceIndexEntries(
      wsId,
      [],
      [
        {
          appId: proj.id,
          path: "apps/legacy-lucia",
          slug: "legacy-lucia",
          scope: "workspace",
          ownerId: "luciaapps000001",
          treeOid: "tree-1",
          title: "Legacy Lucia App",
          hasManifestId: true,
          schedules: [],
          indexedSha: "a".repeat(40),
        },
      ],
    );
    await dual.upsertIndexHead(wsId, {
      sha: "a".repeat(40),
      schemaVersion: 7,
      folders: ["apps/legacy-lucia"],
    });
    await dual.upsertLifecyclePatch(wsId, proj.id, {
      set: { verifiedAt: now, verifiedBy: "luciaapps000001" },
    });
    await dual.ensureWorktreeRow(wsId, "luciaapps000001", "main");
    await dual.ensureWorktreeRow(wsId, "publish", "main");
    await dual.recordBindingRun(
      proj.id,
      "orders",
      { at: now, status: "ready", rowCount: 10 },
      wsId,
    );
    await dual.createDraftBuild(
      {
        projectId: proj.id,
        hash: "h-legacy",
        name: "orders",
        key: "apps/drafts/h-legacy.parquet",
        builtAt: now,
        rowCount: 10,
        byteSize: 256,
        expiresAt: new Date(now.getTime() + 600_000),
      },
      wsId,
    );
    const job = await dual.createBindingJob({
      workspaceId: wsId,
      projectId: proj.id,
      name: "orders",
      kind: "materialize",
      actorId: "luciaapps000001",
      userId: "luciaapps000001",
      canWrite: true,
      request: {},
      expiresAt: new Date(now.getTime() + 600_000),
    });

    // Unsampled Stage 3 read (rng >= shadowSampleRate): ZERO extra getDb calls from DualAppsMetadataRepository!
    rngValue = 0.99;
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 0.5,
    });
    getDbCalls = 0;
    const unsampled = await dual.findProjectById(proj.id, wsId);
    await shadowRunner.flush();
    expect(unsampled?.owner_id).toBe("luciaapps000001");
    expect(getDbCalls).toBe(0);

    // 100% sampled Stage 3 reads across ALL user-bearing & timestamped ops -> 0 mismatches!
    rngValue = 0.0;
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: null,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });

    await dual.findProjectById(proj.id, wsId);
    await dual.findProjectByPath(wsId, "apps/legacy-lucia");
    await dual.findProjectBySlug(wsId, "legacy-lucia");
    await dual.findProjectByShareToken("legacy-share-tok");
    await dual.listProjectsByWorkspace(wsId);
    await dual.listProjectsByIds(wsId, [proj.id]);
    await dual.listPublishedProjects();
    await dual.listIndexEntriesByWorkspace(wsId);
    await dual.findIndexEntryByAppId(proj.id, wsId);
    await dual.findIndexHeadByWorkspace(wsId);
    await dual.listLifecycleByWorkspace(wsId);
    await dual.findWorktree(wsId, "luciaapps000001");
    await dual.listWorktreesActivity([
      { workspaceId: wsId, actorId: "luciaapps000001" },
      { workspaceId: wsId, actorId: "publish" },
    ]);
    await dual.getBindingState(proj.id, "orders", wsId);
    await dual.findActiveDraftBuild(proj.id, "h-legacy", now, wsId);
    await dual.findBindingJobById(job.id, proj.id, wsId);
    await shadowRunner.flush();

    expect(shadowEvents.length).toBeGreaterThanOrEqual(16);
    const nonMatches = shadowEvents.filter(e => e.result !== "match");
    expect(nonMatches).toEqual([]);
  });

  // ── 7. Stage 5 per-workspace canary (ws1 = pg_only, global = mongo_only) ──

  it("routes workspace-less binding jobs/state/drafts and global scans cleanly for a Stage 5 workspace canary", async () => {
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    const dual = new DualAppsMetadataRepository({
      router,
      getDb: () => db,
    });

    // Global stays mongo_only; wsId is Stage 5 canary (pg_only); ws2Id remains mongo_only.
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: null,
      mode: "mongo_only",
    });
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });

    const now = new Date("2026-11-26T10:00:00.000Z");
    // Canary workspace project (PG ONLY)
    const canaryProj = await dual.createProject({
      workspaceId: wsId,
      title: "Canary PG Project",
      slug: "canary-pg",
      path: "apps/canary-pg",
      owner_id: user1Uuid,
      createdBy: user1Uuid,
      publishedSha: "b".repeat(40),
      publishedAt: now,
      publicShare: {
        enabled: true,
        token: "canary-share-token",
        createdAt: now,
        createdBy: user1Uuid,
      },
    });
    // Non-canary workspace project (Mongo ONLY)
    const mongoProj = await dual.createProject({
      workspaceId: ws2Id,
      title: "Global Mongo Project",
      slug: "global-mongo",
      path: "apps/global-mongo",
      owner_id: user1Uuid,
      createdBy: user1Uuid,
      publishedSha: "c".repeat(40),
      publishedAt: now,
      publicShare: {
        enabled: true,
        token: "mongo-share-token",
        createdAt: now,
        createdBy: user1Uuid,
      },
    });
    // Stale Mongo copy for canary workspace that was deleted in PG -> MUST be ignored!
    const staleCanaryMongo = await dual.mongo.createProject({
      workspaceId: wsId,
      title: "Stale Deleted Canary",
      slug: "stale-canary",
      path: "apps/stale-canary",
      owner_id: user1Uuid,
      createdBy: user1Uuid,
      publishedSha: "d".repeat(40),
      publishedAt: now,
      publicShare: {
        enabled: true,
        token: "stale-canary-token",
        createdAt: now,
        createdBy: user1Uuid,
      },
    });

    // Workspace-less project & share-token lookups
    expect((await dual.findProjectById(canaryProj.id))?.title).toBe(
      "Canary PG Project",
    );
    expect((await dual.findProjectById(mongoProj.id))?.title).toBe(
      "Global Mongo Project",
    );
    expect(await dual.findProjectById(staleCanaryMongo.id)).toBeNull();

    expect((await dual.findProjectByShareToken("canary-share-token"))?.id).toBe(
      canaryProj.id,
    );
    expect((await dual.findProjectByShareToken("mongo-share-token"))?.id).toBe(
      mongoProj.id,
    );
    expect(await dual.findProjectByShareToken("stale-canary-token")).toBeNull();

    expect(await dual.isShareTokenTaken("canary-share-token")).toBe(true);
    expect(await dual.isShareTokenTaken("mongo-share-token")).toBe(true);
    expect(await dual.isShareTokenTaken("stale-canary-token")).toBe(false);

    // Cross-workspace global scans partition cleanly across PG (wsId) + Mongo (ws2Id)
    const publishedIds = (await dual.listPublishedProjects()).map(p => p.id);
    expect(publishedIds).toContain(canaryProj.id);
    expect(publishedIds).toContain(mongoProj.id);
    expect(publishedIds).not.toContain(staleCanaryMongo.id);

    const existingIds = await dual.listExistingProjectIds([
      canaryProj.id,
      mongoProj.id,
      staleCanaryMongo.id,
    ]);
    expect(existingIds.sort()).toEqual([canaryProj.id, mongoProj.id].sort());
    expect((await dual.listDistinctProjectWorkspaceIds()).sort()).toEqual(
      [wsId, ws2Id].sort(),
    );

    // Index schedules, paused lifecycle, and worktree activity partitioning
    await dual.replaceWorkspaceIndexEntries(
      wsId,
      [],
      [
        {
          appId: canaryProj.id,
          path: "apps/canary-pg",
          slug: "canary-pg",
          scope: "workspace",
          treeOid: "t1",
          title: "Canary PG Project",
          hasManifestId: true,
          schedules: [{ binding: "sales", cron: "0 * * * *" }],
          indexedSha: "b".repeat(40),
        },
      ],
    );
    await dual.upsertLifecyclePatch(wsId, canaryProj.id, {
      set: { schedulesPausedAt: now },
    });
    await dual.ensureWorktreeRow(wsId, user1Uuid, "main");
    await dual.bumpWorktreeActivity(wsId, user1Uuid, now);

    expect(
      (await dual.listIndexEntriesWithSchedules()).map(e => e.appId),
    ).toContain(canaryProj.id);
    expect(await dual.listPausedScheduleAppIds()).toContain(canaryProj.id);
    expect(
      await dual.listWorktreesActivity([
        { workspaceId: wsId, actorId: user1Uuid },
      ]),
    ).toHaveLength(1);
    expect(
      (
        await dual.listHotWorktreeWorkspacesSince(
          new Date(Date.now() - 3_600_000),
        )
      ).map(w => w.workspaceId),
    ).toContain(wsId);

    // Workspace-less binding jobs lifecycle for Stage 5 canary!
    const job = await dual.createBindingJob({
      workspaceId: wsId,
      projectId: canaryProj.id,
      name: "sales",
      kind: "materialize",
      actorId: user1Uuid,
      userId: user1Uuid,
      canWrite: true,
      request: {},
      expiresAt: new Date(now.getTime() + 600_000),
    });
    expect(await dual.mongo.findBindingJobById(job.id)).toBeNull();
    // All subsequent calls omit workspaceId -> still route to PG via canary resolver!
    expect((await dual.findBindingJobById(job.id))?.id).toBe(job.id);
    await dual.markBindingJob(
      job.id,
      { status: "running" },
      new Date(now.getTime() + 600_000),
      now,
    );
    await dual.heartbeatBindingJob(
      job.id,
      now,
      new Date(now.getTime() + 900_000),
    );
    await dual.updateBindingJobProgress(job.id, {
      phase: "querying",
      rowsWritten: 42,
      at: now,
    });
    expect((await dual.findBindingJobById(job.id))?.progress?.rowsWritten).toBe(
      42,
    );
    const staleJobs = await dual.listStaleRunningBindingJobs(
      new Date(now.getTime() + 60_000),
      50,
    );
    expect(staleJobs).toContainEqual(
      expect.objectContaining({ id: job.id, workspaceId: wsId }),
    );
    const failedJob = await dual.casFailStaleBindingJob(
      job.id,
      new Date(now.getTime() + 60_000),
      "worker stalled",
      502,
      new Date(now.getTime() + 600_000),
    );
    expect(failedJob?.status).toBe("error");

    // Workspace-less binding state & draft cache for Stage 5 canary!
    await dual.recordBindingRun(canaryProj.id, "sales", {
      at: now,
      status: "ready",
      rowCount: 12,
    });
    expect(
      (await dual.getBindingState(canaryProj.id, "sales"))?.lastRowCount,
    ).toBe(12);
    expect(
      (
        await dual.claimPublicBindingRefresh(
          canaryProj.id,
          "sales",
          60_000,
          now,
        )
      ).claimed,
    ).toBe(true);
    await dual.createDraftBuild({
      projectId: canaryProj.id,
      hash: "canary-hash",
      name: "sales",
      key: "apps/drafts/canary.parquet",
      builtAt: now,
      rowCount: 12,
      byteSize: 128,
      expiresAt: new Date(now.getTime() + 600_000),
    });
    expect(
      (await dual.findActiveDraftBuild(canaryProj.id, "canary-hash", now))?.key,
    ).toBe("apps/drafts/canary.parquet");
  });

  // ── 8. Stage 4->2 reverse-sync: $unset cleared fields + legacy_id mapping ──

  it("reverse-syncs cleared PG fields with Mongo $unset and maps UUIDv7 user IDs back to legacy_id", async () => {
    const now = new Date("2026-11-26T10:00:00.000Z");
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });

    const proj = await pgRepo.createProject({
      workspaceId: wsId,
      title: "Rollback App",
      slug: "rollback-app",
      path: "apps/rollback-app",
      owner_id: user1Uuid,
      createdBy: user1Uuid,
      sharedWith: [
        {
          userId: user2Uuid,
          role: "editor",
          addedAt: now,
          addedBy: user1Uuid,
        },
      ],
      publishedSha: "a".repeat(40),
      publishedAt: now,
      deployProgress: {
        sha: "a".repeat(40),
        stage: "build",
        startedAt: now,
        stageStartedAt: now,
        updatedAt: now,
      },
      publicShare: {
        enabled: true,
        token: "rollback-tok",
        createdAt: now,
        createdBy: user1Uuid,
      },
    });
    // Seed Mongo with all those fields set
    await AppProject.create({
      _id: new Types.ObjectId(proj.id),
      workspaceId: new Types.ObjectId(wsId),
      title: "Rollback App",
      slug: "rollback-app",
      path: "apps/rollback-app",
      owner_id: "luciaapps000001",
      createdBy: "luciaapps000001",
      publishedSha: "a".repeat(40),
      publishedAt: now,
      deployProgress: {
        sha: "a".repeat(40),
        stage: "build",
        startedAt: now,
        stageStartedAt: now,
        updatedAt: now,
      },
      publicShare: {
        enabled: true,
        token: "rollback-tok",
        createdAt: now,
        createdBy: "luciaapps000001",
      },
    });

    // Clear publicShare, publishedSha, and deployProgress in PG
    await pgRepo.updateProjectSharing(wsId, proj.id, { publicShare: null });
    await pgRepo.clearPublishedSha(wsId, proj.id);
    await pgRepo.clearDeployProgress(wsId, proj.id, "a".repeat(40));

    await replayAppsMetadataWriteToMongo(
      {
        target: "mongo",
        domain: APPS_METADATA_DOMAIN,
        operation: "updateProjectSharing",
        workspaceId: wsId,
        entityId: proj.id,
        payload: { table: "app_projects", id: proj.id, workspaceId: wsId },
        failedAt: now.toISOString(),
        errorMessage: "simulated reverse sync",
      },
      db,
    );
    const mongoProj = await AppProject.findById(
      new Types.ObjectId(proj.id),
    ).lean();
    expect(mongoProj?.publicShare).toBeUndefined();
    expect(mongoProj?.publishedSha).toBeUndefined();
    expect(mongoProj?.deployProgress).toBeUndefined();
    expect(mongoProj?.owner_id).toBe("luciaapps000001");
    expect(mongoProj?.createdBy).toBe("luciaapps000001");
    expect(mongoProj?.sharedWith?.[0].userId).toBe("luciaapps000002");
    expect(mongoProj?.sharedWith?.[0].addedBy).toBe("luciaapps000001");

    // app_lifecycle cleared stale/paused fields -> $unset in Mongo + verifiedBy -> legacy_id
    await pgRepo.upsertLifecyclePatch(wsId, proj.id, {
      set: {
        verifiedAt: now,
        verifiedBy: user1Uuid,
        staleSince: now,
        staleNotifiedTo: ["owner@example.com"],
        schedulesPausedAt: now,
      },
    });
    await AppLifecycleState.create({
      workspaceId: new Types.ObjectId(wsId),
      appId: proj.id,
      verifiedAt: now,
      verifiedBy: "luciaapps000001",
      staleSince: now,
      staleNotifiedTo: ["owner@example.com"],
      schedulesPausedAt: now,
    });
    await pgRepo.clearStaleAndPausedOnOpen(wsId, proj.id);
    await replayAppsMetadataWriteToMongo(
      {
        target: "mongo",
        domain: APPS_METADATA_DOMAIN,
        operation: "clearStaleAndPausedOnOpen",
        workspaceId: wsId,
        entityId: proj.id,
        payload: { table: "app_lifecycle", workspaceId: wsId, appId: proj.id },
        failedAt: now.toISOString(),
        errorMessage: "simulated reverse sync",
      },
      db,
    );
    const mongoLife = await AppLifecycleState.findOne({
      workspaceId: new Types.ObjectId(wsId),
      appId: proj.id,
    }).lean();
    expect(mongoLife?.staleSince).toBeUndefined();
    expect(mongoLife?.staleNotifiedTo).toBeUndefined();
    expect(mongoLife?.schedulesPausedAt).toBeUndefined();
    expect(mongoLife?.verifiedBy).toBe("luciaapps000001");

    // app_index & app_binding_jobs reverse-map UUIDv7 back to legacy_id
    await pgRepo.replaceWorkspaceIndexEntries(
      wsId,
      [],
      [
        {
          appId: proj.id,
          path: "apps/rollback-app",
          slug: "rollback-app",
          scope: "workspace",
          ownerId: user1Uuid,
          treeOid: "t1",
          title: "Rollback App",
          hasManifestId: true,
          schedules: [],
          indexedSha: "a".repeat(40),
        },
      ],
    );
    await replayAppsMetadataWriteToMongo(
      {
        target: "mongo",
        domain: APPS_METADATA_DOMAIN,
        operation: "replaceWorkspaceIndexEntries",
        workspaceId: wsId,
        entityId: wsId,
        payload: { table: "app_index", workspaceId: wsId },
        failedAt: now.toISOString(),
        errorMessage: "simulated reverse sync",
      },
      db,
    );
    const mongoIdx = await AppIndexEntry.findOne({
      workspaceId: new Types.ObjectId(wsId),
      appId: proj.id,
    }).lean();
    expect(mongoIdx?.ownerId).toBe("luciaapps000001");

    const job = await pgRepo.createBindingJob({
      workspaceId: wsId,
      projectId: proj.id,
      name: "orders",
      kind: "materialize",
      actorId: user1Uuid,
      userId: user1Uuid,
      canWrite: true,
      request: {},
      expiresAt: new Date(now.getTime() + 600_000),
    });
    await replayAppsMetadataWriteToMongo(
      {
        target: "mongo",
        domain: APPS_METADATA_DOMAIN,
        operation: "createBindingJob",
        workspaceId: wsId,
        entityId: job.id,
        payload: { table: "app_binding_jobs", id: job.id, workspaceId: wsId },
        failedAt: now.toISOString(),
        errorMessage: "simulated reverse sync",
      },
      db,
    );
    const mongoJob = await getMongoAppBindingJobModel()
      .findById(new Types.ObjectId(job.id))
      .lean<{ actorId: string; userId?: string } | null>();
    expect(mongoJob?.actorId).toBe("luciaapps000001");
    expect(mongoJob?.userId).toBe("luciaapps000001");
  });

  // ── 9. Natural-key PK drift --repair, failure draft dedupe, guarded repair & missing-workspace safety

  it("heals Stage 1->2 natural-key PK drift and failure draft duplicates via --repair while guarding newer PG rows and deleted workspaces", async () => {
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
    const appId = newDualId().oid;
    const now = new Date("2026-11-26T10:00:00.000Z");

    // Seed Stage 1 Mongo docs with _id = ID_M, and Stage 2 PG rows under the SAME natural key with DIFFERENT id = ID_P!
    const mongoProj = await AppProject.create({
      _id: new Types.ObjectId(appId),
      workspaceId: new Types.ObjectId(wsId),
      title: "PK Drift App",
      slug: "pk-drift",
      path: "apps/pk-drift",
      access: "workspace",
      createdBy: "luciaapps000001",
    });
    await pgRepo.createProject({
      id: appId,
      workspaceId: wsId,
      title: "PK Drift App",
      slug: "pk-drift",
      path: "apps/pk-drift",
      access: "workspace",
      createdBy: "luciaapps000001",
      createdAt: mongoProj.createdAt,
      updatedAt: mongoProj.updatedAt,
    });

    await AppIndexEntry.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      path: "apps/pk-drift",
      slug: "pk-drift",
      scope: "workspace",
      treeOid: "t1",
      title: "PK Drift App",
      hasManifestId: true,
      schedules: [],
      indexedSha: "a".repeat(40),
    });
    // PG gets a different id (Stage 2 dual-write before backfill) AND slightly newer updatedAt!
    await pgRepo.replaceWorkspaceIndexEntries(
      wsId,
      [],
      [
        {
          id: newDualId().oid,
          appId,
          path: "apps/pk-drift",
          slug: "pk-drift",
          scope: "workspace",
          treeOid: "t1",
          title: "PK Drift App",
          hasManifestId: true,
          schedules: [],
          indexedSha: "a".repeat(40),
        },
      ],
    );

    await AppIndexHead.create({
      workspaceId: new Types.ObjectId(wsId),
      sha: "a".repeat(40),
      schemaVersion: 7,
      folders: ["apps/pk-drift"],
    });
    await pgRepo.upsertIndexHead(wsId, {
      id: newDualId().oid,
      sha: "a".repeat(40),
      schemaVersion: 7,
      folders: ["apps/pk-drift"],
    });

    await AppEmbedding.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      path: "apps/pk-drift",
      treeOid: "t1",
      docHash: "dh1",
      embeddingModel: "text-embedding-3-small",
      vector: makeVector(3, 1536),
    });
    await pgRepo.upsertEmbeddingsBatch(
      wsId,
      [
        {
          id: newDualId().oid,
          appId,
          path: "apps/pk-drift",
          treeOid: "t1",
          docHash: "dh1",
          embeddingModel: "text-embedding-3-small",
          vector: makeVector(3, 1536),
        },
      ],
      [],
    );

    await AppLifecycleState.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      verifiedAt: now,
      verifiedBy: "luciaapps000001",
    });
    await pgRepo.upsertLifecyclePatch(
      wsId,
      appId,
      { set: { verifiedAt: now, verifiedBy: "luciaapps000001" } },
      newDualId().oid,
    );

    await AppDeployCommitStatus.create({
      workspaceId: new Types.ObjectId(wsId),
      appId,
      sha: "a".repeat(40),
      state: "success",
    });
    await pgRepo.upsertCommitStatus(
      wsId,
      appId,
      "a".repeat(40),
      "success",
      newDualId().oid,
    );

    await AppWorktree.create({
      workspaceId: new Types.ObjectId(wsId),
      userId: "publish",
      branch: "main",
    });
    await pgRepo.ensureWorktreeRow(wsId, "publish", "main", newDualId().oid);

    await getMongoAppBindingStateModel().create({
      projectId: new Types.ObjectId(appId),
      name: "orders",
      lastMaterializedAt: now,
      lastRowCount: 5,
    });
    await pgRepo.recordBindingRun(
      appId,
      "orders",
      { at: now, status: "ready", rowCount: 5 },
      wsId,
      newDualId().oid,
    );

    // Stage 1 Mongo failure draft + Stage 2 PG failure draft under different IDs
    await getMongoAppBindingDraftModel().create({
      projectId: new Types.ObjectId(appId),
      hash: "h-fail",
      kind: "failure",
      name: "orders",
      failures: 2,
      until: new Date(now.getTime() + 60_000),
      error: "boom",
      expiresAt: new Date(now.getTime() + 600_000),
    });
    await pgRepo.upsertDraftFailure(
      {
        id: newDualId().oid,
        projectId: appId,
        hash: "h-fail",
        name: "orders",
        failures: 2,
        until: new Date(now.getTime() + 60_000),
        error: "boom",
        expiresAt: new Date(now.getTime() + 600_000),
      },
      wsId,
    );

    // Verifier detects all 8 drifted PKs and repairs them cleanly!
    const before = await runParityVerification({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(before.missingInPg).toBe(8);

    const repaired = await runParityVerification({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      repair: true,
      db,
    });
    expect(repaired.repaired).toBe(8);

    // Failure draft must NOT have duplicates!
    const pgDrafts = await db.select().from(pgSchema.appBindingDrafts);
    expect(pgDrafts).toHaveLength(1);

    // Follow-up verification converges cleanly (0 missing in PG)!
    const after = await runParityVerification({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(after.missingInPg).toBe(0);

    // Guarded --repair: strictly newer live PG project must NOT be overwritten!
    await db
      .update(pgSchema.appProjects)
      .set({
        title: "Newer Live PG Title",
        updatedAt: new Date(Date.now() + 600_000),
      })
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appId)));
    await runParityVerification({
      domain: `${APPS_METADATA_DOMAIN}:app_projects`,
      workspaceId: wsId,
      repair: true,
      db,
    });
    const guardedProj = await db
      .select()
      .from(pgSchema.appProjects)
      .where(eq(pgSchema.appProjects.id, objectIdToUuid(appId)));
    expect(guardedProj[0].title).toBe("Newer Live PG Title");

    // Deleted workspace safety: --repair skips orphaned Mongo doc instead of throwing 23503!
    const deletedWsId = newDualId().oid;
    await AppProject.create({
      workspaceId: new Types.ObjectId(deletedWsId),
      title: "Orphaned Project",
      slug: "orphaned",
      path: "apps/orphaned",
      access: "private",
      createdBy: "luciaapps000001",
    });
    const orphanRes = await runParityVerification({
      domain: `${APPS_METADATA_DOMAIN}:app_projects`,
      workspaceId: deletedWsId,
      repair: true,
      db,
    });
    expect(orphanRes.repaired).toBe(0);
  });

  // ── 10. Cross-tenant delete scoping & exact tombstones ───────────────────

  it("scopes workspace/project deletes strictly and records tombstones ONLY for actually-deleted rows", async () => {
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    const dual = new DualAppsMetadataRepository({
      router,
      getDb: () => db,
    });
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: null,
      mode: "dual_write_mongo_read",
    });

    const now = new Date("2026-11-26T10:00:00.000Z");
    const app1 = newDualId().oid;
    const app2 = newDualId().oid;
    const idx1Id = newDualId().oid;
    const idx2Id = newDualId().oid;
    await dual.replaceWorkspaceIndexEntries(
      wsId,
      [],
      [
        {
          id: idx1Id,
          appId: app1,
          path: "apps/a1",
          slug: "a1",
          scope: "workspace",
          treeOid: "t1",
          title: "A1",
          hasManifestId: true,
          schedules: [],
          indexedSha: "a".repeat(40),
        },
      ],
    );
    await dual.replaceWorkspaceIndexEntries(
      ws2Id,
      [],
      [
        {
          id: idx2Id,
          appId: app2,
          path: "apps/a2",
          slug: "a2",
          scope: "workspace",
          treeOid: "t2",
          title: "A2",
          hasManifestId: true,
          schedules: [],
          indexedSha: "b".repeat(40),
        },
      ],
    );

    // Passing ws2's index ID while replacing ws1 MUST NOT delete ws2's row or tombstone it!
    await dual.replaceWorkspaceIndexEntries(wsId, [idx2Id, idx1Id], []);
    expect(await dual.mongo.listIndexEntriesByWorkspace(ws2Id)).toHaveLength(1);
    expect(await dual.pg.listIndexEntriesByWorkspace(ws2Id)).toHaveLength(1);
    const idxTombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    ).filter(t => t.tableName === "app_index");
    expect(idxTombstones.map(t => t.entityId)).toEqual([
      objectIdToUuid(idx1Id),
    ]);

    // deleteEmbeddingsByAppIds records tombstones
    const embId = newDualId().oid;
    await dual.upsertEmbeddingsBatch(
      wsId,
      [
        {
          id: embId,
          appId: app1,
          path: "apps/a1",
          treeOid: "t1",
          docHash: "dh1",
          embeddingModel: "text-embedding-3-small",
          vector: makeVector(2, 1536),
        },
      ],
      [],
    );
    await dual.deleteEmbeddingsByAppIds(wsId, [app1]);
    const embTombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    ).filter(t => t.tableName === "app_embeddings");
    expect(embTombstones.map(t => t.entityId)).toEqual([objectIdToUuid(embId)]);

    // Cross-project deleteDraftsByIds & missing tombstones on deleteDraftFailures / deleteDraftBuildByKey
    const d1 = await dual.createDraftBuild(
      {
        projectId: app1,
        hash: "h1",
        name: "b1",
        key: "k1.parquet",
        builtAt: now,
        rowCount: 1,
        byteSize: 10,
        expiresAt: new Date(now.getTime() + 600_000),
      },
      wsId,
    );
    const d2 = await dual.createDraftBuild(
      {
        projectId: app2,
        hash: "h2",
        name: "b2",
        key: "k2.parquet",
        builtAt: now,
        rowCount: 1,
        byteSize: 10,
        expiresAt: new Date(now.getTime() + 600_000),
      },
      ws2Id,
    );
    await dual.deleteDraftsByIds(app1, [d2.id, d1.id], wsId);
    expect(
      await dual.mongo.findActiveDraftBuild(app2, "h2", now),
    ).not.toBeNull();
    expect(await dual.pg.findActiveDraftBuild(app2, "h2", now)).not.toBeNull();

    const failId = newDualId().oid;
    await dual.upsertDraftFailure(
      {
        id: failId,
        projectId: app1,
        hash: "hf",
        name: "b1",
        failures: 1,
        until: new Date(now.getTime() + 60_000),
        error: "err",
        expiresAt: new Date(now.getTime() + 600_000),
      },
      wsId,
    );
    await dual.deleteDraftFailures(app1, "hf", wsId);
    await dual.deleteDraftBuildByKey(app2, "k2.parquet", ws2Id);

    const draftTombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    )
      .filter(t => t.tableName === "app_binding_drafts")
      .map(t => t.entityId)
      .sort();
    expect(draftTombstones).toEqual(
      [
        objectIdToUuid(d1.id),
        objectIdToUuid(failId),
        objectIdToUuid(d2.id),
      ].sort(),
    );

    // Cross-project deleteBindingJobsByIds
    const j1 = await dual.createBindingJob({
      workspaceId: wsId,
      projectId: app1,
      name: "b1",
      actorId: user1Uuid,
      canWrite: false,
      request: {},
      expiresAt: new Date(now.getTime() + 600_000),
    });
    const j2 = await dual.createBindingJob({
      workspaceId: ws2Id,
      projectId: app2,
      name: "b2",
      actorId: user1Uuid,
      canWrite: false,
      request: {},
      expiresAt: new Date(now.getTime() + 600_000),
    });
    await dual.deleteBindingJobsByIds(app1, [j2.id, j1.id], wsId);
    expect(await dual.mongo.findBindingJobById(j2.id, app2)).not.toBeNull();
    expect(await dual.pg.findBindingJobById(j2.id, app2)).not.toBeNull();
    const jobTombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    ).filter(t => t.tableName === "app_binding_jobs");
    expect(jobTombstones.map(t => t.entityId)).toEqual([objectIdToUuid(j1.id)]);
  });

  // ── 11. PR #1557 review hardening regressions ──────────────────────────────

  it("blocks cross-workspace app_index overwrite with 23505 (PR #1557 #4717230459)", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
    const sharedAppId = newDualId().oid;

    await pgRepo.replaceWorkspaceIndexEntries(
      wsId,
      [],
      [
        {
          appId: sharedAppId,
          path: "apps/ws1-owned",
          slug: "ws1-owned",
          scope: "workspace",
          ownerId: user1Uuid,
          treeOid: "tree-ws1",
          title: "WS1 Owned App",
          hasManifestId: true,
          schedules: [],
          indexedSha: "1".repeat(40),
        },
      ],
    );

    let thrown: (Error & { code?: string }) | null = null;
    try {
      await pgRepo.replaceWorkspaceIndexEntries(
        ws2Id,
        [],
        [
          {
            appId: sharedAppId,
            path: "apps/ws2-hijack",
            slug: "ws2-hijack",
            scope: "workspace",
            ownerId: user2Uuid,
            treeOid: "tree-ws2",
            title: "Hijacked Title",
            hasManifestId: true,
            schedules: [],
            indexedSha: "2".repeat(40),
          },
        ],
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("23505");

    const ws1Row = await pgRepo.findIndexEntryByAppId(sharedAppId);
    expect(ws1Row?.workspaceId).toBe(wsId);
    expect(ws1Row?.title).toBe("WS1 Owned App");
    expect(ws1Row?.path).toBe("apps/ws1-owned");
    expect(ws1Row?.indexedSha).toBe("1".repeat(40));
  });

  it("refreshes updated_at on ensureWorktreeRow conflict so warm-boot sees active sandboxes (PR #1557 #4717231215)", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
    const initial = await pgRepo.ensureWorktreeRow(wsId, user1Uuid, "main");
    const staleAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await db
      .update(pgSchema.appWorktrees)
      .set({ updatedAt: staleAt })
      .where(eq(pgSchema.appWorktrees.id, objectIdToUuid(initial.id)));

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(await pgRepo.listHotWorktreeWorkspacesSince(cutoff)).toEqual([]);

    const touched = await pgRepo.ensureWorktreeRow(
      wsId,
      user1Uuid,
      "ignored-branch",
    );
    expect(touched.branch).toBe("main");
    expect(touched.updatedAt.getTime()).toBeGreaterThan(staleAt.getTime());
    const hot = await pgRepo.listHotWorktreeWorkspacesSince(cutoff);
    expect(hot.map(h => h.workspaceId)).toEqual([wsId]);
  });

  it("applies targeted sharing patches on compat save() so concurrent edits never clobber (PR #1557 #4717291676)", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
    const now = new Date("2026-11-26T10:00:00.000Z");
    const created = await pgRepo.createProject({
      workspaceId: wsId,
      title: "Concurrent Sharing App",
      slug: "concurrent-sharing",
      path: "apps/concurrent-sharing",
      access: "workspace",
      workspaceRole: "viewer",
      owner_id: user1Uuid,
      createdBy: user1Uuid,
      chatEnabled: false,
      publicShare: {
        enabled: true,
        token: "active-public-link",
        createdAt: now,
        createdBy: user1Uuid,
        allowLiveQueries: false,
      },
    });

    const wrap = (rec: typeof created) =>
      toAppProjectCompat(rec, async (doc, modifiedPaths) => {
        const patch = buildProjectSharingPatch(doc, modifiedPaths);
        if (Object.keys(patch).length === 0) return;
        await pgRepo.updateProjectSharing(
          doc.workspaceId.toString(),
          doc._id.toString(),
          patch,
        );
      });

    // Load two concurrent snapshots of the same row at request start
    const snapshotA = wrap(created);
    const snapshotB = wrap(created);

    // Request A revokes public share
    snapshotA.publicShare = undefined;
    snapshotA.markModified("publicShare");
    await snapshotA.save();

    // Request B (with stale publicShare still enabled in memory) toggles chat
    snapshotB.chatEnabled = true;
    await snapshotB.save();

    const afterChat = await pgRepo.findProjectById(created.id, wsId);
    expect(afterChat?.chatEnabled).toBe(true);
    expect(afterChat?.publicShare?.enabled).not.toBe(true);
    expect(afterChat?.publicShare?.token).toBeUndefined();

    // Concurrent access = private (C) vs add collaborator (D)
    const fresh = await pgRepo.findProjectById(created.id, wsId);
    if (!fresh) throw new Error("Expected project after chat toggle");
    const snapshotC = wrap(fresh);
    const snapshotD = wrap(fresh);

    snapshotC.access = "private";
    await snapshotC.save();

    snapshotD.sharedWith = [
      {
        userId: user2Uuid,
        role: "editor",
        addedAt: now,
        addedBy: user1Uuid,
      },
    ];
    await snapshotD.save();

    const afterCollab = await pgRepo.findProjectById(created.id, wsId);
    expect(afterCollab?.access).toBe("private");
    expect(afterCollab?.sharedWith?.map(s => s.userId)).toEqual([user2Uuid]);
  });

  it("preserves raw legacy actor_id on app_binding_jobs while storing PG user_id FK (PR #1557 #4717293835)", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    const dual = new DualAppsMetadataRepository({ router, getDb: () => db });
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_pg_read",
    });

    const projId = newDualId().oid;
    const job = await dual.createBindingJob({
      workspaceId: wsId,
      projectId: projId,
      name: "orders",
      kind: "materialize",
      actorId: "luciaapps000001",
      userId: "luciaapps000001",
      canWrite: true,
      request: {},
      expiresAt: new Date(Date.now() + 600_000),
    });

    // Polling with legacy session ID matches job.actorId verbatim (no 404!)
    const polled = await dual.findBindingJobById(job.id, projId, wsId);
    expect(polled?.actorId).toBe("luciaapps000001");
    expect(polled?.userId).toBe(user1Uuid);

    // Backfill + parity verifier on Mongo-originating binding job passes with 0 mismatches
    await getMongoAppBindingJobModel().deleteMany({});
    await pg.exec(`DELETE FROM app_binding_jobs;`);
    await getMongoAppBindingJobModel().create({
      workspaceId: wsId,
      projectId: projId,
      name: "backfilled-job",
      kind: "dev-build",
      actorId: "luciaapps000001",
      userId: "luciaapps000001",
      canWrite: true,
      request: {},
      status: "queued",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await runBackfill({
      domain: `${APPS_METADATA_DOMAIN}:app_binding_jobs`,
      workspaceId: wsId,
      db,
    });
    const verified = await runParityVerification({
      domain: `${APPS_METADATA_DOMAIN}:app_binding_jobs`,
      workspaceId: wsId,
      db,
    });
    expect(verified.missingInPg).toBe(0);
    expect(verified.mismatched).toBe(0);
  });

  it("rejects unresolved non-sentinel owners instead of silently storing NULL (PR #1557 #4717294515)", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => db });
    const missingUser = "luciaunbackfill";

    // Live runtime writes must throw when owner/createdBy is absent from PG users
    await expect(
      pgRepo.createProject({
        workspaceId: wsId,
        title: "Missing Owner App",
        slug: "missing-owner",
        path: "apps/missing-owner",
        access: "workspace",
        owner_id: missingUser,
        createdBy: missingUser,
      }),
    ).rejects.toThrow(/Unresolved Postgres user/);

    // System sentinels still cleanly resolve to NULL
    const ownerless = await pgRepo.createProject({
      workspaceId: wsId,
      title: "Publish App",
      slug: "publish-app",
      path: "apps/publish-app",
      access: "workspace",
      createdBy: "publish",
    });
    expect(ownerless.owner_id).toBeUndefined();
    expect(ownerless.createdBy).toBe("");

    await expect(
      pgRepo.claimOwnerlessProjectRow(wsId, ownerless.id, missingUser),
    ).rejects.toThrow(/Unresolved Postgres user/);

    await expect(
      pgRepo.updateProjectLocation(wsId, ownerless.id, {
        ownerId: missingUser,
      }),
    ).rejects.toThrow(/Unresolved Postgres user/);

    await expect(
      pgRepo.syncMovedProjects(wsId, [
        {
          appId: ownerless.id,
          path: "users/ghost/apps/publish-app",
          slug: "publish-app",
          title: "Publish App",
          ownerId: missingUser,
        },
      ]),
    ).rejects.toThrow(/Unresolved Postgres user/);

    await expect(
      pgRepo.replaceWorkspaceIndexEntries(
        wsId,
        [],
        [
          {
            appId: ownerless.id,
            path: "users/ghost/apps/publish-app",
            slug: "publish-app",
            scope: "private",
            ownerId: missingUser,
            treeOid: "t-missing",
            title: "Private Missing Owner",
            hasManifestId: true,
            schedules: [],
            indexedSha: "3".repeat(40),
          },
        ],
      ),
    ).rejects.toThrow(/Unresolved Postgres user/);

    // Sync-retry replay also fails while user is absent, then succeeds once user lands in PG
    const mongoProj = await AppProject.create({
      workspaceId: new Types.ObjectId(wsId),
      title: "Retry Owner App",
      slug: "retry-owner",
      path: "apps/retry-owner",
      access: "workspace",
      owner_id: missingUser,
      createdBy: missingUser,
    });
    const retryEvent = {
      target: "pg" as const,
      domain: APPS_METADATA_DOMAIN,
      operation: "createProject",
      workspaceId: wsId,
      entityId: mongoProj._id.toString(),
      payload: {
        table: "app_projects",
        id: mongoProj._id.toString(),
        workspaceId: wsId,
      },
      failedAt: new Date().toISOString(),
      errorMessage: "simulated user lag",
    };
    await expect(replayAppsMetadataWriteToPg(retryEvent, db)).rejects.toThrow(
      /Unresolved Postgres user/,
    );
    expect(
      await pgRepo.findProjectById(mongoProj._id.toString(), wsId),
    ).toBeNull();

    // Once user lands in PG users, replay succeeds with the real owner_id UUID
    const newlyBackfilledUserUuid = generateUuidv7();
    await db.insert(pgSchema.users).values({
      id: newlyBackfilledUserUuid,
      legacyId: missingUser,
      email: "late@example.com",
      emailVerified: true,
    });
    await replayAppsMetadataWriteToPg(retryEvent, db);
    const replayed = await pgRepo.findProjectById(
      mongoProj._id.toString(),
      wsId,
    );
    expect(replayed?.owner_id).toBe(newlyBackfilledUserUuid);
    expect(replayed?.createdBy).toBe(newlyBackfilledUserUuid);
  });

  it("fails closed on transient PG error querying migration_domain_state instead of falling back to Mongo (PR #1557 #4717295467)", async () => {
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
    });
    await router.setDomainState({
      domain: APPS_METADATA_DOMAIN,
      workspaceId: null,
      mode: "dual_write_mongo_read",
    });

    const failingGetDb = () => {
      throw new Error("simulated transient PG connection blip");
    };
    const dual = new DualAppsMetadataRepository({
      router,
      getDb: failingGetDb,
    });

    await expect(dual.findProjectById(newDualId().oid)).rejects.toThrow(
      /simulated transient PG connection blip/,
    );
    await expect(
      dual.findProjectByShareToken("some-share-token"),
    ).rejects.toThrow(/simulated transient PG connection blip/);
    await expect(dual.isShareTokenTaken("some-share-token")).rejects.toThrow(
      /simulated transient PG connection blip/,
    );
    await expect(
      dual.listExistingProjectIds([newDualId().oid]),
    ).rejects.toThrow(/simulated transient PG connection blip/);
  });
});
