/**
 * Postgres (Neon / Drizzle) implementation of `AppsMetadataRepository`.
 *
 * Highlights:
 *   - Atomic SQL `claimPublicBindingRefresh` (single `INSERT ... ON CONFLICT DO UPDATE WHERE` CAS — zero race!).
 *   - Atomic SQL `casResolvePendingCommitStatus` (`UPDATE ... WHERE state = 'pending' RETURNING id`).
 *   - Atomic SQL `recordBindingRun` capping `history` to newest 20 entries in one statement.
 *   - Atomic SQL `recordWorktreePause` capping `idle_paused_at` to latest 5 timestamps without bumping `updated_at`.
 *   - `app_projects.shared_with[].{userId, addedBy}` rewritten via `authRepo.resolveUserUuid()` (or PG `users` table).
 *   - `app_worktrees` maps real users to `(actor_id = uuid, user_id = uuid)` (`ON DELETE CASCADE`)
 *     and system actors (`"publish"`, `"api-key"`) to `(actor_id = raw, user_id = NULL)`.
 *   - Encrypted `app_projects.env` and `public_share_password_encrypted` + bcrypt `public_share_password_hash`
 *     are persisted verbatim as opaque strings.
 */
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isUuidString,
  newDualId,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  appBindingDrafts,
  appBindingJobs,
  appBindingState,
  appDeployCommitStatuses,
  appEmbeddings,
  appIndex,
  appIndexHeads,
  appLifecycle,
  appProjects,
  appWorktrees,
  type AppIndexScheduleJson,
} from "../../database/pg/schema/apps-metadata";
import type { IAppDeployProgress } from "../../database/workspace-schema";
import {
  buildExcludedSet,
  chunkRows,
  dedupByKey,
  prefetchPgUserUuidMap,
} from "../../database/pg/bulk-helpers";
import {
  deserializeBindingRun,
  entityIdToPgUuid,
  optionalEntityIdToPgUuid,
  pgAppBindingDraftToRecord,
  pgAppBindingJobToRecord,
  pgAppBindingStateToRecord,
  pgAppDeployCommitStatusToRecord,
  pgAppEmbeddingToRecord,
  pgAppIndexEntryToRecord,
  pgAppIndexHeadToRecord,
  pgAppLifecycleToRecord,
  pgAppProjectToRecord,
  pgAppWorktreeToRecord,
  serializeBindingRefreshErrors,
  serializeBindingRun,
  serializeDeployProgress,
  serializeJobProgress,
  serializeLastDeployError,
  serializeShareEntries,
} from "./mapper";
import type {
  AppAccessScope,
  AppBindingDraftRecord,
  AppBindingJobProgressRecord,
  AppBindingJobRecord,
  AppBindingRefreshErrorRecord,
  AppBindingRunRecord,
  AppBindingStateRecord,
  AppDeployCommitStatePg,
  AppDeployStage,
  AppEmbeddingMeta,
  AppEmbeddingPathUpdate,
  AppEmbeddingVectorEntry,
  AppEnvVarJson,
  AppIndexEntryRecord,
  AppIndexHeadRecord,
  AppLastDeployErrorRecord,
  AppLifecyclePatch,
  AppLifecycleRecord,
  AppProjectRecord,
  AppWorktreeRecord,
  AppsMetadataRepository,
  BindingStateSummaryRecord,
  ClaimPublicBindingRefreshResult,
  CreateAppProjectInput,
  CreateBindingDraftBuildInput,
  CreateBindingJobInput,
  HotWorktreeWorkspaceRecord,
  MarkBindingJobUpdate,
  ProjectMoveSyncUpdate,
  UpdateAppProjectLocationPatch,
  UpdateAppProjectSharingPatch,
  UpsertAppEmbeddingInput,
  UpsertAppIndexEntryInput,
  UpsertBindingDraftFailureInput,
} from "./types";

const SYSTEM_ACTORS = new Set([
  "",
  "publish",
  "api-key",
  "scheduler",
  "system",
  "worker",
  "app-chat",
]);

