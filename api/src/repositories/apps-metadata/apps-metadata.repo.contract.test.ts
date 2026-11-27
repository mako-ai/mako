import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  generateUuidv7,
  isUuidv7,
  newDualId,
} from "../../database/pg/id-codec";
import { setupPgTestDb, type PgTestDb } from "../../test-support/pg-test";
import * as pgSchema from "../../database/pg/schema";
import {
  buildProjectSharingPatch,
  toAppProjectCompat,
  toAppWorktreeCompat,
} from "./mapper";
import { PgAppsMetadataRepository } from "./pg.repo";
import type { AppsMetadataRepository } from "./types";

function makeVector(seed: number, dims = 1536): number[] {
  const vec = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Number((((i + seed) % 19) * 0.01).toFixed(4));
  }
  return vec;
}

describe("PostgreSQL AppsMetadataRepository", () => {
  let h: PgTestDb;

  let wsId: string;
  let wsUuid: string;
  let ws2Id: string;
  let ws2Uuid: string;
  let user1Uuid: string;
  let user2Uuid: string;

  beforeAll(async () => {
    h = await setupPgTestDb();
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

    await h.db.insert(pgSchema.users).values([
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

    await h.db.insert(pgSchema.workspaces).values([
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

  beforeEach(async () => {
    await h.reset();
    await seedBaseFixtures();
  });

  afterAll(async () => {
    await h.close();
  });

  const repo: AppsMetadataRepository = new PgAppsMetadataRepository({
    getDb: () => h.db,
  });

  it("covers app_projects CRUD, sharing, opaque secrets, deploy progress, publishedSha CAS, and errors", async () => {
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
          userId: "luciaapps000002",
          role: "editor",
          addedAt: now,
          addedBy: "luciaapps000001",
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
    expect(byToken?.publicShare?.passwordHash).toBe("$2b$10$opaqueBcryptHash");
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
    expect(await repo.isShareTokenTaken("sales-share-token", created.id)).toBe(
      false,
    );

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
      (await repo.findProjectById(created.id, wsId))?.deployProgress?.bindings
        ?.prepared,
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
    const pub2 = await repo.setPublishedSha(wsId, created.id, sha2, now, sha1);
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
    expect((await repo.findProjectByPath(wsId, "apps/finance/sales"))?.id).toBe(
      created.id,
    );
    expect(
      await repo.listForeignProjectIds(ws2Id, [created.id, ownerless.id]),
    ).toHaveLength(2);

    await repo.deleteProject(wsId, ownerless.id);
    expect(await repo.findProjectById(ownerless.id, wsId)).toBeNull();
  });

  it("covers app_index, app_index_heads, app_embeddings (1536-d pgvector), app_lifecycle, and commit status CAS", async () => {
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
    expect(await repo.listDistinctWorkspaceIdsWithThumbnails()).toEqual([wsId]);
    expect(await repo.listForeignIndexAppIds(ws2Id, [app1])).toEqual([app1]);

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
    ).toEqual([{ archivedTo: "archive/apps/rev", archivedFrom: "apps/rev" }]);

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
    expect(afterActivity.lastActivityAt?.toISOString()).toBe(now.toISOString());

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
    expect((await repo.findActiveDraftBuild(projId, "h1", now, wsId))?.id).toBe(
      draft.id,
    );
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
    expect((await repo.findDraftFailure(projId, "h2", wsId))?.failures).toBe(2);
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
      (await repo.findBindingJobById(job.id, projId, wsId))?.progress?.phase,
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

  it("cascades personal app_worktrees on DELETE FROM users while keeping system actors intact", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => h.db });
    await pgRepo.ensureWorktreeRow(wsId, user2Uuid, "main");
    await pgRepo.ensureWorktreeRow(wsId, "publish", "main");

    await h.db.delete(pgSchema.users).where(eq(pgSchema.users.id, user2Uuid));

    expect(await pgRepo.findWorktree(wsId, user2Uuid)).toBeNull();
    expect(await pgRepo.findWorktree(wsId, "publish")).not.toBeNull();
  });

  it("blocks cross-workspace app_index overwrite with 23505 (PR #1557 #4717230459)", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => h.db });
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
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => h.db });
    const initial = await pgRepo.ensureWorktreeRow(wsId, user1Uuid, "main");
    expect(isUuidv7(initial.id)).toBe(true);
    const compat = toAppWorktreeCompat(initial);
    expect(String(compat._id)).toBe(initial.id);
    expect(String(compat.workspaceId)).toBe(wsId);
    const staleAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await h.db
      .update(pgSchema.appWorktrees)
      .set({ updatedAt: staleAt })
      .where(eq(pgSchema.appWorktrees.id, initial.id));

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
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => h.db });
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
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => h.db });
    const projId = newDualId().oid;
    const job = await pgRepo.createBindingJob({
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
    const polled = await pgRepo.findBindingJobById(job.id, projId, wsId);
    expect(polled?.actorId).toBe("luciaapps000001");
    expect(polled?.userId).toBe(user1Uuid);
  });

  it("rejects unresolved non-sentinel owners instead of silently storing NULL (PR #1557 #4717294515)", async () => {
    const pgRepo = new PgAppsMetadataRepository({ getDb: () => h.db });
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
  });
});