export class PgAppsMetadataRepository implements AppsMetadataRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  /**
   * Resolve a raw user ID (UUIDv7 or legacy Lucia/UUIDv4) to a valid `users.id` UUID in PG.
   * Returns `null` for empty strings, system actors (`"publish"`, `"api-key"`), or missing users.
   */
  async resolveNullableUserUuid(
    rawUserId: string | null | undefined,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    if (!rawUserId) return null;
    const trimmed = rawUserId.trim();
    if (!trimmed || SYSTEM_ACTORS.has(trimmed)) return null;
    const whereClause = isUuidString(trimmed)
      ? or(eq(users.id, trimmed.toLowerCase()), eq(users.legacyId, trimmed))
      : eq(users.legacyId, trimmed);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(whereClause)
      .limit(1);
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  /**
   * Resolve an ownership/creator user ID (`owner_id`, `created_by`, `app_index.owner_id`)
   * strictly on live runtime writes: returns `null` ONLY for empty/null/undefined or
   * known system sentinels. For any non-sentinel user ID missing from PG `users` (e.g.
   * `auth` dual-write lag), throws so `MigrationRouter` records a secondary failure and
   * enqueues `migration/pg-sync-retry` instead of silently storing `NULL` (which would
   * make the app ownerless/claimable or hide a private app from its owner).
   */
  async resolveStrictOwnerUserUuid(
    rawUserId: string | null | undefined,
    fieldName: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    if (!rawUserId) return null;
    const trimmed = rawUserId.trim();
    if (!trimmed || SYSTEM_ACTORS.has(trimmed)) return null;
    const resolved = await this.resolveNullableUserUuid(trimmed, db);
    if (!resolved) {
      throw new Error(
        `Unresolved Postgres user for ${fieldName}: ${JSON.stringify(trimmed)} not found in users table`,
      );
    }
    return resolved;
  }

  /**
   * Resolve a worktree actor into `(actorId, userId)` for `app_worktrees`:
   *   - Real user present in `users` -> `{ actorId: uuid, userId: uuid }` (cascades on user delete)
   *   - System actor (`"publish"`, `"api-key"`) or unresolvable legacy id -> `{ actorId: raw, userId: null }`
   */
  async resolveWorktreeActor(
    rawActorId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{ actorId: string; userId: string | null }> {
    const resolved = await this.resolveNullableUserUuid(rawActorId, db);
    if (resolved) {
      return { actorId: resolved, userId: resolved };
    }
    return { actorId: rawActorId, userId: null };
  }

  /**
   * Rewrite `sharedWith[].{userId, addedBy}` via the Postgres `users` table only
   * (never touches Mongo, matching offline verifier `resolvePgUserMap(db, ...)`).
   */
  private async rewriteSharedWith(
    entries: AppProjectRecord["sharedWith"],
    db: MakoPgDb,
  ) {
    if (entries === undefined) return undefined;
    const ids = new Set<string>();
    for (const e of entries) {
      if (e.userId) ids.add(e.userId);
      if (e.addedBy) ids.add(e.addedBy);
    }
    const resolvedMap = new Map<string, string>();
    for (const raw of ids) {
      const pgUuid = await this.resolveNullableUserUuid(raw, db);
      if (pgUuid) resolvedMap.set(raw, pgUuid);
    }
    return serializeShareEntries(entries, raw => resolvedMap.get(raw) ?? raw);
  }

  /** Indexed PK helper for workspace-less canary routing. */
  async findProjectWorkspaceId(
    projectId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const parsed = parseEntityId(projectId);
    if (!parsed) return null;
    const rows = await db
      .select({ workspaceId: appProjects.workspaceId })
      .from(appProjects)
      .where(eq(appProjects.id, parsed.uuid))
      .limit(1);
    return rows[0] ? toWireId(rows[0].workspaceId) : null;
  }

  /** Indexed PK helper for workspace-less canary routing on binding jobs. */
  async findBindingJobWorkspaceId(
    jobId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const parsed = parseEntityId(jobId);
    if (!parsed) return null;
    const rows = await db
      .select({ workspaceId: appBindingJobs.workspaceId })
      .from(appBindingJobs)
      .where(eq(appBindingJobs.id, parsed.uuid))
      .limit(1);
    return rows[0] ? toWireId(rows[0].workspaceId) : null;
  }

  async findShareTokenOwnerWorkspaceId(
    token: string,
    excludeId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const conditions = [eq(appProjects.publicShareToken, token)];
    const parsedExclude = excludeId ? parseEntityId(excludeId) : null;
    if (parsedExclude) {
      conditions.push(ne(appProjects.id, parsedExclude.uuid));
    }
    const rows = await db
      .select({ workspaceId: appProjects.workspaceId })
      .from(appProjects)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? toWireId(rows[0].workspaceId) : null;
  }

  async listExistingProjectIdWorkspaces(
    ids: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    const uuids = ids
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const rows = await db
      .select({ id: appProjects.id, workspaceId: appProjects.workspaceId })
      .from(appProjects)
      .where(inArray(appProjects.id, uuids));
    return rows.map(r => ({
      id: toWireId(r.id),
      workspaceId: toWireId(r.workspaceId),
    }));
  }

  async listPausedScheduleEntries(
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ workspaceId: string; appId: string }>> {
    const rows = await db
      .select({
        workspaceId: appLifecycle.workspaceId,
        appId: appLifecycle.appId,
      })
      .from(appLifecycle)
      .where(isNotNull(appLifecycle.schedulesPausedAt));
    return rows.map(r => ({
      workspaceId: toWireId(r.workspaceId),
      appId: toWireId(r.appId),
    }));
  }

  // ── 1. app_projects ──────────────────────────────────────────────────────

  async findProjectById(
    id: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord | null> {
    const parsed = parseEntityId(id);
    if (!parsed) return null;
    const conditions = [eq(appProjects.id, parsed.uuid)];
    if (workspaceId) {
      const wsParsed = parseEntityId(workspaceId);
      if (!wsParsed) return null;
      conditions.push(eq(appProjects.workspaceId, wsParsed.uuid));
    }
    const rows = await db
      .select()
      .from(appProjects)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? pgAppProjectToRecord(rows[0]) : null;
  }

  async findProjectByPath(
    workspaceId: string,
    path: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord | null> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select()
      .from(appProjects)
      .where(
        and(eq(appProjects.workspaceId, wsUuid), eq(appProjects.path, path)),
      )
      .limit(1);
    return rows[0] ? pgAppProjectToRecord(rows[0]) : null;
  }

  async findProjectBySlug(
    workspaceId: string,
    slug: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord | null> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select()
      .from(appProjects)
      .where(
        and(eq(appProjects.workspaceId, wsUuid), eq(appProjects.slug, slug)),
      )
      .limit(1);
    return rows[0] ? pgAppProjectToRecord(rows[0]) : null;
  }

  async findProjectByShareToken(
    token: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord | null> {
    const rows = await db
      .select()
      .from(appProjects)
      .where(
        and(
          eq(appProjects.publicShareToken, token),
          eq(appProjects.publicShareEnabled, true),
        ),
      )
      .limit(1);
    return rows[0] ? pgAppProjectToRecord(rows[0]) : null;
  }

  async isShareTokenTaken(
    token: string,
    excludeId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const conditions = [eq(appProjects.publicShareToken, token)];
    if (excludeId) {
      const parsed = parseEntityId(excludeId);
      if (parsed) conditions.push(ne(appProjects.id, parsed.uuid));
    }
    const rows = await db
      .select({ id: appProjects.id })
      .from(appProjects)
      .where(and(...conditions))
      .limit(1);
    return rows.length > 0;
  }

  async projectExistsMatching(
    params: { id: string; workspaceId: string; path: string; slug: string },
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = entityIdToPgUuid(params.id);
    const wsUuid = entityIdToPgUuid(params.workspaceId);
    const rows = await db
      .select({ id: appProjects.id })
      .from(appProjects)
      .where(
        or(
          eq(appProjects.id, idUuid),
          and(
            eq(appProjects.workspaceId, wsUuid),
            eq(appProjects.path, params.path),
          ),
          and(
            eq(appProjects.workspaceId, wsUuid),
            eq(appProjects.slug, params.slug),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listProjectsByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select()
      .from(appProjects)
      .where(eq(appProjects.workspaceId, wsUuid));
    return rows.map(pgAppProjectToRecord);
  }

  async listProjectsByIds(
    workspaceId: string,
    ids: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord[]> {
    const uuids = ids
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select()
      .from(appProjects)
      .where(
        and(
          eq(appProjects.workspaceId, wsUuid),
          inArray(appProjects.id, uuids),
        ),
      );
    return rows.map(pgAppProjectToRecord);
  }

  async listForeignProjectIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const uuids = candidateIds
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const wsUuid = entityIdToPgUuid(excludeWorkspaceId);
    const rows = await db
      .select({ id: appProjects.id })
      .from(appProjects)
      .where(
        and(
          ne(appProjects.workspaceId, wsUuid),
          inArray(appProjects.id, uuids),
        ),
      );
    return rows.map(r => toWireId(r.id));
  }

  async listExistingProjectIds(
    ids: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const uuids = ids
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const rows = await db
      .select({ id: appProjects.id })
      .from(appProjects)
      .where(inArray(appProjects.id, uuids));
    return rows.map(r => toWireId(r.id));
  }

  async listDistinctProjectWorkspaceIds(
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const rows = await db
      .selectDistinct({ workspaceId: appProjects.workspaceId })
      .from(appProjects);
    return rows.map(r => toWireId(r.workspaceId));
  }

  async listPublishedProjects(
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord[]> {
    const rows = await db
      .select()
      .from(appProjects)
      .where(isNotNull(appProjects.publishedSha));
    return rows.map(pgAppProjectToRecord);
  }

  async listOwnerlessProjects(
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord[]> {
    const conditions = [
      isNull(appProjects.ownerId),
      isNull(appProjects.createdBy),
    ];
    if (workspaceId) {
      conditions.push(
        eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
      );
    }
    const rows = await db
      .select()
      .from(appProjects)
      .where(and(...conditions));
    return rows.map(pgAppProjectToRecord);
  }

  async createProject(
    input: CreateAppProjectInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppProjectRecord> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const [ownerUuid, createdByUuid, shareCreatedByUuid, sharedWithJson] =
      await Promise.all([
        this.resolveStrictOwnerUserUuid(
          input.owner_id,
          "app_projects.owner_id",
          db,
        ),
        this.resolveStrictOwnerUserUuid(
          input.createdBy,
          "app_projects.created_by",
          db,
        ),
        this.resolveNullableUserUuid(input.publicShare?.createdBy, db),
        this.rewriteSharedWith(input.sharedWith, db),
      ]);
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;

    const rows = await db
      .insert(appProjects)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        title: input.title,
        slug: input.slug ?? null,
        path: input.path ?? null,
        description: input.description ?? null,
        access: input.access ?? "private",
        workspaceRole: input.workspaceRole ?? null,
        sharedWith: sharedWithJson ?? null,
        ownerId: ownerUuid,
        createdBy: createdByUuid,
        defaultBranch: input.defaultBranch ?? "main",
        cloudRepoOwner: input.cloudRepo?.owner ?? null,
        cloudRepoName: input.cloudRepo?.repo ?? null,
        publishedSha: input.publishedSha ?? null,
        chatEnabled: input.chatEnabled ?? null,
        publishedAt: input.publishedAt ?? null,
        lastDeployError: serializeLastDeployError(input.lastDeployError),
        bindingRefreshErrors: serializeBindingRefreshErrors(
          input.bindingRefreshErrors,
        ),
        deployProgress: serializeDeployProgress(input.deployProgress),
        publicShareEnabled: input.publicShare?.enabled ?? false,
        publicShareToken: input.publicShare?.token ?? null,
        publicSharePasswordHash: input.publicShare?.passwordHash ?? null,
        publicSharePasswordEncrypted:
          input.publicShare?.passwordEncrypted ?? null,
        publicShareCreatedAt: input.publicShare?.createdAt ?? null,
        publicShareCreatedBy: shareCreatedByUuid,
        publicShareAllowLiveQueries:
          input.publicShare?.allowLiveQueries ?? false,
        env: input.env ?? null,
        createdAt: now,
        updatedAt,
      })
      .returning();
    return pgAppProjectToRecord(rows[0]);
  }

  /** Idempotent backfill upsert guarded by `updated_at`. */
  async upsertProjectWithGuard(
    record: AppProjectRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = entityIdToPgUuid(record.id);
    const wsUuid = entityIdToPgUuid(record.workspaceId);
    const [ownerUuid, createdByUuid, shareCreatedByUuid, sharedWithJson] =
      await Promise.all([
        this.resolveNullableUserUuid(record.owner_id, db),
        this.resolveNullableUserUuid(record.createdBy, db),
        this.resolveNullableUserUuid(record.publicShare?.createdBy, db),
        this.rewriteSharedWith(record.sharedWith, db),
      ]);

    const values = {
      id: idUuid,
      workspaceId: wsUuid,
      title: record.title,
      slug: record.slug ?? null,
      path: record.path ?? null,
      description: record.description ?? null,
      access: record.access,
      workspaceRole: record.workspaceRole ?? null,
      sharedWith: sharedWithJson ?? null,
      ownerId: ownerUuid,
      createdBy: createdByUuid,
      defaultBranch: record.defaultBranch,
      cloudRepoOwner: record.cloudRepo?.owner ?? null,
      cloudRepoName: record.cloudRepo?.repo ?? null,
      publishedSha: record.publishedSha ?? null,
      chatEnabled: record.chatEnabled ?? null,
      publishedAt: record.publishedAt ?? null,
      lastDeployError: serializeLastDeployError(record.lastDeployError),
      bindingRefreshErrors: serializeBindingRefreshErrors(
        record.bindingRefreshErrors,
      ),
      deployProgress: serializeDeployProgress(record.deployProgress),
      publicShareEnabled: record.publicShare?.enabled ?? false,
      publicShareToken: record.publicShare?.token ?? null,
      publicSharePasswordHash: record.publicShare?.passwordHash ?? null,
      publicSharePasswordEncrypted:
        record.publicShare?.passwordEncrypted ?? null,
      publicShareCreatedAt: record.publicShare?.createdAt ?? null,
      publicShareCreatedBy: shareCreatedByUuid,
      publicShareAllowLiveQueries:
        record.publicShare?.allowLiveQueries ?? false,
      env: record.env ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };

    const rows = await db
      .insert(appProjects)
      .values(values)
      .onConflictDoUpdate({
        target: appProjects.id,
        set: values,
        setWhere: sql`${appProjects.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appProjects.updatedAt}`,
      })
      .returning({ id: appProjects.id });
    return rows.length > 0;
  }

  async claimOwnerlessProjectRow(
    workspaceId: string,
    id: string,
    ownerId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const ownerUuid = await this.resolveStrictOwnerUserUuid(
      ownerId,
      "app_projects.owner_id",
      db,
    );
    if (!ownerUuid) return false;
    const rows = await db
      .update(appProjects)
      .set({
        ownerId: ownerUuid,
        createdBy: ownerUuid,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
          isNull(appProjects.ownerId),
          isNull(appProjects.createdBy),
        ),
      )
      .returning({ id: appProjects.id });
    return rows.length > 0;
  }

  async updateProjectSharing(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectSharingPatch,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.access !== undefined) set.access = patch.access;
    if (patch.workspaceRole !== undefined) {
      set.workspaceRole = patch.workspaceRole;
    }
    if (patch.sharedWith !== undefined) {
      set.sharedWith = await this.rewriteSharedWith(patch.sharedWith, db);
    }
    if (patch.chatEnabled !== undefined) set.chatEnabled = patch.chatEnabled;
    if (patch.publicShare === null) {
      set.publicShareEnabled = false;
      set.publicShareToken = null;
      set.publicSharePasswordHash = null;
      set.publicSharePasswordEncrypted = null;
      set.publicShareCreatedAt = null;
      set.publicShareCreatedBy = null;
      set.publicShareAllowLiveQueries = false;
    } else if (patch.publicShare !== undefined) {
      set.publicShareEnabled = Boolean(patch.publicShare.enabled);
      set.publicShareToken = patch.publicShare.token ?? null;
      set.publicSharePasswordHash = patch.publicShare.passwordHash ?? null;
      set.publicSharePasswordEncrypted =
        patch.publicShare.passwordEncrypted ?? null;
      set.publicShareCreatedAt = patch.publicShare.createdAt ?? null;
      set.publicShareCreatedBy = await this.resolveNullableUserUuid(
        patch.publicShare.createdBy,
        db,
      );
      set.publicShareAllowLiveQueries = Boolean(
        patch.publicShare.allowLiveQueries,
      );
    }
    await db
      .update(appProjects)
      .set(set)
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
        ),
      );
  }

  async updateProjectEnv(
    workspaceId: string,
    id: string,
    env: AppEnvVarJson[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .update(appProjects)
      .set({ env, updatedAt: new Date() })
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
        ),
      );
  }

  async updateProjectLocation(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectLocationPatch,
    expectedPath?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.path !== undefined) set.path = patch.path;
    if (patch.slug !== undefined) set.slug = patch.slug;
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.access !== undefined) set.access = patch.access;
    if (patch.ownerId !== undefined) {
      set.ownerId =
        patch.ownerId === null
          ? null
          : await this.resolveStrictOwnerUserUuid(
              patch.ownerId,
              "app_projects.owner_id",
              db,
            );
    }
    const conditions = [
      eq(appProjects.id, entityIdToPgUuid(id)),
      eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
    ];
    if (expectedPath !== undefined) {
      conditions.push(eq(appProjects.path, expectedPath));
    }
    await db
      .update(appProjects)
      .set(set)
      .where(and(...conditions));
  }

  async unsetProjectsPath(
    workspaceId: string,
    ids: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const uuids = ids
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return;
    await db
      .update(appProjects)
      .set({ path: null, updatedAt: new Date() })
      .where(
        and(
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
          inArray(appProjects.id, uuids),
        ),
      );
  }

  async syncMovedProjects(
    workspaceId: string,
    updates: readonly ProjectMoveSyncUpdate[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const now = new Date();
    for (const u of updates) {
      const set: Record<string, unknown> = {
        path: u.path,
        slug: u.slug,
        title: u.title,
        updatedAt: now,
      };
      if (u.access !== undefined) set.access = u.access;
      if (u.ownerId !== undefined) {
        set.ownerId =
          u.ownerId === null
            ? null
            : await this.resolveStrictOwnerUserUuid(
                u.ownerId,
                "app_projects.owner_id",
                db,
              );
      }
      await db
        .update(appProjects)
        .set(set)
        .where(
          and(
            eq(appProjects.id, entityIdToPgUuid(u.appId)),
            eq(appProjects.workspaceId, wsUuid),
          ),
        );
    }
  }

  async setDeployProgressQueued(
    workspaceId: string,
    id: string,
    progress: IAppDeployProgress,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .update(appProjects)
      .set({
        deployProgress: serializeDeployProgress(progress),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
        ),
      );
  }

  async advanceDeployProgressStage(
    workspaceId: string,
    id: string,
    sha: string,
    stage: AppDeployStage,
    now: Date,
    staleBefore: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = entityIdToPgUuid(id);
    const wsUuid = entityIdToPgUuid(workspaceId);
    const nowIso = now.toISOString();
    const staleIso = staleBefore.toISOString();

    const matched = await db.execute(sql`
      UPDATE "app_projects"
      SET "deploy_progress" = (
            ("deploy_progress" - 'bindings')
            || jsonb_build_object(
                 'stage', ${stage}::text,
                 'stageStartedAt', ${nowIso}::text,
                 'updatedAt', ${nowIso}::text
               )
          ),
          "updated_at" = ${nowIso}::timestamptz
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "deploy_progress"->>'sha' = ${sha}
      RETURNING "id"
    `);
    if (extractRows(matched).length > 0) return;

    const freshPayload = JSON.stringify({
      sha,
      stage,
      startedAt: nowIso,
      stageStartedAt: nowIso,
      updatedAt: nowIso,
    });
    await db.execute(sql`
      UPDATE "app_projects"
      SET "deploy_progress" = ${freshPayload}::jsonb,
          "updated_at" = ${nowIso}::timestamptz
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND (
          "deploy_progress" IS NULL
          OR ("deploy_progress"->>'updatedAt')::timestamptz < ${staleIso}::timestamptz
        )
    `);
  }

  async updateDeployProgressBindings(
    workspaceId: string,
    id: string,
    sha: string,
    bindings: NonNullable<IAppDeployProgress["bindings"]>,
    now: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = entityIdToPgUuid(id);
    const wsUuid = entityIdToPgUuid(workspaceId);
    const nowIso = now.toISOString();
    const bindingsJson = JSON.stringify(bindings);
    await db.execute(sql`
      UPDATE "app_projects"
      SET "deploy_progress" = "deploy_progress"
            || jsonb_build_object(
                 'bindings', ${bindingsJson}::jsonb,
                 'updatedAt', ${nowIso}::text
               ),
          "updated_at" = ${nowIso}::timestamptz
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "deploy_progress"->>'sha' = ${sha}
    `);
  }

  async clearDeployProgress(
    workspaceId: string,
    id: string,
    sha: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = entityIdToPgUuid(id);
    const wsUuid = entityIdToPgUuid(workspaceId);
    await db.execute(sql`
      UPDATE "app_projects"
      SET "deploy_progress" = NULL,
          "updated_at" = now()
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "deploy_progress"->>'sha' = ${sha}
    `);
  }

  async setPublishedSha(
    workspaceId: string,
    id: string,
    sha: string,
    publishedAt: Date,
    expectedSha?: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<{ matched: boolean }> {
    const conditions = [
      eq(appProjects.id, entityIdToPgUuid(id)),
      eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
    ];
    if (expectedSha === null) {
      conditions.push(isNull(appProjects.publishedSha));
    } else if (expectedSha !== undefined) {
      conditions.push(eq(appProjects.publishedSha, expectedSha));
    }
    const rows = await db
      .update(appProjects)
      .set({ publishedSha: sha, publishedAt, updatedAt: new Date() })
      .where(and(...conditions))
      .returning({ id: appProjects.id });
    return { matched: rows.length > 0 };
  }

  async clearPublishedSha(
    workspaceId: string,
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .update(appProjects)
      .set({
        publishedSha: null,
        publishedAt: null,
        lastDeployError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
        ),
      );
  }

  async setLastDeployError(
    workspaceId: string,
    id: string,
    error: AppLastDeployErrorRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .update(appProjects)
      .set({
        lastDeployError: serializeLastDeployError(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
        ),
      );
  }

  async clearLastDeployErrorIfSha(
    workspaceId: string,
    id: string,
    failedSha: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = entityIdToPgUuid(id);
    const wsUuid = entityIdToPgUuid(workspaceId);
    await db.execute(sql`
      UPDATE "app_projects"
      SET "last_deploy_error" = NULL,
          "updated_at" = now()
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "last_deploy_error"->>'sha' = ${failedSha}
    `);
  }

  async setBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
    error: AppBindingRefreshErrorRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = entityIdToPgUuid(id);
    const wsUuid = entityIdToPgUuid(workspaceId);
    const entryJson = JSON.stringify({
      sha: error.sha,
      message: error.message,
      attempts: error.attempts,
      at: error.at.toISOString(),
    });
    await db.execute(sql`
      UPDATE "app_projects"
      SET "binding_refresh_errors" = jsonb_set(
            COALESCE("binding_refresh_errors", '{}'::jsonb),
            ARRAY[${binding}::text],
            ${entryJson}::jsonb,
            true
          ),
          "updated_at" = now()
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
    `);
  }

  async clearBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = entityIdToPgUuid(id);
    const wsUuid = entityIdToPgUuid(workspaceId);
    await db.execute(sql`
      UPDATE "app_projects"
      SET "binding_refresh_errors" = CASE
            WHEN ("binding_refresh_errors" - ${binding}::text) = '{}'::jsonb THEN NULL
            ELSE ("binding_refresh_errors" - ${binding}::text)
          END,
          "updated_at" = now()
      WHERE "id" = ${idUuid}::uuid
        AND "workspace_id" = ${wsUuid}::uuid
        AND "binding_refresh_errors" ? ${binding}::text
    `);
  }

  async deleteProject(
    workspaceId: string,
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .delete(appProjects)
      .where(
        and(
          eq(appProjects.id, entityIdToPgUuid(id)),
          eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)),
        ),
      );
  }

  async deleteProjectsByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<number> {
    const rows = await db
      .delete(appProjects)
      .where(eq(appProjects.workspaceId, entityIdToPgUuid(workspaceId)))
      .returning({ id: appProjects.id });
    return rows.length;
  }

  // ── 2. app_index ─────────────────────────────────────────────────────────

  async listIndexEntriesByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppIndexEntryRecord[]> {
    const rows = await db
      .select()
      .from(appIndex)
      .where(eq(appIndex.workspaceId, entityIdToPgUuid(workspaceId)));
    return rows.map(pgAppIndexEntryToRecord);
  }

  async findIndexEntryByAppId(
    appId: string,
    workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppIndexEntryRecord | null> {
    const parsedApp = parseEntityId(appId);
    if (!parsedApp) return null;
    const conditions = [eq(appIndex.appId, parsedApp.uuid)];
    if (workspaceId) {
      const parsedWs = parseEntityId(workspaceId);
      if (!parsedWs) return null;
      conditions.push(eq(appIndex.workspaceId, parsedWs.uuid));
    }
    const rows = await db
      .select()
      .from(appIndex)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? pgAppIndexEntryToRecord(rows[0]) : null;
  }

  async indexEntryExistsByAppId(
    appId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const parsed = parseEntityId(appId);
    if (!parsed) return false;
    const rows = await db
      .select({ id: appIndex.id })
      .from(appIndex)
      .where(eq(appIndex.appId, parsed.uuid))
      .limit(1);
    return rows.length > 0;
  }

  async listIndexEntriesBySlugAndScope(
    slug: string,
    scope: AppAccessScope,
    limit: number,
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ workspaceId: string; appId: string }>> {
    const rows = await db
      .select({ workspaceId: appIndex.workspaceId, appId: appIndex.appId })
      .from(appIndex)
      .where(and(eq(appIndex.slug, slug), eq(appIndex.scope, scope)))
      .limit(limit);
    return rows.map(r => ({
      workspaceId: toWireId(r.workspaceId),
      appId: toWireId(r.appId),
    }));
  }

  async listIndexEntriesWithSchedules(db: MakoPgDb = this.getDb()): Promise<
    Array<{
      workspaceId: string;
      appId: string;
      schedules: AppIndexScheduleJson[];
    }>
  > {
    const rows = await db
      .select({
        workspaceId: appIndex.workspaceId,
        appId: appIndex.appId,
        schedules: appIndex.schedules,
      })
      .from(appIndex)
      .where(sql`jsonb_array_length(${appIndex.schedules}) > 0`);
    return rows.map(r => ({
      workspaceId: toWireId(r.workspaceId),
      appId: toWireId(r.appId),
      schedules: r.schedules ?? [],
    }));
  }

  async listIndexEntriesByAppIds(
    appIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ workspaceId: string; appId: string; path: string }>> {
    const uuids = appIds
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const rows = await db
      .select({
        workspaceId: appIndex.workspaceId,
        appId: appIndex.appId,
        path: appIndex.path,
      })
      .from(appIndex)
      .where(inArray(appIndex.appId, uuids));
    return rows.map(r => ({
      workspaceId: toWireId(r.workspaceId),
      appId: toWireId(r.appId),
      path: r.path,
    }));
  }

  async listForeignIndexAppIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const uuids = candidateIds
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const wsUuid = entityIdToPgUuid(excludeWorkspaceId);
    const rows = await db
      .select({ appId: appIndex.appId })
      .from(appIndex)
      .where(
        and(ne(appIndex.workspaceId, wsUuid), inArray(appIndex.appId, uuids)),
      );
    return rows.map(r => toWireId(r.appId));
  }

  async listDistinctWorkspaceIdsWithThumbnails(
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const rows = await db
      .selectDistinct({ workspaceId: appIndex.workspaceId })
      .from(appIndex)
      .where(isNotNull(appIndex.thumbnail));
    return rows.map(r => toWireId(r.workspaceId));
  }

  async listDistinctIndexWorkspaceIds(
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const rows = await db
      .selectDistinct({ workspaceId: appIndex.workspaceId })
      .from(appIndex);
    return rows.map(r => toWireId(r.workspaceId));
  }

  async replaceWorkspaceIndexEntries(
    workspaceId: string,
    staleEntryIds: readonly string[],
    entries: readonly UpsertAppIndexEntryInput[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const staleUuids = staleEntryIds
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (staleUuids.length > 0) {
      await db
        .delete(appIndex)
        .where(
          and(
            eq(appIndex.workspaceId, wsUuid),
            inArray(appIndex.id, staleUuids),
          ),
        );
    }
    if (entries.length === 0) return;

    // Batch-resolve all owner user IDs in 1 query while preserving strict
    // ownership resolution semantics (throw on unresolved non-system user).
    const rawOwnerIds: string[] = [];
    for (const row of entries) {
      const trimmed = row.ownerId?.trim();
      if (trimmed && !SYSTEM_ACTORS.has(trimmed)) {
        rawOwnerIds.push(trimmed);
      }
    }
    const ownerMap =
      rawOwnerIds.length > 0
        ? await prefetchPgUserUuidMap(db, rawOwnerIds)
        : new Map<string, string>();

    const now = new Date();
    const preparedRows: Array<typeof appIndex.$inferInsert> = [];
    for (const row of entries) {
      const idUuid = row.id ? entityIdToPgUuid(row.id) : undefined;
      const appUuid = entityIdToPgUuid(row.appId);
      const trimmedOwner = row.ownerId?.trim();
      let ownerUuid: string | null = null;
      if (trimmedOwner && !SYSTEM_ACTORS.has(trimmedOwner)) {
        const resolved =
          ownerMap.get(trimmedOwner) ??
          ownerMap.get(trimmedOwner.toLowerCase());
        if (!resolved) {
          throw new Error(
            `Unresolved Postgres user for app_index.owner_id: ${JSON.stringify(trimmedOwner)} not found in users table`,
          );
        }
        ownerUuid = resolved;
      }
      const dupUuid = optionalEntityIdToPgUuid(row.duplicateOf);
      preparedRows.push({
        ...(idUuid ? { id: idUuid } : {}),
        workspaceId: wsUuid,
        appId: appUuid,
        path: row.path,
        slug: row.slug,
        scope: row.scope,
        ownerId: ownerUuid,
        treeOid: row.treeOid,
        title: row.title,
        description: row.description ?? null,
        hasManifestId: row.hasManifestId,
        duplicateOf: dupUuid,
        schedules: row.schedules,
        tables: row.tables ?? null,
        bindingTables: row.bindingTables ?? [],
        bindings: row.bindings ?? null,
        authorEmail: row.authorEmail ?? null,
        firstCommitAt: row.firstCommitAt ?? null,
        thumbnail: row.thumbnail ?? null,
        icon: row.icon ?? null,
        indexedSha: row.indexedSha,
        createdAt: now,
        updatedAt: now,
      });
    }

    const deduped = dedupByKey(preparedRows, r => r.appId.toLowerCase());
    const setExcluded = buildExcludedSet(appIndex, [
      "id",
      "workspaceId",
      "appId",
      "createdAt",
    ]);

    for (const chunk of chunkRows(deduped, 23, 200)) {
      const upserted = await db
        .insert(appIndex)
        .values(chunk)
        .onConflictDoUpdate({
          target: appIndex.appId,
          set: setExcluded,
          // Never overwrite another workspace's app_index row on app_id collision.
          setWhere: eq(appIndex.workspaceId, wsUuid),
        })
        .returning({ appId: appIndex.appId });

      if (upserted.length < chunk.length) {
        const writtenAppIds = new Set(upserted.map(r => r.appId.toLowerCase()));
        const collided = chunk.find(
          r => !writtenAppIds.has(r.appId.toLowerCase()),
        );
        const err = new Error(
          `duplicate key value violates unique constraint "uq_app_index_app_id" (app_id=${collided?.appId ?? "unknown"} belongs to another workspace)`,
        ) as Error & { code?: string };
        err.code = "23505";
        throw err;
      }
    }
  }

  /** Backfill helper for `app_index`. */
  async upsertIndexEntryWithGuard(
    record: AppIndexEntryRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const idUuid = entityIdToPgUuid(record.id);
    const wsUuid = entityIdToPgUuid(record.workspaceId);
    const appUuid = entityIdToPgUuid(record.appId);
    const ownerUuid = await this.resolveNullableUserUuid(record.ownerId, db);
    const dupUuid = optionalEntityIdToPgUuid(record.duplicateOf);
    const values = {
      id: idUuid,
      workspaceId: wsUuid,
      appId: appUuid,
      path: record.path,
      slug: record.slug,
      scope: record.scope,
      ownerId: ownerUuid,
      treeOid: record.treeOid,
      title: record.title,
      description: record.description ?? null,
      hasManifestId: record.hasManifestId,
      duplicateOf: dupUuid,
      schedules: record.schedules,
      tables: record.tables ?? null,
      bindingTables: record.bindingTables ?? null,
      bindings: record.bindings ?? null,
      authorEmail: record.authorEmail ?? null,
      firstCommitAt: record.firstCommitAt ?? null,
      thumbnail: record.thumbnail ?? null,
      icon: record.icon ?? null,
      indexedSha: record.indexedSha,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const rows = await db
      .insert(appIndex)
      .values(values)
      .onConflictDoUpdate({
        target: appIndex.appId,
        set: values,
        setWhere: sql`${appIndex.workspaceId} = ${wsUuid}::uuid AND (${appIndex.updatedAt} IS NULL OR EXCLUDED."updated_at" >= ${appIndex.updatedAt})`,
      })
      .returning({ id: appIndex.id });
    return rows.length > 0;
  }

  // ── 3. app_index_heads ───────────────────────────────────────────────────

  async findIndexHeadByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppIndexHeadRecord | null> {
    const rows = await db
      .select()
      .from(appIndexHeads)
      .where(eq(appIndexHeads.workspaceId, entityIdToPgUuid(workspaceId)))
      .limit(1);
    return rows[0] ? pgAppIndexHeadToRecord(rows[0]) : null;
  }

  async upsertIndexHead(
    workspaceId: string,
    input: {
      sha: string;
      schemaVersion?: number;
      folders: string[];
      id?: string;
      createdAt?: Date;
      updatedAt?: Date;
    },
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const now = input.updatedAt ?? new Date();
    await db
      .insert(appIndexHeads)
      .values({
        ...(input.id ? { id: entityIdToPgUuid(input.id) } : {}),
        workspaceId: wsUuid,
        sha: input.sha,
        schemaVersion: input.schemaVersion ?? null,
        folders: input.folders,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: appIndexHeads.workspaceId,
        set: {
          sha: input.sha,
          schemaVersion: input.schemaVersion ?? null,
          folders: input.folders,
          updatedAt: now,
        },
      });
  }

  // ── 4. app_embeddings ────────────────────────────────────────────────────

  async listEmbeddingsMetaByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppEmbeddingMeta[]> {
    const rows = await db
      .select({
        appId: appEmbeddings.appId,
        path: appEmbeddings.path,
        treeOid: appEmbeddings.treeOid,
        docHash: appEmbeddings.docHash,
        embeddingModel: appEmbeddings.embeddingModel,
      })
      .from(appEmbeddings)
      .where(eq(appEmbeddings.workspaceId, entityIdToPgUuid(workspaceId)));
    return rows.map(r => ({
      appId: toWireId(r.appId),
      path: r.path,
      treeOid: r.treeOid,
      docHash: r.docHash,
      embeddingModel: r.embeddingModel,
    }));
  }

  async listEmbeddingsByWorkspaceAndModel(
    workspaceId: string,
    embeddingModel: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppEmbeddingVectorEntry[]> {
    const rows = await db
      .select({
        appId: appEmbeddings.appId,
        vector: appEmbeddings.vector,
        terms: appEmbeddings.terms,
      })
      .from(appEmbeddings)
      .where(
        and(
          eq(appEmbeddings.workspaceId, entityIdToPgUuid(workspaceId)),
          eq(appEmbeddings.embeddingModel, embeddingModel),
        ),
      );
    return rows.map(r => ({
      appId: toWireId(r.appId),
      vector: Array.isArray(r.vector) ? r.vector.map(Number) : [],
      ...(r.terms != null ? { terms: r.terms } : {}),
    }));
  }

  async deleteEmbeddingsByAppIds(
    workspaceId: string,
    appIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const uuids = appIds
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return;
    await db
      .delete(appEmbeddings)
      .where(
        and(
          eq(appEmbeddings.workspaceId, entityIdToPgUuid(workspaceId)),
          inArray(appEmbeddings.appId, uuids),
        ),
      );
  }

  async upsertEmbeddingsBatch(
    workspaceId: string,
    fullUpserts: readonly UpsertAppEmbeddingInput[],
    pathOnlyUpdates: readonly AppEmbeddingPathUpdate[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const now = new Date();
    for (const r of fullUpserts) {
      const appUuid = entityIdToPgUuid(r.appId);
      await db
        .insert(appEmbeddings)
        .values({
          ...(r.id ? { id: entityIdToPgUuid(r.id) } : {}),
          workspaceId: wsUuid,
          appId: appUuid,
          path: r.path,
          treeOid: r.treeOid,
          docHash: r.docHash,
          embeddingModel: r.embeddingModel,
          vector: r.vector,
          terms: r.terms ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [appEmbeddings.workspaceId, appEmbeddings.appId],
          set: {
            path: r.path,
            treeOid: r.treeOid,
            docHash: r.docHash,
            embeddingModel: r.embeddingModel,
            vector: r.vector,
            terms: r.terms ?? null,
            updatedAt: now,
          },
        });
    }
    for (const r of pathOnlyUpdates) {
      await db
        .update(appEmbeddings)
        .set({ path: r.path, treeOid: r.treeOid, updatedAt: now })
        .where(
          and(
            eq(appEmbeddings.workspaceId, wsUuid),
            eq(appEmbeddings.appId, entityIdToPgUuid(r.appId)),
          ),
        );
    }
  }

  // ── 5. app_lifecycle ─────────────────────────────────────────────────────

  async listLifecycleByWorkspace(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppLifecycleRecord[]> {
    const rows = await db
      .select()
      .from(appLifecycle)
      .where(eq(appLifecycle.workspaceId, entityIdToPgUuid(workspaceId)));
    return rows.map(pgAppLifecycleToRecord);
  }

  async listLifecycleByArchivedTo(
    workspaceId: string,
    archivedToPaths: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ archivedTo: string; archivedFrom: string }>> {
    if (archivedToPaths.length === 0) return [];
    const rows = await db
      .select({
        archivedTo: appLifecycle.archivedTo,
        archivedFrom: appLifecycle.archivedFrom,
      })
      .from(appLifecycle)
      .where(
        and(
          eq(appLifecycle.workspaceId, entityIdToPgUuid(workspaceId)),
          inArray(appLifecycle.archivedTo, [...archivedToPaths]),
          isNotNull(appLifecycle.archivedFrom),
        ),
      );
    return rows.filter((r): r is { archivedTo: string; archivedFrom: string } =>
      Boolean(r.archivedTo && r.archivedFrom),
    );
  }

  async listVerifiedAppIds(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const rows = await db
      .select({ appId: appLifecycle.appId })
      .from(appLifecycle)
      .where(
        and(
          eq(appLifecycle.workspaceId, entityIdToPgUuid(workspaceId)),
          isNotNull(appLifecycle.verifiedAt),
        ),
      );
    return rows.map(r => toWireId(r.appId));
  }

  async listPausedScheduleAppIds(
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const rows = await db
      .selectDistinct({ appId: appLifecycle.appId })
      .from(appLifecycle)
      .where(isNotNull(appLifecycle.schedulesPausedAt));
    return rows.map(r => toWireId(r.appId));
  }

  async clearStaleAndPausedOnOpen(
    workspaceId: string,
    appId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const parsedWs = parseEntityId(workspaceId);
    const parsedApp = parseEntityId(appId);
    if (!parsedWs || !parsedApp) return;
    await db
      .update(appLifecycle)
      .set({
        schedulesPausedAt: null,
        staleSince: null,
        staleNotifiedTo: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appLifecycle.workspaceId, parsedWs.uuid),
          eq(appLifecycle.appId, parsedApp.uuid),
          or(
            isNotNull(appLifecycle.schedulesPausedAt),
            isNotNull(appLifecycle.staleSince),
          ),
        ),
      );
  }

  async markAppRestored(
    workspaceId: string,
    appId: string,
    restoredAt: Date,
    restoredBy?: string,
    id?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const appUuid = entityIdToPgUuid(appId);
    const restoredByUuid = await this.resolveNullableUserUuid(restoredBy, db);
    const now = new Date();
    await db
      .insert(appLifecycle)
      .values({
        ...(id ? { id: entityIdToPgUuid(id) } : {}),
        workspaceId: wsUuid,
        appId: appUuid,
        restoredAt,
        restoredBy: restoredByUuid,
        staleSince: null,
        staleNotifiedTo: null,
        schedulesPausedAt: null,
        archivedAt: null,
        archivedFrom: null,
        archivedTo: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [appLifecycle.workspaceId, appLifecycle.appId],
        set: {
          restoredAt,
          ...(restoredBy !== undefined ? { restoredBy: restoredByUuid } : {}),
          staleSince: null,
          staleNotifiedTo: null,
          schedulesPausedAt: null,
          archivedAt: null,
          archivedFrom: null,
          archivedTo: null,
          updatedAt: now,
        },
      });
  }

  async upsertLifecyclePatch(
    workspaceId: string,
    appId: string,
    patch: AppLifecyclePatch,
    id?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const appUuid = entityIdToPgUuid(appId);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.set) {
      if (patch.set.verifiedAt !== undefined) {
        set.verifiedAt = patch.set.verifiedAt;
      }
      if (patch.set.verifiedBy !== undefined) {
        set.verifiedBy = await this.resolveNullableUserUuid(
          patch.set.verifiedBy,
          db,
        );
      }
      if (patch.set.staleSince !== undefined) {
        set.staleSince = patch.set.staleSince;
      }
      if (patch.set.staleNotifiedTo !== undefined) {
        set.staleNotifiedTo = patch.set.staleNotifiedTo;
      }
      if (patch.set.schedulesPausedAt !== undefined) {
        set.schedulesPausedAt = patch.set.schedulesPausedAt;
      }
      if (patch.set.archivedAt !== undefined) {
        set.archivedAt = patch.set.archivedAt;
      }
      if (patch.set.archivedFrom !== undefined) {
        set.archivedFrom = patch.set.archivedFrom;
      }
      if (patch.set.archivedTo !== undefined) {
        set.archivedTo = patch.set.archivedTo;
      }
      if (patch.set.restoredAt !== undefined) {
        set.restoredAt = patch.set.restoredAt;
      }
      if (patch.set.restoredBy !== undefined) {
        set.restoredBy = await this.resolveNullableUserUuid(
          patch.set.restoredBy,
          db,
        );
      }
    }
    if (patch.unset) {
      for (const field of patch.unset) {
        set[field] = null;
      }
    }
    if (patch.set && Object.keys(patch.set).length > 0) {
      const now = new Date();
      await db
        .insert(appLifecycle)
        .values({
          ...(id ? { id: entityIdToPgUuid(id) } : {}),
          workspaceId: wsUuid,
          appId: appUuid,
          ...set,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [appLifecycle.workspaceId, appLifecycle.appId],
          set,
        });
    } else {
      await db
        .update(appLifecycle)
        .set(set)
        .where(
          and(
            eq(appLifecycle.workspaceId, wsUuid),
            eq(appLifecycle.appId, appUuid),
          ),
        );
    }
  }

  // ── 6. app_deploy_commit_statuses ────────────────────────────────────────

  async listPendingCommitStatusesExcludingSha(
    workspaceId: string,
    appId: string,
    excludeSha: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string[]> {
    const rows = await db
      .select({ sha: appDeployCommitStatuses.sha })
      .from(appDeployCommitStatuses)
      .where(
        and(
          eq(
            appDeployCommitStatuses.workspaceId,
            entityIdToPgUuid(workspaceId),
          ),
          eq(appDeployCommitStatuses.appId, entityIdToPgUuid(appId)),
          eq(appDeployCommitStatuses.state, "pending"),
          ne(appDeployCommitStatuses.sha, excludeSha),
        ),
      );
    return rows.map(r => r.sha);
  }

  /** Atomic SQL CAS: transitions `pending` -> `newState` without race. */
  async casResolvePendingCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    newState: AppDeployCommitStatePg,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const rows = await db
      .update(appDeployCommitStatuses)
      .set({ state: newState, updatedAt: new Date() })
      .where(
        and(
          eq(
            appDeployCommitStatuses.workspaceId,
            entityIdToPgUuid(workspaceId),
          ),
          eq(appDeployCommitStatuses.appId, entityIdToPgUuid(appId)),
          eq(appDeployCommitStatuses.sha, sha),
          eq(appDeployCommitStatuses.state, "pending"),
        ),
      )
      .returning({ id: appDeployCommitStatuses.id });
    return rows.length > 0;
  }

  async upsertCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    state: AppDeployCommitStatePg,
    id?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const now = new Date();
    await db
      .insert(appDeployCommitStatuses)
      .values({
        ...(id ? { id: entityIdToPgUuid(id) } : {}),
        workspaceId: entityIdToPgUuid(workspaceId),
        appId: entityIdToPgUuid(appId),
        sha,
        state,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          appDeployCommitStatuses.workspaceId,
          appDeployCommitStatuses.appId,
          appDeployCommitStatuses.sha,
        ],
        set: { state, updatedAt: now },
      });
  }

  // ── 7. app_worktrees ─────────────────────────────────────────────────────

  async findWorktree(
    workspaceId: string,
    actorId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppWorktreeRecord | null> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    const rows = await db
      .select()
      .from(appWorktrees)
      .where(
        and(
          eq(appWorktrees.workspaceId, wsUuid),
          eq(appWorktrees.actorId, resolved.actorId),
        ),
      )
      .limit(1);
    return rows[0] ? pgAppWorktreeToRecord(rows[0]) : null;
  }

  async ensureWorktreeRow(
    workspaceId: string,
    actorId: string,
    defaultBranch: string,
    id?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppWorktreeRecord> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    const now = new Date();

    const rows = await db
      .insert(appWorktrees)
      .values({
        ...(id ? { id: entityIdToPgUuid(id) } : {}),
        workspaceId: wsUuid,
        actorId: resolved.actorId,
        userId: resolved.userId,
        branch: defaultBranch,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [appWorktrees.workspaceId, appWorktrees.actorId],
        // Touch updated_at like Mongoose timestamps do on every upsert (warm-boot reads it).
        set: { updatedAt: now },
      })
      .returning();
    return pgAppWorktreeToRecord(rows[0]);
  }

  async updateWorktreeBranch(
    workspaceId: string,
    actorId: string,
    branch: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    await db
      .update(appWorktrees)
      .set({ branch, updatedAt: new Date() })
      .where(
        and(
          eq(appWorktrees.workspaceId, wsUuid),
          eq(appWorktrees.actorId, resolved.actorId),
        ),
      );
  }

  async bumpWorktreeActivity(
    workspaceId: string,
    actorId: string,
    lastActivityAt: Date,
    activeUntil?: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    const lastIso = lastActivityAt.toISOString();
    // Deliberately leave `updated_at` alone (matches `{ timestamps: false }`).
    await db
      .update(appWorktrees)
      .set({
        lastActivityAt: sql`GREATEST(COALESCE(${appWorktrees.lastActivityAt}, '-infinity'::timestamptz), ${lastIso}::timestamptz)`,
        ...(activeUntil
          ? {
              activeUntil: sql`GREATEST(COALESCE(${appWorktrees.activeUntil}, '-infinity'::timestamptz), ${activeUntil.toISOString()}::timestamptz)`,
            }
          : {}),
      })
      .where(
        and(
          eq(appWorktrees.workspaceId, wsUuid),
          eq(appWorktrees.actorId, resolved.actorId),
        ),
      );
  }

  async listWorktreesActivity(
    pairs: ReadonlyArray<{ workspaceId: string; actorId: string }>,
    db: MakoPgDb = this.getDb(),
  ): Promise<
    Array<{
      workspaceId: string;
      userId: string;
      lastActivityAt: Date | null;
      activeUntil: Date | null;
    }>
  > {
    if (pairs.length === 0) return [];
    const conditions = [];
    for (const p of pairs) {
      const parsedWs = parseEntityId(p.workspaceId);
      if (!parsedWs) continue;
      const resolved = await this.resolveWorktreeActor(p.actorId, db);
      conditions.push(
        and(
          eq(appWorktrees.workspaceId, parsedWs.uuid),
          eq(appWorktrees.actorId, resolved.actorId),
        ),
      );
    }
    if (conditions.length === 0) return [];
    const rows = await db
      .select({
        workspaceId: appWorktrees.workspaceId,
        actorId: appWorktrees.actorId,
        userId: appWorktrees.userId,
        lastActivityAt: appWorktrees.lastActivityAt,
        activeUntil: appWorktrees.activeUntil,
      })
      .from(appWorktrees)
      .where(or(...conditions));
    return rows.map(r => ({
      workspaceId: toWireId(r.workspaceId),
      userId: r.userId ? r.userId.toLowerCase() : r.actorId,
      lastActivityAt: r.lastActivityAt ?? null,
      activeUntil: r.activeUntil ?? null,
    }));
  }

  async getWorktreePauseHistory(
    workspaceId: string,
    actorId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<{
    pausedAt: Date[];
    holdUntil: Date | null;
    holdSetAt: Date | null;
  }> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    const rows = await db
      .select({
        idlePausedAt: appWorktrees.idlePausedAt,
        idlePauseHoldUntil: appWorktrees.idlePauseHoldUntil,
        idlePauseHoldSetAt: appWorktrees.idlePauseHoldSetAt,
      })
      .from(appWorktrees)
      .where(
        and(
          eq(appWorktrees.workspaceId, wsUuid),
          eq(appWorktrees.actorId, resolved.actorId),
        ),
      )
      .limit(1);
    return {
      pausedAt: rows[0]?.idlePausedAt ?? [],
      holdUntil: rows[0]?.idlePauseHoldUntil ?? null,
      holdSetAt: rows[0]?.idlePauseHoldSetAt ?? null,
    };
  }

  async recordWorktreePause(
    workspaceId: string,
    actorId: string,
    at: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    const atIso = at.toISOString();
    // Keep only the last 5 timestamps without changing updated_at.
    await db.execute(sql`
      UPDATE "app_worktrees"
      SET "idle_paused_at" = (
        SELECT array_agg(ts ORDER BY ord)
        FROM (
          SELECT ts, ord
          FROM unnest(array_append(COALESCE("idle_paused_at", '{}'::timestamptz[]), ${atIso}::timestamptz))
               WITH ORDINALITY AS t(ts, ord)
          ORDER BY ord DESC
          LIMIT 5
        ) s
      )
      WHERE "workspace_id" = ${wsUuid}::uuid
        AND "actor_id" = ${resolved.actorId}
    `);
  }

  async holdWorktreePausing(
    workspaceId: string,
    actorId: string,
    until: Date,
    setAt: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolved = await this.resolveWorktreeActor(actorId, db);
    // Deliberately leave `updated_at` alone (matches `{ timestamps: false }`).
    await db
      .update(appWorktrees)
      .set({ idlePauseHoldUntil: until, idlePauseHoldSetAt: setAt })
      .where(
        and(
          eq(appWorktrees.workspaceId, wsUuid),
          eq(appWorktrees.actorId, resolved.actorId),
        ),
      );
  }

  async listHotWorktreeWorkspacesSince(
    since: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<HotWorktreeWorkspaceRecord[]> {
    const rawResult = await db.execute(sql`
      SELECT "workspace_id", MAX("updated_at") AS "at"
      FROM "app_worktrees"
      WHERE "updated_at" >= ${since.toISOString()}::timestamptz
      GROUP BY "workspace_id"
    `);
    const rows = extractRows<{ workspace_id: string; at: Date | string }>(
      rawResult,
    );
    return rows.map(r => ({
      workspaceId: toWireId(r.workspace_id),
      at: r.at instanceof Date ? r.at : new Date(r.at),
    }));
  }

  // ── 8. app_binding_state ─────────────────────────────────────────────────

  async getBindingState(
    projectId: string,
    name: string,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingStateRecord | null> {
    const rows = await db
      .select()
      .from(appBindingState)
      .where(
        and(
          eq(appBindingState.projectId, entityIdToPgUuid(projectId)),
          eq(appBindingState.name, name),
        ),
      )
      .limit(1);
    return rows[0] ? pgAppBindingStateToRecord(rows[0]) : null;
  }

  async listBindingStatesByProjects(
    _workspaceId: string,
    projectIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<BindingStateSummaryRecord[]> {
    const uuids = projectIds
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (uuids.length === 0) return [];
    const rows = await db
      .select({
        projectId: appBindingState.projectId,
        name: appBindingState.name,
        lastMaterializedAt: appBindingState.lastMaterializedAt,
        history: appBindingState.history,
      })
      .from(appBindingState)
      .where(inArray(appBindingState.projectId, uuids));
    return rows.map(r => ({
      projectId: toWireId(r.projectId),
      name: r.name,
      ...(r.lastMaterializedAt != null
        ? { lastMaterializedAt: r.lastMaterializedAt }
        : {}),
      ...(r.history && r.history.length > 0
        ? { history: [deserializeBindingRun(r.history[0])] }
        : {}),
    }));
  }

  async recordBindingRun(
    projectId: string,
    name: string,
    run: AppBindingRunRecord,
    _workspaceId?: string,
    id?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = id ? entityIdToPgUuid(id) : null;
    const projUuid = entityIdToPgUuid(projectId);
    const runJson = JSON.stringify(serializeBindingRun(run));
    const isReady = run.status === "ready";
    const lastMatIso = isReady ? run.at.toISOString() : null;
    const lastRowCount = isReady ? (run.rowCount ?? 0) : null;
    const nowIso = new Date().toISOString();

    await db.execute(sql`
      INSERT INTO "app_binding_state" (
        "id", "project_id", "name",
        "last_materialized_at", "last_row_count", "history",
        "created_at", "updated_at"
      )
      VALUES (
        COALESCE(${idUuid}::uuid, uuidv7()), ${projUuid}::uuid, ${name},
        ${lastMatIso}::timestamptz, ${lastRowCount}::bigint,
        jsonb_build_array(${runJson}::jsonb),
        ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      ON CONFLICT ("project_id", "name") DO UPDATE SET
        "last_materialized_at" = COALESCE(EXCLUDED."last_materialized_at", "app_binding_state"."last_materialized_at"),
        "last_row_count" = COALESCE(EXCLUDED."last_row_count", "app_binding_state"."last_row_count"),
        "history" = (
          SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
          FROM (
            SELECT elem, ord
            FROM jsonb_array_elements(
              jsonb_build_array(${runJson}::jsonb) || COALESCE("app_binding_state"."history", '[]'::jsonb)
            ) WITH ORDINALITY AS t(elem, ord)
            WHERE ord <= 20
          ) s
        ),
        "updated_at" = ${nowIso}::timestamptz
    `);
  }

  /**
   * Atomic SQL CAS for public binding refresh cooldown — zero race, zero 11000 catch!
   */
  async claimPublicBindingRefresh(
    projectId: string,
    name: string,
    cooldownMs: number,
    now: Date = new Date(),
    _workspaceId?: string,
    id?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<ClaimPublicBindingRefreshResult> {
    const idUuid = id ? entityIdToPgUuid(id) : null;
    const projUuid = entityIdToPgUuid(projectId);
    const nowIso = now.toISOString();
    const cutoffIso = new Date(now.getTime() - cooldownMs).toISOString();

    const won = await db.execute(sql`
      INSERT INTO "app_binding_state" (
        "id", "project_id", "name", "public_refresh_at", "created_at", "updated_at"
      )
      VALUES (
        COALESCE(${idUuid}::uuid, uuidv7()), ${projUuid}::uuid, ${name},
        ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      ON CONFLICT ("project_id", "name") DO UPDATE SET
        "public_refresh_at" = EXCLUDED."public_refresh_at",
        "updated_at" = ${nowIso}::timestamptz
      WHERE "app_binding_state"."public_refresh_at" IS NULL
         OR "app_binding_state"."public_refresh_at" <= ${cutoffIso}::timestamptz
      RETURNING "public_refresh_at"
    `);

    if (extractRows(won).length > 0) {
      return { claimed: true };
    }

    const existing = await db
      .select({ publicRefreshAt: appBindingState.publicRefreshAt })
      .from(appBindingState)
      .where(
        and(
          eq(appBindingState.projectId, projUuid),
          eq(appBindingState.name, name),
        ),
      )
      .limit(1);
    const last = existing[0]?.publicRefreshAt?.getTime() ?? now.getTime();
    return {
      claimed: false,
      retryAfterMs: Math.max(1000, cooldownMs - (now.getTime() - last)),
    };
  }

  // ── 9. app_binding_drafts ────────────────────────────────────────────────

  async findActiveDraftBuild(
    projectId: string,
    hash: string,
    now: Date,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingDraftRecord | null> {
    const rows = await db
      .select()
      .from(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, entityIdToPgUuid(projectId)),
          eq(appBindingDrafts.hash, hash),
          eq(appBindingDrafts.kind, "build"),
          gt(appBindingDrafts.expiresAt, now),
        ),
      )
      .orderBy(desc(appBindingDrafts.builtAt))
      .limit(1);
    return rows[0] ? pgAppBindingDraftToRecord(rows[0]) : null;
  }

  async findDraftFailure(
    projectId: string,
    hash: string,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingDraftRecord | null> {
    const rows = await db
      .select()
      .from(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, entityIdToPgUuid(projectId)),
          eq(appBindingDrafts.hash, hash),
          eq(appBindingDrafts.kind, "failure"),
        ),
      )
      .limit(1);
    return rows[0] ? pgAppBindingDraftToRecord(rows[0]) : null;
  }

  async createDraftBuild(
    input: CreateBindingDraftBuildInput,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingDraftRecord> {
    const now = new Date();
    const rows = await db
      .insert(appBindingDrafts)
      .values({
        ...(input.id ? { id: entityIdToPgUuid(input.id) } : {}),
        projectId: entityIdToPgUuid(input.projectId),
        hash: input.hash,
        kind: "build",
        name: input.name,
        key: input.key,
        builtAt: input.builtAt,
        rowCount: input.rowCount,
        byteSize: input.byteSize,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return pgAppBindingDraftToRecord(rows[0]);
  }

  async deleteDraftFailures(
    projectId: string,
    hash: string,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .delete(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, entityIdToPgUuid(projectId)),
          eq(appBindingDrafts.hash, hash),
          eq(appBindingDrafts.kind, "failure"),
        ),
      );
  }

  async deleteDraftBuildByKey(
    projectId: string,
    key: string,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    await db
      .delete(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, entityIdToPgUuid(projectId)),
          eq(appBindingDrafts.kind, "build"),
          eq(appBindingDrafts.key, key),
        ),
      );
  }

  async upsertDraftFailure(
    input: UpsertBindingDraftFailureInput,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const projUuid = entityIdToPgUuid(input.projectId);
    const now = new Date();
    const updated = await db
      .update(appBindingDrafts)
      .set({
        name: input.name,
        failures: input.failures,
        until: input.until,
        error: input.error,
        expiresAt: input.expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(appBindingDrafts.projectId, projUuid),
          eq(appBindingDrafts.hash, input.hash),
          eq(appBindingDrafts.kind, "failure"),
        ),
      )
      .returning({ id: appBindingDrafts.id });
    if (updated.length > 0) return;
    await db.insert(appBindingDrafts).values({
      ...(input.id ? { id: entityIdToPgUuid(input.id) } : {}),
      projectId: projUuid,
      hash: input.hash,
      kind: "failure",
      name: input.name,
      failures: input.failures,
      until: input.until,
      error: input.error,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listExpiredDrafts(
    projectId: string,
    now: Date,
    limit: number,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ id: string; key: string | null }>> {
    const rows = await db
      .select({ id: appBindingDrafts.id, key: appBindingDrafts.key })
      .from(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, entityIdToPgUuid(projectId)),
          lte(appBindingDrafts.expiresAt, now),
        ),
      )
      .limit(limit);
    return rows.map(r => ({ id: toWireId(r.id), key: r.key }));
  }

  async deleteDraftsByIds(
    projectId: string,
    ids: readonly string[],
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const parsedProj = parseEntityId(projectId);
    const uuids = ids
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (!parsedProj || uuids.length === 0) return;
    await db
      .delete(appBindingDrafts)
      .where(
        and(
          eq(appBindingDrafts.projectId, parsedProj.uuid),
          inArray(appBindingDrafts.id, uuids),
        ),
      );
  }

  // ── 10. app_binding_jobs ─────────────────────────────────────────────────

  async createBindingJob(
    input: CreateBindingJobInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingJobRecord> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const resolvedUserUuid = await this.resolveNullableUserUuid(
      input.userId,
      db,
    );
    const now = new Date();
    const rows = await db
      .insert(appBindingJobs)
      .values({
        id: idUuid,
        workspaceId: entityIdToPgUuid(input.workspaceId),
        projectId: entityIdToPgUuid(input.projectId),
        name: input.name,
        kind: input.kind ?? null,
        actorId: input.actorId,
        userId: resolvedUserUuid,
        canWrite: input.canWrite,
        unregistered: input.unregistered ?? null,
        request: input.request ?? {},
        status: "queued",
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return pgAppBindingJobToRecord(rows[0]);
  }

  async findBindingJobById(
    jobId: string,
    projectId?: string,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingJobRecord | null> {
    const parsedJob = parseEntityId(jobId);
    if (!parsedJob) return null;
    const conditions = [eq(appBindingJobs.id, parsedJob.uuid)];
    if (projectId) {
      const parsedProj = parseEntityId(projectId);
      if (!parsedProj) return null;
      conditions.push(eq(appBindingJobs.projectId, parsedProj.uuid));
    }
    const rows = await db
      .select()
      .from(appBindingJobs)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? pgAppBindingJobToRecord(rows[0]) : null;
  }

  async casFailStaleBindingJob(
    jobId: string,
    staleBefore: Date,
    error: string,
    errorStatus: number,
    newExpiresAt: Date,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppBindingJobRecord | null> {
    const parsedJob = parseEntityId(jobId);
    if (!parsedJob) return null;
    const rows = await db
      .update(appBindingJobs)
      .set({
        status: "error",
        error,
        errorStatus,
        expiresAt: newExpiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appBindingJobs.id, parsedJob.uuid),
          eq(appBindingJobs.status, "running"),
          or(
            lte(appBindingJobs.heartbeatAt, staleBefore),
            isNull(appBindingJobs.heartbeatAt),
          ),
        ),
      )
      .returning();
    return rows[0] ? pgAppBindingJobToRecord(rows[0]) : null;
  }

  async listStaleRunningBindingJobs(
    staleBefore: Date,
    limit: number,
    db: MakoPgDb = this.getDb(),
  ): Promise<
    Array<{
      id: string;
      workspaceId: string;
      projectId: string;
      heartbeatAt: Date | null;
    }>
  > {
    const rows = await db
      .select({
        id: appBindingJobs.id,
        workspaceId: appBindingJobs.workspaceId,
        projectId: appBindingJobs.projectId,
        heartbeatAt: appBindingJobs.heartbeatAt,
      })
      .from(appBindingJobs)
      .where(
        and(
          eq(appBindingJobs.status, "running"),
          or(
            lte(appBindingJobs.heartbeatAt, staleBefore),
            isNull(appBindingJobs.heartbeatAt),
          ),
        ),
      )
      .limit(limit);
    return rows.map(r => ({
      id: toWireId(r.id),
      workspaceId: toWireId(r.workspaceId),
      projectId: toWireId(r.projectId),
      heartbeatAt: r.heartbeatAt ?? null,
    }));
  }

  async heartbeatBindingJob(
    jobId: string,
    now: Date,
    newExpiresAt: Date,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const parsedJob = parseEntityId(jobId);
    if (!parsedJob) return;
    await db
      .update(appBindingJobs)
      .set({ heartbeatAt: now, expiresAt: newExpiresAt, updatedAt: now })
      .where(
        and(
          eq(appBindingJobs.id, parsedJob.uuid),
          eq(appBindingJobs.status, "running"),
        ),
      );
  }

  async updateBindingJobProgress(
    jobId: string,
    progress: AppBindingJobProgressRecord,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const parsedJob = parseEntityId(jobId);
    if (!parsedJob) return;
    await db
      .update(appBindingJobs)
      .set({ progress: serializeJobProgress(progress), updatedAt: new Date() })
      .where(
        and(
          eq(appBindingJobs.id, parsedJob.uuid),
          eq(appBindingJobs.status, "running"),
        ),
      );
  }

  async markBindingJob(
    jobId: string,
    update: MarkBindingJobUpdate,
    newExpiresAt: Date,
    heartbeatAt?: Date,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const parsedJob = parseEntityId(jobId);
    if (!parsedJob) return;
    const set: Record<string, unknown> = {
      status: update.status,
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    };
    if (update.status === "ready") set.result = update.result;
    if (update.status === "error") {
      set.error = update.error;
      set.errorStatus = update.errorStatus;
    }
    if (heartbeatAt) set.heartbeatAt = heartbeatAt;
    await db
      .update(appBindingJobs)
      .set(set)
      .where(eq(appBindingJobs.id, parsedJob.uuid));
  }

  async listExpiredFinishedBindingJobs(
    projectId: string,
    now: Date,
    limit: number,
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<Array<{ id: string; result: AppBindingJobRecord["result"] }>> {
    const rows = await db
      .select({ id: appBindingJobs.id, result: appBindingJobs.result })
      .from(appBindingJobs)
      .where(
        and(
          eq(appBindingJobs.projectId, entityIdToPgUuid(projectId)),
          inArray(appBindingJobs.status, ["ready", "error"]),
          lte(appBindingJobs.expiresAt, now),
        ),
      )
      .limit(limit);
    return rows.map(r => ({ id: toWireId(r.id), result: r.result ?? null }));
  }

  async deleteBindingJobsByIds(
    projectId: string,
    ids: readonly string[],
    _workspaceId?: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const parsedProj = parseEntityId(projectId);
    const uuids = ids
      .map(id => parseEntityId(id)?.uuid)
      .filter((u): u is string => Boolean(u));
    if (!parsedProj || uuids.length === 0) return;
    await db
      .delete(appBindingJobs)
      .where(
        and(
          eq(appBindingJobs.projectId, parsedProj.uuid),
          inArray(appBindingJobs.id, uuids),
        ),
      );
  }
}

export {
  pgAppBindingDraftToRecord,
  pgAppBindingJobToRecord,
  pgAppBindingStateToRecord,
  pgAppDeployCommitStatusToRecord,
  pgAppEmbeddingToRecord,
  pgAppIndexEntryToRecord,
  pgAppIndexHeadToRecord,
  pgAppLifecycleToRecord,
  pgAppProjectToRecord,
  pgAppWorktreeToRecord,
};
